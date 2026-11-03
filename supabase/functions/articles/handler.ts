// Request handler for the articles CRUD endpoint. All I/O comes in through `Deps`,
// so the logic is unit-testable without Supabase or the network (see handler_test.ts).
//
//   GET    /articles?org_id=&status=&limit=&cursor=   list (newest first, keyset paginated)
//   GET    /articles/:id                              read
//   POST   /articles                                  create
//   PATCH  /articles/:id                              update
//   DELETE /articles/:id                              delete

export type ArticleStatus = "draft" | "published" | "archived";

export interface Article {
  id: string;
  org_id: string;
  author_id: string;
  slug: string;
  title: string;
  body: string;
  status: ArticleStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewArticle {
  org_id: string;
  author_id: string;
  slug: string;
  title: string;
  body: string;
  status: ArticleStatus;
}

export type ArticlePatch = Partial<Pick<Article, "slug" | "title" | "body" | "status">>;

export interface ListQuery {
  orgId: string;
  status?: ArticleStatus;
  /** Rows to return. The repo is asked for one extra to detect a next page. */
  limit: number;
  after?: { createdAt: string; id: string };
}

export type RepoFailure = "forbidden" | "not_found" | "conflict" | "unknown";
export type Result<T> = { ok: true; data: T } | { ok: false; reason: RepoFailure };

/** Every method runs with the caller's JWT, so RLS is the authorisation layer. */
export interface Repo {
  list(req: Request, q: ListQuery): Promise<Result<Article[]>>;
  get(req: Request, id: string): Promise<Result<Article>>;
  create(req: Request, row: NewArticle): Promise<Result<Article>>;
  update(req: Request, id: string, patch: ArticlePatch): Promise<Result<Article>>;
  remove(req: Request, id: string): Promise<Result<null>>;
}

export interface Deps {
  /** Resolves the caller's user id from the request's JWT, or null if invalid. */
  getCallerId(req: Request): Promise<string | null>;
  repo: Repo;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STATUSES: readonly string[] = ["draft", "published", "archived"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// CORS headers are added in index.ts by withCors (see ../_shared/cors.ts).
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fail = (error: string, status: number) => json(status, { error });

function failure(reason: RepoFailure): Response {
  switch (reason) {
    case "forbidden":
      return fail("forbidden", 403);
    // RLS hides rows from callers who may not see them, so "no row" and "not yours"
    // are deliberately indistinguishable.
    case "not_found":
      return fail("not_found", 404);
    case "conflict":
      return fail("slug_taken", 409);
    default:
      return fail("internal_error", 500);
  }
}

export function encodeCursor(a: Pick<Article, "created_at" | "id">): string {
  return btoa(`${a.created_at}|${a.id}`).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = atob(raw.replaceAll("-", "+").replaceAll("_", "/")).split("|");
    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !UUID_RE.test(id ?? "")) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function validateFields(input: Record<string, unknown>, partial: boolean): string | null {
  const { slug, title, body, status } = input;
  if ((!partial || slug !== undefined) && (typeof slug !== "string" || !SLUG_RE.test(slug) || slug.length > 120)) {
    return "invalid_slug";
  }
  if ((!partial || title !== undefined) && (typeof title !== "string" || title.trim().length < 1 || title.length > 200)) {
    return "invalid_title";
  }
  if (body !== undefined && typeof body !== "string") return "invalid_body";
  if (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status))) {
    return "invalid_status";
  }
  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function handleArticles(req: Request, deps: Deps): Promise<Response> {
  const callerId = await deps.getCallerId(req);
  if (!callerId) return fail("unauthenticated", 401);

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.indexOf("articles") + 1];
  if (id !== undefined && !UUID_RE.test(id)) return fail("not_found", 404);

  const { repo } = deps;

  if (id === undefined) {
    if (req.method === "GET") return list(req, url, deps);
    if (req.method === "POST") return create(req, callerId, repo);
    return fail("method_not_allowed", 405);
  }

  switch (req.method) {
    case "GET": {
      const res = await repo.get(req, id);
      return res.ok ? json(200, { data: res.data }) : failure(res.reason);
    }
    case "PATCH": {
      const input = await readJson(req);
      if (!input) return fail("invalid_json", 400);
      const patch: ArticlePatch = {};
      for (const key of ["slug", "title", "body", "status"] as const) {
        if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
      }
      if (Object.keys(patch).length === 0) return fail("empty_patch", 400);
      const invalid = validateFields(patch, true);
      if (invalid) return fail(invalid, 400);
      const res = await repo.update(req, id, patch);
      return res.ok ? json(200, { data: res.data }) : failure(res.reason);
    }
    case "DELETE": {
      const res = await repo.remove(req, id);
      return res.ok ? new Response(null, { status: 204 }) : failure(res.reason);
    }
    default:
      return fail("method_not_allowed", 405);
  }
}

async function list(req: Request, url: URL, deps: Deps): Promise<Response> {
  const orgId = url.searchParams.get("org_id");
  if (!orgId || !UUID_RE.test(orgId)) return fail("invalid_org_id", 400);

  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !STATUSES.includes(status)) return fail("invalid_status", 400);

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail("invalid_limit", 400);

  const rawCursor = url.searchParams.get("cursor");
  const after = rawCursor === null ? undefined : decodeCursor(rawCursor);
  if (rawCursor !== null && !after) return fail("invalid_cursor", 400);

  const res = await deps.repo.list(req, {
    orgId,
    status: status as ArticleStatus | undefined,
    limit: limit + 1,
    after: after ?? undefined,
  });
  if (!res.ok) return failure(res.reason);

  const page = res.data.slice(0, limit);
  const next_cursor = res.data.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return json(200, { data: page, next_cursor });
}

async function create(req: Request, callerId: string, repo: Repo): Promise<Response> {
  const input = await readJson(req);
  if (!input) return fail("invalid_json", 400);

  if (typeof input.org_id !== "string" || !UUID_RE.test(input.org_id)) return fail("invalid_org_id", 400);
  const invalid = validateFields(input, false);
  if (invalid) return fail(invalid, 400);

  // author_id always comes from the verified JWT; a client-supplied value is ignored.
  const res = await repo.create(req, {
    org_id: input.org_id,
    author_id: callerId,
    slug: input.slug as string,
    title: (input.title as string).trim(),
    body: (input.body as string | undefined) ?? "",
    status: (input.status as ArticleStatus | undefined) ?? "draft",
  });
  return res.ok ? json(201, { data: res.data }) : failure(res.reason);
}
