import { createClient } from "npm:@supabase/supabase-js@2";
import { withCors } from "../_shared/cors.ts";
import { type Deps, handleArticles, type Repo, type Result } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Client bound to the caller's JWT: every query runs under their RLS context.
function callerClient(req: Request) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
}

function toResult<T>(data: T | null, error: { code?: string } | null): Result<T> {
  if (!error && data !== null) return { ok: true, data };
  switch (error?.code) {
    case "42501":
      return { ok: false, reason: "forbidden" };
    case "23505":
      return { ok: false, reason: "conflict" };
    case "PGRST116": // .single() matched no row (missing, or hidden by RLS)
      return { ok: false, reason: "not_found" };
    default:
      console.error("articles query failed", error?.code);
      return { ok: false, reason: "unknown" };
  }
}

const repo: Repo = {
  async list(req, q) {
    let query = callerClient(req)
      .from("articles")
      .select("*")
      .eq("org_id", q.orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(q.limit);

    if (q.status) query = query.eq("status", q.status);
    if (q.after) {
      query = query.or(
        `created_at.lt.${q.after.createdAt},and(created_at.eq.${q.after.createdAt},id.lt.${q.after.id})`,
      );
    }

    const { data, error } = await query;
    return toResult(data, error);
  },

  async get(req, id) {
    const { data, error } = await callerClient(req).from("articles").select("*").eq("id", id).single();
    return toResult(data, error);
  },

  async create(req, row) {
    const { data, error } = await callerClient(req).from("articles").insert(row).select().single();
    return toResult(data, error);
  },

  async update(req, id, patch) {
    const { data, error } = await callerClient(req).from("articles").update(patch).eq("id", id).select().single();
    return toResult(data, error);
  },

  async remove(req, id) {
    const { data, error } = await callerClient(req).from("articles").delete().eq("id", id).select("id");
    if (error) return toResult(null, error);
    return data.length > 0 ? { ok: true, data: null } : { ok: false, reason: "not_found" };
  },
};

const deps: Deps = {
  async getCallerId(req) {
    const { data, error } = await callerClient(req).auth.getUser();
    return error ? null : data.user?.id ?? null;
  },
  repo,
};

Deno.serve(withCors((req) => handleArticles(req, deps)));
