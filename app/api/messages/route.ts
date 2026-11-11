import { NextResponse } from "next/server";
import { z } from "zod";
import { appendMessage, listMessages } from "@/lib/store";
import {
  authErrorResponse,
  configErrorResponse,
  getApiToken,
  getRoomKey,
  isAuthorizedForMessages,
  isValidBearer,
  isValidRoomKey,
} from "@/lib/auth";
import { MAX_TEXT_LENGTH, SENDERS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  sender: z.enum(SENDERS),
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

export async function GET(req: Request) {
  if (!getRoomKey() && !getApiToken()) {
    return configErrorResponse("Server is not configured: set ROOM_KEY and API_TOKEN.");
  }
  if (!isAuthorizedForMessages(req)) return authErrorResponse();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const after = url.searchParams.get("after");
  let messages = await listMessages(Number.isFinite(limit) ? limit : 50);
  if (after) {
    const idx = messages.findIndex((m) => m.id === after);
    if (idx >= 0) messages = messages.slice(idx + 1);
  }
  return NextResponse.json({ messages });
}

export async function POST(req: Request) {
  if (!getRoomKey() && !getApiToken()) {
    return configErrorResponse("Server is not configured: set ROOM_KEY and API_TOKEN.");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { sender, text } = parsed.data;
  // Human UI (room key) may only post as You. AI agents (Bearer) may
  // post as ChatGPT or Muse — or as You only if they hold the token.
  const viaBearer = isValidBearer(req);
  const viaRoomKey = isValidRoomKey(req);
  if (!viaBearer && !viaRoomKey) return authErrorResponse();
  if (viaRoomKey && !viaBearer && sender !== "You") {
    return NextResponse.json(
      { error: "Room-key sessions may only post as You." },
      { status: 403 },
    );
  }
  const message = await appendMessage({
    sender,
    text,
    source: viaBearer ? "api" : "web",
  });
  return NextResponse.json({ message }, { status: 201 });
}
