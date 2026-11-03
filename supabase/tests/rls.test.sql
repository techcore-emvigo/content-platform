-- pgTAP tests for RLS, triggers and constraints. Run with: supabase test db
begin;
select plan(27);

-- Fixtures (as the postgres superuser, which bypasses RLS) ---------------------
-- alice: owner of Org A     bob: member of Org A     carol: owner of Org B
-- Inserting into auth.users fires the trigger that creates each profile.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'bob@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'carol@example.com');

insert into public.organisations (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Org A'),
  ('22222222-[REDACTED_AADHAAR]-222222222222', 'Org B');

insert into public.memberships (org_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'member'),
  ('22222222-[REDACTED_AADHAAR]-222222222222', 'aaaaaaaa-0000-0000-0000-000000000003', 'owner');

insert into public.articles (org_id, author_id, slug, title, status) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'a-pub',   'Alice published', 'published'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'a-draft', 'Alice draft',     'draft'),
  ('22222222-[REDACTED_AADHAAR]-222222222222', 'aaaaaaaa-0000-0000-0000-000000000003', 'b-pub',   'Carol published', 'published'),
  ('22222222-[REDACTED_AADHAAR]-222222222222', 'aaaaaaaa-0000-0000-0000-000000000003', 'b-draft', 'Carol draft',     'draft');

-- Triggers -----------------------------------------------------------------------
select is((select count(*)::int from public.profiles), 3,
  'a profile is created for every new auth user');
select is((select display_name from public.profiles
           where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'alice',
  'display_name defaults to the local part of the email');
select ok((select published_at is not null from public.articles where slug = 'a-pub'),
  'published_at is stamped when an article is created as published');

-- Member (bob) --------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from public.organisations), 1,
  'member sees only their own organisation');
select is((select count(*)::int from public.articles where slug = 'a-draft'), 1,
  'member can read drafts in their own organisation');
select is((select count(*)::int from public.articles where slug = 'b-draft'), 0,
  'member cannot read another organisation''s drafts');
select is((select count(*)::int from public.articles where slug = 'b-pub'), 1,
  'member can read another organisation''s published articles');
select is((select count(*)::int from public.profiles), 2,
  'profiles are visible only for yourself and organisation colleagues');

update public.organisations set name = 'hacked'
  where id = '11111111-1111-1111-1111-111111111111';
select is((select name from public.organisations
           where id = '11111111-1111-1111-1111-111111111111'), 'Org A',
  'plain member cannot rename the organisation');

select throws_ok(
  $$ insert into public.invitations (org_id, email, token_hash, invited_by)
     values ('11111111-1111-1111-1111-111111111111', 'x@example.com', 'h1',
             'aaaaaaaa-0000-0000-0000-000000000002') $$,
  '42501', null, 'plain member cannot create invitations');

select throws_ok(
  $$ insert into public.articles (org_id, author_id, slug, title)
     values ('11111111-1111-1111-1111-111111111111',
             'aaaaaaaa-0000-0000-0000-000000000001', 'spoof', 'Spoof') $$,
  '42501', null, 'author_id cannot be spoofed');

select throws_ok(
  $$ insert into public.articles (org_id, author_id, slug, title)
     values ('22222222-[REDACTED_AADHAAR]-222222222222',
             'aaaaaaaa-0000-0000-0000-000000000002', 'cross', 'Cross-tenant') $$,
  '42501', null, 'cannot write articles in an organisation you do not belong to');

select lives_ok(
  $$ insert into public.articles (org_id, author_id, slug, title)
     values ('11111111-1111-1111-1111-111111111111',
             'aaaaaaaa-0000-0000-0000-000000000002', 'bob-post', 'Bob post') $$,
  'member can create an article in their organisation');

select throws_ok(
  $$ insert into public.articles (org_id, author_id, slug, title)
     values ('11111111-1111-1111-1111-111111111111',
             'aaaaaaaa-0000-0000-0000-000000000002', 'bob-post', 'Duplicate') $$,
  '23505', null, 'slug is unique within an organisation');

select throws_ok(
  $$ insert into public.articles (org_id, author_id, slug, title)
     values ('11111111-1111-1111-1111-111111111111',
             'aaaaaaaa-0000-0000-0000-000000000002', 'Bad Slug', 'Bad') $$,
  '23514', null, 'slug format is enforced');

update public.articles set title = 'defaced' where slug = 'a-pub';
select is((select title from public.articles where slug = 'a-pub'), 'Alice published',
  'member cannot edit someone else''s article');

update public.articles set status = 'published' where slug = 'bob-post';
select ok((select published_at is not null from public.articles where slug = 'bob-post'),
  'publishing your own article stamps published_at');

delete from public.articles where slug = 'a-draft';
select is((select count(*)::int from public.articles where slug = 'a-draft'), 1,
  'member cannot delete someone else''s article');

update public.profiles set display_name = 'Bobby'
  where id = 'aaaaaaaa-0000-0000-0000-000000000002';
update public.profiles set display_name = 'hacked'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select display_name from public.profiles
           where id = 'aaaaaaaa-0000-0000-0000-000000000002'), 'Bobby',
  'you can edit your own profile');
select is((select display_name from public.profiles
           where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'alice',
  'you cannot edit a colleague''s profile');

delete from public.memberships
  where org_id = '11111111-1111-1111-1111-111111111111'
    and user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
select is((select count(*)::int from public.memberships
           where org_id = '11111111-1111-1111-1111-111111111111' and role = 'owner'), 1,
  'owners cannot be removed through the API');

-- Owner (alice) -------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ insert into public.invitations (org_id, email, token_hash, invited_by)
     values ('11111111-1111-1111-1111-111111111111', 'x@example.com', 'h2',
             'aaaaaaaa-0000-0000-0000-000000000001') $$,
  'owner can create invitations');

select is((select count(*)::int from public.invitations), 1,
  'owner can read invitations for their organisation');

delete from public.articles where slug = 'bob-post';
select is((select count(*)::int from public.articles where slug = 'bob-post'), 0,
  'owner can delete any article in their organisation');

-- Anonymous ----------------------------------------------------------------------
reset role;
set local role anon;

select is((select count(*)::int from public.articles), 2,
  'anonymous role reads only published articles');
select is((select count(*)::int from public.profiles), 0,
  'anonymous role cannot read profiles');
select throws_ok(
  $$ select public.create_organisation('anon org') $$,
  '42501', null, 'anonymous role cannot call create_organisation');

select * from finish();
rollback;
