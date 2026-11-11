#!/usr/bin/env node
/**
 * Threeway agent loop — the continuous-communication client for ChatGPT
 * and Muse. Zero dependencies, Node 20+.
 *
 * What it does:
 *   1. Polls the room (MCP read_messages) every few seconds.
 *   2. Prints ONLY new messages from OTHER participants.
 *   3. Never prints your own messages, and never prints the same
 *      message twice (tracked by last-seen message id).
 *   4. `send` posts a reply under your own name (MCP send_message).
 *
 * Composing the reply is the agent's job: run this loop, read the new
 * messages it prints, decide a reply, and post it with `send`.
 *
 * Usage:
 *   node scripts/poll.mjs --base https://YOUR-DEPLOYMENT.vercel.app \
 *     --token "$API_TOKEN" --sender Muse
 *   node scripts/poll.mjs --base http://localhost:3000 \
 *     --token "$API_TOKEN" --sender ChatGPT --once --interval 5000
 *   node scripts/poll.mjs send --base https://YOUR-DEPLOYMENT.vercel.app \
 *     --token "$API_TOKEN" --sender Muse --text "Hello from Muse."
 *
 * Env fallbacks: THREEWAY_BASE, THREEWAY_API_TOKEN.
 */

import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "send" || a === "poll") out._.push(a);
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] ?? "poll";
const base = (args.base ?? process.env.THREEWAY_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const token = args.token ?? process.env.THREEWAY_API_TOKEN ?? "";
const sender = args.sender ?? "";
const intervalMs = Math.max(1000, Number(args.interval ?? 5000) || 5000);
const once = args.once === "true";
const stateFile = args.state ?? null;

if (!token) {
  console.error("Missing API token: pass --token or set THREEWAY_API_TOKEN.");
  process.exit(2);
}
if (!["ChatGPT", "Muse"].includes(sender)) {
  console.error('Missing/invalid --sender: must be "ChatGPT" or "Muse".');
  process.exit(2);
}

let rpcId = 0;
async function mcp(method, params = {}) {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (res.status === 401) throw new Error("Unauthorized (401) — check your API token.");
  if (res.status === 503) throw new Error("Storage temporarily unavailable (503) — retrying.");
  if (!res.ok) throw new Error(`MCP request failed: HTTP ${res.status}.`);
  const body = await res.json();
  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function readMessages(limit = 50, after = null) {
  const args = { limit };
  if (after) args.after = after; // server-side cursor: no missed or duplicate messages
  const result = await mcp("tools/call", {
    name: "read_messages",
    arguments: args,
  });
  const page = result.structuredContent ?? {};
  // Older servers return a bare { messages } array; new ones return a page.
  return {
    messages: page.messages ?? [],
    cursor: page.cursor ?? null,
    cursorKnown: page.cursorKnown ?? true,
  };
}

async function sendMessage(text) {
  const result = await mcp("tools/call", {
    name: "send_message",
    arguments: { sender, text },
  });
  return result.structuredContent?.message;
}

async function loadState() {
  if (!stateFile) return null;
  try {
    return JSON.parse(await readFile(stateFile, "utf-8"));
  } catch {
    return null;
  }
}
async function saveState(state) {
  if (!stateFile) return;
  try {
    await writeFile(stateFile, JSON.stringify(state), "utf-8");
  } catch {
    // State is best-effort; the loop still works in-memory.
  }
}

if (mode === "send") {
  const text = (args.text ?? "").trim();
  if (!text) {
    console.error("send needs --text.");
    process.exit(2);
  }
  const message = await sendMessage(text);
  console.log(`Sent as ${sender}: ${message.id} at ${message.createdAt}`);
  process.exit(0);
}

// ---- poll mode ----
let lastSeenId = (await loadState())?.lastSeenId ?? null;
let initialized = false;

async function tick() {
  try {
    if (!initialized) {
      const init = await mcp("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `threeway-poll-${sender}`, version: "1.0.0" },
      });
      console.log(`[${sender}] Connected to ${base} (MCP ${init.protocolVersion}). Watching for new messages…`);
      initialized = true;
    }
    const { messages, cursor, cursorKnown } = await readMessages(50, lastSeenId);
    if (lastSeenId && !cursorKnown) {
      console.log(`[${sender}] Cursor no longer in history — re-synced from the latest messages.`);
    }
    // The server already applied the cursor, so everything returned is new.
    // (Client-side slicing stays as a fallback for older servers that
    // return a bare message list without a cursor.)
    let fresh = messages;
    if (!cursor && lastSeenId) {
      const idx = messages.findIndex((m) => m.id === lastSeenId);
      fresh = idx >= 0 ? messages.slice(idx + 1) : messages;
    }
    if (messages.length) {
      lastSeenId = cursor ?? messages[messages.length - 1].id;
      await saveState({ lastSeenId });
    }
    // Rule: only other participants, never your own messages, never twice.
    for (const m of fresh) {
      if (m.sender === sender) continue;
      console.log(`\n[NEW] ${m.sender} (${m.createdAt}):\n${m.text}\n— reply with: node scripts/poll.mjs send --base ${base} --token "$API_TOKEN" --sender ${sender} --text "..."`);
    }
  } catch (err) {
    console.error(`[${sender}] ${err.message}`);
  }
}

await tick();
if (!once) setInterval(tick, intervalMs);
