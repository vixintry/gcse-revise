import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncManager, backoffMs, type Timers } from '@/lib/sync/manager';
import { SyncError, type SupabaseRemote } from '@/lib/sync/remote';
import type { SyncReport } from '@/lib/sync/engine';
import { AppDB } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { days } from './helpers';

let n = 0;
const opened: AppDB[] = [];
afterEach(() => { while (opened.length) opened.pop()!.close(); });

function setup(sync: () => Promise<SyncReport>, signedIn = true) {
  const db = new AppDB(`mgr-${++n}`); opened.push(db);
  const scheduled: { fn: () => void; ms: number; cleared?: boolean }[] = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; scheduled.push(t); return t; },
    clearTimeout: (h) => { (h as { cleared?: boolean }).cleared = true; },
    now: () => 10_000_000,
  };
  const remote = { session: () => (signedIn ? { user: { id: 'u1', email: 'me@x.co' } } : null), signOut: async () => {} } as unknown as SupabaseRemote;
  const mgr = new SyncManager(db, remote, timers, sync as any);
  return { mgr, db, scheduled };
}
const ok: SyncReport = { pulled: 0, pushed: 0, deleted: 0, at: 1 };

describe('retry timing', () => {
  it('backs off 5s, 15s, 1min, then stays at 5 minutes', () => {
    expect([1, 2, 3, 4, 5, 20].map(backoffMs)).toEqual([5_000, 15_000, 60_000, 300_000, 300_000, 300_000]);
  });
});

describe('sync manager', () => {
  it('starts "not configured" without a cloud, and "signed out" without a session', () => {
    const db = new AppDB(`mgr-${++n}`); opened.push(db);
    expect(new SyncManager(db, null).getSnapshot().state).toBe('unconfigured');
    expect(setup(async () => ok, false).mgr.getSnapshot().state).toBe('signed_out');
  });

  it('a good sync ends idle with nothing waiting', async () => {
    const { mgr } = setup(async () => ok);
    await mgr.syncNow();
    expect(mgr.getSnapshot()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('while offline the state says so, local changes are counted as waiting, and a retry is scheduled', async () => {
    const { mgr, db, scheduled } = setup(async () => { throw new SyncError('offline', 'Could not reach the cloud.', true); });
    await makeRepo(db).createDeck({ name: 'Biology' }, days(0));
    await mgr.syncNow();
    expect(mgr.getSnapshot()).toMatchObject({ state: 'offline', pending: 1, message: 'Could not reach the cloud.' });
    expect(scheduled.at(-1)!.ms).toBe(5_000);
  });

  it('repeated failures back off, and a success resets the delay', async () => {
    let fail = true;
    const { mgr, scheduled } = setup(async () => { if (fail) throw new SyncError('server', 'down', true); return ok; });
    await mgr.syncNow(); expect(scheduled.at(-1)!.ms).toBe(5_000);
    await mgr.syncNow(); expect(scheduled.at(-1)!.ms).toBe(15_000);
    await mgr.syncNow(); expect(scheduled.at(-1)!.ms).toBe(60_000);
    fail = false;
    await mgr.syncNow(); expect(mgr.getSnapshot().state).toBe('idle');
    fail = true;
    await mgr.syncNow(); expect(scheduled.at(-1)!.ms).toBe(5_000);
  });

  it.each([['setup_needed', 'setup_needed'], ['auth_expired', 'auth_expired'], ['different_account', 'different_account'], ['not_signed_in', 'auth_expired']] as const)(
    'a %s problem needs the person, so no automatic retry is scheduled', async (code, state) => {
      const { mgr, scheduled } = setup(async () => { throw new SyncError(code, 'msg'); });
      await mgr.syncNow();
      expect(mgr.getSnapshot()).toMatchObject({ state, message: 'msg' });
      expect(scheduled).toHaveLength(0);
    });

  it('an unexpected crash is reported as a retryable problem, never thrown into the app', async () => {
    const { mgr, scheduled } = setup(async () => { throw new Error('boom'); });
    await expect(mgr.syncNow()).resolves.toBeUndefined();
    expect(mgr.getSnapshot().state).toBe('error');
    expect(scheduled).toHaveLength(1);
  });

  it('only one sync runs at a time; a request during one triggers a follow-up afterwards', async () => {
    let running = 0, maxRunning = 0, calls = 0;
    const { mgr, scheduled } = setup(async () => { calls++; running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 10)); running--; return ok; });
    await Promise.all([mgr.syncNow(), mgr.syncNow(), mgr.syncNow()]);
    expect(maxRunning).toBe(1);
    expect(calls).toBe(1);
    expect(scheduled.some((s) => s.ms === 0)).toBe(true); // follow-up queued
  });

  it('signing out stops syncing but keeps local data', async () => {
    let signedIn = true;
    const db = new AppDB(`mgr-${++n}`); opened.push(db);
    const remote = { session: () => (signedIn ? { user: { id: 'u1' } } : null), signOut: async () => { signedIn = false; } } as unknown as SupabaseRemote;
    const mgr = new SyncManager(db, remote, undefined, async () => ok);
    await makeRepo(db).createDeck({ name: 'Keep me' }, days(0));
    await mgr.signOut();
    expect(mgr.getSnapshot().state).toBe('signed_out');
    await mgr.syncNow();
    expect(mgr.getSnapshot().state).toBe('signed_out');
    expect(await db.decks.count()).toBe(1);
  });
});
