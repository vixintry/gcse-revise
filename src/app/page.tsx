'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDB } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { GapsPanel } from '@/components/GapsPanel';
import { DAY, accuracyByDay, countCards, deckAccuracy, estimatedRetention, recommend, upcomingWorkload } from '@/lib/stats';

export default function Dashboard() {
  const [storageError, setStorageError] = useState<string | null>(null);
  const decks = useLiveQuery(() => getDB().decks.toArray(), []);
  const cards = useLiveQuery(() => getDB().cards.toArray(), []);
  const reviews = useLiveQuery(() => getDB().reviews.where('ts').above(Date.now() - 30 * DAY).toArray(), []);
  const [form, setForm] = useState({ name: '', subject: '', examBoard: '' });
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    try { getDB(); } catch { setStorageError('This browser is blocking local storage (private mode?). Cards and progress cannot be saved here.'); return; }
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data
  }, []);

  // Re-check review history for recurring weak topics (idempotent, local only)
  useEffect(() => {
    if (!cards || !reviews || !decks) return;
    makeRepo(getDB()).runDetection().catch(() => {});
  }, [cards, reviews, decks]);

  const now = useMemo(() => new Date(), [cards, reviews]);
  const counts = useMemo(() => countCards(cards ?? [], now), [cards, now]);
  const workload = useMemo(() => upcomingWorkload(cards ?? [], now), [cards, now]);
  const accuracy = useMemo(() => accuracyByDay(reviews ?? [], now), [reviews, now]);
  const retention = useMemo(() => estimatedRetention(cards ?? [], now), [cards, now]);
  const perDeck = useMemo(() => deckAccuracy(reviews ?? [], now.getTime() - 30 * DAY), [reviews, now]);
  const weakDecks = useMemo(
    () => (decks ?? []).flatMap((d) => { const a = perDeck.get(d.id); return a && a.rate < 0.7 ? [{ name: d.name, ...a }] : []; }),
    [decks, perDeck],
  );
  const tips = recommend({ counts, weakDecks });
  const totalAttempts = accuracy.reduce((s, d) => s + d.attempts, 0);
  const totalPassed = accuracy.reduce((s, d) => s + d.passed, 0);
  const maxWork = Math.max(1, ...workload);
  const dayLabel = (i: number) => (i === 0 ? 'Today' : new Date(now.getTime() + i * DAY).toLocaleDateString('en-GB', { weekday: 'short' }));

  async function createDeck(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try { await makeRepo(getDB()).createDeck(form); setForm({ name: '', subject: '', examBoard: '' }); }
    catch (err) { setFormError(err instanceof Error ? err.message : 'Could not create the deck'); }
  }

  if (!decks || !cards) return <p className="muted">Loading your decks…</p>;

  return (
    <div className="stack">
      {storageError && <div className="banner err" role="alert">{storageError}</div>}
      <div className="row between">
        <div>
          <h1>{counts.due > 0 ? `${counts.due} card${counts.due === 1 ? '' : 's'} due` : 'Nothing due right now'}</h1>
          <p className="muted">Data is stored on this device only. It is not synced to other devices or backed up.</p>
        </div>
        <div className="row">
          <Link className="btn primary" href="/review?mode=due">Start revision</Link>
          <Link className="btn" href="/review?mode=weak">Weak cards</Link>
        </div>
      </div>

      <div className="panel stats num">
        {([['Total', counts.total], ['New', counts.new], ['Learning', counts.learning], ['Young', counts.young], ['Mature', counts.mature]] as const).map(([k, v]) => (
          <div className="stat" key={k}><b>{v}</b><span>{k}</span></div>
        ))}
      </div>

      <div className="grid cols-2">
        <section className="panel">
          <h2>Recall, last 14 days <span className="badge">measured</span></h2>
          <div className="bars" role="img" aria-label={`First-try recall per day. ${totalAttempts ? Math.round((100 * totalPassed) / totalAttempts) + '% overall' : 'No reviews yet'}`}>
            {accuracy.map((d) => (
              <div key={d.date} className={d.attempts ? '' : 'empty'} style={{ height: d.attempts ? `${Math.max(4, (100 * d.passed) / d.attempts)}%` : undefined }}
                title={d.attempts ? `${d.date}: ${d.passed}/${d.attempts} recalled first time` : `${d.date}: no reviews`} />
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            {totalAttempts ? `${Math.round((100 * totalPassed) / totalAttempts)}% recalled first time (${totalPassed} of ${totalAttempts}). Hard counts as recalled.` : 'No reviews yet.'}
          </p>
        </section>
        <section className="panel">
          <h2>Next 7 days <span className="badge">scheduled</span></h2>
          <div className="bars" role="img" aria-label={`Reviews due over the next 7 days: ${workload.join(', ')}`}>
            {workload.map((n, i) => <div key={i} className={n ? '' : 'empty'} style={{ height: n ? `${Math.max(6, (100 * n) / maxWork)}%` : undefined }} title={`${dayLabel(i)}: ${n}`} />)}
          </div>
          <div className="bar-labels">{workload.map((_, i) => <span key={i}>{dayLabel(i)}</span>)}</div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Estimated retention: {retention === null ? 'not enough data' : `${Math.round(retention * 100)}%`} <span className="badge">model estimate</span> It is the scheduler's prediction, not a test result.
          </p>
        </section>
      </div>

      <section className="panel">
        <h2>What to do next</h2>
        <ul className="list">{tips.map((t) => <li key={t}>{t}</li>)}</ul>
      </section>

      <GapsPanel decks={decks} cards={cards} />

      <section className="panel stack">
        <h2>Decks</h2>
        {decks.length === 0 && <p className="muted">No decks yet. Create one below, then add cards by hand or generate them from your notes.</p>}
        <ul className="list">
          {decks.map((d) => {
            const own = cards.filter((c) => c.deckId === d.id);
            const c = countCards(own, now);
            return (
              <li key={d.id} className="row between">
                <div>
                  <Link href={`/deck/${d.id}`}><b>{d.name}</b></Link>
                  <div className="small muted">{[d.subject, d.examBoard].filter(Boolean).join(' · ') || 'No subject set'} · {c.total} cards · {c.due} due · {c.new} new</div>
                </div>
                <Link className="btn sm" href={`/review?deck=${d.id}&mode=due`}>Revise</Link>
              </li>
            );
          })}
        </ul>
        <form onSubmit={createDeck} className="stack">
          <div className="row">
            <div style={{ flex: 2, minWidth: 180 }}><label htmlFor="dn">Deck name</label><input id="dn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Homeostasis" maxLength={80} required /></div>
            <div style={{ flex: 1, minWidth: 120 }}><label htmlFor="ds">Subject</label><input id="ds" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Biology" maxLength={60} /></div>
            <div style={{ flex: 1, minWidth: 100 }}><label htmlFor="db">Exam board</label><input id="db" value={form.examBoard} onChange={(e) => setForm({ ...form, examBoard: e.target.value })} placeholder="AQA" maxLength={40} /></div>
          </div>
          {formError && <div className="banner err" role="alert">{formError}</div>}
          <button className="btn primary" type="submit">Create deck</button>
        </form>
      </section>
    </div>
  );
}
