'use client';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getDB, type CardRec, type Deck } from '@/lib/db';
import { makeRepo, uid } from '@/lib/repo';
import { buildSession, currentCardId, isFinished, rate, undo, type Session } from '@/lib/scheduler/session';
import type { Grade } from '@/lib/scheduler/fsrs';
import { Rich } from '@/components/Rich';
import { relevantMemories } from '@/lib/learning/misconceptions';
import type { Memory } from '@/lib/db';

type AIState = { kind: string; text?: string; verdict?: string; error?: string; loading?: boolean } | null;

const RATINGS: { grade: Grade; label: string; cls: string; hint: string }[] = [
  { grade: 1, label: 'Again', cls: 'again', hint: 'Forgot' },
  { grade: 2, label: 'Hard', cls: 'hard', hint: 'Struggled' },
  { grade: 3, label: 'Good', cls: 'good', hint: 'Recalled' },
  { grade: 4, label: 'Easy', cls: 'easy', hint: 'Instant' },
];
const VERDICT: Record<string, string> = { correct: 'Looks correct', partly_correct: 'Partly correct', incorrect: 'Looks incorrect', unclear: 'Unclear' };

function Review() {
  const params = useSearchParams();
  const deckId = params.get('deck');
  const mode = params.get('mode') === 'weak' ? 'weak' : 'due';
  const newLimit = Math.min(50, Math.max(0, Number(params.get('new') ?? 10) || 0));

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [cards, setCards] = useState<Map<string, CardRec>>(new Map());
  const [decks, setDecks] = useState<Map<string, Deck>>(new Map());
  const [memories, setMemories] = useState<Memory[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ai, setAi] = useState<AIState>(null);
  const [question, setQuestion] = useState('');
  const busy = useRef(false);
  const sessionId = useRef(uid());
  const repo = useMemo(() => (typeof indexedDB === 'undefined' ? null : makeRepo(getDB())), []);

  useEffect(() => {
    (async () => {
      try {
        const db = getDB();
        let all = await db.cards.toArray();
        if (deckId) all = all.filter((c) => c.deckId === deckId);
        const ds = await db.decks.toArray();
        setMemories(await db.memories.toArray().catch(() => []));
        setCards(new Map(all.map((c) => [c.id, c])));
        setDecks(new Map(ds.map((d) => [d.id, d])));
        setSession(buildSession(all.map((c) => ({ id: c.id, deckId: c.deckId, createdAt: c.createdAt, fsrs: c.fsrs })), { now: new Date(), newLimit, maxCards: 60, mode }));
        setPhase('ready');
      } catch { setPhase('error'); }
    })();
  }, [deckId, mode, newLimit]);

  const resetCardUi = () => { setRevealed(false); setAnswer(''); setAi(null); setQuestion(''); };

  const onRate = useCallback(async (grade: Grade) => {
    if (!session || !repo || busy.current || !revealed) return;
    const id = currentCardId(session);
    if (!id) return;
    busy.current = true; setSaveError(null);
    const eventId = uid();
    const r = rate(session, grade, eventId);
    try {
      await repo.recordRating({ id: eventId, cardId: id, sessionId: sessionId.current, attempt: (session.progress[id]?.grades.length ?? 0) + 1, rating: grade, commit: r.commit });
      setSession(r.session); resetCardUi();
    } catch {
      setSaveError('This rating could not be saved on this device, so it was not counted. Press the rating again to retry.');
    } finally { busy.current = false; }
  }, [session, repo, revealed]);

  const onUndo = useCallback(async () => {
    if (!session || !repo || busy.current) return;
    const u = undo(session);
    if (!u) return;
    busy.current = true; setSaveError(null);
    try { await repo.undoRating(u.step.eventId); setSession(u.session); resetCardUi(); }
    catch { setSaveError('Could not undo that rating. It stays recorded.'); }
    finally { busy.current = false; }
  }, [session, repo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT';
      if (e.metaKey || e.altKey) return;
      if (typing && !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setRevealed(true); }
      else if (revealed && ['1', '2', '3', '4'].includes(e.key)) onRate(Number(e.key) as Grade);
      else if (e.key.toLowerCase() === 'z' && !typing) onUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, onRate, onUndo]);

  const card = session ? cards.get(currentCardId(session) ?? '') : undefined;

  async function askAI(mode: 'hint' | 'explain' | 'check' | 'ask') {
    if (!card || ai?.loading) return;
    const deck = decks.get(card.deckId);
    setAi({ kind: mode, loading: true });
    try {
      const res = await fetch('/api/tutor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ mode, front: card.front, back: card.back, subject: deck?.subject, examBoard: deck?.examBoard, userAnswer: answer || undefined, question: question || undefined, learningContext: relevantMemories(memories, card.topic, deck?.name) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setAi({ kind: mode, error: data?.error?.message ?? 'The AI is unavailable. Carry on revising without it.' });
      else setAi({ kind: mode, text: data.text, verdict: data.check?.verdict });
    } catch { setAi({ kind: mode, error: 'Could not reach the AI. Carry on revising without it.' }); }
  }

  if (phase === 'loading') return <p className="muted">Building your session…</p>;
  if (phase === 'error' || !session) return <div className="banner err" role="alert">Could not open local storage, so revision cannot start in this browser. <Link href="/">Back</Link></div>;

  const finished = isFinished(session);
  const pct = session.total ? Math.round((100 * session.done.length) / session.total) : 0;

  if (session.total === 0) {
    return (
      <div className="panel stack study">
        <h1>{mode === 'weak' ? 'No weak cards yet' : 'Nothing to revise right now'}</h1>
        <p className="muted">{mode === 'weak' ? 'Cards you forget or find hard will show up here.' : 'No cards are due and there are no new cards. Add cards to a deck or come back later.'}</p>
        <div className="row"><Link className="btn primary" href="/">Dashboard</Link></div>
      </div>
    );
  }

  if (finished) {
    const first = Object.values(session.progress).map((p) => p.grades[0]);
    const ok = first.filter((g) => g >= 2).length;
    return (
      <div className="panel stack study">
        <h1>Session complete</h1>
        <p>{session.total} card{session.total === 1 ? '' : 's'} done. You recalled {ok} of {first.length} first time{first.length ? ` (${Math.round((100 * ok) / first.length)}%)` : ''}.</p>
        <p className="muted small">Your progress is saved on this device. Cards you struggled with will come back sooner.</p>
        <div className="row">
          <Link className="btn primary" href="/">Dashboard</Link>
          <button className="btn" onClick={onUndo}>Undo last rating</button>
        </div>
      </div>
    );
  }

  if (!card) return <div className="banner err">A card in this session was deleted. <Link href="/review">Restart</Link></div>;

  return (
    <div className="study stack">
      <div className="row between small muted">
        <Link href="/">← End session</Link>
        <span className="num">{session.done.length} / {session.total} done · {session.queue.length} left</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Session progress"><i style={{ width: `${pct}%` }} /></div>

      <div className="panel card-face" aria-live="polite">
        <div className="small muted">{decks.get(card.deckId)?.name}</div>
        <div className="card-q"><Rich text={card.front} /></div>
        {revealed && <div className="card-a"><Rich text={card.back} /></div>}
        {revealed && card.unverified && <div className="small"><span className="badge warn">Unverified AI card: check it against your notes</span></div>}
      </div>

      {!revealed && (
        <>
          <textarea aria-label="Your answer (optional)" placeholder="Type your answer (optional)" rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <div className="row">
            <button className="btn primary" onClick={() => setRevealed(true)}>Show answer <kbd>Space</kbd></button>
            <button className="btn" onClick={() => askAI('hint')} disabled={ai?.loading}>Hint</button>
            <button className="btn" onClick={onUndo} disabled={!session.steps.length}>Undo <kbd>Z</kbd></button>
          </div>
        </>
      )}

      {revealed && (
        <>
          <div className="rates" role="group" aria-label="How well did you recall this?">
            {RATINGS.map((r) => (
              <button key={r.grade} className={`btn ${r.cls}`} onClick={() => onRate(r.grade)} aria-keyshortcuts={String(r.grade)}>
                <span>{r.label} <kbd>{r.grade}</kbd></span><small>{r.hint}</small>
              </button>
            ))}
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => askAI('explain')} disabled={ai?.loading}>Explain</button>
            {answer.trim() && <button className="btn sm" onClick={() => askAI('check')} disabled={ai?.loading}>Check my answer with AI</button>}
            <button className="btn sm" onClick={onUndo} disabled={!session.steps.length}>Undo <kbd>Z</kbd></button>
          </div>
          <div className="row">
            <input aria-label="Ask a follow-up question" placeholder="Ask a follow-up question…" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && question.trim()) askAI('ask'); }} style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => askAI('ask')} disabled={!question.trim() || ai?.loading}>Ask</button>
          </div>
        </>
      )}

      {saveError && <div className="banner err" role="alert">{saveError}</div>}
      {ai && (
        <div className="ai-box" role="status">
          <div className="tag">AI {ai.kind === 'check' ? 'feedback' : ai.kind}: not part of your grade. You choose the rating.</div>
          {ai.loading && 'Thinking…'}
          {ai.error && <span>{ai.error}</span>}
          {ai.verdict && <div><b>{VERDICT[ai.verdict]}</b> (AI's opinion, could be wrong)</div>}
          {ai.text && <Rich text={ai.text} />}
        </div>
      )}
    </div>
  );
}

export default function ReviewPage() {
  return <Suspense fallback={<p className="muted">Loading…</p>}><Review /></Suspense>;
}
