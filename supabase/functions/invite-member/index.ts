import { createClient } from "npm:@supabase/supabase-js@2";
import { withCors } from "../_shared/cors.ts";
import { type Deps, handleInviteMember } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MAIL_API_URL = Deno.env.get("MAIL_API_URL");
const MAIL_API_KEY = [REDACTED_SECRET]"MAIL_API_KEY");
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";

// Client bound to the caller's JWT: every query runs under their RLS context.
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

  async insertInvitation(req, row) {
    const { data, error } = await callerClient(req)
      .from("invitations")
      .insert(row)
      .select("id, expires_at")
      .single();

    if (!error) return { ok: true, id: data.id, expires_at: data.expires_at };
    if (error.code === "42501") return { ok: false, reason: "forbidden" };
    if (error.code === "23505") return { ok: false, reason: "duplicate" };
    console.error("insert invitation failed", error.code);
    return { ok: false, reason: "unknown" };
  },

  async sendInviteEmail(email, token, orgId) {
    if (!MAIL_API_URL) return; // local dev: no mail provider configured
    await fetch(MAIL_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MAIL_API_KEY}` },
      body: JSON.stringify({
        to: email,
        template: "org-invitation",
        data: { link: `${APP_URL}/invite?org=${orgId}&token=${token}` },
      }),
    });
  },
};

Deno.serve(withCors((req) => handleInviteMember(req, deps)));
