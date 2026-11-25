import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Runs the real Supabase migration on a real Postgres engine (PGlite) and checks the security rules.
 * Supabase already provides auth.users, auth.uid() and the anon/authenticated roles; small stand-ins are created here.
 */
const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/0001_cloud_sync.sql'), 'utf8');
const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002';
const UPSERT = 'on conflict (user_id, id) do update set updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, data = excluded.data';
let db: PGlite;

const as = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${who}',false)`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const fails = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch { return true; } };
const front = async (who: string, id = 'c1') => (await as(who, () => db.query<{ data: any }>(`select data from public.cards where id='${id}'`))).rows[0]?.data?.front;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  await db.exec(migration);
  await as(A, () => db.exec(`insert into public.cards (id, updated_at, data) values ('c1', 100, '{"front":"a"}')`));
  await as(B, () => db.exec(`insert into public.cards (id, updated_at, data) values ('c1', 100, '{"front":"b"}')`));
}, 60_000);

describe('cloud schema', () => {
  it('can be run twice', async () => { await db.exec(migration); });
  it('creates all five tables with row level security on', async () => {
    const r = await db.query<{ tablename: string; rowsecurity: boolean }>(`select tablename, rowsecurity from pg_tables where schemaname='public' order by 1`);
    expect(r.rows.map((x) => x.tablename)).toEqual(['cards', 'decks', 'memories', 'misconceptions', 'reviews']);
    expect(r.rows.every((x) => x.rowsecurity)).toBe(true);
  });
  it('lets two users use the same record id without seeing each other', async () => {
    expect(await front(A)).toBe('a');
    expect(await front(B)).toBe('b');
    expect((await as(A, () => db.query('select 1 from public.cards'))).rows).toHaveLength(1);
  });
  it('stops a user writing, editing, moving or deleting another user\'s rows', async () => {
    expect(await fails(() => as(A, () => db.exec(`insert into public.cards (user_id, id, updated_at, data) values ('${B}', 'x', 1, '{}')`)))).toBe(true);
    await as(A, () => db.exec(`update public.cards set data='{"front":"hacked"}' where id='c1'`));
    expect(await front(B)).toBe('b');
    expect(await fails(() => as(A, () => db.exec(`update public.cards set user_id='${B}' where id='c1'`)))).toBe(true);
    await as(A, () => db.exec(`delete from public.cards where user_id='${B}'`));
    expect(await front(B)).toBe('b');
  });
  it('refuses signed-out (anon) access', async () => {
    expect(await fails(async () => { await db.exec('set role anon'); try { await db.query('select * from public.cards'); } finally { await db.exec('reset role'); } })).toBe(true);
  });
  it('ignores a stale write from a device that was behind, but accepts a newer or equal one', async () => {
    await as(A, () => db.exec(`insert into public.cards (id, updated_at, data) values ('c1', 200, '{"front":"newer"}') ${UPSERT}`));
    await as(A, () => db.exec(`insert into public.cards (id, updated_at, data) values ('c1', 150, '{"front":"STALE"}') ${UPSERT}`));
    expect(await front(A)).toBe('newer');
    await as(A, () => db.exec(`insert into public.cards (id, updated_at, data) values ('c1', 200, '{"front":"same-time"}') ${UPSERT}`));
    expect(await front(A)).toBe('same-time');
  });
  it('keeps the original when a review is uploaded twice', async () => {
    await as(A, () => db.exec(`insert into public.reviews (id, updated_at, data) values ('r1', 5, '{"v":1}')`));
    await as(A, () => db.exec(`insert into public.reviews (id, updated_at, data) values ('r1', 9, '{"v":2}') on conflict (user_id, id) do nothing`));
    expect((await as(A, () => db.query<{ data: any }>(`select data from public.reviews where id='r1'`))).rows[0].data.v).toBe(1);
  });
  it('supports soft deletes', async () => {
    await as(A, () => db.exec(`update public.cards set deleted_at = 300, updated_at = 300 where id='c1'`));
    expect(Number((await as(A, () => db.query<{ deleted_at: string }>(`select deleted_at from public.cards where id='c1'`))).rows[0].deleted_at)).toBe(300);
  });
  it('moves the server timestamp forward on every real update', async () => {
    await as(A, () => db.exec(`insert into public.decks (id, updated_at, data) values ('d1', 1, '{}')`));
    const get = async () => new Date((await as(A, () => db.query<{ s: string }>(`select server_updated_at s from public.decks where id='d1'`))).rows[0].s).getTime();
    const t1 = await get();
    await new Promise((r) => setTimeout(r, 15));
    await as(A, () => db.exec(`update public.decks set updated_at = 2 where id='d1'`));
    expect(await get()).toBeGreaterThan(t1);
  });
  it('rejects empty ids and oversized records', async () => {
    expect(await fails(() => as(A, () => db.exec(`insert into public.decks (id, updated_at, data) values ('', 1, '{}')`)))).toBe(true);
    expect(await fails(() => as(A, () => db.exec(`insert into public.decks (id, updated_at, data) values ('big', 1, '${JSON.stringify({ x: 'y'.repeat(250000) })}')`)))).toBe(true);
  });
});
