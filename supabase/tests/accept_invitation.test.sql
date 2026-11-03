-- pgTAP tests for public.accept_invitation. Run with: supabase test db
begin;
select plan(9);

-- Fixtures: alice owns Org A and invited dave (valid), erin (expired) and
-- frank (valid). dave and erin exist as users; mallory is an unrelated user.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'dave@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'erin@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'mallory@example.com');

insert into public.organisations (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Org A');

insert into public.memberships (org_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner');

insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at) values
  ('11111111-1111-1111-1111-111111111111', 'dave@example.com', 'admin',  'hash-dave',
   'aaaaaaaa-0000-0000-0000-000000000001', now() + interval '1 day'),
  ('11111111-1111-1111-1111-111111111111', 'erin@example.com', 'member', 'hash-erin',
   'aaaaaaaa-0000-0000-0000-000000000001', now() - interval '1 day');

-- Wrong recipient ------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000006","role":"authenticated","email":"mallory@example.com"}', true);
set local role authenticated;

select throws_ok($$ select public.accept_invitation('hash-dave') $$,
  'P0002', 'invalid or expired invitation',
  'a token issued to someone else cannot be used');

select throws_ok($$ select public.accept_invitation('no-such-hash') $$,
  'P0002', 'invalid or expired invitation',
  'an unknown token is rejected with the same error');

-- Expired --------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000005","role":"authenticated","email":"erin@example.com"}', true);
set local role authenticated;

select throws_ok($$ select public.accept_invitation('hash-erin') $$,
  'P0002', 'invalid or expired invitation',
  'an expired invitation is rejected');

-- Happy path -----------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000004","role":"authenticated","email":"Dave@Example.com"}', true);
set local role authenticated;

select is((select role::text from public.accept_invitation('hash-dave')), 'admin',
  'the intended recipient joins with the invited role (email match is case-insensitive)');

select is((select count(*)::int from public.memberships
           where user_id = 'aaaaaaaa-0000-0000-0000-000000000004'), 1,
  'the new membership is visible to the new member');

reset role;
select ok((select accepted_at is not null from public.invitations where token_hash = 'hash-dave'),
  'the invitation is marked accepted');

-- Single use -----------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000004","role":"authenticated","email":"dave@example.com"}', true);
set local role authenticated;

select throws_ok($$ select public.accept_invitation('hash-dave') $$,
  'P0002', 'invalid or expired invitation',
  'an invitation cannot be accepted twice');

-- Anonymous ------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$ select public.accept_invitation('hash-dave') $$,
  '42501', null, 'anonymous role cannot call accept_invitation');

reset role;
select is((select count(*)::int from public.memberships
           where org_id = '11111111-1111-1111-1111-111111111111'), 2,
  'only the one legitimate acceptance created a membership');

select * from finish();
rollback;
