// Pure request handler for invite-member. All I/O comes in through `Deps`, so the
// logic is unit-testable without Supabase or the network (see handler_test.ts).

import { sha256Hex } from "../_shared/crypto.ts";

export type Role = "admin" | "member";

export interface InvitationRow {
  org_id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string;
}

export type InsertResult =
  | { ok: true; id: string; expires_at: string }
  | { ok: false; reason: "forbidden" | "duplicate" | "unknown" };

export interface Deps {
  /** Resolves the caller's user id from the request's JWT, or null if invalid. */
  getCallerId(req: Request): Promise<string | null>;
  /** Inserts using the caller's JWT, so RLS decides whether they may invite. */
  insertInvitation(req: Request, row: InvitationRow): Promise<InsertResult>;
  sendInviteEmail(email: string, token: string, orgId: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// CORS headers are added in index.ts by withCors (see ../_shared/cors.ts).
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function handleInviteMember(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const callerId = await deps.getCallerId(req);
  if (!callerId) return json(401, { error: "unauthenticated" });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { org_id, email, role = "member" } = payload;
  if (typeof org_id !== "string" || !UUID_RE.test(org_id)) {
    return json(400, { error: "invalid_org_id" });
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return json(400, { error: "invalid_email" });
  }
  if (role !== "admin" && role !== "member") {
    return json(400, { error: "invalid_role" });
  }

  // 256 bits of entropy; only the hash is persisted.
  const token = [REDACTED_SECRET] Uint8Array(32)));
  const result = await deps.insertInvitation(req, {
    org_id,
    email: email.trim().toLowerCase(),
    role,
    token_hash: await sha256Hex(token),
    invited_by: callerId,
  });

  if (!result.ok) {
    if (result.reason === "forbidden") return json(403, { error: "forbidden" });
    if (result.reason === "duplicate") return json(409, { error: "already_invited" });
    return json(500, { error: "internal_error" });
  }

  await deps.sendInviteEmail(email.trim().toLowerCase(), token, org_id);
  return json(201, { id: result.id, expires_at: result.expires_at });
}
