// CORS for all functions. Browsers may call only from ALLOWED_ORIGIN; set it per
// environment (for example https://app.example.com). It defaults to the local
// web app so a missing setting fails closed rather than open.
const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:3000";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Vary": "Origin",
};

export function withCors(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const res = await handler(req);
    for (const [name, value] of Object.entries(corsHeaders)) res.headers.set(name, value);
    return res;
  };
}
