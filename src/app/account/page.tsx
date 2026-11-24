'use client';
import { useState } from 'react';
import { useSync } from '@/components/SyncProvider';

const when = (ts?: number) => (ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

export default function AccountPage() {
  const { mgr, snap } = useSync();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!mgr) return <p className="muted">Loading…</p>;

  if (!mgr.configured) {
    return (
      <div className="stack">
        <h1>Cloud sync</h1>
        <div className="panel stack">
          <p>Cloud sync is not set up yet, so everything is stored on this device only.</p>
          <p className="muted small">To turn it on, create a free Supabase project, run the SQL setup file, and add <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to <code>.env.local</code>. The README has step-by-step instructions. Restart the app after saving the file.</p>
        </div>
      </div>
    );
  }

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  };
  const signedOut = snap.state === 'signed_out';

  return (
    <div className="stack">
      <h1>Cloud sync</h1>

      {signedOut && (
        <section className="panel stack">
          <h2>Sign in or create an account</h2>
          <p className="muted small">Your cards and progress are saved to your account so they follow you to your phone or another computer. Everything on this device stays here and keeps working offline.</p>
          <form className="stack" onSubmit={(e) => e.preventDefault()}>
            <div><label htmlFor="em">Email</label><input id="em" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div><label htmlFor="pw">Password (at least 8 characters)</label><input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></div>
            {error && <div className="banner err" role="alert">{error}</div>}
            {notice && <div className="banner warn" role="status">{notice}</div>}
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || !email || password.length < 8} onClick={() => run(() => mgr.signIn(email, password))}>{busy ? 'Working…' : 'Sign in'}</button>
              <button className="btn" type="button" disabled={busy || !email || password.length < 8}
                onClick={() => run(async () => { const confirm = await mgr.signUp(email, password); if (confirm) setNotice('Account created. Check your email and click the confirmation link, then come back and press Sign in.'); })}>Create account</button>
            </div>
          </form>
        </section>
      )}

      {!signedOut && (
        <section className="panel stack">
          <h2>Signed in as {snap.email ?? 'your account'}</h2>
          <div className="stats num">
            <div className="stat"><b>{snap.state === 'syncing' ? '…' : snap.pending}</b><span>changes not in the cloud yet</span></div>
            <div className="stat"><b style={{ fontSize: '1.05rem' }}>{when(snap.lastSyncAt)}</b><span>last successful sync</span></div>
          </div>
          {snap.state === 'idle' && snap.pending === 0 && <div className="banner warn" role="status">Everything on this device is also saved in the cloud.</div>}
          {snap.state === 'offline' && <div className="banner warn" role="status">You're offline. Your work is saved on this device and will upload automatically when you're back online.</div>}
          {snap.message && snap.state !== 'offline' && <div className="banner err" role="alert">{snap.message}</div>}
          {error && <div className="banner err" role="alert">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || snap.state === 'syncing'} onClick={() => run(() => mgr.syncNow())}>{snap.state === 'syncing' ? 'Syncing…' : 'Sync now'}</button>
            <button className="btn" disabled={busy} onClick={() => { if (snap.pending === 0 || confirm(`${snap.pending} changes are not in the cloud yet. They stay on this device, but will not reach your other devices until you sign in again. Sign out anyway?`)) run(() => mgr.signOut()); }}>Sign out</button>
          </div>
          <p className="small muted">Signing out keeps your data on this device. To start completely fresh on this device, clear this site's data in your browser settings.</p>
        </section>
      )}

      <section className="panel stack">
        <h2>What is stored in the cloud</h2>
        <p className="small muted">Your decks, cards, review history, knowledge-gap patterns and learning notes, in a database that only your account can read. The text you paste to generate cards is sent to your AI provider to make the cards, but is not stored by this app. Your AI key never leaves your computer. You sign in with your password; it is handled by Supabase and never stored by this app.</p>
      </section>
    </div>
  );
}
