'use client';
import Link from 'next/link';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { getDB } from '@/lib/db';
import { SyncManager, type SyncSnapshot } from '@/lib/sync/manager';
import { SupabaseRemote } from '@/lib/sync/remote';

const Ctx = createContext<SyncManager | null>(null);
const NONE: SyncSnapshot = { state: 'unconfigured', pending: 0 };
const noopSubscribe = () => () => {};

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [mgr, setMgr] = useState<SyncManager | null>(null);
  useEffect(() => {
    let m: SyncManager | null = null;
    try {
      // NEXT_PUBLIC_ values are public by design: they are protected by row-level security in the database, not by secrecy.
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const remote = url && key ? new SupabaseRemote({ url, anonKey: key, storage: window.localStorage }) : null;
      m = new SyncManager(getDB(), remote);
      m.start();
      setMgr(m);
    } catch { /* no IndexedDB (private mode): the dashboard already warns about this */ }
    return () => m?.stop();
  }, []);
  return <Ctx.Provider value={mgr}>{children}</Ctx.Provider>;
}

export function useSync() {
  const mgr = useContext(Ctx);
  const snap = useSyncExternalStore(mgr ? mgr.subscribe : noopSubscribe, mgr ? mgr.getSnapshot : () => NONE, () => NONE);
  return { mgr, snap };
}

/** Small status pill in the top bar: always says whether your work is only on this device or also in the cloud. */
export function SyncBadge() {
  const { snap } = useSync();
  const n = snap.pending;
  const [label, warn]: [string, boolean] =
    snap.state === 'unconfigured' ? ['This device only', false]
    : snap.state === 'signed_out' ? ['Not signed in', false]
    : snap.state === 'syncing' ? ['Syncing…', false]
    : snap.state === 'offline' ? [`Offline · ${n} waiting`, true]
    : snap.state === 'setup_needed' ? ['Cloud setup needed', true]
    : snap.state === 'auth_expired' ? ['Sign in again', true]
    : snap.state === 'different_account' ? ['Different account', true]
    : snap.state === 'error' ? ['Sync problem', true]
    : n > 0 ? [`${n} not in cloud yet`, true] : ['✓ In the cloud', false];
  return <Link href="/account" className={`badge ${warn ? 'warn' : ''}`} title={snap.message ?? 'Cloud sync'}>{label}</Link>;
}
