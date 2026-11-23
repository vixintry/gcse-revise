import { AppDB, type CardRec, type Deck, type Diagnosis, type Memory, type MisconceptionStatus, type ReviewRec, type SyncTable } from './db';
import { RULES, deriveMemories, reconcile } from './learning/misconceptions';
import { newFsrsCard, scheduleCard, type Grade } from './scheduler/fsrs';

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const DIRTY = 1 as const;
const tomb = (table: SyncTable, id: string, deletedAt: number) => ({ key: `${table}:${id}`, table, id, deletedAt });

/**
 * Every write marks the record `dirty` (changed locally, not yet in the cloud) and every delete
 * leaves a tombstone, so the sync engine knows exactly what to send. Nothing here talks to the network.
 */
export function makeRepo(db: AppDB) {
  const repo = {
    async createDeck(input: { name: string; subject?: string; examBoard?: string }, now = new Date()): Promise<Deck> {
      const name = input.name.trim();
      if (!name) throw new Error('Deck name is required');
      const t = now.getTime();
      const deck: Deck = { id: uid(), name, subject: input.subject?.trim() ?? '', examBoard: input.examBoard?.trim() ?? '', createdAt: t, updatedAt: t, dirty: DIRTY };
      await db.decks.add(deck);
      return deck;
    },

    async deleteDeck(deckId: string, now = new Date()): Promise<void> {
      // Review history is kept so past statistics are not silently destroyed.
      await db.transaction('rw', db.decks, db.cards, db.tombstones, async () => {
        const ids = await db.cards.where('deckId').equals(deckId).primaryKeys();
        await db.tombstones.bulkPut([...ids.map((id) => tomb('cards', id, now.getTime())), tomb('decks', deckId, now.getTime())]);
        await db.cards.where('deckId').equals(deckId).delete();
        await db.decks.delete(deckId);
      });
    },

    async addCards(
      deckId: string,
      items: { front: string; back: string; topic?: string; sourceQuote?: string; unverified?: boolean }[],
      now = new Date(),
    ): Promise<CardRec[]> {
      const recs = items.map((it, i): CardRec => {
        const front = it.front.trim(), back = it.back.trim();
        if (!front || !back) throw new Error('A card needs both a question and an answer');
        const fsrs = newFsrsCard(now);
        return {
          id: uid(), deckId, front, back, topic: it.topic?.trim().slice(0, 60) || undefined, sourceQuote: it.sourceQuote, unverified: it.unverified,
          createdAt: now.getTime() + i, updatedAt: now.getTime(), schedAt: now.getTime(), fsrs, due: fsrs.due.getTime(), dirty: DIRTY,
        };
      });
      await db.cards.bulkAdd(recs);
      return recs;
    },

    async updateCard(id: string, patch: { front: string; back: string; topic?: string }, now = new Date()): Promise<void> {
      const front = patch.front.trim(), back = patch.back.trim();
      if (!front || !back) throw new Error('A card needs both a question and an answer');
      await db.cards.update(id, { front, back, topic: patch.topic?.trim().slice(0, 60) || undefined, updatedAt: now.getTime(), unverified: false, dirty: DIRTY });
    },

    async deleteCard(id: string, now = new Date()): Promise<void> {
      await db.transaction('rw', db.cards, db.tombstones, async () => {
        await db.tombstones.put(tomb('cards', id, now.getTime()));
        await db.cards.delete(id);
      });
    },

    /**
     * Persist one rating atomically. `commit` is the grade to apply to the FSRS schedule
     * (only when the card finished its in-session cycle). Re-sending the same `id` is a no-op,
     * so retries and cloud sync cannot double-apply a review.
     */
    async recordRating(input: {
      id: string; cardId: string; sessionId: string; attempt: number;
      rating: Grade; commit: Grade | null; now?: Date;
    }): Promise<{ duplicate: boolean }> {
      const now = input.now ?? new Date();
      return db.transaction('rw', db.cards, db.reviews, async () => {
        if (await db.reviews.get(input.id)) return { duplicate: true };
        const card = await db.cards.get(input.cardId);
        if (!card) throw new Error('Card no longer exists');
        const rec: ReviewRec = {
          id: input.id, cardId: card.id, deckId: card.deckId, sessionId: input.sessionId,
          attempt: input.attempt, rating: input.rating, ts: now.getTime(), committed: input.commit !== null, dirty: DIRTY,
        };
        if (input.commit !== null) {
          rec.prevFsrs = card.fsrs;
          const next = scheduleCard(card.fsrs, input.commit, now);
          await db.cards.update(card.id, { fsrs: next, due: next.due.getTime(), schedAt: now.getTime(), dirty: DIRTY });
        }
        await db.reviews.add(rec);
        return { duplicate: false };
      });
    },

    /** Re-run misconception detection on real review history and keep derived memories in step. Idempotent. */
    async runDetection(now = new Date()): Promise<{ changed: number }> {
      return db.transaction('rw', [db.decks, db.cards, db.reviews, db.misconceptions, db.memories, db.tombstones], async () => {
        const [decks, cards, existing, memories] = await Promise.all([db.decks.toArray(), db.cards.toArray(), db.misconceptions.toArray(), db.memories.toArray()]);
        const reviews = await db.reviews.where('ts').above(now.getTime() - RULES.windowDays * 86_400_000).toArray();
        const names = Object.fromEntries(decks.map((d) => [d.id, d.name]));
        const changed = reconcile(existing, cards, reviews, names, now);
        if (changed.length) await db.misconceptions.bulkPut(changed.map((m) => ({ ...m, dirty: DIRTY })));
        const merged = existing.map((m) => changed.find((c) => c.id === m.id) ?? m).concat(changed.filter((c) => !existing.some((m) => m.id === c.id)));
        const { put, remove } = deriveMemories(merged, memories, now);
        if (put.length) await db.memories.bulkPut(put.map((m) => ({ ...m, dirty: DIRTY })));
        if (remove.length) {
          await db.tombstones.bulkPut(remove.map((id) => tomb('memories', id, now.getTime())));
          await db.memories.bulkDelete(remove);
        }
        return { changed: changed.length };
      });
    },

    async setMisconceptionStatus(id: string, status: MisconceptionStatus, now = new Date()): Promise<void> {
      await db.transaction('rw', [db.misconceptions, db.memories, db.tombstones], async () => {
        const m = await db.misconceptions.get(id);
        if (!m) return;
        await db.misconceptions.put({ ...m, status, updatedAt: now.getTime(), dirty: DIRTY, ...(status === 'resolved' ? { resolvedAt: now.getTime() } : {}) });
        const mem = await db.memories.get(`mem:${id}`);
        if (status === 'dismissed' && mem && !mem.userEdited) {
          await db.tombstones.put(tomb('memories', mem.id, now.getTime()));
          await db.memories.delete(mem.id);
        }
      });
    },

    async saveDiagnosis(id: string, d: Omit<Diagnosis, 'createdAt'>, now = new Date()): Promise<void> {
      const saved = await db.transaction('rw', db.misconceptions, async () => {
        const m = await db.misconceptions.get(id);
        if (!m) return false;
        await db.misconceptions.put({ ...m, diagnosis: { ...d, createdAt: now.getTime() }, updatedAt: now.getTime(), dirty: DIRTY });
        return true;
      });
      // Separate transaction: detection touches more tables than the one above.
      if (saved) await repo.runDetection(now);
    },

    async addMemory(topic: string, text: string, now = new Date()): Promise<void> {
      const t = text.trim().slice(0, 300);
      if (!t || !topic.trim()) throw new Error('A note needs a topic and some text');
      await db.memories.add({ id: uid(), topic: topic.trim().slice(0, 60), text: t, source: 'user', userEdited: true, createdAt: now.getTime(), updatedAt: now.getTime(), dirty: DIRTY });
    },

    async updateMemory(id: string, text: string, now = new Date()): Promise<void> {
      const t = text.trim().slice(0, 300);
      if (!t) throw new Error('A note cannot be empty. Delete it instead.');
      await db.memories.update(id, { text: t, userEdited: true, updatedAt: now.getTime(), dirty: DIRTY });
    },

    /** Deleting an automatic note means "this interpretation is wrong": the underlying suspicion is dismissed too. */
    async deleteMemory(id: string, now = new Date()): Promise<void> {
      await db.transaction('rw', [db.misconceptions, db.memories, db.tombstones], async () => {
        const mem = await db.memories.get(id);
        if (!mem) return;
        if (id.startsWith('mem:mc:')) {
          const m = await db.misconceptions.get(id.slice(4));
          if (m && m.status !== 'dismissed') await db.misconceptions.put({ ...m, status: 'dismissed', updatedAt: now.getTime(), dirty: DIRTY });
        }
        await db.tombstones.put(tomb('memories', id, now.getTime()));
        await db.memories.delete(id);
      });
    },

    async undoRating(reviewId: string, now = new Date()): Promise<void> {
      await db.transaction('rw', db.cards, db.reviews, db.tombstones, async () => {
        const rev = await db.reviews.get(reviewId);
        if (!rev) return;
        if (rev.committed && rev.prevFsrs) {
          await db.cards.update(rev.cardId, { fsrs: rev.prevFsrs, due: rev.prevFsrs.due.getTime(), schedAt: now.getTime(), dirty: DIRTY });
        }
        await db.tombstones.put(tomb('reviews', reviewId, now.getTime()));
        await db.reviews.delete(reviewId);
      });
    },
  };
  return repo;
}
export type Repo = ReturnType<typeof makeRepo>;
