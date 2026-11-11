import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, RoomInfo, Sender } from "./types";
import { MAX_MESSAGES } from "./types";

/**
 * Storage design (fixes ChatGPT's review, 2026-11-11):
 *
 * 1. Reliability: a failed read NEVER returns an empty list. "Not found"
 *    means empty; any other failure throws, and callers turn that into a
 *    503 instead of writing over the history.
 *
 * 2. Concurrent writes: in Blob mode each message is its own object,
 *    `threeway/messages/<createdAt>-<id>.json`. Appending never reads
 *    first, so two Vercel instances can never overwrite each other —
 *    there is no read-modify-write at all. A legacy single-file blob
 *    (`threeway/messages.json`, from v1) is still read on list, so
 *    messages written before this change are not lost.
 *
 *    The local-file fallback (dev only) still uses read-modify-write,
 *    serialised by an in-process mutex, and a failed read aborts the
 *    write instead of overwriting the file.
 */
const BLOB_PREFIX = "threeway/messages/";
const LEGACY_BLOB_PATH = "threeway/messages.json";
const FILE_PATH = path.join(process.cwd(), "data", "messages.json");

export function storageMode(): "blob" | "file" {
  return process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "file";
}

/** In-process mutex, used only by the local-file fallback. */
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function isValidMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.sender === "You" || m.sender === "ChatGPT" || m.sender === "Muse") &&
    typeof m.text === "string" &&
    typeof m.createdAt === "string"
  );
}

/* ---------------- Blob mode: one object per message ---------------- */

async function readBlobMessages(): Promise<ChatMessage[]> {
  const { list, get } = await import("@vercel/blob");
  // list() throwing means storage is unavailable — propagate, never [].
  const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 1000 });
  const out: ChatMessage[] = [];
  for (const blob of blobs) {
    try {
      const result = await get(blob.pathname, { access: "private", useCache: false });
      if (!result?.stream) continue;
      const parsed = JSON.parse(await new Response(result.stream).text()) as unknown;
      if (isValidMessage(parsed)) out.push(parsed);
      // One unreadable message is skipped, never the whole history.
    } catch {
      continue;
    }
  }
  // Legacy v1 single-file blob, if it still exists.
  try {
    const legacy = await get(LEGACY_BLOB_PATH, { access: "private", useCache: false });
    if (legacy?.stream) {
      const data = JSON.parse(await new Response(legacy.stream).text()) as unknown;
      if (Array.isArray(data)) {
        for (const m of data) if (isValidMessage(m)) out.push(m);
      }
    }
  } catch {
    // No legacy blob, or it is unreadable — ignore, history is in per-message blobs.
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return out;
}

async function appendBlobMessage(message: ChatMessage): Promise<void> {
  const { put } = await import("@vercel/blob");
  await put(`${BLOB_PREFIX}${message.createdAt}-${message.id}.json`, JSON.stringify(message), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
  });
  // Best-effort trim: never let trimming fail the append.
  try {
    const { list, del } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 1000 });
    if (blobs.length > MAX_MESSAGES) {
      const sorted = [...blobs].sort((a, b) => a.pathname.localeCompare(b.pathname));
      const excess = sorted.slice(0, blobs.length - MAX_MESSAGES);
      await del(excess.map((b) => b.url));
    }
  } catch {
    // Trim later; extra messages are harmless.
  }
}

/* ---------------- File mode (local dev only) ---------------- */

async function readFileMessages(): Promise<ChatMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no history yet
    throw err; // any other failure: propagate, never pretend history is empty
  }
  const data = JSON.parse(raw) as unknown; // corrupt file throws — do not overwrite it
  return Array.isArray(data) ? data.filter(isValidMessage) : [];
}

async function writeFileMessages(messages: ChatMessage[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(messages, null, 2), "utf-8");
  await fs.rename(tmp, FILE_PATH); // atomic replace
}

/* ---------------- Public interface ---------------- */

export async function readMessages(): Promise<ChatMessage[]> {
  return storageMode() === "blob" ? readBlobMessages() : readFileMessages();
}

export async function listMessages(limit = 50): Promise<ChatMessage[]> {
  const all = await readMessages();
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return all.slice(-n);
}

export async function appendMessage(input: {
  sender: Sender;
  text: string;
  source: ChatMessage["source"];
}): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: randomUUID(),
    sender: input.sender,
    text: input.text,
    createdAt: new Date().toISOString(),
    source: input.source,
  };
  if (storageMode() === "blob") {
    // No read before write: concurrent instances cannot overwrite each other.
    await appendBlobMessage(message);
    return message;
  }
  return withLock(async () => {
    const all = await readFileMessages(); // throws on failure — write is aborted
    const next = [...all, message].slice(-MAX_MESSAGES);
    await writeFileMessages(next);
    return message;
  });
}

export async function roomInfo(): Promise<RoomInfo> {
  const messages = await readMessages();
  const lastSeen = (sender: Sender): string => {
    const found = [...messages].reverse().find((m) => m.sender === sender);
    return found ? `last message ${found.createdAt}` : "no messages yet";
  };
  return {
    name: process.env.NEXT_PUBLIC_ROOM_NAME || "Threeway",
    participants: [
      { name: "You", role: "Human — web UI", status: lastSeen("You") },
      { name: "ChatGPT", role: "AI agent — MCP / API", status: lastSeen("ChatGPT") },
      { name: "Muse", role: "AI agent — MCP / API", status: lastSeen("Muse") },
    ],
    messageCount: messages.length,
    storageMode: storageMode(),
    updatedAt: messages.length ? messages[messages.length - 1].createdAt : null,
  };
}
