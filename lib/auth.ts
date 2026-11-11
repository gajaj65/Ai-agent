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

export function getMcpToken(): string | undefined {
  return process.env.MCP_TOKEN || process.env.API_TOKEN || undefined;
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  if (!h || !h.toLowerCase().startsWith("bearer ")) return undefined;
  return h.slice(7).trim() || undefined;
}

/** True when the request carries a valid Bearer API token. */
export function isValidBearer(req: Request, expected?: string): boolean {
  const token = expected ?? getApiToken();
  if (!token) return false;
  const given = bearerToken(req);
  return !!given && safeEqual(given, token);
}

/** True when the request carries a valid Bearer MCP token. */
export function isValidMcpBearer(req: Request): boolean {
  return isValidBearer(req, getMcpToken());
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
