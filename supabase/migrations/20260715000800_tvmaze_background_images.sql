alter table public.shows
  add column if not exists background_url text;

update public.shows
set background_url = nullif(btrim(coalesce(
      metadata->>'background_url',
      metadata #>> '{upstream,tvmaze_background_url}',
      metadata #>> '{last_refresh,background_url}',
      metadata #>> '{last_refresh,upstream,tvmaze_background_url}',
      ''
    )), '')
where background_url is null;

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
    'total_season_count', p_show.total_season_count,
    'total_episode_count', p_show.total_episode_count,
    'total_runtime_minutes', p_show.total_runtime_minutes,
    'metadata_provider', p_show.metadata_provider,
    'provider_record_id', p_show.provider_record_id,
    'metadata_retrieved_at', p_show.metadata_retrieved_at,
    'poster_storage_path', p_show.poster_storage_path,
    'poster_source_url', p_show.poster_source_url,
    'background_url', p_show.background_url,
    'poster_retrieval_status', p_show.poster_retrieval_status,
    'poster_updated_at', p_show.poster_updated_at,
    'disambiguation', p_show.disambiguation,
    'created_at', p_show.created_at,
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
    )
  )
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
  v_source_provenance jsonb := coalesce(p_metadata->'source_provenance', '{}'::jsonb);
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
      tvdb_record_id,
      tvdb_metadata_retrieved_at,
      metadata_source_provenance,
      metadata_retrieved_at,
      metadata_refresh_attempted_at,
      metadata_refresh_succeeded_at,
      metadata_refresh_status,
      poster_url,
      poster_source_url,
      background_url,
      poster_retrieval_status,
      poster_refresh_status,
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
      nullif(btrim(coalesce(p_metadata->>'tvdb_record_id', '')), ''),
      case when nullif(btrim(coalesce(p_metadata->>'tvdb_record_id', '')), '') is not null then v_now else null end,
      v_source_provenance,
      coalesce(nullif(p_metadata->>'metadata_retrieved_at', '')::timestamptz, v_now),
      v_now,
      v_now,
      'success',
      nullif(btrim(coalesce(p_poster_url, '')), ''),
      nullif(btrim(coalesce(p_metadata->>'poster_source_url', p_poster_url, '')), ''),
      nullif(btrim(coalesce(p_metadata->>'background_url', '')), ''),
      nullif(btrim(coalesce(p_metadata->>'poster_retrieval_status', 'pending')), ''),
      nullif(btrim(coalesce(p_metadata->>'poster_retrieval_status', 'pending')), ''),
      v_now,
      nullif(btrim(coalesce(p_disambiguation, '')), ''),
      jsonb_strip_nulls(coalesce(p_metadata, '{}'::jsonb)),
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
        tvdb_record_id = coalesce(nullif(btrim(coalesce(p_metadata->>'tvdb_record_id', '')), ''), tvdb_record_id),
        tvdb_metadata_retrieved_at = case
          when nullif(btrim(coalesce(p_metadata->>'tvdb_record_id', '')), '') is not null then v_now
          else tvdb_metadata_retrieved_at
        end,
        metadata_source_provenance = case
          when v_source_provenance = '{}'::jsonb then metadata_source_provenance
          else v_source_provenance
        end,
        metadata_retrieved_at = coalesce(nullif(p_metadata->>'metadata_retrieved_at', '')::timestamptz, metadata_retrieved_at),
        metadata_refresh_attempted_at = coalesce(metadata_refresh_attempted_at, v_now),
        metadata_refresh_succeeded_at = coalesce(metadata_refresh_succeeded_at, v_now),
        metadata_refresh_status = coalesce(metadata_refresh_status, 'success'),
        poster_url = coalesce(nullif(btrim(coalesce(p_poster_url, '')), ''), poster_url),
        poster_source_url = coalesce(nullif(btrim(coalesce(p_metadata->>'poster_source_url', p_poster_url, '')), ''), poster_source_url),
        background_url = coalesce(nullif(btrim(coalesce(p_metadata->>'background_url', '')), ''), background_url),
        poster_retrieval_status = case
          when poster_storage_path is null then coalesce(nullif(btrim(coalesce(p_metadata->>'poster_retrieval_status', '')), ''), poster_retrieval_status)
          else poster_retrieval_status
        end,
        poster_refresh_status = coalesce(poster_refresh_status, nullif(btrim(coalesce(p_metadata->>'poster_retrieval_status', '')), '')),
        disambiguation = coalesce(nullif(btrim(coalesce(p_disambiguation, '')), ''), disambiguation),
        metadata = case when p_metadata is null or p_metadata = '{}'::jsonb then metadata else jsonb_strip_nulls(p_metadata) end
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
      background_url = case
        when v_success then coalesce(nullif(btrim(coalesce(p_metadata->>'background_url', '')), ''), background_url)
        else background_url
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

  return private.show_json(v_show, null::uuid);
end;
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
  total_season_count integer,
  total_episode_count integer,
  total_runtime_minutes integer,
  poster_storage_path text,
  poster_retrieval_status text,
  background_url text,
  disambiguation text,
  ranked_count integer,
  ranked_active_user_count integer,
  active_user_count integer,
  unranked_active_user_count integer,
  active_nomination_count integer,
  is_confirmed boolean
)
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_candidates uuid[];
  v_remaining uuid[];
  v_winner uuid;
  v_position bigint := 1;
begin
  select coalesce(array_agg(s.id order by s.created_at, s.id), array[]::uuid[])
  into v_candidates
  from public.shows s
  where s.admin_removed_at is null
    and exists (
      select 1
      from public.show_nominations n
      where n.show_id = s.id
        and n.withdrawn_at is null
    )
    and exists (
      select 1
      from public.user_show_rankings r
      where r.show_id = s.id
        and r.rank_position is not null
    );

  v_remaining := v_candidates;

  while coalesce(array_length(v_remaining, 1), 0) > 0 loop
    v_winner := private.run_irv_election(v_remaining);
    if v_winner is null then
      exit;
    end if;

    return query
    with active_users as (
      select id
      from public.app_users
      where is_active = true
        and token_revoked_at is null
    ),
    show_row as (
      select
        s.*,
        (
          select count(*)::integer
          from public.show_nominations n
          where n.show_id = s.id
            and n.withdrawn_at is null
        ) as active_nomination_count,
        (
          select count(*)::integer
          from public.user_show_rankings r
          join active_users au on au.id = r.user_id
          where r.show_id = s.id
            and r.rank_position is not null
        ) as ranked_active_user_count,
        (select count(*)::integer from active_users) as active_user_count
      from public.shows s
      where s.id = v_winner
    )
    select
      v_position,
      private.board_strategy_id(),
      show_row.id,
      show_row.normalized_imdb_id,
      show_row.title,
      show_row.release_year,
      coalesce(show_row.provider_title_type, show_row.title_type),
      show_row.series_status,
      show_row.total_season_count,
      show_row.total_episode_count,
      show_row.total_runtime_minutes,
      show_row.poster_storage_path,
      show_row.poster_retrieval_status,
      show_row.background_url,
      show_row.disambiguation,
      show_row.ranked_active_user_count,
      show_row.ranked_active_user_count,
      show_row.active_user_count,
      greatest(show_row.active_user_count - show_row.ranked_active_user_count, 0)::integer,
      show_row.active_nomination_count,
      show_row.active_user_count > 0
        and show_row.ranked_active_user_count = show_row.active_user_count
    from show_row;

    v_remaining := array_remove(v_remaining, v_winner);
    v_position := v_position + 1;
  end loop;
end;
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
        'strategy_id', b.strategy_id,
        'show_id', b.show_id,
        'imdb_id', b.imdb_id,
        'title', b.title,
        'release_year', b.release_year,
        'title_type', b.title_type,
        'series_status', b.series_status,
        'total_season_count', b.total_season_count,
        'total_episode_count', b.total_episode_count,
        'total_runtime_minutes', b.total_runtime_minutes,
        'poster_storage_path', b.poster_storage_path,
        'poster_retrieval_status', b.poster_retrieval_status,
        'background_url', b.background_url,
        'disambiguation', b.disambiguation,
        'ranked_count', b.ranked_count,
        'ranked_active_user_count', b.ranked_active_user_count,
        'active_user_count', b.active_user_count,
        'unranked_active_user_count', b.unranked_active_user_count,
        'active_nomination_count', b.active_nomination_count,
        'is_confirmed', b.is_confirmed
      ) order by b.aggregate_position)
      from public.calculate_provisional_board() b
    ), '[]'::jsonb)
  );
end;
$$;

drop trigger if exists shows_bump_board_revision on public.shows;
create trigger shows_bump_board_revision
after insert or update of title, release_year, title_type, provider_title_type, series_status, total_episode_count, total_runtime_minutes, poster_storage_path, poster_retrieval_status, background_url, metadata_refresh_status, metadata_source_provenance, disambiguation, admin_removed_at on public.shows
for each row execute function private.bump_board_revision();

revoke execute on function public.calculate_provisional_board() from public, anon, authenticated;
grant execute on function public.calculate_provisional_board() to service_role;
