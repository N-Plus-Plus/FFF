create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists public.app_users (
  id uuid primary key default extensions.gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) > 0),
  link_token_hash text not null unique,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  token_issued_at timestamptz not null default now(),
  token_revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.app_users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.shows (
  id uuid primary key default extensions.gen_random_uuid(),
  imdb_id text not null,
  normalized_imdb_id text generated always as (lower(btrim(imdb_id))) stored,
  title text not null check (length(btrim(title)) > 0),
  release_year integer,
  title_type text,
  poster_url text,
  disambiguation text,
  metadata jsonb not null default '{}'::jsonb,
  first_enrolled_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  admin_removed_at timestamptz,
  admin_removed_by uuid references public.app_users(id),
  restored_at timestamptz,
  restored_by uuid references public.app_users(id),
  constraint shows_normalized_imdb_id_unique unique (normalized_imdb_id),
  constraint shows_imdb_id_format check (normalized_imdb_id ~ '^tt[0-9]{7,10}$')
);

create table if not exists public.show_nominations (
  user_id uuid not null references public.app_users(id),
  show_id uuid not null references public.shows(id),
  nominated_at timestamptz not null default now(),
  last_activated_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  primary key (user_id, show_id)
);

create table if not exists public.user_show_rankings (
  user_id uuid not null references public.app_users(id),
  show_id uuid not null references public.shows(id),
  rank_position integer check (rank_position is null or rank_position > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, show_id)
);

create unique index if not exists user_show_rankings_rank_position_unique
  on public.user_show_rankings (user_id, rank_position)
  where rank_position is not null;

create table if not exists public.app_revisions (
  singleton boolean primary key default true check (singleton),
  board_revision bigint not null default 1,
  board_updated_at timestamptz not null default now()
);

insert into public.app_revisions (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.app_users enable row level security;
alter table public.shows enable row level security;
alter table public.show_nominations enable row level security;
alter table public.user_show_rankings enable row level security;
alter table public.app_revisions enable row level security;

create or replace function private.hash_link_token(p_raw_token text)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select encode(extensions.digest(coalesce(p_raw_token, ''), 'sha256'), 'hex')
$$;

create or replace function private.generate_link_token()
returns text
language sql
volatile
set search_path = pg_catalog, extensions
as $$
  select rtrim(replace(replace(encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'), '=')
$$;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.bump_board_revision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.app_revisions
  set board_revision = board_revision + 1,
      board_updated_at = now()
  where singleton = true;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger app_users_touch_updated_at
before update on public.app_users
for each row execute function private.touch_updated_at();

create trigger shows_touch_updated_at
before update on public.shows
for each row execute function private.touch_updated_at();

create trigger shows_bump_board_revision
after insert or update of title, release_year, title_type, poster_url, disambiguation, admin_removed_at on public.shows
for each row execute function private.bump_board_revision();

create trigger show_nominations_bump_board_revision
after insert or update of withdrawn_at on public.show_nominations
for each row execute function private.bump_board_revision();

create trigger user_show_rankings_bump_board_revision
after insert or update of rank_position on public.user_show_rankings
for each row execute function private.bump_board_revision();

create or replace function private.require_user(p_link_token text)
returns public.app_users
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_user public.app_users;
begin
  if p_link_token is null or length(btrim(p_link_token)) < 32 then
    raise exception 'Invalid or inactive user link' using errcode = '28000';
  end if;

  select *
  into v_user
  from public.app_users
  where link_token_hash = private.hash_link_token(p_link_token)
    and is_active = true
    and token_revoked_at is null
  limit 1;

  if v_user.id is null then
    raise exception 'Invalid or inactive user link' using errcode = '28000';
  end if;

  return v_user;
end;
$$;

create or replace function private.is_show_active(p_show_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shows s
    where s.id = p_show_id
      and s.admin_removed_at is null
      and exists (
        select 1
        from public.show_nominations n
        where n.show_id = s.id
          and n.withdrawn_at is null
      )
  )
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
    'title_type', p_show.title_type,
    'poster_url', p_show.poster_url,
    'disambiguation', p_show.disambiguation,
    'created_at', p_show.created_at,
    'first_enrolled_by', p_show.first_enrolled_by,
    'is_admin_removed', p_show.admin_removed_at is not null,
    'admin_removed_at', p_show.admin_removed_at,
    'current_user_nominated', exists (
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

create or replace function public.resolve_current_user(p_link_token text)
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
    'id', v_user.id,
    'display_name', v_user.display_name,
    'is_admin', v_user.is_admin
  );
end;
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
    'removed_shows', case
      when v_user.is_admin then coalesce((
        select jsonb_agg(private.show_json(s, v_user.id) order by s.admin_removed_at desc, s.title)
        from public.shows s
        where s.admin_removed_at is not null
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
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
begin
  v_user := private.require_user(p_link_token);
  v_imdb_id := lower(btrim(coalesce(p_imdb_id, '')));

  if v_imdb_id !~ '^tt[0-9]{7,10}$' then
    raise exception 'Enter a valid IMDb title ID' using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Show title is required' using errcode = '22023';
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
      poster_url,
      disambiguation,
      metadata,
      first_enrolled_by
    )
    values (
      v_imdb_id,
      btrim(p_title),
      p_release_year,
      nullif(btrim(coalesce(p_title_type, '')), ''),
      nullif(btrim(coalesce(p_poster_url, '')), ''),
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
        title_type = coalesce(nullif(btrim(coalesce(p_title_type, '')), ''), title_type),
        poster_url = coalesce(nullif(btrim(coalesce(p_poster_url, '')), ''), poster_url),
        disambiguation = coalesce(nullif(btrim(coalesce(p_disambiguation, '')), ''), disambiguation),
        metadata = case when p_metadata is null or p_metadata = '{}'::jsonb then metadata else p_metadata end
    where id = v_show.id
    returning * into v_show;
  end if;

  insert into public.show_nominations (user_id, show_id)
  values (v_user.id, v_show.id)
  on conflict (user_id, show_id) do update
    set last_activated_at = now(),
        withdrawn_at = null;

  insert into public.user_show_rankings (user_id, show_id, rank_position)
  values (v_user.id, v_show.id, null)
  on conflict (user_id, show_id) do nothing;

  return private.show_json(v_show, v_user.id);
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

create or replace function public.admin_set_show_removed(
  p_link_token text,
  p_show_id uuid,
  p_removed boolean
)
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

  if coalesce(p_removed, false) then
    update public.shows
    set admin_removed_at = coalesce(admin_removed_at, now()),
        admin_removed_by = coalesce(admin_removed_by, v_user.id)
    where id = p_show_id
    returning * into v_show;
  else
    update public.shows
    set admin_removed_at = null,
        admin_removed_by = null,
        restored_at = now(),
        restored_by = v_user.id
    where id = p_show_id
    returning * into v_show;
  end if;

  if v_show.id is null then
    raise exception 'Unknown show' using errcode = '22023';
  end if;

  return private.show_json(v_show, v_user.id);
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

  insert into public.user_show_rankings (user_id, show_id, rank_position, updated_at)
  select v_user.id, s.id, null, v_now
  from public.shows s
  where private.is_show_active(s.id)
  on conflict (user_id, show_id) do nothing;

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

create or replace function public.calculate_provisional_board()
returns table (
  show_id uuid,
  imdb_id text,
  title text,
  release_year integer,
  title_type text,
  poster_url text,
  disambiguation text,
  average_rank numeric,
  ranked_count integer,
  unranked_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with active_users as (
    select id from public.app_users where is_active = true
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
      avg(r.rank_position)::numeric as average_rank,
      count(r.rank_position)::integer as ranked_count,
      (select count(*) from active_users)::integer - count(r.rank_position)::integer as unranked_count
    from active_shows s
    left join public.user_show_rankings r
      on r.show_id = s.id
     and r.rank_position is not null
     and exists (select 1 from active_users u where u.id = r.user_id)
    group by s.id
  )
  select
    s.id,
    s.normalized_imdb_id,
    s.title,
    s.release_year,
    s.title_type,
    s.poster_url,
    s.disambiguation,
    ranked.average_rank,
    ranked.ranked_count,
    ranked.unranked_count
  from active_shows s
  join ranked on ranked.show_id = s.id
  order by
    case when ranked.ranked_count = 0 then 1 else 0 end,
    ranked.ranked_count desc,
    ranked.average_rank asc nulls last,
    s.title asc
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
      select jsonb_agg(to_jsonb(b) order by
        case when b.ranked_count = 0 then 1 else 0 end,
        b.ranked_count desc,
        b.average_rank asc nulls last,
        b.title asc)
      from public.calculate_provisional_board() b
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_board_revision(p_link_token text)
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
    'updated_at', (select board_updated_at from public.app_revisions where singleton = true)
  );
end;
$$;

create or replace function public.admin_create_known_user(
  p_display_name text,
  p_is_admin boolean default false,
  p_base_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_token text := private.generate_link_token();
  v_user public.app_users;
  v_fragment text := '?u=' || v_token;
begin
  if length(btrim(coalesce(p_display_name, ''))) = 0 then
    raise exception 'Display name is required' using errcode = '22023';
  end if;

  insert into public.app_users (
    display_name,
    link_token_hash,
    is_admin,
    token_issued_at
  )
  values (
    btrim(p_display_name),
    private.hash_link_token(v_token),
    coalesce(p_is_admin, false),
    now()
  )
  returning * into v_user;

  return jsonb_build_object(
    'user_id', v_user.id,
    'display_name', v_user.display_name,
    'is_admin', v_user.is_admin,
    'token', v_token,
    'url_fragment', v_fragment,
    'complete_url', case
      when nullif(btrim(coalesce(p_base_url, '')), '') is null then null
      else rtrim(btrim(p_base_url), '/') || '/' || v_fragment
    end
  );
end;
$$;

create or replace function public.admin_rotate_user_link(
  p_user_id uuid,
  p_base_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_token text := private.generate_link_token();
  v_user public.app_users;
  v_fragment text := '?u=' || v_token;
begin
  update public.app_users
  set link_token_hash = private.hash_link_token(v_token),
      token_issued_at = now(),
      token_revoked_at = null
  where id = p_user_id
  returning * into v_user;

  if v_user.id is null then
    raise exception 'Unknown user' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'user_id', v_user.id,
    'display_name', v_user.display_name,
    'is_admin', v_user.is_admin,
    'token', v_token,
    'url_fragment', v_fragment,
    'complete_url', case
      when nullif(btrim(coalesce(p_base_url, '')), '') is null then null
      else rtrim(btrim(p_base_url), '/') || '/' || v_fragment
    end
  );
end;
$$;

create or replace function public.admin_revoke_user_link(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.app_users
  set token_revoked_at = now()
  where id = p_user_id;
end;
$$;

revoke all on public.app_users from anon, authenticated;
revoke all on public.shows from anon, authenticated;
revoke all on public.show_nominations from anon, authenticated;
revoke all on public.user_show_rankings from anon, authenticated;
revoke all on public.app_revisions from anon, authenticated;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;
revoke execute on all functions in schema private from public;
revoke execute on all functions in schema private from anon;
revoke execute on all functions in schema private from authenticated;

grant usage on schema public to anon;
grant execute on function public.resolve_current_user(text) to anon;
grant execute on function public.list_catalogue(text) to anon;
grant execute on function public.nominate_imdb_show(text, text, text, integer, text, text, text, jsonb) to anon;
grant execute on function public.withdraw_nomination(text, uuid) to anon;
grant execute on function public.admin_set_show_removed(text, uuid, boolean) to anon;
grant execute on function public.get_user_order(text) to anon;
grant execute on function public.replace_user_ranking(text, uuid[]) to anon;
grant execute on function public.get_board(text) to anon;
grant execute on function public.get_board_revision(text) to anon;

grant execute on function public.admin_create_known_user(text, boolean, text) to service_role;
grant execute on function public.admin_rotate_user_link(uuid, text) to service_role;
grant execute on function public.admin_revoke_user_link(uuid) to service_role;

alter default privileges in schema public revoke execute on functions from public;
