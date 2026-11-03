import { assertEquals } from "jsr:@std/assert@1";
import { sha256Hex } from "../_shared/crypto.ts";
import { type AcceptResult, type Deps, handleAcceptInvitation } from "./handler.ts";

const TOKEN = "A".repeat(43);

function makeDeps(result: AcceptResult, callerId: string | null = "user-1") {
  const hashes: string[] = [];
  const deps: Deps = {
    getCallerId: () => Promise.resolve(callerId),
    acceptInvitation: (_req, tokenHash) => {
      hashes.push(tokenHash);
      return Promise.resolve(result);
    },
  };
  return { deps, hashes };
}

const post = (body: unknown) =>
  new Request("http://localhost/accept-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const OK: AcceptResult = { ok: true, org_id: "org-1", role: "member" };

Deno.test("405 for non-POST", async () => {
  const { deps } = makeDeps(OK);
  const res = await handleAcceptInvitation(new Request("http://localhost/", { method: "GET" }), deps);
  assertEquals(res.status, 405);
});

Deno.test("401 when the caller cannot be authenticated", async () => {
  const { deps, hashes } = makeDeps(OK, null);
  assertEquals((await handleAcceptInvitation(post({ token: TOKEN }), deps)).status, 401);
  assertEquals(hashes.length, 0);
});

Deno.test("400 on malformed JSON or a token of the wrong shape", async () => {
  const { deps, hashes } = makeDeps(OK);
  assertEquals((await handleAcceptInvitation(post("{nope"), deps)).status, 400);
  for (const token of [undefined, 5, "short", "A".repeat(44), "!".repeat(43)]) {
    const res = await handleAcceptInvitation(post({ token }), deps);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_token");
  }
  assertEquals(hashes.length, 0);
});

Deno.test("200: only the token hash reaches the database", async () => {
  const { deps, hashes } = makeDeps(OK);
  const res = await handleAcceptInvitation(post({ token: TOKEN }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { org_id: "org-1", role: "member" });
  assertEquals(hashes, [await sha256Hex(TOKEN)]);
});

Deno.test("404 for an invalid invitation, 500 for an unexpected failure", async () => {
  const invalid = makeDeps({ ok: false, reason: "invalid" });
  const res = await handleAcceptInvitation(post({ token: TOKEN }), invalid.deps);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "invalid_invitation");

  const broken = makeDeps({ ok: false, reason: "unknown" });
  assertEquals((await handleAcceptInvitation(post({ token: TOKEN }), broken.deps)).status, 500);
});
