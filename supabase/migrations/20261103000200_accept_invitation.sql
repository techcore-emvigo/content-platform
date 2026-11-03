-- Accepting an invitation. This is the only path that creates memberships for
-- non-owners, since clients have no INSERT policy on `memberships`.
--
-- SECURITY DEFINER lets it write `memberships` and `invitations` on the caller's
-- behalf, but it is bound to the caller's identity: the invitation must have been
-- issued to the email in the caller's JWT. The Edge Function calls it with the
-- caller's JWT, so no service-role key is needed.

create function public.accept_invitation(_token_hash text)
returns public.memberships
language plpgsql security definer set search_path = ''
as $$
declare
  _uid   uuid := (select auth.uid());
  _email text := lower((select auth.jwt() ->> 'email'));
  _inv   public.invitations;
  _member public.memberships;
begin
  if _uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into _inv
  from public.invitations
  where token_hash = _token_hash
    and accepted_at is null
    and expires_at > now()
  for update;

  -- One error for unknown, expired, already-used and wrong-recipient, so a
  -- caller cannot probe which tokens exist.
  if not found or _inv.email is distinct from _email then
    raise exception 'invalid or expired invitation' using errcode = 'P0002';
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (_inv.org_id, _uid, _inv.role)
  on conflict (org_id, user_id) do nothing;

  update public.invitations set accepted_at = now() where id = _inv.id;

  select * into _member
  from public.memberships
  where org_id = _inv.org_id and user_id = _uid;
  return _member;
end;
$$;

revoke execute on function public.accept_invitation(text) from public, anon;
grant  execute on function public.accept_invitation(text) to authenticated;
