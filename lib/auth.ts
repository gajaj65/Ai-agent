import { timingSafeEqual } from "node:crypto";
import { identityFromAccessToken } from "./oauth";

/** Constant-time string comparison, safe against timing attacks. */
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

export function getRoomKey(): string | undefined {
  return process.env.ROOM_KEY || undefined;
}

export function getApiToken(): string | undefined {
  return process.env.API_TOKEN || undefined;
}

export function getChatGptToken(): string | undefined {
  return process.env.CHATGPT_TOKEN || undefined;
}

export function getMuseToken(): string | undefined {
  return process.env.MUSE_TOKEN || undefined;
}

export function getMcpToken(): string | undefined {
  return (
    process.env.MCP_TOKEN ||
    process.env.API_TOKEN ||
    process.env.CHATGPT_TOKEN ||
    process.env.MUSE_TOKEN ||
    undefined
  );
}

/**
 * Extract the presented API token from the request.
 * ChatGPT's custom-MCP "API key" auth sends the key in different ways
 * depending on its form, so accept all three standard forms — the secret
 * itself is still required and still compared in constant time:
 *   Authorization: Bearer <token>   (MCP clients, curl, poll.mjs)
 *   Authorization: <token>          (raw API-key value, no scheme)
 *   X-Api-Key: <token>              (standard API-key header)
 */
function bearerToken(req: Request): string | undefined {
  const h = (req.headers.get("authorization") ?? "").trim();
  if (h) {
    if (h.toLowerCase().startsWith("bearer ")) {
      return h.slice(7).trim() || undefined;
    }
    // Raw token with no scheme — accept it; the value is still verified
    // against the configured secrets below.
    return h || undefined;
  }
  const apiKey = (req.headers.get("x-api-key") ?? "").trim();
  return apiKey || undefined;
}

/**
 * Separate authenticated identities (ChatGPT review, 2026-11-11):
 * when CHATGPT_TOKEN / MUSE_TOKEN are set, each AI has its own token and
 * the token — not the self-declared `sender` field — decides who is
 * posting. Returns the identity the Bearer token proves, or null.
 * A shared API_TOKEN (or MCP_TOKEN) proves only "api": either AI, for
 * backward compatibility when per-AI tokens are not configured.
 * An OAuth 2.1 access token (issued at /oauth/token after the room owner
 * approved the connection) proves the identity chosen at authorization.
 */
export type BearerIdentity = "ChatGPT" | "Muse" | "api";
export function identifyBearer(req: Request): BearerIdentity | null {
  const given = bearerToken(req);
  if (!given) return null;
  const chatGpt = getChatGptToken();
  if (chatGpt && safeEqual(given, chatGpt)) return "ChatGPT";
  const muse = getMuseToken();
  if (muse && safeEqual(given, muse)) return "Muse";
  const shared = getApiToken() ?? process.env.MCP_TOKEN;
  if (shared && safeEqual(given, shared)) return "api";
  // OAuth 2.1 access token: verified by signature, identity is its subject.
  const oauth = identityFromAccessToken(given);
  if (oauth) return oauth;
  return null;
}

/** True when the request carries a valid Bearer API token. */
export function isValidBearer(req: Request, expected?: string): boolean {
  const token = expected ?? getApiToken();
  if (!token) return false;
  const given = bearerToken(req);
  return !!given && safeEqual(given, token);
}

/** True when the request carries any valid Bearer token (per-AI or shared). */
export function isValidMcpBearer(req: Request): boolean {
  return identifyBearer(req) !== null;
}

/**
 * True when the Bearer token authorises posting as `sender`.
 * A per-AI token may only post as its own AI; a shared token may post
 * as either AI. Returns false when there is no valid Bearer token.
 */
export function bearerMayPostAs(req: Request, sender: "ChatGPT" | "Muse"): boolean {
  const identity = identifyBearer(req);
  if (!identity) return false;
  if (identity === "api") return true;
  return identity === sender;
}

/** True when the request carries a valid room key (header or query). */
export function isValidRoomKey(req: Request): boolean {
  const key = getRoomKey();
  if (!key) return false;
  const header = req.headers.get("x-room-key");
  if (header && safeEqual(header, key)) return true;
  const url = new URL(req.url);
  const query = url.searchParams.get("roomKey");
  return !!query && safeEqual(query, key);
}

/** Human UI or an AI agent: room key OR Bearer token. */
export function isAuthorizedForMessages(req: Request): boolean {
  return isValidRoomKey(req) || isValidBearer(req);
}

export function authErrorResponse(message = "Unauthorized") {
  return Response.json({ error: message }, { status: 401 });
}

export function configErrorResponse(message: string) {
  return Response.json({ error: message }, { status: 503 });
}
