import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sender } from "./types";

/**
 * MCP OAuth 2.1 (2026-11-11) — stateless, PKCE-only, no client secrets.
 *
 * Why stateless: Vercel serverless functions share no memory or disk, so
 * authorization codes and tokens are signed JWTs (HS256) instead of rows
 * in a database. The signing secret is OAUTH_SECRET (generated per
 * deployment); API_TOKEN is the fallback so the flow still works if the
 * dedicated secret is missing. Rotating the secret invalidates every
 * outstanding code and token, which is the safe failure mode.
 *
 * Flow:
 *   1. Client discovers us via /.well-known/oauth-protected-resource and
 *      /.well-known/oauth-authorization-server.
 *   2. Client may register via POST /oauth/register (public client, no
 *      secret — we accept any client_id it sends afterwards).
 *   3. GET /oauth/authorize?... shows a page: the room owner picks which
 *      AI this grant is for (ChatGPT or Muse) and enters the ROOM_KEY.
 *      POST approves it and redirects back with a signed, 10-minute,
 *      single-purpose authorization code.
 *   4. POST /oauth/token exchanges the code + PKCE verifier for an access
 *      token (8h) and a refresh token (30d), both bound to that identity.
 *   5. The MCP endpoint accepts the access token as a Bearer token and
 *      treats it exactly like the matching per-AI static token: the token
 *      — not the self-declared `sender` field — decides who is posting.
 */

export type AiIdentity = "ChatGPT" | "Muse";

function signingSecret(): string {
  return process.env.OAUTH_SECRET || process.env.API_TOKEN || "";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

interface JwtPayload {
  typ: "code" | "access" | "refresh";
  sub: AiIdentity;
  exp: number;
  iat: number;
  jti: string;
  /** PKCE S256 challenge (code tokens only). */
  challenge?: string;
  /** Redirect URI the code was issued for (code tokens only). */
  redirect_uri?: string;
  /** Client the code was issued to (code tokens only). */
  client_id?: string;
  scope?: string;
}

function signJwt(payload: Omit<JwtPayload, "iat" | "jti">): string {
  const secret = signingSecret();
  const full: JwtPayload = { ...payload, iat: Math.floor(Date.now() / 1000), jti: randomToken(16) };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(full));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, expectedTyp: JwtPayload["typ"]): JwtPayload | null {
  const secret = signingSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  if (!safeEqual(sig, expected)) return null;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf-8")) as JwtPayload;
  } catch {
    return null;
  }
  if (payload.typ !== expectedTyp) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (payload.sub !== "ChatGPT" && payload.sub !== "Muse") return null;
  return payload;
}

/** PKCE S256: the verifier must hash to the challenge the client sent. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const digest = b64url(createHash("sha256").update(verifier).digest());
  return safeEqual(digest, challenge);
}

/** Mint a 10-minute authorization code bound to an identity + challenge. */
export function mintAuthCode(opts: {
  identity: AiIdentity;
  challenge: string;
  redirectUri: string;
  clientId: string;
}): string {
  return signJwt({
    typ: "code",
    sub: opts.identity,
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
    challenge: opts.challenge,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  });
}

/** Mint an 8-hour access token for an identity. */
export function mintAccessToken(identity: AiIdentity): { token: string; expiresIn: number } {
  const expiresIn = 8 * 60 * 60;
  return {
    token: signJwt({
      typ: "access",
      sub: identity,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
      scope: "threeway",
    }),
    expiresIn,
  };
}

/** Mint a 30-day refresh token for an identity. */
export function mintRefreshToken(identity: AiIdentity): string {
  return signJwt({
    typ: "refresh",
    sub: identity,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
}

/** The identity an OAuth access token proves, or null. */
export function identityFromAccessToken(token: string): AiIdentity | null {
  const payload = verifyJwt(token, "access");
  return payload ? payload.sub : null;
}

/** Origin (scheme + host) of the current deployment, from the request. */
export function originOf(req: Request): string {
  return new URL(req.url).origin;
}

export type { Sender };
