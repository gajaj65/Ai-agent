import {
  mintAccessToken,
  mintRefreshToken,
  verifyJwt,
  verifyPkce,
} from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth 2.1 token endpoint (PKCE, public clients, no client secret).
 *
 * Accepts application/x-www-form-urlencoded (standard) and JSON.
 *
 * grant_type=authorization_code:
 *   code, redirect_uri, code_verifier, client_id
 *   → verifies the signed code, the redirect URI and the PKCE verifier,
 *     then issues an access token (8h) + refresh token (30d) bound to
 *     the identity chosen at /oauth/authorize.
 * grant_type=refresh_token:
 *   refresh_token → verifies it and issues a fresh access token (+ a
 *   rotated refresh token) for the same identity.
 */

function err(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status });
}

async function readBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      return Object.fromEntries(new URLSearchParams(text)) as Record<string, string>;
    }
    const json = (await req.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  const body = await readBody(req);
  const grant = body.grant_type ?? "";

  if (grant === "authorization_code") {
    const { code, redirect_uri, code_verifier, client_id } = body;
    if (!code || !redirect_uri || !code_verifier) {
      return err("invalid_request", "code, redirect_uri and code_verifier are required.");
    }
    const payload = verifyJwt(code, "code");
    if (!payload) {
      return err("invalid_grant", "The authorization code is invalid or expired.");
    }
    if (payload.redirect_uri !== redirect_uri) {
      return err("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (payload.client_id && client_id && payload.client_id !== client_id) {
      return err("invalid_grant", "client_id does not match the authorization request.");
    }
    if (!payload.challenge || !verifyPkce(code_verifier, payload.challenge)) {
      return err("invalid_grant", "PKCE code_verifier does not match the code_challenge.");
    }
    const access = mintAccessToken(payload.sub);
    return Response.json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: mintRefreshToken(payload.sub),
      scope: "threeway",
    });
  }

  if (grant === "refresh_token") {
    const { refresh_token } = body;
    if (!refresh_token) {
      return err("invalid_request", "refresh_token is required.");
    }
    const payload = verifyJwt(refresh_token, "refresh");
    if (!payload) {
      return err("invalid_grant", "The refresh token is invalid or expired.");
    }
    const access = mintAccessToken(payload.sub);
    return Response.json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: mintRefreshToken(payload.sub),
      scope: "threeway",
    });
  }

  return err("unsupported_grant_type", `grant_type "${grant || "(missing)"}" is not supported.`);
}
