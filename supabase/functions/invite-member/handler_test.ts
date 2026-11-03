import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { sha256Hex } from "../_shared/crypto.ts";
import { type Deps, handleInviteMember, type InvitationRow } from "./handler.ts";

const ORG = "11111111-1111-1111-1111-111111111111";
const CALLER = "aaaaaaaa-0000-0000-0000-000000000001";

function makeDeps(overrides: Partial<Deps> = {}) {
  const inserted: InvitationRow[] = [];
  const emails: { email: string; token: string }[] = [];
  const deps: Deps = {
    getCallerId: () => Promise.resolve(CALLER),
    insertInvitation: (_req, row) => {
      inserted.push(row);
      return Promise.resolve({ ok: true, id: "inv-1", expires_at: "2026-01-08T00:00:00Z" });
    },
    sendInviteEmail: (email, token) => {
      emails.push({ email, token });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, inserted, emails };
}

const post = (body: unknown) =>
  new Request("http://localhost/invite-member", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("rejects non-POST methods", async () => {
  const { deps } = makeDeps();
  const res = await handleInviteMember(new Request("http://localhost/", { method: "GET" }), deps);
  assertEquals(res.status, 405);
});

Deno.test("401 when the caller cannot be authenticated", async () => {
  const { deps, inserted } = makeDeps({ getCallerId: () => Promise.resolve(null) });
  const res = await handleInviteMember(post({ org_id: ORG, email: "a@example.com" }), deps);
  assertEquals(res.status, 401);
  assertEquals(inserted.length, 0);
});

Deno.test("400 on malformed JSON", async () => {
  const { deps } = makeDeps();
  const res = await handleInviteMember(post("{not json"), deps);
  assertEquals(res.status, 400);
});

Deno.test("400 on invalid org_id, email and role", async () => {
  const { deps, inserted } = makeDeps();
  const cases: [unknown, string][] = [
    [{ org_id: "nope", email: "a@example.com" }, "invalid_org_id"],
    [{ org_id: ORG, email: "not-an-email" }, "invalid_email"],
    [{ org_id: ORG, email: "a@example.com", role: "owner" }, "invalid_role"],
  ];
  for (const [body, error] of cases) {
    const res = await handleInviteMember(post(body), deps);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, error);
  }
  assertEquals(inserted.length, 0);
});

Deno.test("201: stores only the token hash, emails the raw token, normalises email", async () => {
  const { deps, inserted, emails } = makeDeps();
  const res = await handleInviteMember(
    post({ org_id: ORG, email: "  New.User@Example.COM ", role: "admin" }),
    deps,
  );

  assertEquals(res.status, 201);
  assertEquals((await res.json()).id, "inv-1");

  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].email, "new.user@example.com");
  assertEquals(inserted[0].role, "admin");
  assertEquals(inserted[0].invited_by, CALLER);

  assertEquals(emails.length, 1);
  const { token } = emails[0];
  assertMatch(token, /^[A-Za-z0-9_-]{43}$/);
  assertNotEquals(inserted[0].token_hash, token);
  assertEquals(inserted[0].token_hash, await sha256Hex(token));
});

Deno.test("403 when RLS rejects the insert; no email is sent", async () => {
  const { deps, emails } = makeDeps({
    insertInvitation: () => Promise.resolve({ ok: false, reason: "forbidden" }),
  });
  const res = await handleInviteMember(post({ org_id: ORG, email: "a@example.com" }), deps);
  assertEquals(res.status, 403);
  assertEquals(emails.length, 0);
});

Deno.test("409 on duplicate open invitation", async () => {
  const { deps } = makeDeps({
    insertInvitation: () => Promise.resolve({ ok: false, reason: "duplicate" }),
  });
  const res = await handleInviteMember(post({ org_id: ORG, email: "a@example.com" }), deps);
  assertEquals(res.status, 409);
});
