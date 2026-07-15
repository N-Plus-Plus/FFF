alter table public.shows
  add column if not exists tvdb_record_id text,
  add column if not exists tvdb_metadata_retrieved_at timestamptz,
  add column if not exists metadata_source_provenance jsonb not null default '{}'::jsonb,
  add column if not exists metadata_refresh_attempted_at timestamptz,
  add column if not exists metadata_refresh_succeeded_at timestamptz,
  add column if not exists metadata_refresh_status text,
  add column if not exists metadata_refresh_failure_category text,
  add column if not exists poster_refresh_status text;

delete from public.user_show_rankings
where rank_position is null;

create index if not exists shows_metadata_refresh_due_idx
  on public.shows (metadata_refresh_succeeded_at, admin_removed_at)
  where admin_removed_at is null;

create index if not exists app_users_active_access_idx
  on public.app_users (is_active, token_revoked_at)
  where is_active = true and token_revoked_at is null;

create or replace function private.current_active_user_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.app_users
  where is_active = true
    and token_revoked_at is null
$$;

create or replace function private.board_strategy_id()
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select 'mean-explicit-position-v1'
$$;

create or replace function private.imdb_tie_break_key(p_imdb_id text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select substring(lower(btrim(coalesce(p_imdb_id, ''))) from 2)
      || substring(lower(btrim(coalesce(p_imdb_id, ''))) from 1 for 1)
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
        and u.token_revoked_at is null
    ), '[]'::jsonb)
  )
$$;

drop function if exists public.calculate_provisional_board();

create or replace function public.calculate_provisional_board()
returns table (
  aggregate_position bigint,
  strategy_id text,
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
  aggregate_value numeric,
  ranked_count integer,
  ranked_active_user_count integer,
  active_user_count integer,
  unranked_active_user_count integer,
  is_confirmed boolean
)
language sql
stable
security definer
set search_path = public, private
as $$
  with active_users as (
    select id
    from public.app_users
    where is_active = true
      and token_revoked_at is null
  ),
  active_shows as (
    select s.*
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
      avg(r.rank_position)::numeric as aggregate_value,
      count(r.rank_position)::integer as ranked_count,
      count(r.rank_position) filter (where au.id is not null)::integer as ranked_active_user_count,
      private.current_active_user_count() as active_user_count
    from active_shows s
    left join public.user_show_rankings r
      on r.show_id = s.id
     and r.rank_position is not null
    left join active_users au on au.id = r.user_id
    group by s.id
  ),
  board as (
    select
      private.board_strategy_id() as strategy_id,
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
      ranked.aggregate_value,
      ranked.ranked_count,
      ranked.ranked_active_user_count,
      ranked.active_user_count,
      greatest(ranked.active_user_count - ranked.ranked_active_user_count, 0)::integer as unranked_active_user_count,
      ranked.active_user_count > 0
        and ranked.ranked_active_user_count >= ranked.active_user_count as is_confirmed
    from active_shows s
    join ranked on ranked.show_id = s.id
    where ranked.ranked_count > 0
  )
  select
    row_number() over (
      order by aggregate_value asc, private.imdb_tie_break_key(normalized_imdb_id) asc
    ) as aggregate_position,
    strategy_id,
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
    aggregate_value,
    ranked_count,
    ranked_active_user_count,
    active_user_count,
    unranked_active_user_count,
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
      select jsonb_agg(jsonb_build_object(
        'aggregate_position', b.aggregate_position,
        'show_id', b.show_id,
        'imdb_id', b.imdb_id,
        'title', b.title,
        'release_year', b.release_year,
        'title_type', b.title_type,
        'series_status', b.series_status,
        'total_episode_count', b.total_episode_count,
        'total_runtime_minutes', b.total_runtime_minutes,
        'poster_storage_path', b.poster_storage_path,
        'poster_retrieval_status', b.poster_retrieval_status,
        'disambiguation', b.disambiguation,
        'ranked_count', b.ranked_count,
        'ranked_active_user_count', b.ranked_active_user_count,
        'active_user_count', b.active_user_count,
        'unranked_active_user_count', b.unranked_active_user_count,
        'is_confirmed', b.is_confirmed
      ) order by b.aggregate_position)
      from public.calculate_provisional_board() b
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_activate_known_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
begin
  update public.app_users
  set is_active = true
  where id = p_user_id
  returning * into v_user;

  if v_user.id is null then
    raise exception 'Unknown user' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'id', v_user.id,
    'display_name', v_user.display_name,
    'is_active', v_user.is_active,
    'token_revoked_at', v_user.token_revoked_at
  );
end;
$$;

create or replace function public.admin_deactivate_known_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
begin
  update public.app_users
  set is_active = false
  where id = p_user_id
  returning * into v_user;

  if v_user.id is null then
    raise exception 'Unknown user' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'id', v_user.id,
    'display_name', v_user.display_name,
    'is_active', v_user.is_active,
    'token_revoked_at', v_user.token_revoked_at
  );
end;
$$;

create or replace function public.admin_list_metadata_refresh_candidates(p_limit integer default 10)
returns table (
  id uuid,
  imdb_id text,
  title text,
  poster_storage_path text,
  poster_source_url text
)
language sql
security definer
set search_path = public
as $$
  select
    s.id,
    s.normalized_imdb_id,
    s.title,
    s.poster_storage_path,
    s.poster_source_url
  from public.shows s
  where s.admin_removed_at is null
    and (
      s.metadata_refresh_succeeded_at is null
      or s.metadata_refresh_succeeded_at <= now() - interval '7 days'
    )
  order by
    exists (
      select 1
      from public.show_nominations n
      where n.show_id = s.id
        and n.withdrawn_at is null
    ) desc,
    s.metadata_refresh_succeeded_at asc nulls first,
    s.created_at asc
  limit greatest(1, least(coalesce(p_limit, 10), 25))
$$;

create or replace function public.admin_update_show_metadata(
  p_show_id uuid,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_show public.shows;
  v_now timestamptz := now();
  v_status text := nullif(btrim(coalesce(p_metadata->>'metadata_refresh_status', 'success')), '');
  v_success boolean := coalesce(v_status, 'success') = 'success';
  v_runtime_is_estimate boolean := coalesce((p_metadata->>'total_runtime_is_estimate')::boolean, false);
begin
  update public.shows
  set title = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'title', '')), ''), title)
        else title
      end,
      release_year = case
        when v_success then coalesce(nullif(p_metadata->>'release_year', '')::integer, release_year)
        else release_year
      end,
      provider_title_type = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'provider_title_type', '')), ''), provider_title_type)
        else provider_title_type
      end,
      series_status = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'series_status', '')), ''), series_status)
        else series_status
      end,
      total_episode_count = case
        when v_success then coalesce(nullif(p_metadata->>'total_episode_count', '')::integer, total_episode_count)
        else total_episode_count
      end,
      total_runtime_minutes = case
        when v_success and not v_runtime_is_estimate then coalesce(nullif(p_metadata->>'total_runtime_minutes', '')::integer, total_runtime_minutes)
        else total_runtime_minutes
      end,
      metadata_provider = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'metadata_provider', '')), ''), metadata_provider)
        else metadata_provider
      end,
      provider_record_id = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'provider_record_id', '')), ''), provider_record_id)
        else provider_record_id
      end,
      tvdb_record_id = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'tvdb_record_id', '')), ''), tvdb_record_id)
        else tvdb_record_id
      end,
      tvdb_metadata_retrieved_at = case
        when v_success and nullif(btrim(coalesce(p_metadata->>'tvdb_record_id', '')), '') is not null then v_now
        else tvdb_metadata_retrieved_at
      end,
      metadata_retrieved_at = case
        when v_success then coalesce(nullif(p_metadata->>'metadata_retrieved_at', '')::timestamptz, v_now)
        else metadata_retrieved_at
      end,
      poster_source_url = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'poster_source_url', '')), ''), poster_source_url)
        else poster_source_url
      end,
      metadata_source_provenance = case
        when v_success then coalesce(p_metadata->'source_provenance', metadata_source_provenance)
        else metadata_source_provenance
      end,
      metadata = case
        when v_success then jsonb_strip_nulls(metadata || jsonb_build_object('last_refresh', p_metadata))
        else metadata
      end,
      metadata_refresh_attempted_at = v_now,
      metadata_refresh_succeeded_at = case when v_success then v_now else metadata_refresh_succeeded_at end,
      metadata_refresh_status = coalesce(v_status, case when v_success then 'success' else 'failed' end),
      metadata_refresh_failure_category = case
        when v_success then null
        else nullif(btrim(coalesce(p_metadata->>'metadata_refresh_failure_category', 'failed')), '')
      end
  where id = p_show_id
  returning * into v_show;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, v_show.first_enrolled_by);
end;
$$;

drop trigger if exists app_users_bump_board_revision on public.app_users;
create trigger app_users_bump_board_revision
after update of is_active, token_revoked_at on public.app_users
for each row execute function private.bump_board_revision();

drop trigger if exists shows_bump_board_revision on public.shows;
create trigger shows_bump_board_revision
after insert or update of title, release_year, title_type, provider_title_type, series_status, total_episode_count, total_runtime_minutes, poster_storage_path, poster_retrieval_status, metadata_refresh_status, disambiguation, admin_removed_at on public.shows
for each row execute function private.bump_board_revision();

revoke execute on function private.board_confirmation_threshold() from public, anon, authenticated;
revoke execute on function private.current_active_user_count() from public, anon, authenticated;
revoke execute on function private.board_strategy_id() from public, anon, authenticated;
revoke execute on function private.imdb_tie_break_key(text) from public, anon, authenticated;
revoke execute on function public.calculate_provisional_board() from public, anon, authenticated;
revoke execute on function public.admin_activate_known_user(uuid) from public, anon, authenticated;
revoke execute on function public.admin_deactivate_known_user(uuid) from public, anon, authenticated;
revoke execute on function public.admin_list_metadata_refresh_candidates(integer) from public, anon, authenticated;
revoke execute on function public.admin_update_show_metadata(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.admin_activate_known_user(uuid) to service_role;
grant execute on function public.admin_deactivate_known_user(uuid) to service_role;
grant execute on function public.admin_list_metadata_refresh_candidates(integer) to service_role;
grant execute on function public.admin_update_show_metadata(uuid, jsonb) to service_role;

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
  set poster_storage_path = coalesce(nullif(btrim(coalesce(p_storage_path, '')), ''), poster_storage_path),
      poster_source_url = coalesce(nullif(btrim(coalesce(p_source_url, '')), ''), poster_source_url),
      poster_retrieval_status = nullif(btrim(coalesce(p_status, '')), ''),
      poster_refresh_status = nullif(btrim(coalesce(p_status, '')), ''),
      poster_updated_at = now()
  where id = p_show_id
  returning * into v_show;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, v_show.first_enrolled_by);
end;
$$;

revoke execute on function public.admin_record_show_poster_result(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_record_show_poster_result(uuid, text, text, text) to service_role;
