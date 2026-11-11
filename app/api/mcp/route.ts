import { NextResponse } from "next/server";
import { z } from "zod";
import { appendMessage, listMessages, roomInfo } from "@/lib/store";
import { configErrorResponse, getMcpToken, isValidMcpBearer } from "@/lib/auth";
import { MAX_TEXT_LENGTH, SENDERS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOOLS = [
  {
    name: "send_message",
    description:
      "Send a message to the shared Threeway chat room as ChatGPT or Muse.",
    inputSchema: {
      type: "object",
      properties: {
        sender: { type: "string", enum: ["ChatGPT", "Muse"] },
        text: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
      },
      required: ["sender", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "read_messages",
    description: "Retrieve recent messages from the shared Threeway chat room.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "room_info",
    description: "Return room information and participant details.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

const sendSchema = z.object({
  sender: z.enum(["ChatGPT", "Muse"]),
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});
const readSchema = z.object({ limit: z.number().int().min(1).max(200).default(50) });

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}
function toolText(id: unknown, payload: unknown) {
  return rpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });
}

export async function POST(req: Request) {
  if (!getMcpToken()) {
    return configErrorResponse("Server is not configured: set API_TOKEN (or MCP_TOKEN).");
  }
  if (!isValidMcpBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error: invalid JSON.");
  }
  const rpc = body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return rpcError(rpc.id, -32600, "Invalid Request: expected JSON-RPC 2.0 with a method.");
  }
  const isNotification = rpc.id === undefined || rpc.id === null;
  const method = rpc.method;
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  // Notifications (e.g. notifications/initialized) get no JSON-RPC reply.
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202 });
  }

  if (method === "initialize") {
    return rpcResult(rpc.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "threeway-mcp", version: "1.0.0" },
    });
  }
  if (method === "ping") return rpcResult(rpc.id, {});
  if (method === "tools/list") return rpcResult(rpc.id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === "send_message") {
      const parsed = sendSchema.safeParse(args);
      if (!parsed.success) return rpcError(rpc.id, -32602, "Invalid params for send_message.");
      const message = await appendMessage({ ...parsed.data, source: "mcp" });
      return toolText(rpc.id, { message });
    }
    if (name === "read_messages") {
      const parsed = readSchema.safeParse(args);
      if (!parsed.success) return rpcError(rpc.id, -32602, "Invalid params for read_messages.");
      const messages = await listMessages(parsed.data.limit);
      return toolText(rpc.id, { messages });
    }
    if (name === "room_info") {
      return toolText(rpc.id, await roomInfo());
    }
    return rpcError(rpc.id, -32602, `Unknown tool: ${name ?? "(missing)"}.`);
  }

  return rpcError(rpc.id, -32601, `Method not found: ${method}.`);
}

export async function GET() {
  return NextResponse.json(
    {
      error: "Method not allowed. POST JSON-RPC 2.0 to this endpoint with a Bearer token.",
      tools: TOOLS.map((t) => t.name),
    },
    { status: 405 },
  );
}
