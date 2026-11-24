import type { SyncTable } from '../db';

export const SYNC_TABLES: SyncTable[] = ['decks', 'cards', 'reviews', 'misconceptions', 'memories'];

/** Stable stringify (sorted keys): Postgres jsonb reorders keys, so plain JSON.stringify can't be compared. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/** The record as it is stored in the cloud: plain JSON (Dates become ISO strings), without local-only flags. */
export function toData(rec: Record<string, any>): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(rec));
  delete clone.dirty;
  return clone;
}

export const fingerprint = (rec: Record<string, any>): string => canon(toData(rec));

function reviveCard(c: any): void {
  if (!c) return;
  c.due = new Date(c.due);
  if (c.last_review != null) c.last_review = new Date(c.last_review);
}

/** Turn cloud JSON back into a local record (FSRS cards need real Date objects again). */
export function fromData(table: SyncTable, data: Record<string, any>): Record<string, any> {
  const rec = JSON.parse(JSON.stringify(data));
  if (table === 'cards') reviveCard(rec.fsrs);
  if (table === 'reviews') reviveCard(rec.prevFsrs);
  return rec;
}

/** The single "last changed" number stored in the cloud's updated_at column. */
export function updatedOf(table: SyncTable, rec: Record<string, any>): number {
  if (table === 'reviews') return rec.ts ?? 0;
  if (table === 'cards') return Math.max(rec.updatedAt ?? 0, rec.schedAt ?? 0);
  return rec.updatedAt ?? 0;
}
