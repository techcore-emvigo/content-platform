-- Core schema: organisations, memberships, invitations, profiles, articles.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.org_role as enum ('owner', 'admin', 'member');
create type public.article_status as enum ('draft', 'published', 'archived');

-- Tables ---------------------------------------------------------------------

create table public.organisations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

-- One profile per auth user, created by trigger below.
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.memberships (
  org_id     uuid not null references public.organisations (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations (id) on delete cascade,
  email       text not null check (email = lower(email)),
  role        public.org_role not null default 'member' check (role <> 'owner'),
  token_hash  text not null unique,           -- SHA-256 of the emailed token; the token itself is never stored
  invited_by  uuid not null references public.profiles (id),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
-- One open invitation per (org, email).
create unique index invitations_open_email_idx
  on public.invitations (org_id, email) where accepted_at is null;

create table public.articles (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations (id) on delete cascade,
  author_id    uuid not null references public.profiles (id),
  slug         text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 120),
  title        text not null check (char_length(title) between 1 and 200),
  body         text not null default '',
  status       public.article_status not null default 'draft',
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, slug)
);
-- Backs the keyset-paginated list: (org, status) filter, newest first.
create index articles_org_status_created_idx
  on public.articles (org_id, status, created_at desc, id desc);
create index articles_author_id_idx on public.articles (author_id);

-- Triggers -------------------------------------------------------------------

create function private.touch_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

-- Stamps published_at on first publish and freezes ownership columns.
create function private.articles_before_write()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.author_id <> old.author_id then
      raise exception 'org_id and author_id are immutable'
        using errcode = 'integrity_constraint_violation';
    end if;
    new.updated_at := now();
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end;
$$;

create trigger articles_before_write
  before insert or update on public.articles
  for each row execute function private.articles_before_write();

create function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Policy helpers -------------------------------------------------------------
-- SECURITY DEFINER so policies on `memberships` can consult `memberships`
-- without recursing into their own RLS. search_path is pinned to '' and every
-- reference is schema-qualified.

create function private.is_org_member(_org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = _org and m.user_id = (select auth.uid())
  );
$$;

create function private.has_org_role(_org uuid, _roles public.org_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = _org
      and m.user_id = (select auth.uid())
      and m.role = any (_roles)
  );
$$;

-- True when the caller and `_user` belong to at least one common organisation.
create function private.shares_org_with(_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = _user
  );
$$;

revoke execute on function private.is_org_member(uuid) from public, anon;
revoke execute on function private.has_org_role(uuid, public.org_role[]) from public, anon;
revoke execute on function private.shares_org_with(uuid) from public, anon;
grant  execute on function private.is_org_member(uuid) to authenticated;
grant  execute on function private.has_org_role(uuid, public.org_role[]) to authenticated;
grant  execute on function private.shares_org_with(uuid) to authenticated;

-- RPC: create an organisation and make the caller its owner atomically.
-- Clients have no INSERT policy on organisations/memberships, so this is the
-- only way in.

create function public.create_organisation(_name text)
returns public.organisations
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := (select auth.uid());
  _org public.organisations;
begin
  if _uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.organisations (name) values (_name) returning * into _org;
  insert into public.memberships (org_id, user_id, role) values (_org.id, _uid, 'owner');
  return _org;
end;
$$;

revoke execute on function public.create_organisation(text) from public, anon;
grant  execute on function public.create_organisation(text) to authenticated;
