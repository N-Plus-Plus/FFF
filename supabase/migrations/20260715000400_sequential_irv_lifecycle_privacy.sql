create or replace function private.board_strategy_id()
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select 'sequential-irv-v1'
$$;

create or replace function private.imdb_numeric_key(p_imdb_id text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(nullif(regexp_replace(regexp_replace(coalesce(p_imdb_id, ''), '[^0-9]', '', 'g'), '^0+', ''), ''), '0')
$$;

create or replace function private.highest_imdb_candidate(p_show_ids uuid[])
returns uuid
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_duplicate_key text;
  v_show_id uuid;
begin
  select private.imdb_numeric_key(s.normalized_imdb_id)
  into v_duplicate_key
  from public.shows s
  where s.id = any(p_show_ids)
  group by private.imdb_numeric_key(s.normalized_imdb_id)
  having count(*) > 1
  limit 1;

  if v_duplicate_key is not null then
    raise exception 'Duplicate canonical IMDb numeric component in Board tie-break: %', v_duplicate_key
      using errcode = '23505';
  end if;

  select s.id
  into v_show_id
  from public.shows s
  where s.id = any(p_show_ids)
  order by
    length(private.imdb_numeric_key(s.normalized_imdb_id)) desc,
    private.imdb_numeric_key(s.normalized_imdb_id) desc
  limit 1;

  return v_show_id;
end;
$$;

create or replace function private.lowest_imdb_candidate(p_show_ids uuid[])
returns uuid
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_duplicate_key text;
  v_show_id uuid;
begin
  select private.imdb_numeric_key(s.normalized_imdb_id)
  into v_duplicate_key
  from public.shows s
  where s.id = any(p_show_ids)
  group by private.imdb_numeric_key(s.normalized_imdb_id)
  having count(*) > 1
  limit 1;

  if v_duplicate_key is not null then
    raise exception 'Duplicate canonical IMDb numeric component in Board tie-break: %', v_duplicate_key
      using errcode = '23505';
  end if;

  select s.id
  into v_show_id
  from public.shows s
  where s.id = any(p_show_ids)
  order by
    length(private.imdb_numeric_key(s.normalized_imdb_id)) asc,
    private.imdb_numeric_key(s.normalized_imdb_id) asc
  limit 1;

  return v_show_id;
end;
$$;

create or replace function private.run_irv_election(p_candidate_ids uuid[])
returns uuid
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_remaining uuid[] := p_candidate_ids;
  v_remaining_count integer;
  v_non_exhausted_count integer;
  v_winner uuid;
  v_min_votes integer;
  v_elimination_tie uuid[];
begin
  loop
    v_remaining_count := coalesce(array_length(v_remaining, 1), 0);

    if v_remaining_count = 0 then
      return null;
    elsif v_remaining_count = 1 then
      return v_remaining[1];
    end if;

    with first_votes as (
      select distinct on (r.user_id)
        r.user_id,
        r.show_id
      from public.user_show_rankings r
      where r.rank_position is not null
        and r.show_id = any(v_remaining)
      order by r.user_id, r.rank_position
    ),
    vote_counts as (
      select
        candidate.show_id,
        count(first_votes.user_id)::integer as vote_count
      from unnest(v_remaining) as candidate(show_id)
      left join first_votes on first_votes.show_id = candidate.show_id
      group by candidate.show_id
    ),
    totals as (
      select coalesce(sum(vote_count), 0)::integer as non_exhausted_count
      from vote_counts
    )
    select vote_counts.show_id, totals.non_exhausted_count
    into v_winner, v_non_exhausted_count
    from vote_counts
    cross join totals
    where vote_counts.vote_count > totals.non_exhausted_count::numeric / 2
    order by vote_counts.vote_count desc
    limit 1;

    if v_winner is not null then
      return v_winner;
    end if;

    with first_votes as (
      select distinct on (r.user_id)
        r.user_id,
        r.show_id
      from public.user_show_rankings r
      where r.rank_position is not null
        and r.show_id = any(v_remaining)
      order by r.user_id, r.rank_position
    ),
    vote_counts as (
      select
        candidate.show_id,
        count(first_votes.user_id)::integer as vote_count
      from unnest(v_remaining) as candidate(show_id)
      left join first_votes on first_votes.show_id = candidate.show_id
      group by candidate.show_id
    )
    select min(vote_count)
    into v_min_votes
    from vote_counts;

    with first_votes as (
      select distinct on (r.user_id)
        r.user_id,
        r.show_id
      from public.user_show_rankings r
      where r.rank_position is not null
        and r.show_id = any(v_remaining)
      order by r.user_id, r.rank_position
    ),
    vote_counts as (
      select
        candidate.show_id,
        count(first_votes.user_id)::integer as vote_count
      from unnest(v_remaining) as candidate(show_id)
      left join first_votes on first_votes.show_id = candidate.show_id
      group by candidate.show_id
    )
    select array_agg(show_id)
    into v_elimination_tie
    from vote_counts
    where vote_count = v_min_votes;

    if coalesce(array_length(v_elimination_tie, 1), 0) = v_remaining_count then
      return private.highest_imdb_candidate(v_remaining);
    end if;

    v_remaining := array_remove(v_remaining, private.lowest_imdb_candidate(v_elimination_tie));
  end loop;
end;
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

create or replace function public.withdraw_nomination(p_link_token text, p_show_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
  v_show public.shows;
  v_ranked_ids uuid[];
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

  select coalesce(array_agg(r.show_id order by r.rank_position), array[]::uuid[])
  into v_ranked_ids
  from public.user_show_rankings r
  where r.user_id = v_user.id
    and r.rank_position is not null
    and r.show_id <> p_show_id;

  delete from public.user_show_rankings
  where user_id = v_user.id
    and show_id = p_show_id;

  update public.user_show_rankings
  set rank_position = null
  where user_id = v_user.id
    and rank_position is not null;

  insert into public.user_show_rankings (user_id, show_id, rank_position, updated_at)
  select v_user.id, ordered.show_id, ordered.ordinality::integer, now()
  from unnest(v_ranked_ids) with ordinality as ordered(show_id, ordinality)
  on conflict (user_id, show_id) do update
    set rank_position = excluded.rank_position,
        updated_at = excluded.updated_at;

  if not exists (
    select 1
    from public.show_nominations n
    where n.show_id = p_show_id
      and n.withdrawn_at is null
  ) then
    delete from public.user_show_rankings
    where show_id = p_show_id;
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

  update public.show_nominations
  set withdrawn_at = coalesce(withdrawn_at, now())
  where show_id = v_show.id;

  delete from public.user_show_rankings
  where show_id = v_show.id;

  return jsonb_build_object(
    'id', v_show.id,
    'imdb_id', v_show.normalized_imdb_id,
    'title', v_show.title,
    'admin_removed_at', v_show.admin_removed_at,
    'restored_at', v_show.restored_at
  );
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
  total_episode_count integer,
  total_runtime_minutes integer,
  poster_storage_path text,
  poster_retrieval_status text,
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
      show_row.total_episode_count,
      show_row.total_runtime_minutes,
      show_row.poster_storage_path,
      show_row.poster_retrieval_status,
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
        'total_episode_count', b.total_episode_count,
        'total_runtime_minutes', b.total_runtime_minutes,
        'poster_storage_path', b.poster_storage_path,
        'poster_retrieval_status', b.poster_retrieval_status,
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
    and exists (
      select 1
      from public.show_nominations n
      where n.show_id = s.id
        and n.withdrawn_at is null
    )
    and (
      s.metadata_refresh_succeeded_at is null
      or s.metadata_refresh_succeeded_at <= now() - interval '7 days'
    )
  order by
    s.metadata_refresh_succeeded_at asc nulls first,
    s.created_at asc
  limit greatest(1, least(coalesce(p_limit, 10), 25))
$$;

update public.shows
set tvdb_record_id = coalesce(
      tvdb_record_id,
      nullif(btrim(metadata->>'tvdb_record_id'), ''),
      nullif(btrim(metadata #>> '{tvdb,tvdb_id}'), ''),
      nullif(btrim(metadata #>> '{tvdb,id}'), '')
    ),
    metadata_source_provenance = case
      when metadata_source_provenance = '{}'::jsonb
        and metadata ? 'source_provenance'
      then metadata->'source_provenance'
      else metadata_source_provenance
    end
where tvdb_record_id is null
   or metadata_source_provenance = '{}'::jsonb;

drop trigger if exists shows_bump_board_revision on public.shows;
create trigger shows_bump_board_revision
after insert or update of title, release_year, title_type, provider_title_type, series_status, total_episode_count, total_runtime_minutes, poster_storage_path, poster_retrieval_status, metadata_refresh_status, metadata_source_provenance, disambiguation, admin_removed_at on public.shows
for each row execute function private.bump_board_revision();

revoke execute on function private.imdb_numeric_key(text) from public, anon, authenticated;
revoke execute on function private.highest_imdb_candidate(uuid[]) from public, anon, authenticated;
revoke execute on function private.lowest_imdb_candidate(uuid[]) from public, anon, authenticated;
revoke execute on function private.run_irv_election(uuid[]) from public, anon, authenticated;
revoke execute on function public.calculate_provisional_board() from public, anon, authenticated;
