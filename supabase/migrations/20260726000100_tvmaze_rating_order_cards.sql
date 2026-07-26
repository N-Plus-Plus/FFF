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
    'tvmaze_rating', coalesce(
      nullif(p_show.metadata->>'tvmaze_rating', '')::numeric,
      nullif(p_show.metadata->'last_refresh'->>'tvmaze_rating', '')::numeric,
      nullif(p_show.metadata->'upstream'->'tvmaze'->'rating'->>'average', '')::numeric,
      nullif(p_show.metadata->'last_refresh'->'upstream'->'primary'->'tvmaze'->'rating'->>'average', '')::numeric
    ),
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
