import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { createSupabaseClient } from "./db/client";
import { buildMeta } from "./response";
import type { ApiMeta } from "./response";
import { registerReadTools } from "./tools/read";
import { registerMaintenanceTools } from "./tools/maintenance";

export class LtsMCP extends McpAgent {
  server = new McpServer({
    name: "ren-lts",
    version: "1.0.0",
  });

  async init() {
    const client = createSupabaseClient(this.env.SUPABASE_URL, this.env.SUPABASE_ANON_KEY);
    const meta: ApiMeta = buildMeta({
      lastSynced: this.env.LAST_SYNCED,
    });

    registerReadTools(this.server, client, meta);
    registerMaintenanceTools(this.server, client, meta);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return LtsMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response(
      "REN.PH LTS MCP Server - DHSUD License to Sell data.\nConnect via /mcp endpoint.",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      },
    );
  },
};
