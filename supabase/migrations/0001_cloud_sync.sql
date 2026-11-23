-- Retain: cloud sync schema.
-- Run once in Supabase: SQL Editor -> New query -> paste this whole file -> Run.
-- Safe to run again: everything uses "if not exists" / "drop ... if exists".
--
-- Every table has the same shape: one row per record, the record itself in `data` (jsonb).
-- Row Level Security makes every row visible only to the user who owns it.

create or replace function public.retain_touch() returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A device that was behind tries to overwrite newer data: ignore the write, never lose the newer version.
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return old;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['decks', 'cards', 'reviews', 'misconceptions', 'memories'] loop
    execute format($sql$
      create table if not exists public.%1$I (
        user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
        id text not null,
        updated_at bigint not null,
        deleted_at bigint,
        data jsonb not null,
        server_updated_at timestamptz not null default clock_timestamp(),
        primary key (user_id, id),
        constraint %1$s_id_len check (char_length(id) between 1 and 100),
        constraint %1$s_data_size check (pg_column_size(data) < 200000)
      )$sql$, t);

    execute format('create index if not exists %1$s_pull_idx on public.%1$I (user_id, server_updated_at, id)', t);

    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);

    execute format('drop policy if exists %1$s_select_own on public.%1$I', t);
    execute format('drop policy if exists %1$s_insert_own on public.%1$I', t);
    execute format('drop policy if exists %1$s_update_own on public.%1$I', t);
    execute format('drop policy if exists %1$s_delete_own on public.%1$I', t);
    execute format('create policy %1$s_select_own on public.%1$I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy %1$s_insert_own on public.%1$I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy %1$s_update_own on public.%1$I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy %1$s_delete_own on public.%1$I for delete to authenticated using (user_id = (select auth.uid()))', t);

    execute format('drop trigger if exists %1$s_touch on public.%1$I', t);
    execute format('create trigger %1$s_touch before insert or update on public.%1$I for each row execute function public.retain_touch()', t);
  end loop;
end
$$;
