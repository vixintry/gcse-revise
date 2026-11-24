import type { SyncTable } from '../db';

export type SyncErrorCode = 'not_signed_in' | 'offline' | 'auth_expired' | 'rate_limited' | 'server' | 'setup_needed' | 'different_account' | 'rejected';

export class SyncError extends Error {
  constructor(public code: SyncErrorCode, message: string, public retryable = false) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface RemoteRow { id: string; updated_at: number; deleted_at: number | null; data: Record<string, any>; server_updated_at: string }
export interface PushRow { id: string; updated_at: number; deleted_at: number | null; data: Record<string, any> }

/** What the sync engine needs from the cloud. The real one talks to Supabase; tests use an in-memory fake. */
export interface Remote {
  userId(): Promise<string>;
  pull(table: SyncTable, since: string | null, offset: number, limit: number): Promise<RemoteRow[]>;
  push(table: SyncTable, rows: PushRow[], mode: 'merge' | 'ignore'): Promise<void>;
}

export interface Session { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email?: string } }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const SESSION_KEY = 'retain.session';

export class SupabaseRemote implements Remote {
  constructor(private cfg: { url: string; anonKey: string; storage: KV; fetch?: typeof fetch; now?: () => number }) {
    this.cfg.url = cfg.url.replace(/\/+$/, '');
  }

  private now = () => (this.cfg.now ?? Date.now)();
  private doFetch = (url: string, init: RequestInit) => (this.cfg.fetch ?? ((u: string, i: RequestInit) => fetch(u, i)))(url, init);

  // ---------- session ----------
  session(): Session | null {
    try {
      const raw = this.cfg.storage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch { return null; }
  }
  private save(s: Session) { this.cfg.storage.setItem(SESSION_KEY, JSON.stringify(s)); }
  private clear() { this.cfg.storage.removeItem(SESSION_KEY); }

  private toSession(d: any): Session {
    if (!d?.access_token || !d?.refresh_token || !d?.user?.id) throw new SyncError('rejected', 'Unexpected response from the sign-in service.');
    return {
      access_token: d.access_token, refresh_token: d.refresh_token,
      expires_at: d.expires_at ?? Math.floor(this.now() / 1000) + (d.expires_in ?? 3600),
      user: { id: d.user.id, email: d.user.email },
    };
  }

  async signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const res = await this.request('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    const data = await res.json().catch(() => null);
    if (data?.access_token) { this.save(this.toSession(data)); return { needsConfirmation: false }; }
    return { needsConfirmation: true };
  }

  async signIn(email: string, password: string): Promise<Session> {
    const res = await this.request('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    const s = this.toSession(await res.json().catch(() => null));
    this.save(s);
    return s;
  }

  async signOut(): Promise<void> {
    const s = this.session();
    this.clear(); // local sign-out always succeeds, even offline
    if (s) await this.doFetch(`${this.cfg.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.cfg.anonKey, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
  }

  private async refresh(s: Session): Promise<Session> {
    let res: Response;
    try {
      res = await this.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: s.refresh_token }) }, false);
    } catch (e) {
      if (e instanceof SyncError && e.code === 'rejected') { this.clear(); throw new SyncError('auth_expired', 'Your login expired. Sign in again.'); }
      throw e;
    }
    const next = this.toSession(await res.json().catch(() => null));
    this.save(next);
    return next;
  }

  private async validSession(): Promise<Session> {
    const s = this.session();
    if (!s) throw new SyncError('not_signed_in', 'Sign in to sync.');
    return s.expires_at - this.now() / 1000 < 60 ? this.refresh(s) : s;
  }

  async userId(): Promise<string> { return (await this.validSession()).user.id; }

  // ---------- HTTP ----------
  /** One request with consistent error mapping. `auth` adds the signed-in user's token and retries once after a refresh. */
  private async request(path: string, init: RequestInit, auth: boolean, retried = false): Promise<Response> {
    const headers: Record<string, string> = { apikey: this.cfg.anonKey, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
    if (auth) headers.Authorization = `Bearer ${(await this.validSession()).access_token}`;
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.url}${path}`, { ...init, headers });
    } catch {
      throw new SyncError('offline', 'Could not reach the cloud. Your changes are saved on this device.', true);
    }
    if (res.ok) return res;
    if (res.status === 401 && auth) {
      if (retried) { this.clear(); throw new SyncError('auth_expired', 'Your login expired. Sign in again.'); }
      const s = this.session();
      if (s) await this.refresh(s);
      return this.request(path, init, auth, true);
    }
    const body = await res.json().catch(() => null);
    const msg: string = body?.message ?? body?.msg ?? body?.error_description ?? body?.error ?? `Request failed (${res.status})`;
    if (res.status === 429) throw new SyncError('rate_limited', 'The cloud is rate limiting requests. Retrying shortly.', true);
    if (res.status >= 500) throw new SyncError('server', 'The cloud had a problem. Retrying shortly.', true);
    if (path.startsWith('/rest/') && (res.status === 404 || body?.code === 'PGRST205' || body?.code === '42P01')) throw new SyncError('setup_needed', 'The cloud tables are not set up yet. Run the SQL setup file in Supabase.');
    throw new SyncError('rejected', msg);
  }

  // ---------- data ----------
  async pull(table: SyncTable, since: string | null, offset: number, limit: number): Promise<RemoteRow[]> {
    const q = new URLSearchParams({ select: 'id,updated_at,deleted_at,data,server_updated_at', order: 'server_updated_at.asc,id.asc', limit: String(limit), offset: String(offset) });
    if (since) q.set('server_updated_at', `gte.${since}`);
    const res = await this.request(`/rest/v1/${table}?${q}`, { method: 'GET' }, true);
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) throw new SyncError('server', 'Unexpected response from the cloud.', true);
    return rows as RemoteRow[];
  }

  async push(table: SyncTable, rows: PushRow[], mode: 'merge' | 'ignore'): Promise<void> {
    if (!rows.length) return;
    const user_id = await this.userId();
    await this.request(`/rest/v1/${table}?on_conflict=user_id,id`, {
      method: 'POST',
      headers: { Prefer: `resolution=${mode === 'merge' ? 'merge' : 'ignore'}-duplicates,return=minimal` },
      body: JSON.stringify(rows.map((r) => ({ user_id, ...r }))),
    }, true);
  }
}
