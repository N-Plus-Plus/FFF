-- Preserve the existing trusted refresh contract, but expose enough selected-art
-- state for it to replace older background-first card assets when TVmaze offers
-- a closer panoramic banner.
create or replace function public.admin_list_metadata_refresh_candidates(p_limit integer default 10)
returns table (
  id uuid,
  imdb_id text,
  title text,
  poster_storage_path text,
  poster_source_url text,
  card_art_storage_path text,
  card_art_source_url text,
  card_art_type text,
  card_art_width integer,
  card_art_height integer
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
    s.card_art_storage_path,
    s.card_art_source_url,
    s.card_art_type,
    s.card_art_width,
    s.card_art_height
  from public.shows s
  where s.admin_removed_at is null
    and exists (
      select 1 from public.show_nominations n
      where n.show_id = s.id and n.withdrawn_at is null
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

revoke execute on function public.admin_list_metadata_refresh_candidates(integer) from public, anon, authenticated;
grant execute on function public.admin_list_metadata_refresh_candidates(integer) to service_role;
