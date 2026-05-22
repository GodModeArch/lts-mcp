import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { createSupabaseClient } from "./db/client";
import { buildMeta } from "./response";
import type { ApiMeta } from "./response";
import { registerReadTools } from "./tools/read";
import { registerMaintenanceTools } from "./tools/maintenance";
import { registerAnalyticsTools } from "./tools/analytics";
import {
  checkRequiredConfig,
  probeDatabase,
  buildHealthReport,
  healthHttpStatus,
} from "./health";

const SERVER_VERSION = "1.0.0";

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
    registerAnalyticsTools(this.server, client, meta);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const envRecord = env as unknown as Record<string, unknown>;

    // Health check: config presence + a live DB probe. Returns 200 only when
    // both pass, 503 otherwise, so an uptime monitor catches the exact failure
    // (misconfigured secrets vs DB unreachable) instead of a silent hang.
    if (url.pathname === "/health") {
      const config = checkRequiredConfig(envRecord);
      const database = config.ok
        ? await probeDatabase(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY))
        : { ok: false, error: "skipped: missing required config" };
      const report = buildHealthReport(config, database, SERVER_VERSION);
      return Response.json(report, {
        status: healthHttpStatus(report.status),
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/mcp") {
      // Fail fast on misconfiguration. Without this the missing-secret error
      // throws inside the MCP transport and the handshake hangs with no
      // actionable response to the client.
      const config = checkRequiredConfig(envRecord);
      if (!config.ok) {
        return Response.json(
          {
            error: "Server misconfigured: required secrets are not set.",
            missing: config.missing,
            hint: "Set each with: npx wrangler secret put <NAME>",
          },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      return LtsMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response(
      "REN.PH LTS MCP Server - DHSUD License to Sell data.\nConnect via /mcp endpoint. Health at /health.",
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
