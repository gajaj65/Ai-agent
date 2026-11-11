import { originOf } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected-resource metadata. MCP clients (including ChatGPT)
 * fetch this first to learn which authorization server protects the
 * Threeway MCP endpoint and where to authenticate.
 */
export async function GET(req: Request) {
  const origin = originOf(req);
  return Response.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/`,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
