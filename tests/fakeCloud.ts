import { AppDB, type SyncTable } from '@/lib/db';
import { makeRepo } from '@/lib/repo';
import { SyncError, type PushRow, type Remote, type RemoteRow } from '@/lib/sync/remote';

type Stored = RemoteRow & { user: string };

/** In-memory stand-in for the Supabase tables: per-user rows, a server clock, the stale-write guard and ignore-duplicates. */
export class FakeCloud {
  rows: Stored[] = [];
  clock = Date.parse('2026-11-22T10:00:00Z');
  online = true;
  pushBudget: number | null = null;
  pushes = 0;
  pulls = 0;

  private tick() { this.clock += 1000; return new Date(this.clock).toISOString(); }

  count(user: string, table: SyncTable, opts: { live?: boolean } = {}) {
    return this.rows.filter((r) => r.user === user && (r as any).table === table && (!opts.live || r.deleted_at == null)).length;
  }

  remote(user = 'user-1'): Remote {
    const guard = () => { if (!this.online) throw new SyncError('offline', 'offline', true); };
    return {
      userId: async () => { guard(); return user; },
      pull: async (table, since, offset, limit) => {
        guard(); this.pulls++;
        return this.rows
          .filter((r) => r.user === user && (r as any).table === table && (!since || Date.parse(r.server_updated_at) >= Date.parse(since)))
          .sort((a, b) => a.server_updated_at.localeCompare(b.server_updated_at) || a.id.localeCompare(b.id))
          .slice(offset, offset + limit)
          .map(({ user: _u, ...r }) => JSON.parse(JSON.stringify(r)));
      },
      push: async (table, rows: PushRow[], mode) => {
        guard(); this.pushes++;
        if (this.pushBudget !== null) { if (this.pushBudget <= 0) throw new SyncError('server', 'boom', true); this.pushBudget--; }
        for (const row of rows) {
          const cur = this.rows.find((r) => r.user === user && (r as any).table === table && r.id === row.id);
          if (cur && mode === 'ignore') continue;
          if (cur && row.updated_at < cur.updated_at) continue; // the database's stale-write guard
          const next = { ...JSON.parse(JSON.stringify(row)), server_updated_at: this.tick(), user, table } as any;
          if (cur) Object.assign(cur, next); else this.rows.push(next);
        }
      },
    };
  }
}

let n = 0;
export function device(cloud: FakeCloud, user = 'user-1') {
  const db = new AppDB(`dev-${++n}`);
  return { db, repo: makeRepo(db), remote: cloud.remote(user) };
}
export type Device = ReturnType<typeof device>;
