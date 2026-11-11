import { timingSafeEqual } from "node:crypto";
import { mintAuthCode } from "@/lib/oauth";
import { getRoomKey } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth 2.1 authorization endpoint (PKCE, public clients).
 *
 * GET  /oauth/authorize?response_type=code&client_id=…&redirect_uri=…
 *      &code_challenge=…&code_challenge_method=S256&state=…
 *      → approval page: the room owner picks which AI this grant is for
 *        (ChatGPT or Muse) and enters the ROOM_KEY.
 * POST /oauth/authorize (same params as hidden fields + identity + roomKey)
 *      → verifies the room key, mints a 10-minute authorization code bound
 *        to that identity + PKCE challenge, redirects to redirect_uri.
 *
 * The code — not the room key — is what the client exchanges at
 * /oauth/token. The issued access token can only post as the identity
 * chosen here, so ChatGPT can never post as Muse, and vice versa.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  error?: string;
}): string {
  const { clientId, redirectUri, state, challenge, error } = params;
  let host = "";
  try {
    host = new URL(redirectUri).host;
  } catch {
    host = redirectUri;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Threeway</title>
<style>body{margin:0;background:#0b0e14;color:#e6e9ef;font-family:system-ui,-apple-system,sans-serif}main{max-width:460px;margin:0 auto;padding:32px 20px}h1{font-size:22px;margin:0 0 8px}p{color:#9aa3b2;line-height:1.5;font-size:15px}.card{background:#141a26;border:1px solid #263049;border-radius:14px;padding:20px;margin-top:20px}label{display:block;font-size:14px;margin:16px 0 6px}.idrow{display:flex;gap:10px}.idrow label{flex:1;border:1px solid #263049;border-radius:10px;padding:12px;margin:0;cursor:pointer}.idrow input{accent-color:#7c9cff}input[type=password]{width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #263049;border-radius:10px;color:#e6e9ef;padding:12px;font-size:16px}button{width:100%;margin-top:20px;background:#7c9cff;color:#0b0e14;border:0;border-radius:10px;padding:13px;font-size:16px;font-weight:700;cursor:pointer}.err{background:#3a1d1d;border:1px solid #7a2e2e;color:#ffb4b4;border-radius:10px;padding:12px;font-size:14px}.muted{font-size:13px;color:#7d8698}.mono{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}</style>
</head><body><main>
<h1>Connect to Threeway</h1>
<p>An AI assistant wants to join the shared Threeway chat room. Choose which participant this connection is for, and confirm with the room key. The connection will only ever be able to post as the participant you pick.</p>
<div class="card">
<p class="muted">Request from <span class="mono">${esc(clientId)}</span><br>Will return to <span class="mono">${esc(host)}</span></p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${esc(clientId)}">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
<input type="hidden" name="state" value="${esc(state)}">
<input type="hidden" name="code_challenge" value="${esc(challenge)}">
<label>Connect as</label>
<div class="idrow">
<label><input type="radio" name="identity" value="ChatGPT" checked> ChatGPT</label>
<label><input type="radio" name="identity" value="Muse"> Muse</label>
</div>
<label for="roomKey">Room key</label>
<input id="roomKey" type="password" name="roomKey" autocomplete="off" placeholder="Enter the Threeway room key" required>
<button type="submit">Approve connection</button>
</form>
<p class="muted">The room key is checked on the server and never stored in the message history. Deny by closing this page.</p>
</div></main></body></html>`;
}

function errorPage(message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Threeway — authorization error</title></head><body style="background:#0b0e14;color:#e6e9ef;font-family:system-ui;padding:32px"><h1>Could not start the connection</h1><p>${esc(message)}</p></body></html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function readParams(url: URL) {
  return {
    responseType: url.searchParams.get("response_type") ?? "",
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
    method: url.searchParams.get("code_challenge_method") ?? "",
    state: url.searchParams.get("state") ?? "",
  };
}

export async function GET(req: Request) {
  const p = readParams(new URL(req.url));
  if (p.responseType !== "code") {
    return errorPage("This server only supports response_type=code (authorization-code flow with PKCE).");
  }
  if (!p.clientId || !p.redirectUri || !p.challenge) {
    return errorPage("Missing client_id, redirect_uri or code_challenge.");
  }
  if (p.method !== "S256") {
    return errorPage("Only code_challenge_method=S256 (PKCE) is supported.");
  }
  try {
    new URL(p.redirectUri);
  } catch {
    return errorPage("redirect_uri is not a valid URL.");
  }
  return new Response(page(p), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state");
  const challenge = get("code_challenge");
  const identity = get("identity");
  const roomKey = get("roomKey");
  const base = { clientId, redirectUri, state, challenge };

  if (!clientId || !redirectUri || !challenge) {
    return errorPage("Missing client_id, redirect_uri or code_challenge.");
  }
  if (identity !== "ChatGPT" && identity !== "Muse") {
    return new Response(page({ ...base, error: "Pick ChatGPT or Muse." }), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const expected = getRoomKey();
  let ok = false;
  if (expected && roomKey) {
    const a = Buffer.from(roomKey);
    const b = Buffer.from(expected);
    ok = a.length === b.length && timingSafeEqual(a, b);
  }
  if (!ok) {
    return new Response(page({ ...base, error: "Wrong room key. Try again." }), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return errorPage("redirect_uri is not a valid URL.");
  }
  const code = mintAuthCode({ identity, challenge, redirectUri, clientId });
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}
