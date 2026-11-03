// Request handler for accept-invitation. All I/O comes in through `Deps`, so the
// logic is unit-testable without Supabase or the network (see handler_test.ts).
//
//   POST /accept-invitation   { "token": "<token from the invitation email>" }

import { sha256Hex } from "../_shared/crypto.ts";

export type AcceptResult =
  | { ok: true; org_id: string; role: string }
  | { ok: false; reason: "invalid" | "unknown" };

export interface Deps {
  /** Resolves the caller's user id from the request's JWT, or null if invalid. */
  getCallerId(req: Request): Promise<string | null>;
  /** Calls public.accept_invitation with the caller's JWT. */
  acceptInvitation(req: Request, tokenHash: string): Promise<AcceptResult>;
}

// Tokens are 32 random bytes, base64url encoded (see invite-member).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAcceptInvitation(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  if (!(await deps.getCallerId(req))) return json(401, { error: "unauthenticated" });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { token } = payload;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return json(400, { error: "invalid_token" });
  }

  const result = await deps.acceptInvitation(req, await sha256Hex(token));
  if (!result.ok) {
    return result.reason === "invalid"
      ? json(404, { error: "invalid_invitation" })
      : json(500, { error: "internal_error" });
  }
  return json(200, { org_id: result.org_id, role: result.role });
}
