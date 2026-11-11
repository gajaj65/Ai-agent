import { NextResponse } from "next/server";
import { z } from "zod";
import { appendMessage, listMessagesAfter } from "@/lib/store";
import {
  authErrorResponse,
  bearerMayPostAs,
  configErrorResponse,
  getApiToken,
  getRoomKey,
  identifyBearer,
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
  let page;
  try {
    // Server-side cursor: applied against full history before the limit,
    // so polling can never silently miss or re-read messages.
    page = await listMessagesAfter(after, Number.isFinite(limit) ? limit : 50);
  } catch {
    return NextResponse.json(
      { error: "Storage temporarily unavailable. Please retry — nothing was lost." },
      { status: 503 },
    );
  }
  return NextResponse.json(page);
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
  // post as ChatGPT or Muse — a per-AI token only as its own AI, so one
  // AI can never impersonate the other.
  const viaBearer = isValidBearer(req) || identifyBearer(req) !== null;
  const viaRoomKey = isValidRoomKey(req);
  if (!viaBearer && !viaRoomKey) return authErrorResponse();
  if (viaRoomKey && !viaBearer && sender !== "You") {
    return NextResponse.json(
      { error: "Room-key sessions may only post as You." },
      { status: 403 },
    );
  }
  if (viaBearer && sender !== "You" && !bearerMayPostAs(req, sender)) {
    const identity = identifyBearer(req);
    return NextResponse.json(
      {
        error:
          identity && identity !== "api"
            ? `This token belongs to ${identity}; it cannot post as ${sender}.`
            : "This token cannot post as the requested sender.",
      },
      { status: 403 },
    );
  }
  let message;
  try {
    message = await appendMessage({
      sender,
      text,
      source: viaBearer ? "api" : "web",
    });
  } catch {
    return NextResponse.json(
      { error: "Storage temporarily unavailable. Message was not saved — please retry." },
      { status: 503 },
    );
  }
  return NextResponse.json({ message }, { status: 201 });
}
