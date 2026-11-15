import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDB } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { buildSession, createSession, rate, undo, currentCardId, isFinished, type QueueCard } from '@/lib/scheduler/session';
import { State } from '@/lib/scheduler/fsrs';
import { days, T0 } from './helpers';

let db: AppDB, repo: ReturnType<typeof makeRepo>, n = 0;
beforeEach(() => { db = new AppDB(`test-${++n}`); repo = makeRepo(db); });
afterEach(async () => { db.close(); vi.unstubAllGlobals(); });

async function seed(count = 3) {
  const deck = await repo.createDeck({ name: 'Biology', subject: 'Biology', examBoard: 'AQA' }, T0);
  const cards = await repo.addCards(deck.id, Array.from({ length: count }, (_, i) => ({ front: `Question number ${i}?`, back: `Answer ${i}` })), T0);
  return { deck, cards };
}

describe('review persistence', () => {
  it('a committed rating moves the card out of New and sets a future due date', async () => {
    const { cards } = await seed(1);
    await repo.recordRating({ id: 'r1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3, commit: 3, now: T0 });
    const c = (await db.cards.get(cards[0].id))!;
    expect(c.fsrs.state).toBe(State.Review);
    expect(c.due).toBeGreaterThan(T0.getTime());
    expect(await db.reviews.count()).toBe(1);
  });

  it('an uncommitted (reinforcement) rating is logged but does not change the schedule', async () => {
    const { cards } = await seed(1);
    await repo.recordRating({ id: 'r1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 1, commit: null, now: T0 });
    expect((await db.cards.get(cards[0].id))!.fsrs.state).toBe(State.New);
    expect((await db.reviews.get('r1'))!.committed).toBe(false);
  });

  it('writing the same review id twice applies it once (idempotent)', async () => {
    const { cards } = await seed(1);
    const input = { id: 'same', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3 as const, commit: 3 as const, now: T0 };
    const a = await repo.recordRating(input);
    const afterFirst = (await db.cards.get(cards[0].id))!.fsrs;
    const b = await repo.recordRating(input);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(await db.reviews.count()).toBe(1);
    expect((await db.cards.get(cards[0].id))!.fsrs).toEqual(afterFirst);
  });

  it('concurrent duplicate submissions still produce one review', async () => {
    const { cards } = await seed(1);
    const input = { id: 'dup', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3 as const, commit: 3 as const, now: T0 };
    await Promise.all([repo.recordRating(input), repo.recordRating(input), repo.recordRating(input)]);
    expect(await db.reviews.count()).toBe(1);
  });

  it('undo restores the previous schedule and removes the event', async () => {
    const { cards } = await seed(1);
    const before = (await db.cards.get(cards[0].id))!.fsrs;
    await repo.recordRating({ id: 'u1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 4, commit: 4, now: T0 });
    await repo.undoRating('u1');
    expect((await db.cards.get(cards[0].id))!.fsrs).toEqual(before);
    expect(await db.reviews.count()).toBe(0);
  });

  it('history and schedules survive closing and reopening the database', async () => {
    const { cards } = await seed(2);
    await repo.recordRating({ id: 'p1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3, commit: 3, now: T0 });
    const name = db.name;
    db.close();
    const reopened = new AppDB(name);
    expect(await reopened.reviews.count()).toBe(1);
    expect((await reopened.cards.get(cards[0].id))!.fsrs.state).toBe(State.Review);
    expect(await reopened.decks.count()).toBe(1);
    reopened.close();
  });

  it('rejects empty cards and unknown cards', async () => {
    const { deck } = await seed(0);
    await expect(repo.addCards(deck.id, [{ front: ' ', back: 'x' }])).rejects.toThrow();
    await expect(repo.recordRating({ id: 'x', cardId: 'nope', sessionId: 's', attempt: 1, rating: 3, commit: 3 })).rejects.toThrow();
  });

  it('deleting a deck removes its cards but keeps review history', async () => {
    const { deck, cards } = await seed(1);
    await repo.recordRating({ id: 'h1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3, commit: 3, now: T0 });
    await repo.deleteDeck(deck.id);
    expect(await db.cards.count()).toBe(0);
    expect(await db.reviews.count()).toBe(1);
  });
});

describe('revision works with the AI disabled', () => {
  it('runs a full session, with undo, while every network call throws', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('network is down'); });
    const { cards } = await seed(4);
    const now = new Date(T0.getTime() + 1000);
    const toQueue = async (): Promise<QueueCard[]> =>
      (await db.cards.toArray()).map((c) => ({ id: c.id, deckId: c.deckId, createdAt: c.createdAt, fsrs: c.fsrs }));
    let s = buildSession(await toQueue(), { now, newLimit: 10, maxCards: 50, mode: 'due' });
    expect(s.queue).toHaveLength(4);

    let i = 0;
    const step = async (grade: 1 | 2 | 3 | 4) => {
      const id = currentCardId(s)!;
      const r = rate(s, grade, `ev${i++}`);
      await repo.recordRating({ id: `ev${i}`, cardId: id, sessionId: 'S', attempt: 1, rating: grade, commit: r.commit, now });
      s = r.session;
    };
    await step(4);
    // accidental rating, then undo
    const accidental = currentCardId(s)!;
    const r = rate(s, 4, 'ev-acc');
    await repo.recordRating({ id: 'ev-acc', cardId: accidental, sessionId: 'S', attempt: 1, rating: 4, commit: r.commit, now });
    const u = undo(r.session)!;
    await repo.undoRating(u.step.eventId);
    s = u.session;
    expect((await db.cards.get(accidental))!.fsrs.state).toBe(State.New);

    while (!isFinished(s)) await step(3);
    expect(s.done).toHaveLength(4);
    expect((await db.cards.toArray()).every((c) => c.fsrs.state !== State.New)).toBe(true);
    expect(cards).toHaveLength(4);
  });
});
