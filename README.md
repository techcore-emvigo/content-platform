# Content Platform

Multi-tenant content backend on Supabase. Organisations own articles, members author them, and published articles are public. Postgres with Row Level Security does the authorisation; Deno Edge Functions provide the API.

## Layout

| Area | Location |
|---|---|
| Schema, triggers, policy helpers, RPC | `supabase/migrations/20261103000000_init_multitenant.sql` |
| Row Level Security policies | `supabase/migrations/20261103000100_rls_policies.sql` |
| Invitation acceptance (RPC) | `supabase/migrations/20261103000200_accept_invitation.sql` |
| Articles CRUD API | `supabase/functions/articles/` |
| Invitation APIs | `supabase/functions/invite-member/`, `supabase/functions/accept-invitation/` |
| Shared CORS and crypto helpers | `supabase/functions/_shared/` |
| Database tests (pgTAP) | `supabase/tests/*.test.sql` |
| Function tests (Deno) | `supabase/functions/*/handler_test.ts` |
| Optional local data | `supabase/dev-seed.sql` |
| CI | `.github/workflows/ci.yml` |

## Data model

- `profiles`: one per auth user, created by a trigger on `auth.users`.
- `organisations` and `memberships` (`owner`, `admin`, `member`).
- `invitations`: admin-issued, one open invite per email per organisation, token stored hashed, expires after 7 days.
- `articles`: `draft`, `published` or `archived`, unique slug per organisation, `published_at` stamped on first publish.

## Articles API

All calls need a user JWT (`Authorization: Bearer <token>`).

| Method and path | Purpose |
|---|---|
| `GET /articles?org_id=&status=&limit=&cursor=` | List, newest first. Keyset pagination: pass `next_cursor` back as `cursor`. `limit` is 1 to 100, default 20. |
| `GET /articles/:id` | Read one article. |
| `POST /articles` | Create. Body: `org_id`, `slug`, `title`, optional `body` and `status`. |
| `PATCH /articles/:id` | Update `slug`, `title`, `body` or `status`. |
| `DELETE /articles/:id` | Delete. Returns 204. |

Errors are `{ "error": "<code>" }` with 400 (validation), 401, 403, 404 or 409 (`slug_taken`). Because RLS hides rows from people who cannot see them, "not found" and "not yours" both return 404.

## Invitations

1. An admin calls `POST /invite-member` with `org_id`, `email` and `role` (`admin` or `member`). A random token is emailed, and only its SHA-256 hash is stored.
2. The recipient signs in and calls `POST /accept-invitation` with `{ "token": "..." }`.
3. `public.accept_invitation()` checks that the invitation is unused, unexpired and was issued to the email in the caller's JWT, then creates the membership and marks the invitation accepted in one transaction. Unknown, expired, used and wrong-recipient tokens all return the same 404.

## Access rules

| | anon | member | author | admin / owner |
|---|---|---|---|---|
| Read published articles | yes | yes | yes | yes |
| Read drafts in own org | no | yes | yes | yes |
| Create article | no | yes | yes | yes |
| Edit or delete article | no | no | own | any in org |
| Rename org, manage invitations | no | no | no | yes |

## Design notes

- **Deny by default.** RLS is on for every table. Write policies are `to authenticated`; the only `anon` access is reading published articles.
- **No client-side INSERT on tenancy tables.** Organisations are created through `create_organisation()` and memberships through `accept_invitation()`.
- **Policy helpers are `SECURITY DEFINER`** with `search_path = ''`, live in a non-exposed `private` schema, and have `EXECUTE` revoked from `public` and `anon`. This avoids recursive policies on `memberships`.
- **`(select auth.uid())`** inside policies lets Postgres evaluate it once per statement instead of per row.
- **Functions run with the caller's JWT, never the service role.** RLS and the RPCs are the authorisation checks, so the API cannot escalate privileges.
- **`org_id` and `author_id` are immutable** after insert (trigger), and `author_id` is always taken from the verified JWT.
- **Handlers take their I/O as injected dependencies**, so they are unit-tested without a database or network.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `ALLOWED_ORIGIN` | all functions | The one browser origin allowed by CORS. Defaults to `http://localhost:3000`. |
| `APP_URL` | `invite-member` | Base URL for the link in the invitation email. |
| `MAIL_API_URL`, `MAIL_API_KEY` | `invite-member` | Mail provider endpoint and key. Mail is skipped when `MAIL_API_URL` is unset. |

## Development

```bash
supabase start
supabase test db                    # pgTAP: RLS, triggers, constraints, invitations
deno test supabase/functions/       # handler unit tests
supabase functions serve
```

Optional local data (two users, one organisation, three articles):

```bash
psql "postgresql://postgres:[REDACTED_PASSWORD]@127.0.0.1:54322/postgres" -f supabase/dev-seed.sql
```

Load it after running the database tests, not before: the tests expect an empty database.
