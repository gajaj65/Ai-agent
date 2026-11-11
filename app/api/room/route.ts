import { NextResponse } from "next/server";
import { roomInfo } from "@/lib/store";
import { authErrorResponse, getApiToken, getRoomKey, isAuthorizedForMessages } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!getRoomKey() && !getApiToken()) {
    return NextResponse.json({ error: "Server is not configured." }, { status: 503 });
  }
  if (!isAuthorizedForMessages(req)) return authErrorResponse();
  try {
    return NextResponse.json(await roomInfo());
  } catch {
    return NextResponse.json(
      { error: "Storage temporarily unavailable. Please retry." },
      { status: 503 },
    );
  }
}
