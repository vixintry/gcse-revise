import Dexie, { type Table } from 'dexie';
import type { Card } from './scheduler/fsrs';

export interface Deck {
  id: string;
  name: string;
  subject: string;
  examBoard: string;
  createdAt: number;
  updatedAt: number;
  /** 1 = changed locally and not yet confirmed in the cloud */
  dirty?: 0 | 1;
}
export interface CardRec {
  id: string;
  deckId: string;
  front: string;
  back: string;
  sourceQuote?: string;
  /** optional topic label, used to group related cards for misconception detection */
  topic?: string;
  /** true when AI generated this card and its source quote could not be verified */
  unverified?: boolean;
  createdAt: number;
  updatedAt: number;
  fsrs: Card;
  /** mirror of fsrs.due in ms, indexed for queries */
  due: number;
  /** when the schedule (fsrs/due) last changed. Card text and schedule merge independently across devices. */
  schedAt?: number;
  dirty?: 0 | 1;
}
export interface ReviewRec {
  /** durable, client-generated id: writing the same id twice is a no-op */
  id: string;
  cardId: string;
  deckId: string;
  sessionId: string;
  /** 1 = first time the card was shown in this session */
  attempt: number;
  rating: 1 | 2 | 3 | 4;
  ts: number;
  /** true when this rating changed the FSRS schedule */
  committed: boolean;
  prevFsrs?: Card;
  dirty?: 0 | 1;
}

export type MisconceptionStatus = 'suspected' | 'confirmed' | 'dismissed' | 'resolved';
export interface Evidence { cardIds: string[]; failed: number; attempts: number; failDays: number; firstSeen: number; lastSeen: number }
export interface Diagnosis { gap: string; explanation: string; question: string; answer: string; createdAt: number }
export interface Misconception {
  /** deterministic: `mc:<deckId>:<normalised topic>` so detection is idempotent */
  id: string;
  deckId: string;
  topic: string;
  status: MisconceptionStatus;
  confidence: 'low' | 'medium' | 'high';
  evidence: Evidence;
  diagnosis?: Diagnosis;
  reopenCount: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  dirty?: 0 | 1;
}
/** Short structured learning facts the tutor may use. Always inspectable, editable and deletable. */
export interface Memory {
  id: string;
  topic: string;
  text: string;
  source: 'auto' | 'user';
  /** user edited the text: automatic updates must not overwrite it */
  userEdited?: boolean;
  createdAt: number;
  updatedAt: number;
  dirty?: 0 | 1;
}

export type SyncTable = 'decks' | 'cards' | 'reviews' | 'misconceptions' | 'memories';
/** A local deletion waiting to be sent to the cloud. */
export interface Tombstone { key: string; table: SyncTable; id: string; deletedAt: number }
export interface MetaRec { key: string; value: unknown }

export class AppDB extends Dexie {
  decks!: Table<Deck, string>;
  cards!: Table<CardRec, string>;
  reviews!: Table<ReviewRec, string>;
  misconceptions!: Table<Misconception, string>;
  memories!: Table<Memory, string>;
  tombstones!: Table<Tombstone, string>;
  meta!: Table<MetaRec, string>;
  constructor(name = 'gcse-revise') {
    super(name);
    this.version(1).stores({
      decks: 'id',
      cards: 'id, deckId, due',
      reviews: 'id, cardId, deckId, ts, sessionId',
    });
    this.version(2).stores({
      decks: 'id',
      cards: 'id, deckId, due',
      reviews: 'id, cardId, deckId, ts, sessionId',
      misconceptions: 'id, deckId, status',
      memories: 'id, topic',
    });
    this.version(3).stores({
      decks: 'id, dirty',
      cards: 'id, deckId, due, dirty',
      reviews: 'id, cardId, deckId, ts, sessionId, dirty',
      misconceptions: 'id, deckId, status, dirty',
      memories: 'id, topic, dirty',
      tombstones: 'key, table',
      meta: 'key',
    }).upgrade((tx) => tx.table('decks').toCollection().modify((d: Deck) => { d.updatedAt ??= d.createdAt; }));
  }
}

let instance: AppDB | null = null;
/** Client-only singleton (IndexedDB does not exist during server rendering). */
export function getDB(): AppDB {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available in this environment');
  return (instance ??= new AppDB());
}
