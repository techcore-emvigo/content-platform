-- Row Level Security. Default is deny: a table with RLS enabled and no matching
-- policy returns no rows and rejects writes. Write policies are scoped
-- `to authenticated`; the only `anon` access is reading published articles.

alter table public.organisations enable row level security;
alter table public.profiles      enable row level security;
alter table public.memberships   enable row level security;
alter table public.invitations   enable row level security;
alter table public.articles      enable row level security;

-- organisations --------------------------------------------------------------
-- No INSERT policy: created via public.create_organisation().
-- No DELETE policy: organisation deletion is an operator task.

create policy organisations_select_member
  on public.organisations for select to authenticated
  using ((select private.is_org_member(id)));

create policy organisations_update_admin
  on public.organisations for update to authenticated
  using       ((select private.has_org_role(id, array['owner', 'admin']::public.org_role[])))
  with check  ((select private.has_org_role(id, array['owner', 'admin']::public.org_role[])));

-- profiles -------------------------------------------------------------------
-- Visible to yourself and to people you share an organisation with.
-- No INSERT/DELETE policy: managed by the auth.users trigger and cascade.

create policy profiles_select_self_or_colleague
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.shares_org_with(id)));

create policy profiles_update_self
  on public.profiles for update to authenticated
  using       (id = (select auth.uid()))
  with check  (id = (select auth.uid()));

-- memberships ----------------------------------------------------------------
-- No INSERT policy: rows are added by the invitation-accept flow (service role).
-- Owners cannot be removed through the API, so an organisation is never orphaned.

create policy memberships_select_same_org
  on public.memberships for select to authenticated
  using ((select private.is_org_member(org_id)));

create policy memberships_update_owner
  on public.memberships for update to authenticated
  using       ((select private.has_org_role(org_id, array['owner']::public.org_role[])))
  with check  ((select private.has_org_role(org_id, array['owner']::public.org_role[])));

create policy memberships_delete_self_or_admin
  on public.memberships for delete to authenticated
  using (
    role <> 'owner'
    and (
      user_id = (select auth.uid())
      or (select private.has_org_role(org_id, array['owner', 'admin']::public.org_role[]))
    )
  );

-- invitations ----------------------------------------------------------------
-- Admin-only. The invite-member Edge Function inserts using the caller's JWT, so
-- these policies are the authorisation check; the function does not duplicate it.

create policy invitations_select_admin
  on public.invitations for select to authenticated
  using ((select private.has_org_role(org_id, array['owner', 'admin']::public.org_role[])));

create policy invitations_insert_admin
  on public.invitations for insert to authenticated
  with check (
    invited_by = (select auth.uid())
    and (select private.has_org_role(org_id, array['owner', 'admin']::public.org_role[]))
  );

create policy invitations_delete_admin
  on public.invitations for delete to authenticated
  using ((select private.has_org_role(org_id, array['owner', 'admin']::public.org_role[])));

-- articles -------------------------------------------------------------------
-- Published articles are public. Drafts and archived articles are visible to
-- members of the owning organisation only. Policies are permissive, so a row is
-- readable if either SELECT policy matches.

create policy articles_select_published
  on public.articles for select to anon, authenticated
  using (status = 'published');

create policy articles_select_member
  on public.articles for select to authenticated
  using ((select private.is_org_member(org_id)));

create policy articles_insert_member
  on public.articles for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (select private.is_org_member(org_id))
  );

create policy articles_update_author_or_admin
  on public.articles for update to authenticated
  using (
    author_id = (select auth.uid())
    or (select private.has_org_role(org_id, array['owner', 'admin']::public.org_role[]))
  )
  with check ((select private.is_org_member(org_id)));

create policy articles_delete_author_or_admin
  on public.articles for delete to authenticated
  using (
    author_id = (select auth.uid())
    or (select private.has_org_role(org_id, array['owner', 'admin']::public.org_role[]))
  );
