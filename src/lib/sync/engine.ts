import type { AppDB, SyncTable } from './../db';
import { deletionWins, mergeRecord } from './merge';
import { SyncError, type Remote, type RemoteRow } from './remote';
import { SYNC_TABLES, fingerprint, fromData, toData, updatedOf } from './serialize';

const PAGE = 500;
const BATCH = 100;
const CURSOR_OVERLAP_MS = 10_000; // re-read a little history each time: merging is idempotent, and it can't miss late commits

export interface SyncReport { pulled: number; pushed: number; deleted: number; at: number }

/**
 * One full sync: pull (and merge) first, then push. Pulling first means what we push already includes other devices' changes.
 * Safe to run repeatedly and safe to interrupt: every step is idempotent and progress is saved as it goes.
 */
export async function syncOnce(db: AppDB, remote: Remote, nowMs = Date.now()): Promise<SyncReport> {
  const uid = await remote.userId();
  await ensureAccount(db, uid);
  let pulled = 0, pushed = 0;
  for (const t of SYNC_TABLES) pulled += await pullTable(db, remote, t);
  for (const t of SYNC_TABLES) pushed += await pushTable(db, remote, t);
  const deleted = await pushTombstones(db, remote);
  await db.meta.put({ key: 'lastSyncAt', value: nowMs });
  return { pulled, pushed, deleted, at: nowMs };
}

/** Number of local changes not yet confirmed in the cloud. */
export async function pendingCount(db: AppDB): Promise<number> {
  const counts = await Promise.all(SYNC_TABLES.map((t) => db.table(t).where('dirty').equals(1).count()));
  return counts.reduce((a, b) => a + b, 0) + (await db.tombstones.count());
}

export async function lastSyncAt(db: AppDB): Promise<number | undefined> {
  return (await db.meta.get('lastSyncAt'))?.value as number | undefined;
}

/** First sync for this account on this device: everything already here needs uploading. A different account is refused. */
async function ensureAccount(db: AppDB, uid: string): Promise<void> {
  const current = (await db.meta.get('userId'))?.value as string | undefined;
  if (current && current !== uid) {
    throw new SyncError('different_account', 'This browser already holds data synced to a different account. Sign back in to that account, or clear this site\'s data to start fresh.');
  }
  if (current) return;
  await db.transaction('rw', [db.decks, db.cards, db.reviews, db.misconceptions, db.memories, db.meta], async () => {
    await db.cards.toCollection().modify((c: any) => { c.schedAt ??= c.fsrs?.last_review ? new Date(c.fsrs.last_review).getTime() : c.createdAt; });
    for (const t of SYNC_TABLES) await db.table(t).toCollection().modify({ dirty: 1 });
    await db.meta.put({ key: 'userId', value: uid });
  });
}

async function pullTable(db: AppDB, remote: Remote, table: SyncTable): Promise<number> {
  const cursor = ((await db.meta.get(`cursor:${table}`))?.value as string | undefined) ?? null;
  let offset = 0, applied = 0, newest = 0;
  for (;;) {
    const rows = await remote.pull(table, cursor, offset, PAGE);
    for (const row of rows) {
      if (await applyRemoteRow(db, table, row)) applied++;
      newest = Math.max(newest, Date.parse(row.server_updated_at) || 0);
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  if (newest) await db.meta.put({ key: `cursor:${table}`, value: new Date(newest - CURSOR_OVERLAP_MS).toISOString() });
  return applied;
}

async function applyRemoteRow(db: AppDB, table: SyncTable, row: RemoteRow): Promise<boolean> {
  const T = db.table(table);
  return db.transaction('rw', T, db.tombstones, async () => {
    const key = `${table}:${row.id}`;
    const local = await T.get(row.id);
    const tomb = await db.tombstones.get(key);

    if (row.deleted_at != null) {
      if (tomb) await db.tombstones.delete(key); // deleted on both sides: converged
      if (!local) return false;
      if (deletionWins(table, local, row.deleted_at)) { await T.delete(row.id); return true; }
      await T.update(row.id, { dirty: 1 }); // changed here after it was deleted elsewhere: keep it and send it back
      return false;
    }

    if (tomb) {
      if (tomb.deletedAt >= row.updated_at) return false; // our deletion is newer: it stays queued and gets sent
      await db.tombstones.delete(key); // the other device changed it after we deleted it: bring it back
    }

    const remoteRec = fromData(table, row.data);
    if (!local) { await T.put({ ...remoteRec, dirty: 0 }); return true; }
    const merged = mergeRecord(table, local, remoteRec);
    const dirty = fingerprint(merged) === fingerprint(remoteRec) ? 0 : 1;
    if (fingerprint(merged) === fingerprint(local) && (local.dirty ?? 0) === dirty) return false;
    await T.put({ ...merged, dirty });
    return true;
  });
}

async function pushTable(db: AppDB, remote: Remote, table: SyncTable): Promise<number> {
  const T = db.table(table);
  let sent = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const batch = await T.where('dirty').equals(1).limit(BATCH).toArray();
    if (!batch.length) break;
    await remote.push(table, batch.map((r: any) => ({ id: r.id, updated_at: updatedOf(table, r), deleted_at: null, data: toData(r) })), table === 'reviews' ? 'ignore' : 'merge');
    let cleared = 0;
    await db.transaction('rw', T, async () => {
      for (const r of batch) {
        const cur = await T.get(r.id);
        // Only mark as synced if it did not change while we were uploading
        if (cur && fingerprint(cur) === fingerprint(r)) { await T.update(r.id, { dirty: 0 }); cleared++; }
      }
    });
    sent += batch.length;
    if (!cleared) break;
  }
  return sent;
}

async function pushTombstones(db: AppDB, remote: Remote): Promise<number> {
  const all = await db.tombstones.toArray();
  for (const table of SYNC_TABLES) {
    const mine = all.filter((t) => t.table === table);
    for (let i = 0; i < mine.length; i += BATCH) {
      const chunk = mine.slice(i, i + BATCH);
      await remote.push(table, chunk.map((t) => ({ id: t.id, updated_at: t.deletedAt, deleted_at: t.deletedAt, data: {} })), 'merge');
      await db.transaction('rw', db.tombstones, async () => {
        for (const t of chunk) {
          const cur = await db.tombstones.get(t.key);
          if (cur && cur.deletedAt === t.deletedAt) await db.tombstones.delete(t.key);
        }
      });
    }
  }
  return all.length;
}
