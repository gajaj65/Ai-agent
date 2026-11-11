import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, RoomInfo, Sender } from "./types";
import { MAX_MESSAGES } from "./types";

const BLOB_PATH = "threeway/messages.json";
const FILE_PATH = path.join(process.cwd(), "data", "messages.json");

export function storageMode(): "blob" | "file" {
  return process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "file";
}

/** In-process mutex: serialises read-modify-write so simultaneous
 *  messages on one server instance cannot overwrite each other.
 *  Blob itself is last-write-wins across instances — see README. */
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function readBlob(): Promise<ChatMessage[]> {
  try {
    const { get } = await import("@vercel/blob");
    const result = await get(BLOB_PATH, { access: "private", useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text) as unknown;
    return Array.isArray(data) ? (data as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

async function writeBlob(messages: ChatMessage[]): Promise<void> {
  const { put } = await import("@vercel/blob");
  await put(BLOB_PATH, JSON.stringify(messages), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function readFile(): Promise<ChatMessage[]> {
  try {
    const raw = await fs.readFile(FILE_PATH, "utf-8");
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? (data as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

async function writeFile(messages: ChatMessage[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(messages, null, 2), "utf-8");
  await fs.rename(tmp, FILE_PATH); // atomic replace
}

export async function readMessages(): Promise<ChatMessage[]> {
  return storageMode() === "blob" ? readBlob() : readFile();
}

async function writeMessages(messages: ChatMessage[]): Promise<void> {
  return storageMode() === "blob" ? writeBlob(messages) : writeFile(messages);
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
  return withLock(async () => {
    const all = await readMessages();
    const message: ChatMessage = {
      id: randomUUID(),
      sender: input.sender,
      text: input.text,
      createdAt: new Date().toISOString(),
      source: input.source,
    };
    const next = [...all, message].slice(-MAX_MESSAGES);
    await writeMessages(next);
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
