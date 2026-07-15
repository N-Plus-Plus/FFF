alter table public.shows
  add column if not exists provider_title_type text,
  add column if not exists series_status text,
  add column if not exists total_episode_count integer check (total_episode_count is null or total_episode_count >= 0),
  add column if not exists total_runtime_minutes integer check (total_runtime_minutes is null or total_runtime_minutes >= 0),
  add column if not exists metadata_provider text,
  add column if not exists provider_record_id text,
  add column if not exists metadata_retrieved_at timestamptz,
  add column if not exists poster_storage_path text,
  add column if not exists poster_source_url text,
  add column if not exists poster_retrieval_status text,
  add column if not exists poster_updated_at timestamptz;

update public.shows
set provider_title_type = coalesce(provider_title_type, title_type)
where provider_title_type is null and title_type is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'show-posters',
  'show-posters',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'show_posters_public_read'
  ) then
    create policy show_posters_public_read
      on storage.objects
      for select
      to anon
      using (bucket_id = 'show-posters');
  end if;
end $$;

create table if not exists public.board_revision_public (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.board_revision_public (singleton, revision, updated_at)
select true, board_revision, board_updated_at
from public.app_revisions
where singleton = true
on conflict (singleton) do update
set revision = excluded.revision,
    updated_at = excluded.updated_at;

alter table public.board_revision_public enable row level security;
alter table public.board_revision_public replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'board_revision_public'
      and policyname = 'board_revision_public_read'
  ) then
    create policy board_revision_public_read
      on public.board_revision_public
      for select
      to anon
      using (true);
  end if;
end $$;

grant select on public.board_revision_public to anon;
revoke insert, update, delete on public.board_revision_public from anon, authenticated;

create or replace function private.sync_board_revision_public()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.board_revision_public (singleton, revision, updated_at)
  values (true, new.board_revision, new.board_updated_at)
  on conflict (singleton) do update
  set revision = excluded.revision,
      updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists app_revisions_sync_board_revision_public on public.app_revisions;
create trigger app_revisions_sync_board_revision_public
after insert or update of board_revision, board_updated_at on public.app_revisions
for each row execute function private.sync_board_revision_public();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'board_revision_public'
     ) then
    alter publication supabase_realtime add table public.board_revision_public;
  end if;
end $$;

create or replace function private.board_confirmation_threshold()
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select 4
$$;

create or replace function private.show_json(p_show public.shows, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_show.id,
    'imdb_id', p_show.normalized_imdb_id,
    'title', p_show.title,
    'release_year', p_show.release_year,
    'title_type', coalesce(p_show.provider_title_type, p_show.title_type),
    'series_status', p_show.series_status,
    'total_episode_count', p_show.total_episode_count,
    'total_runtime_minutes', p_show.total_runtime_minutes,
    'metadata_provider', p_show.metadata_provider,
    'provider_record_id', p_show.provider_record_id,
    'metadata_retrieved_at', p_show.metadata_retrieved_at,
    'poster_storage_path', p_show.poster_storage_path,
    'poster_source_url', p_show.poster_source_url,
    'poster_retrieval_status', p_show.poster_retrieval_status,
    'poster_updated_at', p_show.poster_updated_at,
    'disambiguation', p_show.disambiguation,
    'created_at', p_show.created_at,
    'first_enrolled_by', p_show.first_enrolled_by,
    'is_admin_removed', p_show.admin_removed_at is not null,
    'admin_removed_at', p_show.admin_removed_at,
    'admin_removed_by', p_show.admin_removed_by,
    'current_user_is_admin', coalesce((select u.is_admin from public.app_users u where u.id = p_user_id), false),
    'current_user_nominated', exists (
      select 1
      from public.show_nominations n
      where n.show_id = p_show.id
        and n.user_id = p_user_id
        and n.withdrawn_at is null
    ),
    'current_user_may_withdraw', exists (
      select 1
      from public.show_nominations n
      where n.show_id = p_show.id
        and n.user_id = p_user_id
        and n.withdrawn_at is null
    ),
    'active_nomination_count', (
      select count(*)
      from public.show_nominations n
      where n.show_id = p_show.id
        and n.withdrawn_at is null
    ),
    'nominators', coalesce((
      select jsonb_agg(u.display_name order by u.display_name)
      from public.show_nominations n
      join public.app_users u on u.id = n.user_id
      where n.show_id = p_show.id
        and n.withdrawn_at is null
        and u.is_active = true
    ), '[]'::jsonb)
  )
$$;

create or replace function public.list_catalogue(p_link_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
begin
  v_user := private.require_user(p_link_token);

  return jsonb_build_object(
    'current_user', public.resolve_current_user(p_link_token),
    'shows', coalesce((
      select jsonb_agg(private.show_json(s, v_user.id) order by s.created_at, s.title)
      from public.shows s
      where s.admin_removed_at is null
        and exists (
          select 1 from public.show_nominations n
          where n.show_id = s.id and n.withdrawn_at is null
        )
    ), '[]'::jsonb),
    'removed_shows', '[]'::jsonb
  );
end;
$$;

create or replace function public.nominate_imdb_show(
  p_link_token text,
  p_imdb_id text,
  p_title text,
  p_release_year integer default null,
  p_title_type text default null,
  p_poster_url text default null,
  p_disambiguation text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
  v_show public.shows;
  v_imdb_id text;
  v_now timestamptz := now();
  v_already_active boolean := false;
  v_provider_title_type text;
begin
  v_user := private.require_user(p_link_token);
  v_imdb_id := lower(btrim(coalesce(p_imdb_id, '')));
  v_provider_title_type := nullif(btrim(coalesce(p_metadata->>'provider_title_type', p_title_type, '')), '');

  if v_imdb_id !~ '^tt[0-9]{7,10}$' then
    raise exception 'Enter a valid IMDb title ID' using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Show title is required' using errcode = '22023';
  end if;

  if lower(coalesce(v_provider_title_type, '')) in ('tvepisode', 'tv_episode', 'episode') then
    raise exception 'Individual IMDb episodes cannot be nominated as canonical shows' using errcode = '22023';
  end if;

  select *
  into v_show
  from public.shows
  where normalized_imdb_id = v_imdb_id
  limit 1;

  if v_show.id is null then
    insert into public.shows (
      imdb_id,
      title,
      release_year,
      title_type,
      provider_title_type,
      series_status,
      total_episode_count,
      total_runtime_minutes,
      metadata_provider,
      provider_record_id,
      metadata_retrieved_at,
      poster_url,
      poster_source_url,
      poster_retrieval_status,
      poster_updated_at,
      disambiguation,
      metadata,
      first_enrolled_by
    )
    values (
      v_imdb_id,
      btrim(p_title),
      p_release_year,
      v_provider_title_type,
      v_provider_title_type,
      nullif(btrim(coalesce(p_metadata->>'series_status', '')), ''),
      nullif(p_metadata->>'total_episode_count', '')::integer,
      nullif(p_metadata->>'total_runtime_minutes', '')::integer,
      nullif(btrim(coalesce(p_metadata->>'metadata_provider', '')), ''),
      nullif(btrim(coalesce(p_metadata->>'provider_record_id', '')), ''),
      coalesce(nullif(p_metadata->>'metadata_retrieved_at', '')::timestamptz, v_now),
      nullif(btrim(coalesce(p_poster_url, '')), ''),
      nullif(btrim(coalesce(p_metadata->>'poster_source_url', p_poster_url, '')), ''),
      nullif(btrim(coalesce(p_metadata->>'poster_retrieval_status', 'pending')), ''),
      v_now,
      nullif(btrim(coalesce(p_disambiguation, '')), ''),
      coalesce(p_metadata, '{}'::jsonb),
      v_user.id
    )
    returning * into v_show;
  elsif v_show.admin_removed_at is not null then
    raise exception 'This show was removed by the administrator' using errcode = '42501';
  else
    update public.shows
    set title = coalesce(nullif(btrim(p_title), ''), title),
        release_year = coalesce(p_release_year, release_year),
        title_type = coalesce(v_provider_title_type, title_type),
        provider_title_type = coalesce(v_provider_title_type, provider_title_type),
        series_status = coalesce(nullif(btrim(coalesce(p_metadata->>'series_status', '')), ''), series_status),
        total_episode_count = coalesce(nullif(p_metadata->>'total_episode_count', '')::integer, total_episode_count),
        total_runtime_minutes = coalesce(nullif(p_metadata->>'total_runtime_minutes', '')::integer, total_runtime_minutes),
        metadata_provider = coalesce(nullif(btrim(coalesce(p_metadata->>'metadata_provider', '')), ''), metadata_provider),
        provider_record_id = coalesce(nullif(btrim(coalesce(p_metadata->>'provider_record_id', '')), ''), provider_record_id),
        metadata_retrieved_at = coalesce(nullif(p_metadata->>'metadata_retrieved_at', '')::timestamptz, metadata_retrieved_at),
        poster_url = coalesce(nullif(btrim(coalesce(p_poster_url, '')), ''), poster_url),
        poster_source_url = coalesce(nullif(btrim(coalesce(p_metadata->>'poster_source_url', p_poster_url, '')), ''), poster_source_url),
        poster_retrieval_status = case
          when poster_storage_path is null then coalesce(nullif(btrim(coalesce(p_metadata->>'poster_retrieval_status', '')), ''), poster_retrieval_status)
          else poster_retrieval_status
        end,
        disambiguation = coalesce(nullif(btrim(coalesce(p_disambiguation, '')), ''), disambiguation),
        metadata = case when p_metadata is null or p_metadata = '{}'::jsonb then metadata else p_metadata end
    where id = v_show.id
    returning * into v_show;
  end if;

  select exists (
    select 1
    from public.show_nominations n
    where n.user_id = v_user.id
      and n.show_id = v_show.id
      and n.withdrawn_at is null
  )
  into v_already_active;

  if not v_already_active then
    insert into public.show_nominations (user_id, show_id, last_activated_at, withdrawn_at)
    values (v_user.id, v_show.id, v_now, null)
    on conflict (user_id, show_id) do update
      set last_activated_at = excluded.last_activated_at,
          withdrawn_at = null;
  end if;

  return private.show_json(v_show, v_user.id) || jsonb_build_object('already_nominated', v_already_active);
end;
$$;

create or replace function public.withdraw_nomination(p_link_token text, p_show_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
  v_show public.shows;
begin
  v_user := private.require_user(p_link_token);

  update public.show_nominations
  set withdrawn_at = now()
  where user_id = v_user.id
    and show_id = p_show_id
    and withdrawn_at is null;

  select * into v_show from public.shows where id = p_show_id;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, v_user.id);
end;
$$;

create or replace function public.admin_remove_show(p_link_token text, p_show_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
  v_show public.shows;
begin
  v_user := private.require_user(p_link_token);

  if not v_user.is_admin then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  update public.shows
  set admin_removed_at = coalesce(admin_removed_at, now()),
      admin_removed_by = coalesce(admin_removed_by, v_user.id)
  where id = p_show_id
  returning * into v_show;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, v_user.id);
end;
$$;

create or replace function public.admin_restore_show(
  p_show_id uuid default null,
  p_imdb_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_show public.shows;
begin
  update public.shows
  set admin_removed_at = null,
      admin_removed_by = null,
      restored_at = now(),
      restored_by = null
  where (p_show_id is not null and id = p_show_id)
     or (p_imdb_id is not null and normalized_imdb_id = lower(btrim(p_imdb_id)))
  returning * into v_show;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'id', v_show.id,
    'imdb_id', v_show.normalized_imdb_id,
    'title', v_show.title,
    'admin_removed_at', v_show.admin_removed_at,
    'restored_at', v_show.restored_at
  );
end;
$$;

create or replace function public.admin_record_show_poster_result(
  p_show_id uuid,
  p_storage_path text,
  p_source_url text,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_show public.shows;
begin
  update public.shows
  set poster_storage_path = nullif(btrim(coalesce(p_storage_path, '')), ''),
      poster_source_url = coalesce(nullif(btrim(coalesce(p_source_url, '')), ''), poster_source_url),
      poster_retrieval_status = nullif(btrim(coalesce(p_status, '')), ''),
      poster_updated_at = now()
  where id = p_show_id
  returning * into v_show;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, v_show.first_enrolled_by);
end;
$$;

create or replace function public.get_user_order(p_link_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
begin
  v_user := private.require_user(p_link_token);

  return jsonb_build_object(
    'current_user', public.resolve_current_user(p_link_token),
    'ranked', coalesce((
      select jsonb_agg(private.show_json(s, v_user.id) || jsonb_build_object('rank_position', r.rank_position) order by r.rank_position)
      from public.user_show_rankings r
      join public.shows s on s.id = r.show_id
      where r.user_id = v_user.id
        and r.rank_position is not null
        and private.is_show_active(s.id)
    ), '[]'::jsonb),
    'unranked', coalesce((
      select jsonb_agg(private.show_json(s, v_user.id) order by s.created_at, s.title)
      from public.shows s
      where private.is_show_active(s.id)
        and not exists (
          select 1
          from public.user_show_rankings r
          where r.user_id = v_user.id
            and r.show_id = s.id
            and r.rank_position is not null
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.replace_user_ranking(p_link_token text, p_show_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
  v_now timestamptz := now();
  v_requested_count integer;
  v_distinct_count integer;
  v_invalid_count integer;
begin
  v_user := private.require_user(p_link_token);

  if p_show_ids is null then
    p_show_ids := array[]::uuid[];
  end if;

  select count(*), count(distinct show_id)
  into v_requested_count, v_distinct_count
  from unnest(p_show_ids) as requested(show_id);

  if v_requested_count <> v_distinct_count then
    raise exception 'Ranking sequence contains duplicate shows' using errcode = '22023';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(p_show_ids) as requested(show_id)
  where requested.show_id is null
     or not private.is_show_active(requested.show_id);

  if v_invalid_count > 0 then
    raise exception 'Ranking sequence contains inactive or unknown shows' using errcode = '22023';
  end if;

  update public.user_show_rankings
  set rank_position = null,
      updated_at = v_now
  where user_id = v_user.id
    and rank_position is not null;

  insert into public.user_show_rankings (user_id, show_id, rank_position, updated_at)
  select v_user.id, ordered.show_id, ordered.ordinality::integer, v_now
  from unnest(p_show_ids) with ordinality as ordered(show_id, ordinality)
  on conflict (user_id, show_id) do update
    set rank_position = excluded.rank_position,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'revision', (select board_revision from public.app_revisions where singleton = true),
    'updated_at', v_now,
    'order', public.get_user_order(p_link_token)
  );
end;
$$;

drop function if exists public.calculate_provisional_board();

create or replace function public.calculate_provisional_board()
returns table (
  aggregate_position bigint,
  show_id uuid,
  imdb_id text,
  title text,
  release_year integer,
  title_type text,
  series_status text,
  total_episode_count integer,
  total_runtime_minutes integer,
  poster_storage_path text,
  poster_retrieval_status text,
  disambiguation text,
  average_rank numeric,
  provisional_score numeric,
  ranked_count integer,
  unranked_count integer,
  active_nomination_count integer,
  confirmation_threshold integer,
  is_confirmed boolean
)
language sql
stable
security definer
set search_path = public, private
as $$
  with active_users as (
    select id from public.app_users where is_active = true
  ),
  active_shows as (
    select
      s.*,
      (
        select count(*)::integer
        from public.show_nominations n
        where n.show_id = s.id
          and n.withdrawn_at is null
      ) as active_nomination_count
    from public.shows s
    where s.admin_removed_at is null
      and exists (
        select 1
        from public.show_nominations n
        where n.show_id = s.id
          and n.withdrawn_at is null
      )
  ),
  ranked as (
    select
      s.id as show_id,
      avg(r.rank_position)::numeric as average_rank,
      count(r.rank_position)::integer as ranked_count,
      (select count(*) from active_users)::integer - count(r.rank_position)::integer as unranked_count
    from active_shows s
    left join public.user_show_rankings r
      on r.show_id = s.id
     and r.rank_position is not null
     and exists (select 1 from active_users u where u.id = r.user_id)
    group by s.id
  ),
  board as (
    select
      s.id,
      s.normalized_imdb_id,
      s.title,
      s.release_year,
      coalesce(s.provider_title_type, s.title_type) as title_type,
      s.series_status,
      s.total_episode_count,
      s.total_runtime_minutes,
      s.poster_storage_path,
      s.poster_retrieval_status,
      s.disambiguation,
      ranked.average_rank,
      ranked.average_rank as provisional_score,
      ranked.ranked_count,
      ranked.unranked_count,
      s.active_nomination_count,
      private.board_confirmation_threshold() as confirmation_threshold,
      ranked.ranked_count >= private.board_confirmation_threshold() as is_confirmed
    from active_shows s
    join ranked on ranked.show_id = s.id
    where ranked.ranked_count > 0
  )
  select
    row_number() over (order by ranked_count desc, average_rank asc nulls last, title asc) as aggregate_position,
    id,
    normalized_imdb_id,
    title,
    release_year,
    title_type,
    series_status,
    total_episode_count,
    total_runtime_minutes,
    poster_storage_path,
    poster_retrieval_status,
    disambiguation,
    average_rank,
    provisional_score,
    ranked_count,
    unranked_count,
    active_nomination_count,
    confirmation_threshold,
    is_confirmed
  from board
  order by aggregate_position
$$;

create or replace function public.get_board(p_link_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
begin
  v_user := private.require_user(p_link_token);

  return jsonb_build_object(
    'revision', (select board_revision from public.app_revisions where singleton = true),
    'updated_at', (select board_updated_at from public.app_revisions where singleton = true),
    'entries', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.aggregate_position)
      from public.calculate_provisional_board() b
    ), '[]'::jsonb)
  );
end;
$$;

drop trigger if exists shows_bump_board_revision on public.shows;
create trigger shows_bump_board_revision
after insert or update of title, release_year, title_type, provider_title_type, series_status, total_episode_count, total_runtime_minutes, poster_storage_path, poster_retrieval_status, disambiguation, admin_removed_at on public.shows
for each row execute function private.bump_board_revision();

revoke execute on function public.admin_set_show_removed(text, uuid, boolean) from anon;
revoke execute on function public.admin_set_show_removed(text, uuid, boolean) from authenticated;
revoke execute on function public.admin_restore_show(uuid, text) from public;
revoke execute on function public.admin_restore_show(uuid, text) from anon;
revoke execute on function public.admin_restore_show(uuid, text) from authenticated;
revoke execute on function public.admin_record_show_poster_result(uuid, text, text, text) from public;
revoke execute on function public.admin_record_show_poster_result(uuid, text, text, text) from anon;
revoke execute on function public.admin_record_show_poster_result(uuid, text, text, text) from authenticated;
revoke execute on function public.calculate_provisional_board() from public;
revoke execute on function public.calculate_provisional_board() from anon;
revoke execute on function public.calculate_provisional_board() from authenticated;
grant execute on function public.admin_remove_show(text, uuid) to anon;
grant execute on function public.admin_restore_show(uuid, text) to service_role;
grant execute on function public.admin_record_show_poster_result(uuid, text, text, text) to service_role;
