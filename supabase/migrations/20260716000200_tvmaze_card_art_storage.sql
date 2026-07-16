alter table public.shows
  add column if not exists card_art_storage_path text,
  add column if not exists card_art_source_url text,
  add column if not exists card_art_type text check (card_art_type is null or card_art_type in ('background', 'banner', 'poster', 'placeholder')),
  add column if not exists card_art_width integer check (card_art_width is null or card_art_width >= 0),
  add column if not exists card_art_height integer check (card_art_height is null or card_art_height >= 0),
  add column if not exists card_art_retrieval_status text,
  add column if not exists card_art_updated_at timestamptz;

update public.shows
set card_art_source_url = coalesce(card_art_source_url, metadata->>'card_art_url', metadata->>'background_url', background_url, poster_source_url),
    card_art_type = coalesce(card_art_type, nullif(metadata->>'card_art_type', ''), case when background_url is not null then 'background' when poster_source_url is not null then 'poster' else null end),
    card_art_width = coalesce(card_art_width, nullif(metadata->>'card_art_width', '')::integer, nullif(metadata->>'background_width', '')::integer),
    card_art_height = coalesce(card_art_height, nullif(metadata->>'card_art_height', '')::integer, nullif(metadata->>'background_height', '')::integer)
where card_art_source_url is null
   or card_art_type is null;

create or replace function public.admin_record_show_card_art_result(
  p_show_id uuid,
  p_storage_path text,
  p_source_url text,
  p_art_type text,
  p_status text,
  p_width integer default null,
  p_height integer default null
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
  set card_art_storage_path = nullif(btrim(coalesce(p_storage_path, '')), ''),
      card_art_source_url = nullif(btrim(coalesce(p_source_url, '')), ''),
      card_art_type = nullif(btrim(coalesce(p_art_type, '')), ''),
      card_art_width = coalesce(p_width, card_art_width),
      card_art_height = coalesce(p_height, card_art_height),
      card_art_retrieval_status = nullif(btrim(coalesce(p_status, '')), ''),
      card_art_updated_at = now()
  where id = p_show_id
  returning * into v_show;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, null::uuid);
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
    'end_year', p_show.end_year,
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
    'card_art_storage_path', p_show.card_art_storage_path,
    'card_art_source_url', p_show.card_art_source_url,
    'card_art_type', p_show.card_art_type,
    'card_art_width', p_show.card_art_width,
    'card_art_height', p_show.card_art_height,
    'card_art_retrieval_status', p_show.card_art_retrieval_status,
    'card_art_updated_at', p_show.card_art_updated_at,
    'poster_retrieval_status', p_show.poster_retrieval_status,
    'poster_updated_at', p_show.poster_updated_at,
    'disambiguation', p_show.disambiguation,
    'created_at', p_show.created_at,
    'is_admin_removed', p_show.admin_removed_at is not null,
    'admin_removed_at', p_show.admin_removed_at,
    'admin_removed_by', p_show.admin_removed_by,
    'current_user_is_admin', coalesce((select u.is_admin from public.app_users u where u.id = p_user_id), false),
    'current_user_nominated', exists (
      select 1 from public.show_nominations n
      where n.show_id = p_show.id and n.user_id = p_user_id and n.withdrawn_at is null
    ),
    'current_user_may_withdraw', exists (
      select 1 from public.show_nominations n
      where n.show_id = p_show.id and n.user_id = p_user_id and n.withdrawn_at is null
    ),
    'active_nomination_count', (
      select count(*) from public.show_nominations n
      where n.show_id = p_show.id and n.withdrawn_at is null
    )
  )
$$;

drop function if exists public.admin_list_metadata_refresh_candidates(integer);

create or replace function public.admin_list_metadata_refresh_candidates(p_limit integer default 10)
returns table (
  id uuid,
  imdb_id text,
  title text,
  poster_storage_path text,
  poster_source_url text,
  card_art_storage_path text
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
    s.poster_source_url,
    s.card_art_storage_path
  from public.shows s
  where s.admin_removed_at is null
    and exists (
      select 1
      from public.show_nominations n
      where n.show_id = s.id
        and n.withdrawn_at is null
    )
    and (
      s.card_art_storage_path is null
      or s.metadata_refresh_succeeded_at is null
      or s.metadata_refresh_succeeded_at <= now() - interval '7 days'
    )
  order by
    case when s.card_art_storage_path is null then 0 else 1 end,
    s.metadata_refresh_succeeded_at asc nulls first,
    s.created_at asc
  limit greatest(1, least(coalesce(p_limit, 10), 25))
$$;

grant execute on function public.admin_record_show_card_art_result(uuid, text, text, text, text, integer, integer) to service_role;

drop trigger if exists shows_bump_board_revision on public.shows;
create trigger shows_bump_board_revision
after insert or update of title, release_year, end_year, title_type, provider_title_type, series_status, total_season_count, total_episode_count, total_runtime_minutes, poster_storage_path, poster_retrieval_status, card_art_storage_path, card_art_type, card_art_retrieval_status, background_url, metadata_refresh_status, metadata_source_provenance, disambiguation, admin_removed_at on public.shows
for each row execute function private.bump_board_revision();
