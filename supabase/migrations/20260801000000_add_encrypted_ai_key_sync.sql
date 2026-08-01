alter table public.vine_sync_documents
drop constraint if exists vine_sync_documents_kind_check;

alter table public.vine_sync_documents
add constraint vine_sync_documents_kind_check check (
  kind in ('price_cache', 'saved_searches', 'keyword_lists', 'ai_keys')
);

comment on table public.vine_sync_documents is
  'Per-user Amazon Vine cache, saved-search, keyword, and encrypted AI-key sync documents.';

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

  if p_kind not in ('price_cache', 'saved_searches', 'keyword_lists', 'ai_keys') then
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
