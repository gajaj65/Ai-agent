import { timingSafeEqual } from "node:crypto";

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

function bearerToken(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  if (!h || !h.toLowerCase().startsWith("bearer ")) return undefined;
  return h.slice(7).trim() || undefined;
}

/**
 * Separate authenticated identities (ChatGPT review, 2026-11-11):
 * when CHATGPT_TOKEN / MUSE_TOKEN are set, each AI has its own token and
 * the token — not the self-declared `sender` field — decides who is
 * posting. Returns the identity the Bearer token proves, or null.
 * A shared API_TOKEN (or MCP_TOKEN) proves only "api": either AI, for
 * backward compatibility when per-AI tokens are not configured.
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
