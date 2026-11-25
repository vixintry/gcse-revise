import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDB } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { pendingCount } from '@/lib/sync/engine';
import { days } from './helpers';

let db: AppDB, repo: ReturnType<typeof makeRepo>, n = 0;
beforeEach(() => { db = new AppDB(`dirty-${++n}`); repo = makeRepo(db); });
afterEach(() => db.close());

const clean = async () => { for (const t of ['decks', 'cards', 'reviews', 'misconceptions', 'memories']) await db.table(t).toCollection().modify({ dirty: 0 }); await db.tombstones.clear(); };
async function seed() {
  const deck = await repo.createDeck({ name: 'Biology' }, days(0));
  const cards = await repo.addCards(deck.id, ['a', 'b', 'c', 'd'].map((x) => ({ front: `Question ${x} here?`, back: `ans ${x}`, topic: 'water balance' })), days(0));
  return { deck, cards };
}

describe('every save is tracked for cloud sync', () => {
  it('new decks and cards are marked as not yet synced', async () => {
    const { deck, cards } = await seed();
    expect((await db.decks.get(deck.id))!.dirty).toBe(1);
    expect((await db.cards.get(cards[0].id))!).toMatchObject({ dirty: 1, schedAt: days(0).getTime() });
    expect(await pendingCount(db)).toBe(5);
  });

  it('editing a card marks it unsynced again', async () => {
    const { cards } = await seed(); await clean();
    await repo.updateCard(cards[0].id, { front: 'A better question here?', back: 'x' }, days(1));
    expect((await db.cards.get(cards[0].id))).toMatchObject({ dirty: 1, updatedAt: days(1).getTime() });
    expect(await pendingCount(db)).toBe(1);
  });

  it('a committed rating dirties both the review and the card schedule', async () => {
    const { cards } = await seed(); await clean();
    await repo.recordRating({ id: 'r1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3, commit: 3, now: days(2) });
    expect((await db.reviews.get('r1'))!.dirty).toBe(1);
    expect((await db.cards.get(cards[0].id))).toMatchObject({ dirty: 1, schedAt: days(2).getTime() });
  });

  it('an uncommitted rating only creates the review', async () => {
    const { cards } = await seed(); await clean();
    await repo.recordRating({ id: 'r1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 1, commit: null, now: days(2) });
    expect((await db.cards.get(cards[0].id))!.dirty).toBe(0);
    expect(await pendingCount(db)).toBe(1);
  });

  it('deleting leaves a tombstone so other devices find out', async () => {
    const { deck, cards } = await seed(); await clean();
    await repo.deleteCard(cards[0].id, days(1));
    expect((await db.tombstones.get(`cards:${cards[0].id}`))).toMatchObject({ table: 'cards', deletedAt: days(1).getTime() });
    await repo.deleteDeck(deck.id, days(2));
    expect(await db.tombstones.count()).toBe(5); // 4 cards + the deck
    expect(await db.tombstones.get(`decks:${deck.id}`)).toBeTruthy();
  });

  it('undo removes the review locally and tombstones it, and re-dirties the restored card', async () => {
    const { cards } = await seed();
    await repo.recordRating({ id: 'r1', cardId: cards[0].id, sessionId: 's', attempt: 1, rating: 3, commit: 3, now: days(1) });
    await clean();
    await repo.undoRating('r1', days(2));
    expect(await db.reviews.count()).toBe(0);
    expect(await db.tombstones.get('reviews:r1')).toBeTruthy();
    expect((await db.cards.get(cards[0].id))).toMatchObject({ dirty: 1, schedAt: days(2).getTime() });
  });

  it('notes are tracked, and deleting an automatic note tombstones it', async () => {
    await repo.addMemory('cells', 'my own note', days(0));
    expect((await db.memories.toArray())[0].dirty).toBe(1);
    await clean();
    const id = (await db.memories.toArray())[0].id;
    await repo.deleteMemory(id, days(1));
    expect(await db.tombstones.get(`memories:${id}`)).toBeTruthy();
  });
});

describe('knowledge-gap saves (regression: saving a diagnosis used to fail)', () => {
  async function flagged() {
    const { deck, cards } = await seed();
    const mk = (i: number, day: number, rating: 1 | 3) => db.reviews.add({ id: `x${n}-${i}`, cardId: cards[i % 4].id, deckId: deck.id, sessionId: 's', attempt: 1, rating, ts: days(day).getTime(), committed: false });
    await mk(0, 6, 1); await mk(1, 7, 1); await mk(2, 8, 1); await mk(3, 8, 3); await mk(4, 9, 3);
    await repo.runDetection(days(10));
    return (await db.misconceptions.toArray())[0];
  }

  it('saving an AI diagnosis works, marks the record unsynced, and updates the note', async () => {
    const m = await flagged();
    await clean();
    await repo.saveDiagnosis(m.id, { gap: 'Confuses ADH with aldosterone', explanation: 'x', question: 'q?', answer: 'a' }, days(11));
    const saved = (await db.misconceptions.get(m.id))!;
    expect(saved.diagnosis?.gap).toBe('Confuses ADH with aldosterone');
    expect(saved.dirty).toBe(1);
    expect((await db.memories.toArray())[0].text).toMatch(/Suspected gap: Confuses ADH/);
  });

  it('saving a diagnosis for a record that no longer exists does nothing', async () => {
    await expect(repo.saveDiagnosis('mc:none', { gap: 'g', explanation: 'e', question: 'q', answer: 'a' })).resolves.toBeUndefined();
  });

  it('detection and dismissing mark records unsynced', async () => {
    const m = await flagged();
    expect(m.dirty).toBe(1);
    await clean();
    await repo.setMisconceptionStatus(m.id, 'dismissed', days(11));
    expect((await db.misconceptions.get(m.id))!.dirty).toBe(1);
    expect(await db.tombstones.get(`memories:mem:${m.id}`)).toBeTruthy();
  });
});
