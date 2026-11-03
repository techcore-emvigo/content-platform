import { assertEquals } from "jsr:@std/assert@1";
import {
  type Article,
  type Deps,
  encodeCursor,
  handleArticles,
  type ListQuery,
  type NewArticle,
  type Repo,
} from "./handler.ts";

const ORG = "11111111-1111-1111-1111-111111111111";
const CALLER = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "aaaaaaaa-0000-0000-0000-000000000002";
const ID = "bbbbbbbb-0000-0000-0000-000000000001";

const article = (n: number, overrides: Partial<Article> = {}): Article => ({
  id: `bbbbbbbb-0000-0000-0000-00000000000${n}`,
  org_id: ORG,
  author_id: CALLER,
  slug: `post-${n}`,
  title: `Post ${n}`,
  body: "",
  status: "draft",
  published_at: null,
  created_at: `2026-01-0${n}T00:00:00.000Z`,
  updated_at: `2026-01-0${n}T00:00:00.000Z`,
  ...overrides,
});

function makeDeps(repoOverrides: Partial<Repo> = {}, callerId: string | null = CALLER) {
  const calls = { list: [] as ListQuery[], create: [] as NewArticle[], patch: [] as unknown[] };
  const repo: Repo = {
    list: (_req, q) => {
      calls.list.push(q);
      return Promise.resolve({ ok: true, data: [article(3), article(2), article(1)] });
    },
    get: () => Promise.resolve({ ok: true, data: article(1) }),
    create: (_req, row) => {
      calls.create.push(row);
      return Promise.resolve({ ok: true, data: article(1, row) });
    },
    update: (_req, _id, patch) => {
      calls.patch.push(patch);
      return Promise.resolve({ ok: true, data: article(1, patch) });
    },
    remove: () => Promise.resolve({ ok: true, data: null }),
    ...repoOverrides,
  };
  const deps: Deps = { getCallerId: () => Promise.resolve(callerId), repo };
  return { deps, calls };
}

const call = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost/articles${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

// Auth and routing ---------------------------------------------------------------

Deno.test("401 when the caller cannot be authenticated", async () => {
  const { deps } = makeDeps({}, null);
  assertEquals((await handleArticles(call("GET", `?org_id=${ORG}`), deps)).status, 401);
});

Deno.test("404 for a non-UUID id, 405 for unsupported methods", async () => {
  const { deps } = makeDeps();
  assertEquals((await handleArticles(call("GET", "/not-a-uuid"), deps)).status, 404);
  assertEquals((await handleArticles(call("PUT", `/${ID}`, {}), deps)).status, 405);
  assertEquals((await handleArticles(call("DELETE", ""), deps)).status, 405);
});

// List ---------------------------------------------------------------------------

Deno.test("list: validates query parameters", async () => {
  const { deps, calls } = makeDeps();
  const cases: [string, string][] = [
    ["", "invalid_org_id"],
    ["?org_id=nope", "invalid_org_id"],
    [`?org_id=${ORG}&status=bogus`, "invalid_status"],
    [`?org_id=${ORG}&limit=0`, "invalid_limit"],
    [`?org_id=${ORG}&limit=101`, "invalid_limit"],
    [`?org_id=${ORG}&limit=abc`, "invalid_limit"],
    [`?org_id=${ORG}&cursor=%25%25`, "invalid_cursor"],
  ];
  for (const [qs, error] of cases) {
    const res = await handleArticles(call("GET", qs), deps);
    assertEquals(res.status, 400, qs);
    assertEquals((await res.json()).error, error, qs);
  }
  assertEquals(calls.list.length, 0);
});

Deno.test("list: returns one page and a cursor when more rows exist", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleArticles(call("GET", `?org_id=${ORG}&limit=2&status=published`), deps);
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.data.map((a: Article) => a.slug), ["post-3", "post-2"]);
  assertEquals(body.next_cursor, encodeCursor(article(2)));
  // The repo is asked for limit + 1 to detect the next page.
  assertEquals(calls.list[0].limit, 3);
  assertEquals(calls.list[0].status, "published");
});

Deno.test("list: next_cursor is null on the last page, and a cursor is passed through", async () => {
  const { deps, calls } = makeDeps();
  const cursor = encodeCursor(article(3));
  const res = await handleArticles(call("GET", `?org_id=${ORG}&limit=10&cursor=${cursor}`), deps);
  assertEquals((await res.json()).next_cursor, null);
  assertEquals(calls.list[0].after, { createdAt: article(3).created_at, id: article(3).id });
});

// Read ---------------------------------------------------------------------------

Deno.test("get: 200 with the article, 404 when the repo finds nothing", async () => {
  const ok = makeDeps();
  const found = await handleArticles(call("GET", `/${ID}`), ok.deps);
  assertEquals(found.status, 200);
  assertEquals((await found.json()).data.slug, "post-1");

  const missing = makeDeps({ get: () => Promise.resolve({ ok: false, reason: "not_found" }) });
  assertEquals((await handleArticles(call("GET", `/${ID}`), missing.deps)).status, 404);
});

// Create -------------------------------------------------------------------------

Deno.test("create: 201, author comes from the JWT and not the request body", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleArticles(
    call("POST", "", { org_id: ORG, slug: "hello-world", title: "  Hello  ", author_id: OTHER }),
    deps,
  );
  assertEquals(res.status, 201);
  assertEquals(calls.create[0], {
    org_id: ORG,
    author_id: CALLER,
    slug: "hello-world",
    title: "Hello",
    body: "",
    status: "draft",
  });
});

Deno.test("create: 400 on invalid input", async () => {
  const { deps, calls } = makeDeps();
  const cases: [unknown, string][] = [
    ["{not json", "invalid_json"],
    [{ slug: "a", title: "T" }, "invalid_org_id"],
    [{ org_id: ORG, slug: "Bad Slug", title: "T" }, "invalid_slug"],
    [{ org_id: ORG, slug: "ok", title: "" }, "invalid_title"],
    [{ org_id: ORG, slug: "ok", title: "T", status: "live" }, "invalid_status"],
    [{ org_id: ORG, slug: "ok", title: "T", body: 5 }, "invalid_body"],
  ];
  for (const [body, error] of cases) {
    const res = await handleArticles(call("POST", "", body), deps);
    assertEquals(res.status, 400, error);
    assertEquals((await res.json()).error, error);
  }
  assertEquals(calls.create.length, 0);
});

Deno.test("create: maps repo failures to 403 and 409", async () => {
  const input = { org_id: ORG, slug: "ok", title: "T" };
  const forbidden = makeDeps({ create: () => Promise.resolve({ ok: false, reason: "forbidden" }) });
  assertEquals((await handleArticles(call("POST", "", input), forbidden.deps)).status, 403);

  const dup = makeDeps({ create: () => Promise.resolve({ ok: false, reason: "conflict" }) });
  assertEquals((await handleArticles(call("POST", "", input), dup.deps)).status, 409);
});

// Update -------------------------------------------------------------------------

Deno.test("patch: only whitelisted fields reach the repo", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleArticles(
    call("PATCH", `/${ID}`, { title: "New", status: "published", org_id: OTHER, author_id: OTHER }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(calls.patch[0], { title: "New", status: "published" });
});

Deno.test("patch: 400 on empty or invalid patch, 404 when nothing matches", async () => {
  const { deps } = makeDeps();
  const empty = await handleArticles(call("PATCH", `/${ID}`, { org_id: OTHER }), deps);
  assertEquals((await empty.json()).error, "empty_patch");
  assertEquals((await handleArticles(call("PATCH", `/${ID}`, { slug: "Nope!" }), deps)).status, 400);

  const missing = makeDeps({ update: () => Promise.resolve({ ok: false, reason: "not_found" }) });
  assertEquals((await handleArticles(call("PATCH", `/${ID}`, { title: "x" }), missing.deps)).status, 404);
});

// Delete -------------------------------------------------------------------------

Deno.test("delete: 204 on success, 404 when nothing was deleted", async () => {
  const { deps } = makeDeps();
  const res = await handleArticles(call("DELETE", `/${ID}`), deps);
  assertEquals(res.status, 204);
  assertEquals(await res.text(), "");

  const missing = makeDeps({ remove: () => Promise.resolve({ ok: false, reason: "not_found" }) });
  assertEquals((await handleArticles(call("DELETE", `/${ID}`), missing.deps)).status, 404);
});
