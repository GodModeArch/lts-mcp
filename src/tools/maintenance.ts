import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "../db/client";
import type { ApiMeta } from "../response";
import { getFilterValues } from "../db/queries";
import { toolResult, safeToolError } from "../utils";

export function registerMaintenanceTools(server: McpServer, client: SupabaseClient, meta: ApiMeta) {
  // -- lts_filters --
  server.tool(
    "lts_filters",
    "Get available filter values for LTS queries. Returns distinct regions and cities from the verification queue. Optionally filter cities by region. Use this before calling lts_queue or lts_search with region/city filters to get valid values.",
    {
      region: z.string().optional().describe("If provided, only return cities within this region"),
    },
    async ({ region }) => {
      try {
        const filters = await getFilterValues(client, region);
        return toolResult(filters, meta);
      } catch (err) {
        return safeToolError("Filters query failed.", err);
      }
    }
  );
}
