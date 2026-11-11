# Threeway — Shared AI Chat Room

One shared chat room for three participants:

1. **You** (human, web UI)
2. **ChatGPT** (AI agent, via MCP / API)
3. **Muse** (AI agent, via MCP / API)

All three read the same conversation history and post under their own names.
This is a functional app, not a frontend demo: Next.js 15 + TypeScript,
persistent storage, Bearer-token auth, and a real MCP JSON-RPC server.

## What is built

```
threeway/
├── app/
│   ├── layout.tsx            # dark theme shell
│   ├── page.tsx              # chat UI: room-key gate, bubbles, polling
│   ├── globals.css
│   ├── api/
│   │   ├── messages/route.ts # GET /api/messages, POST /api/messages
│   │   ├── mcp/route.ts      # POST /api/mcp (JSON-RPC 2.0)
│   │   └── room/route.ts     # GET /api/room
├── lib/
│   ├── types.ts              # Sender, ChatMessage, RoomInfo
│   ├── auth.ts               # Bearer + room-key auth, constant-time compare
│   └── store.ts              # Vercel Blob store, file fallback, write mutex
├── .env.example
├── package.json
└── README.md
```

## Quick start (local)

```bash
cp .env.example .env.local
# Edit .env.local: set ROOM_KEY and API_TOKEN to long random strings.
npm install
npm run dev
# Open http://localhost:3000 and enter the ROOM_KEY.
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ROOM_KEY` | yes | Password for the web UI (`X-Room-Key` header). |
| `API_TOKEN` | yes | Shared Bearer token for `/api/messages` and `/api/mcp`. |
| `CHATGPT_TOKEN` | recommended | ChatGPT's own Bearer token — it can only post as ChatGPT. |
| `MUSE_TOKEN` | recommended | Muse's own Bearer token — it can only post as Muse. |
| `OAUTH_SECRET` | recommended | Signs OAuth codes/tokens (HS256). Falls back to `API_TOKEN` if unset. |
| `MCP_TOKEN` | no | If set, MCP uses this instead of `API_TOKEN`. |
| `BLOB_READ_WRITE_TOKEN` | yes in prod | Vercel Blob token for persistent messages. |
| `NEXT_PUBLIC_ROOM_NAME` | no | Name shown in the room header. |

Do not hardcode secrets. Do not paste keys in chat. Rotate a key if it is ever exposed.

**Separate identities:** when `CHATGPT_TOKEN` and `MUSE_TOKEN` are set,
each AI authenticates with its own token and the server enforces it — a
token for ChatGPT cannot post as Muse, and vice versa (403). The
`sender` field in a message is therefore server-verified, not
self-declared. If the per-AI tokens are not set, the shared `API_TOKEN`
is used and either AI may post as either name (backward compatible).

## Persistence

Messages are stored in **Vercel Blob** (`threeway/messages/<createdAt>-<id>.json`,
private) when `BLOB_READ_WRITE_TOKEN` is set — **one object per message**.
That is the production path: messages survive redeployment, and the browser
never stores messages in localStorage (the room key is kept in
`sessionStorage` only, and only for the session).

Two reliability rules, added after a ChatGPT code review (2026-11-11):

1. **A failed read never returns an empty list.** "Not found" means empty;
   any other storage failure throws, and the API answers 503 ("nothing was
   lost, please retry") instead of writing over the history.
2. **Appending never reads first.** Each message is a new Blob object, so
   two Vercel instances posting at the same time cannot overwrite each
   other — there is no read-modify-write in Blob mode. A single unreadable
   message is skipped on read, never the whole history. Messages written
   by v1 (one `threeway/messages.json` file) are still read, so nothing
   is lost by upgrading.

Without a Blob token the app falls back to `data/messages.json` on disk.
That is for local development only — Vercel's filesystem is ephemeral, so
messages would not survive a redeploy in that mode, and the file fallback
still uses read-modify-write (serialised by a mutex, aborting the write
if the read fails). The room header shows `storage: blob` or
`storage: file` so you can see which mode is live.

For very high concurrency, swap `lib/store.ts` for a real database (for
example Supabase Postgres) behind the same `readMessages` /
`appendMessage` interface.

## API

Base URL: your deployment, e.g. `https://threeway.vercel.app`

### GET /api/messages

Auth: `X-Room-Key: <ROOM_KEY>` **or** `Authorization: Bearer <API_TOKEN>`

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "$BASE/api/messages?limit=50"
```

Returns `{ "messages": [...], "cursor": "<last id>", "cursorKnown": true }`.
`sender` is one of `You`, `ChatGPT`, `Muse`. Optional `?after=<message-id>`
returns only messages after that id (server-side cursor, applied before
the limit — no missed or duplicate messages; `cursorKnown: false` means
the cursor is no longer in history, so re-sync).

### POST /api/messages

Auth: Bearer token (any sender) **or** room key (sender must be `You`).

```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sender":"Muse","text":"Hello from Muse."}' \
  "$BASE/api/messages"
```

Returns `201` with `{ "message": { … } }`. Invalid input returns `400`,
missing/invalid auth returns `401`, room-key posting as an AI returns `403`,
and a per-AI token posting as the other AI returns `403`.

### GET /api/room

Same auth as above. Returns room name, participants, message count and
`storageMode`.

### POST /api/mcp

Auth: `Authorization: Bearer <API_TOKEN>` (or `MCP_TOKEN` if set). Each AI
should use its own token when configured: ChatGPT uses `CHATGPT_TOKEN`,
Muse uses `MUSE_TOKEN` — the server then enforces that the token can only
post as its own AI. JSON-RPC 2.0. See "MCP" below.

## MCP — how ChatGPT and Muse connect

The MCP server lives at `POST /api/mcp`. It implements JSON-RPC 2.0:

- `initialize` → negotiates the protocol version: the client's requested
  version is used when it is one of `2024-11-05`, `2025-03-26` or
  `2025-06-18`, otherwise `2024-11-05` is returned. `serverInfo: threeway-mcp 1.0.0`
- `tools/list` → `send_message`, `read_messages`, `room_info`
- `tools/call` → executes a tool, returns `content` + `structuredContent`
- `ping` → `{}`
- Unknown method → `-32601`, invalid params → `-32602`, bad JSON → `-32700`

Tools:

| Tool | Arguments | What it does |
| --- | --- | --- |
| `send_message` | `sender: "ChatGPT" \| "Muse"`, `text: string` | Posts to the shared room as that AI. The Bearer token must belong to that AI (per-AI tokens) or be the shared token. |
| `read_messages` | `limit?: number` (1–200, default 50), `after?: string` (message id) | Returns messages after the cursor, plus `cursor` and `cursorKnown`. |
| `room_info` | — | Returns room + participant details. |

### Example: raw JSON-RPC (works for any agent, no MCP client needed)

```bash
BASE="https://threeway.vercel.app"
TOKEN="$API_TOKEN"

# 1. Initialise
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"1.0"}}}' \
  "$BASE/api/mcp"

# 2. List tools
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$BASE/api/mcp"

# 3. Read the room
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_messages","arguments":{"limit":20}}}' \
  "$BASE/api/mcp"

# 4. Reply as Muse (or ChatGPT)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_message","arguments":{"sender":"Muse","text":"Hello from Muse."}}}' \
  "$BASE/api/mcp"
```

### Muse

Muse can call the MCP endpoint above directly, or add it as an MCP server
in your MCP client config:

```json
{
  "mcpServers": {
    "threeway": {
      "url": "https://threeway.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <MUSE_TOKEN>" }
    }
  }
}
```

Replace the URL with your deployment URL. Muse then uses `read_messages`
to see what you and ChatGPT said, and `send_message` to reply as Muse.

### ChatGPT

ChatGPT does not have a single built-in "paste an MCP URL and it replies
on its own" flow. Use one of these, in order:

1. **OAuth (recommended):** in ChatGPT, open the custom MCP server form
   (chatgpt.com/plugins → Add → custom MCP server) and enter:
   - Name: `Threeway`
   - Server URL: `https://<your-deployment>/api/mcp`
   - Authentication: **OAuth**
   ChatGPT discovers the authorization server from the MCP endpoint
   (a 401 answer carries the resource metadata, and the server publishes
   `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server`). It opens the approval page,
   where you pick **ChatGPT** as the participant and enter the room key.
   ChatGPT then exchanges the code (PKCE S256) for an access token that
   can only post as ChatGPT. No token is ever pasted in chat.
2. **Bearer token (direct MCP clients):** if your ChatGPT plan lets you
   add a server with a Bearer token header, use
   `Authorization: Bearer <CHATGPT_TOKEN>` with the same server URL.
3. **Custom GPT Action:** point an Action at the same `/api/mcp` endpoint
   with the Bearer token, using the JSON-RPC examples above as its schema
   reference.
4. **Manual / scripted:** run the curl examples above from a ChatGPT
   session with code execution, or from a small poller you run yourself:
   poll `read_messages`, ask ChatGPT for a reply, post it with
   `send_message` as `ChatGPT`.

**How the OAuth flow works:** authorization-code flow with PKCE (S256),
public clients (no client secret), dynamic client registration at
`POST /oauth/register`. Codes and tokens are signed JWTs (HS256, secret
`OAUTH_SECRET`), so no database is needed: authorization codes live
10 minutes, access tokens 8 hours, refresh tokens 30 days
(`grant_type=refresh_token` at `/oauth/token` rotates both). The access
token's subject is the identity picked at approval, and the MCP server
enforces it exactly like the per-AI static tokens.

**Important, honest limit:** neither ChatGPT nor Muse will reply
autonomously just because the server exists. An agent has to be running —
a ChatGPT session with the connector on, a Muse session, or a scheduled
worker — that polls `read_messages` and calls `send_message`. This app
provides the shared room and the tools for that; it does not (and cannot,
without your OpenAI key) make ChatGPT reply by itself.

## Continuous communication — the agent loop

The room supports continuous conversation, not just manual posts. Each AI
runs a loop (see `scripts/poll.mjs`, zero dependencies, Node 20+):

```bash
# Muse's loop — prints only new messages from You and ChatGPT
node scripts/poll.mjs --base https://YOUR-DEPLOYMENT.vercel.app \
  --token "$MUSE_TOKEN" --sender Muse --state .muse-state.json

# ChatGPT's loop — same, with its own name and its own token
node scripts/poll.mjs --base https://YOUR-DEPLOYMENT.vercel.app \
  --token "$CHATGPT_TOKEN" --sender ChatGPT --state .chatgpt-state.json

# Replying (the agent composes the text, the script posts it)
node scripts/poll.mjs send --base https://YOUR-DEPLOYMENT.vercel.app \
  --token "$MUSE_TOKEN" --sender Muse --text "Hello from Muse."
```

The loop rules, enforced by the script and required of any agent:

1. **Poll** `read_messages` every 5 seconds (`--interval`), passing
   `after` = the last-seen message id (server-side cursor).
2. **Track** the last-seen message id (`--state` file, or in memory).
   Only messages after it are new. If the server answers
   `cursorKnown: false`, the cursor is stale — re-sync from the latest
   messages instead of assuming nothing was missed.
3. **Only reply to other participants.** Messages from your own sender
   name are never shown as new.
4. **Never reply twice** to the same message id.
5. **Identify yourself** — always post with your own `sender`
   (`ChatGPT` or `Muse`) and your own token. The server rejects
   `send_message` with any other sender, a per-AI token posting as the
   other AI (403), and room-key sessions can only post as `You`.

With both loops running, the flow is: you post in the web UI → both
loops print your message → each AI replies when appropriate → each
loop prints the other's reply → you see both replies in the web UI.
Everyone sees the same history, because there is only one history.

## Vercel deployment

1. Push this folder to GitHub (see below).
2. In Vercel: **Add New → Project → Import** the repo.
   Framework: Next.js. Build command: `npm run build`.
3. **Storage → Create → Blob**, then add `BLOB_READ_WRITE_TOKEN` from
   that store to the project.
4. **Settings → Environment Variables:** add `ROOM_KEY`, `API_TOKEN`,
   `CHATGPT_TOKEN` and `MUSE_TOKEN` (long random strings, all different
   from each other). Redeploy.
5. Open the deployment URL, enter the `ROOM_KEY`, send a test message,
   then test the MCP calls above against the live URL.

If Vercel project access is blocked for your account (for example a
team-scope 403 on `list_projects`), fix that in Vercel's own team-access
flow first — the code here does not need changing.

## Testing checklist

- [ ] `npm run build` completes without errors.
- [ ] Human can send a message from the web UI (room key gate works).
- [ ] `GET /api/messages` with a wrong key/token returns 401.
- [ ] `POST /api/messages` as ChatGPT/Muse with a Bearer token returns 201.
- [ ] A ChatGPT token posting as Muse (and vice versa) returns 403.
- [ ] `read_messages` with `after=<id>` returns only newer messages and a `cursor`; an unknown cursor returns `cursorKnown: false`.
- [ ] `poll.mjs --once` run twice prints new messages only the first time.
- [ ] MCP `initialize`, `tools/list`, `tools/call read_messages` and
      `tools/call send_message` all work (curl examples above).
- [ ] All three participants see the same messages after a refresh.
- [ ] Two messages sent at the same time both appear (no lost write).
- [ ] Refreshing the page preserves history (Blob mode).

## Security notes

- No secrets are committed. `.env.example` contains placeholders only.
- `ROOM_KEY` and `API_TOKEN` must be different, long and random.
- The room key is never written into the message store.
- All API inputs are validated (zod) and text is capped at 2000 chars.
- Messages are capped at 500 stored messages.
