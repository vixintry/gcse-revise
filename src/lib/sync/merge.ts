import type { SyncTable } from '../db';
import { updatedOf } from './serialize';

/**
 * Pure conflict rules. `local` and `remote` are full records; the result is the record both sides should converge on.
 *  - reviews are immutable events: never changed, only added or removed.
 *  - cards: the text (front/back/topic) and the schedule (fsrs/due) are merged separately, each taken from
 *    whichever side changed it last. So an edit on one device and a review on another both survive.
 *  - everything else: the version changed last wins.
 * Ties go to the remote copy, so every device resolves them the same way.
 */
export function mergeRecord(table: SyncTable, local: Record<string, any> | undefined, remote: Record<string, any>): Record<string, any> {
  if (!local) return remote;
  if (table === 'reviews') return local;
  if (table === 'cards') {
    const text = (local.updatedAt ?? 0) > (remote.updatedAt ?? 0) ? local : remote;
    const sched = (local.schedAt ?? 0) > (remote.schedAt ?? 0) ? local : remote;
    return {
      ...remote,
      front: text.front, back: text.back, topic: text.topic, sourceQuote: text.sourceQuote, unverified: text.unverified, updatedAt: text.updatedAt,
      fsrs: sched.fsrs, due: sched.due, schedAt: sched.schedAt,
    };
  }
  return (local.updatedAt ?? 0) > (remote.updatedAt ?? 0) ? local : remote;
}

/**
 * A deletion arrived from another device. It wins unless the record here was changed after the deletion:
 * then we keep it (and send it back) rather than silently throw away newer work.
 */
export function deletionWins(table: SyncTable, local: Record<string, any>, deletedAt: number): boolean {
  if (table === 'reviews') return true;
  return updatedOf(table, local) <= deletedAt;
}
