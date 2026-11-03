-- Optional local development data. It is deliberately not named seed.sql, so
-- `supabase start` does not load it and the pgTAP suite runs on an empty database.
--
--   psql "postgresql://postgres:[REDACTED_PASSWORD]@127.0.0.1:54322/postgres" -f supabase/dev-seed.sql
--
-- Users: alice@example.com (owner) and bob@example.com (member), password "password123".

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('password123', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('display_name', u.display_name),
  now(), now(), '', '', '', ''
from (values
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'alice@example.com', 'Alice Example'),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'bob@example.com',   'Bob Example')
) as u(id, email, display_name)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email),
       'email', now(), now(), now()
from auth.users u
where u.email in ('alice@example.com', 'bob@example.com')
  and not exists (select 1 from auth.identities i where i.user_id = u.id);

insert into public.organisations (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Northwind Editorial')
on conflict (id) do nothing;

insert into public.memberships (org_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'member')
on conflict do nothing;

insert into public.articles (org_id, author_id, slug, title, body, status) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'welcome', 'Welcome', 'Our first published article.', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002',
   'editorial-calendar', 'Editorial calendar', 'Draft for the next quarter.', 'draft'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'old-announcement', 'Old announcement', 'Superseded.', 'archived')
on conflict (org_id, slug) do nothing;
