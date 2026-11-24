import type { AppDB } from '../db';
import { lastSyncAt, pendingCount, syncOnce, type SyncReport } from './engine';
import { SyncError, type SupabaseRemote } from './remote';

export type SyncState = 'unconfigured' | 'signed_out' | 'idle' | 'syncing' | 'offline' | 'error' | 'setup_needed' | 'auth_expired' | 'different_account';
export interface SyncSnapshot { state: SyncState; pending: number; lastSyncAt?: number; email?: string; message?: string }

/** Delay before retry number `failures` (1, 2, 3...): bounded, so a long outage never turns into a retry storm. */
export const backoffMs = (failures: number): number => [5_000, 15_000, 60_000, 300_000][Math.min(Math.max(failures, 1) - 1, 3)];

/** Errors where retrying automatically makes no sense: the person has to do something. */
const NEEDS_PERSON: SyncState[] = ['setup_needed', 'auth_expired', 'different_account', 'signed_out', 'unconfigured'];

export interface Timers { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void; now: () => number }
const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() };

/**
 * Keeps the local database and the cloud in step in the background. The app never waits for it:
 * revision always works from local data, and this just uploads/downloads whenever it can.
 */
export class SyncManager {
  private snap: SyncSnapshot;
  private listeners = new Set<() => void>();
  private running = false;
  private again = false;
  private failures = 0;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private db: AppDB,
    private remote: SupabaseRemote | null,
    private timers: Timers = realTimers,
    private sync: (db: AppDB, remote: SupabaseRemote) => Promise<SyncReport> = (d, r) => syncOnce(d, r),
  ) {
    this.snap = { state: remote ? (remote.session() ? 'idle' : 'signed_out') : 'unconfigured', pending: 0, email: remote?.session()?.user.email };
  }

  // ---- store interface for React ----
  subscribe = (l: () => void) => { this.listeners.add(l); return () => void this.listeners.delete(l); };
  getSnapshot = (): SyncSnapshot => this.snap;
  private set(patch: Partial<SyncSnapshot>) { this.snap = { ...this.snap, ...patch }; this.listeners.forEach((l) => l()); }

  get configured() { return this.remote !== null; }

  // ---- lifecycle ----
  start(): void {
    void this.refreshPending().then(async () => this.set({ lastSyncAt: await lastSyncAt(this.db) }));
    if (this.remote?.session()) this.requestSync(500);
    if (typeof window === 'undefined') return;
    const onOnline = () => this.requestSync(0);
    const onVisible = () => { if (document.visibilityState === 'visible') this.requestSync(500); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    this.cleanup.push(() => window.removeEventListener('online', onOnline), () => document.removeEventListener('visibilitychange', onVisible));
    this.interval = setInterval(() => void this.tick(), 10_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
  }

  /** Every 10s: update the unsynced count, and sync if there is something to send or it has been a minute. */
  async tick(): Promise<void> {
    await this.refreshPending();
    if (!this.remote?.session() || this.running || this.retryTimer || NEEDS_PERSON.includes(this.snap.state)) return;
    if (this.snap.pending > 0 || this.timers.now() - (this.snap.lastSyncAt ?? 0) > 60_000) this.requestSync(0);
  }

  async refreshPending(): Promise<void> {
    try { this.set({ pending: await pendingCount(this.db) }); } catch { /* database closed: ignore */ }
  }

  requestSync(delayMs = 1500): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.syncNow(); }, delayMs);
  }

  /** Run one sync now. Never throws: problems are reported through the snapshot. */
  async syncNow(): Promise<void> {
    if (!this.remote) return;
    if (this.running) { this.again = true; return; }
    if (!this.remote.session()) { this.set({ state: 'signed_out', email: undefined }); return; }
    if (this.retryTimer) { this.timers.clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.running = true;
    this.set({ state: 'syncing', message: undefined, email: this.remote.session()?.user.email });
    try {
      await this.sync(this.db, this.remote);
      this.failures = 0;
      this.set({ state: 'idle', message: undefined, lastSyncAt: await lastSyncAt(this.db) });
    } catch (e) {
      this.fail(e instanceof SyncError ? e : new SyncError('server', 'Something went wrong while syncing.', true));
    } finally {
      this.running = false;
      await this.refreshPending();
      if (this.again) { this.again = false; this.requestSync(0); }
    }
  }

  private fail(err: SyncError): void {
    const state: SyncState = err.code === 'offline' ? 'offline'
      : err.code === 'setup_needed' ? 'setup_needed'
      : err.code === 'different_account' ? 'different_account'
      : err.code === 'auth_expired' || err.code === 'not_signed_in' ? 'auth_expired'
      : 'error';
    this.set({ state, message: err.message });
    if (err.retryable) {
      this.failures++;
      this.retryTimer = this.timers.setTimeout(() => { this.retryTimer = null; void this.syncNow(); }, backoffMs(this.failures));
    }
  }

  // ---- account ----
  async signIn(email: string, password: string): Promise<void> {
    if (!this.remote) throw new SyncError('rejected', 'Cloud sync is not configured.');
    await this.remote.signIn(email.trim(), password);
    this.failures = 0;
    this.set({ state: 'idle', email: email.trim(), message: undefined });
    await this.syncNow();
  }

  /** Returns true if the person must confirm their email before signing in. */
  async signUp(email: string, password: string): Promise<boolean> {
    if (!this.remote) throw new SyncError('rejected', 'Cloud sync is not configured.');
    const { needsConfirmation } = await this.remote.signUp(email.trim(), password);
    if (!needsConfirmation) { this.set({ state: 'idle', email: email.trim(), message: undefined }); await this.syncNow(); }
    return needsConfirmation;
  }

  /** Signs out. Data stays on this device; it just stops syncing. */
  async signOut(): Promise<void> {
    if (!this.remote) return;
    await this.remote.signOut();
    if (this.retryTimer) { this.timers.clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.set({ state: 'signed_out', email: undefined, message: undefined });
  }
}
