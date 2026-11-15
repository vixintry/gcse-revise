'use client';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDB, type CardRec, type Deck, type Misconception } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { Rich } from './Rich';

interface Result { gap: string; explanation: string; question: string; answer: string; cards: { front: string; back: string; topic: string; sourceQuote: string }[]; noShared?: boolean }

const date = (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function GapsPanel({ decks, cards }: { decks: Deck[]; cards: CardRec[] }) {
  const all = useLiveQuery(() => getDB().misconceptions.toArray(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [revealed, setRevealed] = useState<Record<string, 'answer' | 'right'>>({});
  const [added, setAdded] = useState<Record<string, number>>({});
  const repo = () => makeRepo(getDB());

  if (!all) return null;
  const active = all.filter((m) => m.status === 'suspected' || m.status === 'confirmed');
  const resolved = all.filter((m) => m.status === 'resolved').length;
  if (!active.length && !resolved) return null;

  const err = (id: string, msg: string) => setErrors((e) => ({ ...e, [id]: msg }));
  const deckOf = (m: Misconception) => decks.find((d) => d.id === m.deckId);

  async function runDiagnosis(m: Misconception) {
    if (busy) return;
    setBusy(m.id); err(m.id, '');
    const failed = cards.filter((c) => m.evidence.cardIds.includes(c.id)).slice(0, 8);
    const deck = deckOf(m);
    try {
      const res = await fetch('/api/diagnose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({ topic: m.topic, subject: deck?.subject, examBoard: deck?.examBoard, failedCards: failed.map((c) => ({ front: c.front, back: c.back })), stats: { failed: m.evidence.failed, attempts: m.evidence.attempts, failDays: m.evidence.failDays } }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { err(m.id, data?.error?.message ?? 'The AI is unavailable. Keep revising: this pattern stays tracked without it.'); return; }
      if (!data.sharedGap) { setResults((r) => ({ ...r, [m.id]: { gap: '', explanation: '', question: '', answer: '', cards: [], noShared: true } })); return; }
      setResults((r) => ({ ...r, [m.id]: { gap: data.gap, explanation: data.explanation, question: data.question, answer: data.answer, cards: data.cards } }));
      await repo().saveDiagnosis(m.id, { gap: data.gap, explanation: data.explanation, question: data.question, answer: data.answer });
    } catch { err(m.id, 'Could not reach the AI. Keep revising: this pattern stays tracked without it.'); }
    finally { setBusy(null); }
  }

  async function addCards(m: Misconception, r: Result) {
    try {
      await repo().addCards(m.deckId, r.cards.map((c) => ({ front: c.front, back: c.back, topic: c.topic || m.topic, sourceQuote: c.sourceQuote, unverified: true })));
      setAdded((a) => ({ ...a, [m.id]: r.cards.length }));
    } catch { err(m.id, 'Could not save the cards on this device. Nothing was added.'); }
  }

  return (
    <section className="panel stack">
      <h2>Possible knowledge gaps <span className="badge">from your review history</span></h2>
      <p className="small muted">
        Flagged only when you forgot several different cards in one topic on at least two days. These are suspicions, not diagnoses. Dismiss any that look wrong. A gap counts as resolved only after you recall the topic reliably over several later reviews.
        {resolved > 0 && ` ${resolved} resolved so far.`}
      </p>
      {active.length === 0 && <p className="muted">No active patterns right now.</p>}
      <ul className="list">
        {active.map((m) => {
          const r = results[m.id];
          const d = m.diagnosis;
          const shown = r ?? (d ? { gap: d.gap, explanation: d.explanation, question: d.question, answer: d.answer, cards: [] } : null);
          return (
            <li key={m.id} className="stack">
              <div className="row between">
                <div>
                  <b>{m.topic}</b> <span className="small muted">in {deckOf(m)?.name ?? 'a deleted deck'}</span>
                  <div className="small muted num">Forgot {m.evidence.failed} of {m.evidence.attempts} first-time reviews · {m.evidence.cardIds.length} different cards · {m.evidence.failDays} days · last {date(m.evidence.lastSeen)}</div>
                </div>
                <div className="row">
                  <span className={`badge ${m.confidence === 'low' ? 'warn' : ''}`}>{m.confidence} confidence</span>
                  {m.status === 'confirmed' && <span className="badge">you confirmed</span>}
                  {m.reopenCount > 0 && <span className="badge warn">came back</span>}
                </div>
              </div>

              {r?.noShared && <div className="banner warn">The AI found no clear shared concept in these cards. Treat them as separate mistakes.</div>}
              {shown && !r?.noShared && (
                <div className="ai-box stack">
                  <div className="tag">AI suspicion: could be wrong</div>
                  <div><b><Rich text={shown.gap} /></b></div>
                  <div><Rich text={shown.explanation} /></div>
                  <div><b>Check yourself:</b> <Rich text={shown.question} /></div>
                  {!revealed[m.id] && <button className="btn sm" onClick={() => setRevealed((x) => ({ ...x, [m.id]: 'answer' }))}>Show answer</button>}
                  {revealed[m.id] && <div><Rich text={shown.answer} /></div>}
                  {revealed[m.id] === 'answer' && (
                    <div className="row">
                      <button className="btn sm" onClick={() => repo().setMisconceptionStatus(m.id, 'confirmed')}>I got it wrong</button>
                      <button className="btn sm" onClick={() => setRevealed((x) => ({ ...x, [m.id]: 'right' }))}>I got it right</button>
                    </div>
                  )}
                  {revealed[m.id] === 'right' && <div className="small muted">Good. It stays a suspicion and will resolve by itself if your recall holds up.</div>}
                  {r && r.cards.length > 0 && (
                    <div className="stack">
                      <div className="small muted">Suggested practice cards (AI-written, so they are marked unverified until you edit them):</div>
                      <ul className="small">{r.cards.map((c, i) => <li key={i}><Rich text={c.front} /> → <Rich text={c.back} /></li>)}</ul>
                      {added[m.id] ? <div className="small">Added {added[m.id]} cards to the deck.</div> : <button className="btn sm primary" onClick={() => addCards(m, r)}>Add {r.cards.length} cards to deck</button>}
                    </div>
                  )}
                </div>
              )}
              {errors[m.id] && <div className="banner err" role="alert">{errors[m.id]}</div>}
              <div className="row">
                <button className="btn sm" disabled={busy !== null} onClick={() => runDiagnosis(m)}>{busy === m.id ? 'Thinking…' : shown ? 'Diagnose again' : 'Explain and diagnose (AI)'}</button>
                <button className="btn sm danger" onClick={() => repo().setMisconceptionStatus(m.id, 'dismissed')}>This is wrong, dismiss</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
