import { createClient } from "npm:@supabase/supabase-js@2";
import { withCors } from "../_shared/cors.ts";
import { type Deps, handleAcceptInvitation } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Client bound to the caller's JWT, so accept_invitation sees their identity.
function callerClient(req: Request) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
}

const deps: Deps = {
  async getCallerId(req) {
    const { data, error } = await callerClient(req).auth.getUser();
    return error ? null : data.user?.id ?? null;
  },

  async acceptInvitation(req, tokenHash) {
    const { data, error } = await callerClient(req).rpc("accept_invitation", { _token_hash: tokenHash });
    if (!error && data) return { ok: true, org_id: data.org_id, role: data.role };
    if (error?.code === "P0002") return { ok: false, reason: "invalid" };
    console.error("accept_invitation failed", error?.code);
    return { ok: false, reason: "unknown" };
  },
};

Deno.serve(withCors((req) => handleAcceptInvitation(req, deps)));
