import { originOf } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 8414 authorization-server metadata. ChatGPT's OAuth discovery
 * reads this to find the authorize/token/register endpoints and to learn
 * that we speak authorization-code + PKCE (S256) with public clients
 * (no client secret).
 */
export async function GET(req: Request) {
  const origin = originOf(req);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["threeway"],
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
