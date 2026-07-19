create or replace function public.admin_list_order_reminder_recipients()
returns table (
  user_id uuid,
  display_name text,
  unranked_show_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with active_shows as (
    select s.id
    from public.shows s
    where s.admin_removed_at is null
      and exists (
        select 1
        from public.show_nominations n
        where n.show_id = s.id
          and n.withdrawn_at is null
      )
  )
  select
    u.id,
    u.display_name,
    count(active_shows.id)::integer as unranked_show_count
  from public.app_users u
  cross join active_shows
  where u.is_active = true
    and u.token_revoked_at is null
    and not exists (
      select 1
      from public.user_show_rankings r
      where r.user_id = u.id
        and r.show_id = active_shows.id
        and r.rank_position is not null
    )
  group by u.id, u.display_name
  having count(active_shows.id) > 0
  order by u.display_name;
$$;

revoke execute on function public.admin_list_order_reminder_recipients() from public, anon, authenticated;
grant execute on function public.admin_list_order_reminder_recipients() to service_role;
