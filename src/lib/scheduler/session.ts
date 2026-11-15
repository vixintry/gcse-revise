import { retrievability, State, type Card, type Grade } from './fsrs';

/**
 * Short-term session queue. Pure and deterministic: no clock, no randomness, no network.
 *
 * Rules (documented in README):
 *  - Again  -> card returns after (4 - misses) other cards, minimum 1; must then be recalled twice in a row.
 *  - Hard   -> returns after 5 other cards; needs one clean Good.
 *  - Good   -> clean review card: done for the session. New / struggled card: returns after 10 other
 *              cards and must succeed again before it is done.
 *  - Easy   -> done.
 *  - When a card leaves the queue, ONE rating is committed to FSRS: the worst grade seen in the
 *    cycle. So a card that needed three tries is scheduled as a lapse, not as a success.
 */

export interface CardProgress {
  grades: Grade[];
  goodStreak: number;
  needed: number;
}
export interface Step {
  eventId: string;
  cardId: string;
  grade: Grade;
  queueBefore: string[];
  progressBefore: CardProgress | undefined;
  doneBefore: string[];
  commit: Grade | null;
}
export interface Session {
  queue: string[];
  newIds: string[];
  progress: Record<string, CardProgress>;
  done: string[];
  total: number;
  steps: Step[];
}

export const AGAIN_GAP = 4;
export const HARD_GAP = 5;
export const CONFIRM_GAP = 10;

export function createSession(queue: string[], newIds: string[]): Session {
  return { queue: [...queue], newIds: [...newIds], progress: {}, done: [], total: queue.length, steps: [] };
}

export const currentCardId = (s: Session): string | undefined => s.queue[0];
export const isFinished = (s: Session): boolean => s.queue.length === 0;

export function rate(session: Session, grade: Grade, eventId: string): { session: Session; commit: Grade | null; cardId: string } {
  const cardId = session.queue[0];
  if (cardId === undefined) throw new Error('Session has no cards left');
  const prev = session.progress[cardId];
  const isNew = session.newIds.includes(cardId);
  const p: CardProgress = prev ?? { grades: [], goodStreak: 0, needed: isNew ? 2 : 0 };

  const grades = [...p.grades, grade];
  let { needed, goodStreak } = p;
  let gap: number | null = null; // null = card is finished

  if (grade === 1) {
    const misses = grades.filter((g) => g === 1).length;
    needed = 2;
    goodStreak = 0;
    gap = Math.max(1, AGAIN_GAP - misses);
  } else if (grade === 2) {
    needed = Math.max(needed, 1);
    goodStreak = 0;
    gap = HARD_GAP;
  } else if (grade === 3) {
    goodStreak += 1;
    gap = goodStreak >= needed ? null : CONFIRM_GAP;
  } // Easy: finished

  const rest = session.queue.slice(1);
  const queue = [...rest];
  const done = [...session.done];
  let commit: Grade | null = null;
  if (gap === null) {
    done.push(cardId);
    commit = Math.min(...grades) as Grade;
  } else {
    queue.splice(Math.min(gap, queue.length), 0, cardId);
  }

  const step: Step = {
    eventId, cardId, grade,
    queueBefore: session.queue, progressBefore: prev, doneBefore: session.done, commit,
  };
  return {
    cardId, commit,
    session: {
      ...session, queue, done,
      progress: { ...session.progress, [cardId]: { grades, goodStreak, needed } },
      steps: [...session.steps, step],
    },
  };
}

export function undo(session: Session): { session: Session; step: Step } | null {
  const step = session.steps[session.steps.length - 1];
  if (!step) return null;
  const progress = { ...session.progress };
  if (step.progressBefore) progress[step.cardId] = step.progressBefore;
  else delete progress[step.cardId];
  return {
    step,
    session: { ...session, queue: step.queueBefore, done: step.doneBefore, progress, steps: session.steps.slice(0, -1) },
  };
}

// ---------------- queue building ----------------

export interface QueueCard { id: string; deckId: string; createdAt: number; fsrs: Card }
export interface BuildOptions { now: Date; newLimit: number; maxCards: number; mode: 'due' | 'weak' }

const byUrgency = (now: Date) => (a: QueueCard, b: QueueCard) =>
  retrievability(a.fsrs, now) - retrievability(b.fsrs, now) ||
  a.fsrs.due.getTime() - b.fsrs.due.getTime() ||
  a.id.localeCompare(b.id);

function interleaveByDeck(cards: QueueCard[]): QueueCard[] {
  const groups = new Map<string, QueueCard[]>();
  for (const c of cards) groups.set(c.deckId, [...(groups.get(c.deckId) ?? []), c]);
  const lists = [...groups.values()];
  const out: QueueCard[] = [];
  for (let i = 0; out.length < cards.length; i++) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out;
}

export function buildSession(cards: QueueCard[], opts: BuildOptions): Session {
  const { now, newLimit, maxCards, mode } = opts;
  const seen = cards.filter((c) => c.fsrs.state !== State.New);
  const pool = mode === 'weak'
    ? seen.filter((c) => c.fsrs.lapses >= 1 || c.fsrs.difficulty >= 7)
    : seen.filter((c) => c.fsrs.due.getTime() <= now.getTime());

  const newCards = mode === 'weak' ? [] : cards
    .filter((c) => c.fsrs.state === State.New)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, newLimit));
  const reviews = interleaveByDeck([...pool].sort(byUrgency(now))).slice(0, Math.max(0, maxCards - newCards.length));

  // Spread new cards through the reviews: one new card after every 3 reviews.
  const ids: string[] = [];
  let n = 0;
  reviews.forEach((c, i) => {
    ids.push(c.id);
    if ((i + 1) % 3 === 0 && n < newCards.length) ids.push(newCards[n++].id);
  });
  while (n < newCards.length) ids.push(newCards[n++].id);
  return createSession(ids, newCards.map((c) => c.id));
}
