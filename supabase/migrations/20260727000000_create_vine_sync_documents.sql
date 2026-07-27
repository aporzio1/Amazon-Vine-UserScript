create table if not exists public.vine_sync_documents (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (
    kind in ('price_cache', 'saved_searches', 'keyword_lists')
  ),
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object'
  ),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

comment on table public.vine_sync_documents is
  'Per-user Amazon Vine cache, saved-search, and keyword sync documents.';

alter table public.vine_sync_documents enable row level security;

revoke all on table public.vine_sync_documents from anon;
grant select, insert, update on table public.vine_sync_documents
  to authenticated;

create policy "Users can read their own Vine sync documents"
on public.vine_sync_documents
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (select auth.uid()) = user_id
);

create policy "Users can create their own Vine sync documents"
on public.vine_sync_documents
for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and (select auth.uid()) = user_id
);

create policy "Users can update their own Vine sync documents"
on public.vine_sync_documents
for update
to authenticated
using (
  (select auth.uid()) is not null
  and (select auth.uid()) = user_id
)
with check (
  (select auth.uid()) is not null
  and (select auth.uid()) = user_id
);

create or replace function public.replace_vine_sync_document(
  p_kind text,
  p_payload jsonb,
  p_expected_revision bigint
)
returns table (applied boolean, revision bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_revision bigint;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_kind not in ('price_cache', 'saved_searches', 'keyword_lists') then
    raise exception 'Unsupported sync document kind';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Sync payload must be a JSON object';
  end if;

  if p_expected_revision = 0 then
    insert into public.vine_sync_documents as document (
      user_id,
      kind,
      payload
    )
    values (
      v_user_id,
      p_kind,
      p_payload
    )
    on conflict (user_id, kind) do nothing
    returning document.revision into v_revision;
  else
    update public.vine_sync_documents as document
    set
      payload = p_payload,
      revision = document.revision + 1,
      updated_at = now()
    where document.user_id = v_user_id
      and document.kind = p_kind
      and document.revision = p_expected_revision
    returning document.revision into v_revision;
  end if;

  return query
  select
    v_revision is not null,
    coalesce(
      v_revision,
      (
        select document.revision
        from public.vine_sync_documents as document
        where document.user_id = v_user_id
          and document.kind = p_kind
      )
    );
end;
$$;

revoke all on function public.replace_vine_sync_document(
  text,
  jsonb,
  bigint
) from public;

grant execute on function public.replace_vine_sync_document(
  text,
  jsonb,
  bigint
) to authenticated;
