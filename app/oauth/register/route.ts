import { randomToken } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 7591 dynamic client registration. Threeway uses public clients
 * (PKCE, no secret), so registration just hands out a client_id — any
 * client_id the client sends later is accepted, this endpoint exists so
 * MCP clients that register first (ChatGPT does) can complete discovery.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  return Response.json(
    {
      client_id: `threeway-${randomToken(12)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: typeof body.client_name === "string" ? body.client_name : "Threeway MCP client",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "threeway",
    },
    { status: 201 },
  );
}
