import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDB, type CardRec, type Misconception, type ReviewRec } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { computeStats, confidenceOf, deriveMemories, isRecurring, meetsResolution, reconcile, relevantMemories } from '@/lib/learning/misconceptions';
import { newFsrsCard } from '@/lib/scheduler/fsrs';
import { days, T0 } from './helpers';

const names = { d1: 'Biology' };
const card = (id: string, topic?: string, deckId = 'd1'): CardRec => ({ id, deckId, topic, front: 'f', back: 'b', createdAt: 0, updatedAt: 0, fsrs: newFsrsCard(T0), due: 0 });
let n = 0;
const rev = (cardId: string, dayOffset: number, rating: 1 | 2 | 3 | 4, attempt = 1): ReviewRec => ({
  id: `r${++n}`, cardId, deckId: 'd1', sessionId: 's', attempt, rating, ts: days(dayOffset).getTime(), committed: false,
});
const NOW = days(10);
const topicCards = ['a', 'b', 'c', 'd'].map((id) => card(id, 'water balance'));

describe('detection requires a real pattern', () => {
  it('one wrong answer is not a misconception', () => {
    const s = [...computeStats(topicCards, [rev('a', 9, 1)], names, NOW).values()][0];
    expect(isRecurring(s)).toBe(false);
  });

  it('a burst of errors on one day is not enough', () => {
    const revs = ['a', 'b', 'c', 'd'].map((c) => rev(c, 9, 1)).concat([rev('a', 9, 3)]);
    expect(isRecurring([...computeStats(topicCards, revs, names, NOW).values()][0])).toBe(false);
  });

  it('three different cards forgotten across two days with a high forget rate is flagged', () => {
    const revs = [rev('a', 8, 1), rev('b', 8, 1), rev('c', 9, 1), rev('d', 9, 3), rev('a', 9, 3)];
    const s = [...computeStats(topicCards, revs, names, NOW).values()][0];
    expect(isRecurring(s)).toBe(true);
    expect(s.failedCardIds).toEqual(['a', 'b', 'c']);
    expect(confidenceOf(s)).toBe('low');
  });

  it('repeating the same card does not count as several cards', () => {
    const revs = [rev('a', 7, 1), rev('a', 8, 1), rev('a', 9, 1), rev('b', 9, 3), rev('c', 9, 3), rev('d', 9, 3)];
    expect(isRecurring([...computeStats(topicCards, revs, names, NOW).values()][0])).toBe(false);
  });

  it('a low forget rate is not flagged even with many failures', () => {
    const many = Array.from({ length: 30 }, (_, i) => rev('a', 5 + (i % 4), 3));
    const revs = [...many, rev('a', 8, 1), rev('b', 8, 1), rev('c', 9, 1)];
    expect(isRecurring([...computeStats(topicCards, revs, names, NOW).values()][0])).toBe(false);
  });

  it('ignores reinforcement attempts and reviews older than 30 days', () => {
    const revs = [rev('a', 8, 1, 2), rev('b', 8, 1, 2), rev('c', 9, 1, 2), rev('a', -40, 1), rev('b', -41, 1), rev('c', -42, 1)];
    expect(computeStats(topicCards, revs, names, NOW).size).toBe(0);
  });

  it('falls back to the deck name when a card has no topic', () => {
    const s = [...computeStats([card('x')], [rev('x', 9, 1)], names, NOW).values()][0];
    expect(s.topic).toBe('Biology');
  });

  it('high confidence needs many cards, several days and a high rate', () => {
    const cs = ['a', 'b', 'c', 'd', 'e'].map((id) => card(id, 't'));
    const revs = [rev('a', 6, 1), rev('b', 7, 1), rev('c', 8, 1), rev('d', 9, 1), rev('e', 9, 1), rev('a', 9, 3)];
    expect(confidenceOf([...computeStats(cs, revs, names, NOW).values()][0])).toBe('high');
  });
});

describe('lifecycle', () => {
  const flagged = [rev('a', 6, 1), rev('b', 7, 1), rev('c', 8, 1), rev('d', 8, 3), rev('d', 9, 3)];

  it('fixture sanity: the shared fixture really is a recurring pattern', () => {
    expect(isRecurring([...computeStats(topicCards, flagged, names, NOW).values()][0])).toBe(true);
  });

  it('creates a suspected record with evidence, and is idempotent', () => {
    const first = reconcile([], topicCards, flagged, names, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'suspected', id: 'mc:d1:water balance' });
    expect(first[0].evidence.cardIds).toEqual(['a', 'b', 'c']);
    expect(reconcile(first, topicCards, flagged, names, NOW)).toHaveLength(0);
  });

  it('is NOT resolved by a single success, only by enough later clean recalls', () => {
    const [m] = reconcile([], topicCards, flagged, names, NOW);
    const one = [...flagged, rev('a', 9, 4)];
    const afterOne = reconcile([m], topicCards, one, names, days(10));
    expect(afterOne.every((x) => x.status === 'suspected')).toBe(true);
    expect(afterOne[0].evidence.attempts).toBe(6); // evidence refreshed, still unresolved
    const later = [...flagged, ...['a', 'b', 'c', 'd', 'a', 'b'].map((c, i) => rev(c, 9 + Math.floor(i / 3), 3))];
    const out = reconcile([m], topicCards, later, names, days(12));
    expect(out[0].status).toBe('resolved');
    expect(out[0].resolvedAt).toBe(days(12).getTime());
  });

  it('resolution needs variety: many successes on one card on one day does not count', () => {
    const [m] = reconcile([], topicCards, flagged, names, NOW);
    const narrow = [...flagged, ...Array.from({ length: 8 }, () => rev('a', 9, 4))];
    expect(meetsResolution([...computeStats(topicCards, narrow, names, days(10)).values()][0])).toBe(false);
    expect(reconcile([m], topicCards, narrow, names, days(10))).toHaveLength(0);
  });

  it('a resolved weakness reopens only on NEW failures after resolution', () => {
    const [m] = reconcile([], topicCards, flagged, names, NOW);
    const resolved: Misconception = { ...m, status: 'resolved', resolvedAt: days(10).getTime() };
    expect(reconcile([resolved], topicCards, flagged, names, days(11))).toHaveLength(0);
    const relapse = [...flagged, rev('a', 11, 1), rev('b', 12, 1), rev('c', 12, 1), rev('d', 12, 3), rev('a', 12, 3)];
    const out = reconcile([resolved], topicCards, relapse, names, days(13));
    expect(out[0]).toMatchObject({ status: 'suspected', reopenCount: 1 });
  });

  it('a dismissed interpretation is never re-flagged', () => {
    const [m] = reconcile([], topicCards, flagged, names, NOW);
    expect(reconcile([{ ...m, status: 'dismissed' }], topicCards, [...flagged, rev('a', 9, 1)], names, NOW)).toHaveLength(0);
  });
});

describe('memory', () => {
  const [m] = reconcile([], topicCards, [rev('a', 6, 1), rev('b', 7, 1), rev('c', 8, 1), rev('d', 8, 3), rev('d', 9, 3)], names, NOW);

  it('derives a short note from evidence and never overwrites a student edit', () => {
    const { put } = deriveMemories([m], [], NOW);
    expect(put[0].text).toMatch(/Forgot 3 of 5/);
    expect(put[0].text).toMatch(/not a certainty/);
    const edited = { ...put[0], text: 'my own wording', userEdited: true };
    expect(deriveMemories([{ ...m, evidence: { ...m.evidence, failed: 9 } }], [edited], NOW).put).toHaveLength(0);
  });

  it('says a resolved weakness is not to be assumed, and drops dismissed ones', () => {
    const { put } = deriveMemories([{ ...m, status: 'resolved', resolvedAt: NOW.getTime() }], [], NOW);
    expect(put[0].text).toMatch(/Do not assume it is still a weakness/);
    const existing = deriveMemories([m], [], NOW).put;
    expect(deriveMemories([{ ...m, status: 'dismissed' }], existing, NOW).remove).toEqual([`mem:${m.id}`]);
  });

  it('retrieves at most 3 relevant notes and ignores other topics', () => {
    const mk = (i: number, topic: string) => ({ id: `m${i}`, topic, text: `note ${i}`, source: 'auto' as const, createdAt: 0, updatedAt: i });
    const mems = [mk(1, 'Water balance'), mk(2, 'water balance'), mk(3, 'WATER BALANCE'), mk(4, 'water balance'), mk(5, 'genetics')];
    expect(relevantMemories(mems, 'water balance', 'Biology')).toEqual(['note 4', 'note 3', 'note 2']);
    expect(relevantMemories(mems, undefined, undefined)).toEqual([]);
  });
});

describe('persistence (IndexedDB)', () => {
  let db: AppDB, repo: ReturnType<typeof makeRepo>;
  beforeEach(() => { db = new AppDB(`mc-${++n}`); repo = makeRepo(db); });
  afterEach(() => db.close());

  async function seedFailures() {
    const deck = await repo.createDeck({ name: 'Biology' }, days(0));
    const cards = await repo.addCards(deck.id, ['a', 'b', 'c', 'd'].map((x) => ({ front: `Question ${x} here?`, back: `ans ${x}`, topic: 'water balance' })), days(0));
    const mk = (i: number, day: number, rating: 1 | 3) => db.reviews.add({ id: `x${n}-${i}`, cardId: cards[i % 4].id, deckId: deck.id, sessionId: 's', attempt: 1, rating, ts: days(day).getTime(), committed: false });
    await mk(0, 6, 1); await mk(1, 7, 1); await mk(2, 8, 1); await mk(3, 8, 3); await mk(4, 9, 3);
    return { deck, cards };
  }

  it('runDetection stores one suspected record and one memory, and is idempotent', async () => {
    await seedFailures();
    expect((await repo.runDetection(NOW)).changed).toBe(1);
    expect((await repo.runDetection(NOW)).changed).toBe(0);
    expect(await db.misconceptions.count()).toBe(1);
    expect(await db.memories.count()).toBe(1);
  });

  it('dismissing removes the auto memory and stays dismissed', async () => {
    await seedFailures();
    await repo.runDetection(NOW);
    const m = (await db.misconceptions.toArray())[0];
    await repo.setMisconceptionStatus(m.id, 'dismissed', NOW);
    await repo.runDetection(NOW);
    expect((await db.misconceptions.get(m.id))!.status).toBe('dismissed');
    expect(await db.memories.count()).toBe(0);
  });

  it('deleting an automatic memory dismisses the interpretation behind it', async () => {
    await seedFailures();
    await repo.runDetection(NOW);
    const mem = (await db.memories.toArray())[0];
    await repo.deleteMemory(mem.id, NOW);
    expect(await db.memories.count()).toBe(0);
    await repo.runDetection(NOW);
    expect(await db.memories.count()).toBe(0);
  });

  it('student edits survive later detection runs', async () => {
    await seedFailures();
    await repo.runDetection(NOW);
    const mem = (await db.memories.toArray())[0];
    await repo.updateMemory(mem.id, 'I just mix up ADH and aldosterone', NOW);
    await repo.runDetection(days(11));
    expect((await db.memories.get(mem.id))!.text).toBe('I just mix up ADH and aldosterone');
  });

  it('upgrades a version-1 database without losing cards or reviews', async () => {
    const name = `upgrade-${++n}`;
    const { default: Dexie } = await import('dexie');
    const old = new Dexie(name);
    old.version(1).stores({ decks: 'id', cards: 'id, deckId, due', reviews: 'id, cardId, deckId, ts, sessionId' });
    await old.table('decks').add({ id: 'd', name: 'Old', subject: '', examBoard: '', createdAt: 0 });
    await old.table('cards').add({ id: 'c', deckId: 'd', front: 'f', back: 'b', createdAt: 0, updatedAt: 0, fsrs: newFsrsCard(T0), due: 0 });
    old.close();
    const upgraded = new AppDB(name);
    expect(await upgraded.decks.count()).toBe(1);
    expect(await upgraded.cards.count()).toBe(1);
    expect(await upgraded.misconceptions.count()).toBe(0);
    upgraded.close();
  });
});
