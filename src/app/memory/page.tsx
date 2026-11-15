'use client';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDB } from '@/lib/db';
import { makeRepo } from '@/lib/repo';

const date = (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function MemoryPage() {
  const memories = useLiveQuery(() => getDB().memories.toArray(), []);
  const misc = useLiveQuery(() => getDB().misconceptions.toArray(), []);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [note, setNote] = useState({ topic: '', text: '' });
  const [error, setError] = useState<string | null>(null);
  const repo = () => makeRepo(getDB());
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); } };

  if (!memories || !misc) return <p className="muted">Loading…</p>;
  const history = [...misc].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="stack">
      <div>
        <h1>Learning notes</h1>
        <p className="muted">Short notes about how your revision is going. The tutor can see up to 3 relevant ones when you ask it for help. Everything here lives on this device only. Edit anything that is wrong, or delete it.</p>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}

      <section className="panel">
        <h2>Notes</h2>
        {memories.length === 0 && <p className="muted">Nothing yet. Notes appear when the app spots a pattern in your reviews, or you can add your own below.</p>}
        <ul className="list">
          {[...memories].sort((a, b) => b.updatedAt - a.updatedAt).map((m) => (
            <li key={m.id} className="stack">
              <div className="row between">
                <span className="row"><b>{m.topic}</b><span className="badge">{m.userEdited ? 'edited by you' : 'automatic'}</span></span>
                <span className="small muted">{date(m.updatedAt)}</span>
              </div>
              {editing?.id === m.id ? (
                <>
                  <textarea aria-label="Note text" rows={3} maxLength={300} value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                  <div className="row"><button className="btn sm primary" onClick={() => run(async () => { await repo().updateMemory(m.id, editing.text); setEditing(null); })}>Save</button><button className="btn sm" onClick={() => setEditing(null)}>Cancel</button></div>
                </>
              ) : (
                <>
                  <div>{m.text}</div>
                  <div className="row">
                    <button className="btn sm" onClick={() => setEditing({ id: m.id, text: m.text })}>Edit</button>
                    <button className="btn sm danger" onClick={() => { if (confirm(m.id.startsWith('mem:mc:') ? 'Delete this note? The pattern behind it will also be dismissed.' : 'Delete this note?')) run(() => repo().deleteMemory(m.id)); }}>Delete</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        <form className="stack" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await repo().addMemory(note.topic, note.text); setNote({ topic: '', text: '' }); }); }}>
          <div className="row">
            <div style={{ flex: 1, minWidth: 140 }}><label htmlFor="nt">Topic</label><input id="nt" value={note.topic} onChange={(e) => setNote({ ...note, topic: e.target.value })} placeholder="water balance" maxLength={60} required /></div>
            <div style={{ flex: 3, minWidth: 220 }}><label htmlFor="nx">Your note</label><input id="nx" value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} placeholder="I mix up ADH and aldosterone" maxLength={300} required /></div>
          </div>
          <div><button className="btn" type="submit">Add note</button></div>
        </form>
        <p className="small muted">Notes match cards by topic label (or deck name when a card has no topic). Don't put private personal information in notes.</p>
      </section>

      <section className="panel">
        <h2>Pattern history</h2>
        {history.length === 0 && <p className="muted">No patterns detected yet.</p>}
        <ul className="list">
          {history.map((m) => (
            <li key={m.id} className="row between">
              <div>
                <b>{m.topic}</b> <span className={`badge ${m.status === 'suspected' ? 'warn' : ''}`}>{m.status}</span>
                <div className="small muted">
                  {m.status === 'resolved' && m.resolvedAt ? `Resolved ${date(m.resolvedAt)} after later reviews held up. ` : ''}
                  Forgot {m.evidence.failed} of {m.evidence.attempts} reviews · last {date(m.evidence.lastSeen)}{m.reopenCount ? ` · came back ${m.reopenCount}×` : ''}
                </div>
              </div>
              {m.status === 'dismissed' && <button className="btn sm" onClick={() => run(() => repo().setMisconceptionStatus(m.id, 'suspected'))}>Track again</button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
