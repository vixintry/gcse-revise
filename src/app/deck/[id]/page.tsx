'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDB, type CardRec } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { State } from '@/lib/scheduler/fsrs';
import { GeneratePanel } from '@/components/GeneratePanel';
import { Rich } from '@/components/Rich';

export default function DeckPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const deck = useLiveQuery(() => getDB().decks.get(id), [id]);
  const cards = useLiveQuery(() => getDB().cards.where('deckId').equals(id).sortBy('createdAt'), [id]);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [topic, setTopic] = useState('');
  const [editing, setEditing] = useState<{ id: string; front: string; back: string; topic: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Resolved lazily: IndexedDB only exists in the browser, never during server rendering.
  const repo = () => makeRepo(getDB());
  const now = Date.now();

  if (deck === undefined || cards === undefined) return <p className="muted">Loading…</p>;
  if (!deck) return <div className="panel"><p>That deck does not exist.</p><Link href="/">Back to dashboard</Link></div>;

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : fallback); }
  };

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <Link href="/" className="small">← Dashboard</Link>
          <h1>{deck.name}</h1>
          <p className="muted">{[deck.subject, deck.examBoard].filter(Boolean).join(' · ') || 'No subject set'} · {cards.length} cards</p>
        </div>
        <div className="row">
          <Link className="btn primary" href={`/review?deck=${deck.id}&mode=due`}>Revise this deck</Link>
          <button className="btn danger" onClick={() => {
            if (confirm(`Delete "${deck.name}" and its ${cards.length} cards? Review history is kept. This cannot be undone.`))
              run(async () => { await repo().deleteDeck(deck.id); router.push('/'); }, 'Could not delete deck');
          }}>Delete deck</button>
        </div>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}

      <section className="panel stack">
        <h2>Add a card</h2>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await repo().addCards(deck.id, [{ front, back, topic }]); setFront(''); setBack(''); }, 'Could not add card'); }}>
          <div><label htmlFor="f">Question</label><input id="f" value={front} onChange={(e) => setFront(e.target.value)} placeholder="What is the function of the nucleus?  (maths: $x^2$)" maxLength={300} required /></div>
          <div><label htmlFor="b">Answer</label><textarea id="b" rows={2} value={back} onChange={(e) => setBack(e.target.value)} maxLength={600} required /></div>
          <div><label htmlFor="t">Topic (optional)</label><input id="t" list="topics" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. negative feedback" maxLength={60} /><datalist id="topics">{[...new Set(cards.map((c) => c.topic).filter(Boolean))].map((t) => <option key={t} value={t} />)}</datalist><p className="small muted" style={{ marginTop: 4 }}>Cards with the same topic are grouped so the app can spot recurring weak areas.</p></div>
          <div><button className="btn primary" type="submit">Add card</button></div>
        </form>
      </section>

      <GeneratePanel deck={deck} existingFronts={cards.map((c) => c.front)} onAdd={(items) => repo().addCards(deck.id, items).then(() => undefined)} />

      <section className="panel">
        <h2>Cards</h2>
        {cards.length === 0 && <p className="muted">No cards yet. Add one above or generate some from your notes.</p>}
        <ul className="list">
          {cards.map((c: CardRec) => (
            <li key={c.id}>
              {editing?.id === c.id ? (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await repo().updateCard(c.id, editing); setEditing(null); }, 'Could not save'); }}>
                  <input aria-label="Question" value={editing.front} onChange={(e) => setEditing({ ...editing, front: e.target.value })} />
                  <textarea aria-label="Answer" rows={2} value={editing.back} onChange={(e) => setEditing({ ...editing, back: e.target.value })} />
                  <input aria-label="Topic" placeholder="Topic (optional)" value={editing.topic} onChange={(e) => setEditing({ ...editing, topic: e.target.value })} maxLength={60} />
                  <div className="row"><button className="btn primary sm" type="submit">Save</button><button className="btn sm" type="button" onClick={() => setEditing(null)}>Cancel</button></div>
                </form>
              ) : (
                <div className="row between" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <div><b><Rich text={c.front} /></b></div>
                    <div className="muted"><Rich text={c.back} /></div>
                    <div className="row" style={{ marginTop: 4 }}>
                      {c.fsrs.state === State.New ? <span className="badge">new</span> : c.due <= now ? <span className="badge">due</span> : <span className="badge">due {new Date(c.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                      {c.topic && <span className="badge">{c.topic}</span>}
                      {c.unverified && <span className="badge warn">unverified AI card</span>}
                      {c.fsrs.lapses > 0 && <span className="badge warn">{c.fsrs.lapses} lapse{c.fsrs.lapses === 1 ? '' : 's'}</span>}
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn sm" onClick={() => setEditing({ id: c.id, front: c.front, back: c.back, topic: c.topic ?? '' })}>Edit</button>
                    <button className="btn sm danger" onClick={() => { if (confirm('Delete this card?')) run(() => repo().deleteCard(c.id), 'Could not delete'); }}>Delete</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
