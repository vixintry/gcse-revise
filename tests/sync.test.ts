import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { pendingCount, syncOnce } from '@/lib/sync/engine';
import { canon, fingerprint, fromData, toData } from '@/lib/sync/serialize';
import { deletionWins, mergeRecord } from '@/lib/sync/merge';
import { State } from '@/lib/scheduler/fsrs';
import { days } from './helpers';
import { FakeCloud, device, type Device } from './fakeCloud';

const open: Device[] = [];
const dev = (cloud: FakeCloud, user?: string) => { const d = device(cloud, user); open.push(d); return d; };
afterEach(() => { while (open.length) open.pop()!.db.close(); });
const sync = (d: Device) => syncOnce(d.db, d.remote);

async function seed(d: Device, cards = 3) {
  const deck = await d.repo.createDeck({ name: 'Biology', subject: 'Biology' }, days(0));
  const recs = await d.repo.addCards(deck.id, Array.from({ length: cards }, (_, i) => ({ front: `Question ${String.fromCharCode(97 + i)} about cells?`, back: `Answer ${i}`, topic: 'cells' })), days(0));
  return { deck, recs };
}
const rate = (d: Device, id: string, cardId: string, at: number, commit: 1 | 2 | 3 | 4 = 3) =>
  d.repo.recordRating({ id, cardId, sessionId: 's', attempt: 1, rating: commit, commit, now: days(at) });

describe('two devices, one cloud', () => {
  it('a new device receives everything, with real Date objects for the schedule', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { deck, recs } = await seed(A);
    await rate(A, 'r1', recs[0].id, 1);
    await sync(A);
    await sync(B);
    expect(await B.db.decks.get(deck.id)).toMatchObject({ name: 'Biology', dirty: 0 });
    expect(await B.db.cards.count()).toBe(3);
    expect(await B.db.reviews.count()).toBe(1);
    const a = (await A.db.cards.get(recs[0].id))!, b = (await B.db.cards.get(recs[0].id))!;
    expect(b.fsrs.state).toBe(State.Review);
    expect(b.fsrs.due).toBeInstanceOf(Date);
    expect(b.fsrs.due.getTime()).toBe(a.fsrs.due.getTime());
    expect(b.due).toBe(a.due);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('syncing again changes nothing and uploads nothing', async () => {
    const cloud = new FakeCloud(), A = dev(cloud);
    const { recs } = await seed(A);
    await rate(A, 'r1', recs[0].id, 1);
    const first = await sync(A);
    expect(first.pushed).toBeGreaterThan(0);
    expect(await pendingCount(A.db)).toBe(0);
    const before = cloud.rows.length;
    const second = await sync(A);
    expect(second).toMatchObject({ pushed: 0, deleted: 0 });
    expect(cloud.rows.length).toBe(before);
  });

  it('offline: nothing is lost, and everything uploads once the connection is back', async () => {
    const cloud = new FakeCloud(), A = dev(cloud);
    cloud.online = false;
    const { recs } = await seed(A);
    await expect(sync(A)).rejects.toMatchObject({ code: 'offline' });
    await rate(A, 'r1', recs[0].id, 1);
    expect(await A.db.cards.count()).toBe(3);
    expect(await pendingCount(A.db)).toBeGreaterThan(0);
    cloud.online = true;
    await sync(A);
    expect(await pendingCount(A.db)).toBe(0);
    expect(cloud.count('user-1', 'cards')).toBe(3);
    expect(cloud.count('user-1', 'reviews')).toBe(1);
  });

  it('a text edit on one device and a review on another both survive', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 1);
    await sync(A); await sync(B);
    await A.repo.updateCard(recs[0].id, { front: 'Edited on device A today?', back: 'bA' }, days(1));
    await rate(B, 'rB', recs[0].id, 2);
    await sync(A); await sync(B); await sync(A);
    for (const d of [A, B]) {
      const c = (await d.db.cards.get(recs[0].id))!;
      expect(c.front).toBe('Edited on device A today?');
      expect(c.fsrs.state).toBe(State.Review);
    }
    expect(fingerprint((await A.db.cards.get(recs[0].id))!)).toBe(fingerprint((await B.db.cards.get(recs[0].id))!));
    expect(await pendingCount(A.db)).toBe(0);
    expect(await pendingCount(B.db)).toBe(0);
  });

  it('conflicting text edits: the later one wins everywhere, and nothing is left unsynced', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 1);
    await sync(A); await sync(B);
    await A.repo.updateCard(recs[0].id, { front: 'Version from A at day one?', back: 'a' }, days(1));
    await B.repo.updateCard(recs[0].id, { front: 'Version from B at day two?', back: 'b' }, days(2));
    await sync(B); await sync(A); await sync(B);
    expect((await A.db.cards.get(recs[0].id))!.front).toBe('Version from B at day two?');
    expect((await B.db.cards.get(recs[0].id))!.front).toBe('Version from B at day two?');
    expect(await pendingCount(A.db) + await pendingCount(B.db)).toBe(0);
  });

  it('reviews done on two devices are all kept', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 2);
    await sync(A); await sync(B);
    await rate(A, 'a1', recs[0].id, 1);
    await rate(B, 'b1', recs[0].id, 2);
    await rate(B, 'b2', recs[1].id, 2);
    await sync(A); await sync(B); await sync(A);
    for (const d of [A, B]) expect((await d.db.reviews.toArray()).map((r) => r.id).sort()).toEqual(['a1', 'b1', 'b2']);
    expect(cloud.count('user-1', 'reviews')).toBe(3);
  });

  it('deleting a card on one device removes it on the other', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 2);
    await sync(A); await sync(B);
    await A.repo.deleteCard(recs[0].id, days(1));
    expect(await pendingCount(A.db)).toBeGreaterThan(0);
    await sync(A); await sync(B);
    expect(await B.db.cards.get(recs[0].id)).toBeUndefined();
    expect(await B.db.cards.count()).toBe(1);
    expect(await A.db.tombstones.count()).toBe(0);
    expect(await pendingCount(B.db)).toBe(0);
  });

  it('deleting a deck removes its cards everywhere', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { deck } = await seed(A, 3);
    await sync(A); await sync(B);
    await A.repo.deleteDeck(deck.id, days(1));
    await sync(A); await sync(B);
    expect(await B.db.decks.count()).toBe(0);
    expect(await B.db.cards.count()).toBe(0);
  });

  it('a deletion never destroys work done after it on another device', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 1);
    await sync(A); await sync(B);
    await A.repo.deleteCard(recs[0].id, days(1));
    await B.repo.updateCard(recs[0].id, { front: 'Improved on device B later?', back: 'b' }, days(2));
    await sync(A); await sync(B); await sync(A);
    for (const d of [A, B]) expect((await d.db.cards.get(recs[0].id))?.front).toBe('Improved on device B later?');
  });

  it('undoing a rating on one device undoes it on the other', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 1);
    await rate(A, 'r1', recs[0].id, 1);
    await sync(A); await sync(B);
    expect((await B.db.cards.get(recs[0].id))!.fsrs.state).toBe(State.Review);
    await A.repo.undoRating('r1', days(2));
    await sync(A); await sync(B);
    expect(await B.db.reviews.count()).toBe(0);
    expect((await B.db.cards.get(recs[0].id))!.fsrs.state).toBe(State.New);
  });

  it('notes sync, and deleting one removes it elsewhere', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    await A.repo.addMemory('cells', 'I mix up mitosis and meiosis', days(0));
    await sync(A); await sync(B);
    const [m] = await B.db.memories.toArray();
    expect(m.text).toBe('I mix up mitosis and meiosis');
    await B.repo.deleteMemory(m.id, days(1));
    await sync(B); await sync(A);
    expect(await A.db.memories.count()).toBe(0);
  });

  it('a sync that fails halfway can simply be run again', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const { recs } = await seed(A, 5);
    await rate(A, 'r1', recs[0].id, 1);
    cloud.pushBudget = 1;
    await expect(sync(A)).rejects.toMatchObject({ code: 'server' });
    expect(await pendingCount(A.db)).toBeGreaterThan(0);
    cloud.pushBudget = null;
    await sync(A);
    expect(await pendingCount(A.db)).toBe(0);
    expect(cloud.count('user-1', 'cards')).toBe(5);
    expect(cloud.count('user-1', 'reviews')).toBe(1);
    await sync(B);
    expect(await B.db.cards.count()).toBe(5);
  });

  it('handles more rows than fit in one page or one upload batch', async () => {
    const cloud = new FakeCloud(), A = dev(cloud), B = dev(cloud);
    const deck = await A.repo.createDeck({ name: 'Big' }, days(0));
    await A.repo.addCards(deck.id, Array.from({ length: 1200 }, (_, i) => ({ front: `Question number ${i} here?`, back: `a${i}` })), days(0));
    await sync(A);
    expect(cloud.count('user-1', 'cards')).toBe(1200);
    await sync(B);
    expect(await B.db.cards.count()).toBe(1200);
  });

  it('a different account is refused and nothing is uploaded to it', async () => {
    const cloud = new FakeCloud(), A = dev(cloud, 'user-1');
    await seed(A);
    await sync(A);
    const intruder = { ...A, remote: cloud.remote('user-2') };
    const before = cloud.rows.length;
    await expect(syncOnce(intruder.db, intruder.remote)).rejects.toMatchObject({ code: 'different_account' });
    expect(cloud.rows.length).toBe(before);
    expect(cloud.count('user-2', 'cards')).toBe(0);
  });

  it('data from before cloud sync existed is uploaded on first sync', async () => {
    const cloud = new FakeCloud(), A = dev(cloud);
    const { recs } = await seed(A, 2);
    // simulate a record saved by an older version of the app: no sync flags at all
    await A.db.cards.update(recs[0].id, { dirty: undefined, schedAt: undefined } as any);
    await sync(A);
    expect(cloud.count('user-1', 'cards')).toBe(2);
    expect((await A.db.cards.get(recs[0].id))!.schedAt).toBeTypeOf('number');
  });
});

describe('merge rules', () => {
  const card = (o: any) => ({ id: 'c', front: 'f', back: 'b', updatedAt: 0, schedAt: 0, fsrs: { s: 'old' }, due: 1, ...o });
  it('cards merge text and schedule independently', () => {
    const merged = mergeRecord('cards', card({ front: 'local text', updatedAt: 5, schedAt: 1, fsrs: { s: 'local' } }), card({ front: 'remote text', updatedAt: 2, schedAt: 9, fsrs: { s: 'remote' }, due: 9 }));
    expect(merged).toMatchObject({ front: 'local text', updatedAt: 5, schedAt: 9, fsrs: { s: 'remote' }, due: 9 });
  });
  it('ties go to the remote copy so every device decides the same way', () => {
    expect(mergeRecord('decks', { id: 'd', name: 'local', updatedAt: 3 }, { id: 'd', name: 'remote', updatedAt: 3 }).name).toBe('remote');
  });
  it('other records: the last change wins', () => {
    expect(mergeRecord('memories', { id: 'm', text: 'new', updatedAt: 9 }, { id: 'm', text: 'old', updatedAt: 1 }).text).toBe('new');
  });
  it('reviews are immutable', () => {
    const local = { id: 'r', rating: 3, ts: 1 };
    expect(mergeRecord('reviews', local, { id: 'r', rating: 1, ts: 1 })).toBe(local);
  });
  it('a deletion loses to a newer edit, but always wins for reviews', () => {
    expect(deletionWins('cards', { updatedAt: 5, schedAt: 0 }, 10)).toBe(true);
    expect(deletionWins('cards', { updatedAt: 5, schedAt: 20 }, 10)).toBe(false);
    expect(deletionWins('decks', { updatedAt: 11 }, 10)).toBe(false);
    expect(deletionWins('reviews', { ts: 999 }, 10)).toBe(true);
  });
  it('comparison ignores key order and local-only flags', () => {
    expect(canon({ b: 1, a: [2, { y: 1, x: 2 }] })).toBe(canon({ a: [2, { x: 2, y: 1 }], b: 1 }));
    expect(fingerprint({ id: 1, name: 'x', dirty: 1 })).toBe(fingerprint({ name: 'x', id: 1 }));
  });
  it('cloud JSON turns back into real Dates', () => {
    const rec = fromData('cards', toData({ id: 'c', fsrs: { due: new Date('2026-11-20T10:00:00Z'), last_review: new Date('2026-11-19T10:00:00Z') } }));
    expect(rec.fsrs.due).toBeInstanceOf(Date);
    expect(rec.fsrs.last_review.toISOString()).toBe('2026-11-19T10:00:00.000Z');
  });
});
