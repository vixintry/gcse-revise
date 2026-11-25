import { describe, expect, it } from 'vitest';
import { SupabaseRemote, SyncError, type Session } from '@/lib/sync/remote';

const URL_ = 'https://proj.supabase.co', KEY = 'anon-key-123';
const NOW = 1_800_000_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokens = (o: Record<string, unknown> = {}) => ({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, user: { id: 'u1', email: 'a@b.co' }, ...o });

function setup(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>, signedIn: Partial<Session> | null = { access_token: 'AT1', refresh_token: 'RT1', expires_at: NOW / 1000 + 3600, user: { id: 'u1' } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  if (signedIn) storage.setItem('retain.session', JSON.stringify(signedIn));
  const remote = new SupabaseRemote({
    url: `${URL_}/`, anonKey: KEY, storage, now: () => NOW,
    fetch: (async (u: string, i: RequestInit) => { calls.push({ url: String(u), init: i }); return handler(String(u), i, calls.length); }) as unknown as typeof fetch,
  });
  return { remote, calls, storage };
}
const hdr = (c: { init: RequestInit }, k: string) => (c.init.headers as Record<string, string>)[k];

describe('sign in', () => {
  it('signs in with email and password and keeps the session', async () => {
    const { remote, calls } = setup(() => json(tokens()), null);
    const s = await remote.signIn('a@b.co', 'secret123');
    expect(calls[0].url).toBe(`${URL_}/auth/v1/token?grant_type=password`);
    expect(hdr(calls[0], 'apikey')).toBe(KEY);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: 'a@b.co', password: 'secret123' });
    expect(s.user.id).toBe('u1');
    expect(remote.session()?.access_token).toBe('AT1');
    expect(await remote.userId()).toBe('u1');
  });

  it('a wrong password is a clear, non-retryable error and stores nothing', async () => {
    const { remote } = setup(() => json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400), null);
    await expect(remote.signIn('a@b.co', 'bad')).rejects.toMatchObject({ code: 'rejected', message: 'Invalid login credentials', retryable: false });
    expect(remote.session()).toBeNull();
  });

  it('sign up: signed in straight away, or told to confirm by email', async () => {
    const direct = setup(() => json(tokens()), null);
    expect(await direct.remote.signUp('a@b.co', 'secret123')).toEqual({ needsConfirmation: false });
    expect(direct.remote.session()).not.toBeNull();
    const confirm = setup(() => json({ id: 'u2', email: 'a@b.co' }), null);
    expect(await confirm.remote.signUp('a@b.co', 'secret123')).toEqual({ needsConfirmation: true });
    expect(confirm.remote.session()).toBeNull();
  });

  it('signing out works even when offline', async () => {
    const { remote } = setup(() => { throw new Error('offline'); });
    await remote.signOut();
    expect(remote.session()).toBeNull();
  });

  it('refuses to do anything when signed out, without touching the network', async () => {
    const { remote, calls } = setup(() => json([]), null);
    await expect(remote.pull('cards', null, 0, 10)).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(calls).toHaveLength(0);
  });
});

describe('data requests', () => {
  it('pull asks for one page, in a stable order, after the cursor', async () => {
    const { remote, calls } = setup(() => json([{ id: 'c1', updated_at: 1, deleted_at: null, data: {}, server_updated_at: 'x' }]));
    const rows = await remote.pull('cards', '2026-11-22T10:00:00.000Z', 500, 500);
    expect(rows).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/rest/v1/cards');
    expect(u.searchParams.get('order')).toBe('server_updated_at.asc,id.asc');
    expect(u.searchParams.get('limit')).toBe('500');
    expect(u.searchParams.get('offset')).toBe('500');
    expect(u.searchParams.get('server_updated_at')).toBe('gte.2026-11-22T10:00:00.000Z');
    expect(hdr(calls[0], 'apikey')).toBe(KEY);
    expect(hdr(calls[0], 'Authorization')).toBe('Bearer AT1');
  });

  it('the first pull has no cursor filter', async () => {
    const { remote, calls } = setup(() => json([]));
    await remote.pull('decks', null, 0, 10);
    expect(new URL(calls[0].url).searchParams.has('server_updated_at')).toBe(false);
  });

  it('push upserts by (user, id) and tags every row with the signed-in user', async () => {
    const { remote, calls } = setup(() => new Response(null, { status: 201 }));
    await remote.push('cards', [{ id: 'c1', updated_at: 5, deleted_at: null, data: { front: 'q' } }], 'merge');
    const u = new URL(calls[0].url);
    expect(u.pathname + u.search).toBe('/rest/v1/cards?on_conflict=user_id,id');
    expect(calls[0].init.method).toBe('POST');
    expect(hdr(calls[0], 'Prefer')).toBe('resolution=merge-duplicates,return=minimal');
    expect(JSON.parse(calls[0].init.body as string)).toEqual([{ user_id: 'u1', id: 'c1', updated_at: 5, deleted_at: null, data: { front: 'q' } }]);
  });

  it('reviews are pushed with ignore-duplicates, and an empty push sends nothing', async () => {
    const { remote, calls } = setup(() => new Response(null, { status: 201 }));
    await remote.push('reviews', [{ id: 'r1', updated_at: 1, deleted_at: null, data: {} }], 'ignore');
    expect(hdr(calls[0], 'Prefer')).toBe('resolution=ignore-duplicates,return=minimal');
    await remote.push('reviews', [], 'ignore');
    expect(calls).toHaveLength(1);
  });

  it('the public key only ever travels in the apikey header, never in a URL', async () => {
    const { remote, calls } = setup(() => json([]));
    await remote.pull('cards', null, 0, 10);
    expect(calls.every((c) => !c.url.includes(KEY))).toBe(true);
  });
});

describe('sessions expire and refresh', () => {
  it('a 401 triggers one refresh and one retry with the new token', async () => {
    const { remote, calls, storage } = setup((url, _i, n) => {
      if (url.includes('grant_type=refresh_token')) return json(tokens({ access_token: 'AT2', refresh_token: 'RT2' }));
      return n === 1 ? json({ message: 'JWT expired' }, 401) : json([]);
    });
    await remote.pull('cards', null, 0, 10);
    expect(calls).toHaveLength(3);
    expect(hdr(calls[2], 'Authorization')).toBe('Bearer AT2');
    expect(JSON.parse(storage.getItem('retain.session')!).refresh_token).toBe('RT2');
  });

  it('a token that is about to expire is refreshed before the request', async () => {
    const { remote, calls } = setup((url) => (url.includes('refresh_token') ? json(tokens({ access_token: 'AT9' })) : json([])), { access_token: 'OLD', refresh_token: 'RT1', expires_at: NOW / 1000 - 10, user: { id: 'u1' } });
    await remote.pull('cards', null, 0, 10);
    expect(calls[0].url).toContain('grant_type=refresh_token');
    expect(hdr(calls[1], 'Authorization')).toBe('Bearer AT9');
  });

  it('if the login is really dead you are asked to sign in again, and the dead session is removed', async () => {
    const { remote } = setup((url) => (url.includes('refresh_token') ? json({ error: 'invalid_grant' }, 400) : json({}, 401)));
    await expect(remote.pull('cards', null, 0, 10)).rejects.toMatchObject({ code: 'auth_expired' });
    expect(remote.session()).toBeNull();
  });
});

describe('failures are described accurately', () => {
  const failWith = async (res: () => Response | never) => {
    const { remote } = setup(res);
    return remote.pull('cards', null, 0, 10).catch((e) => e as SyncError);
  };
  it('no connection: offline, will retry', async () => {
    const e = await failWith(() => { throw new TypeError('fetch failed'); });
    expect(e).toMatchObject({ code: 'offline', retryable: true });
  });
  it('rate limited and server errors are retryable', async () => {
    expect(await failWith(() => json({}, 429))).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(await failWith(() => json({}, 503))).toMatchObject({ code: 'server', retryable: true });
  });
  it('missing tables tell you to run the SQL setup, and do not retry', async () => {
    const e = await failWith(() => json({ code: 'PGRST205', message: 'Could not find the table' }, 404));
    expect(e).toMatchObject({ code: 'setup_needed', retryable: false });
    expect((e as Error).message).toMatch(/SQL/);
  });
  it('a 404 from the sign-in service is not blamed on missing tables', async () => {
    const { remote } = setup(() => json({ message: 'requested path is invalid' }, 404), null);
    await expect(remote.signIn('a@b.co', 'secret123')).rejects.toMatchObject({ code: 'rejected', message: 'requested path is invalid' });
  });
  it('other rejections show the server message', async () => {
    expect(await failWith(() => json({ message: 'permission denied for table cards' }, 403))).toMatchObject({ code: 'rejected', message: 'permission denied for table cards', retryable: false });
  });
});
