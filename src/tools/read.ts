import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "../db/client";
import type { ApiMeta } from "../response";
import { search, getLTSRecordItems, getProjectLTS, findProjectByName, getStats, checkLTSNumber } from "../db/queries";
import { toolResult, toolError, safeToolError } from "../utils";

export function registerReadTools(server: McpServer, client: SupabaseClient, meta: ApiMeta) {
  // -- lts_search --
  server.tool(
    "lts_search",
    "Search across DHSUD LTS records and published projects by name, LTS number, developer, or city. Returns matches from both lts_records and published projects. Universal entry point for LTS data.",
    {
      query: z.string().min(2).describe("Search term: project name, LTS number, developer name, or city. Matched as a literal substring; use * as a wildcard"),
      limit: z.number().int().positive().max(50).default(20).describe("Max results per category"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ query, limit, offset }) => {
      try {
        const results = await search(client, query, { limit, offset });
        return toolResult(results, meta);
      } catch (err) {
        return safeToolError("Search failed. Try a different query.", err);
      }
    }
  );

  // -- lts_records (was lts_queue) --
  server.tool(
    "lts_records",
    "Browse LTS records from DHSUD with filters. Shows normalized records with confidence levels. Filter by confidence (high/medium), linked status (has project_id), region, or text search. Use expiringWithinDays to find records expiring soon.",
    {
      confidence: z
        .enum(["high", "medium"])
        .optional()
        .describe("Filter by data confidence level"),
      linked: z
        .boolean()
        .optional()
        .describe("true = linked to project, false = unlinked"),
      region: z.string().optional().describe("Filter by region (use lts_filters to get valid values)"),
      search: z.string().optional().describe("Text search: project name, LTS number, or developer. Matched as a literal substring; use * as a wildcard"),
      expiringWithinDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Show records with expiry date within N days from today"),
      sortBy: z
        .enum(["expiry_date", "created_at", "normalized_project_name"])
        .default("created_at")
        .describe("Sort field"),
      sortOrder: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
      limit: z.number().int().positive().max(100).default(20).describe("Max results"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ confidence, linked, region, search, expiringWithinDays, sortBy, sortOrder, limit, offset }) => {
      try {
        const results = await getLTSRecordItems(client, {
          confidence,
          linked,
          region,
          search,
          expiringWithinDays,
          sortBy,
          sortOrder,
          limit,
          offset,
        });
        return toolResult(results, meta);
      } catch (err) {
        return safeToolError("LTS records query failed. Adjust filters and retry.", err);
      }
    }
  );

  // -- lts_project --
  server.tool(
    "lts_project",
    "Get the complete LTS picture for a single project: all LTS records with computed fields (is_expired, days_until_expiry), summary counts, and the primary LTS number. Pass either a project UUID or a project name (fuzzy matched).",
    {
      projectId: z.string().uuid().optional().describe("Project UUID. Takes priority over projectName if both provided"),
      projectName: z.string().optional().describe("Project name or slug for fuzzy lookup. Matched as a literal substring; use * as a wildcard. Use when you don't have the UUID"),
    },
    async ({ projectId, projectName }) => {
      try {
        let id = projectId;

        if (!id && projectName) {
          const project = await findProjectByName(client, projectName);
          if (!project) {
            return toolError(
              `No published project found matching "${projectName}". Use lts_search to find projects by name.`
            );
          }
          id = project.id;
        }

        if (!id) {
          return toolError("Provide either projectId (UUID) or projectName.");
        }

        const result = await getProjectLTS(client, id);
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("Project LTS query failed.", err);
      }
    }
  );

  // -- lts_stats --
  server.tool(
    "lts_stats",
    "Get system-wide LTS statistics. Returns two sections: (1) lts_records stats (total, by confidence, linked/unlinked, active/expired, unique developers/cities), and (2) project LTS stats (total records, verified, expired, expiring within 30 days, projects with LTS).",
    {},
    async () => {
      try {
        const stats = await getStats(client);
        return toolResult(stats, meta);
      } catch (err) {
        return safeToolError("Stats query failed.", err);
      }
    }
  );

  // -- lts_check --
  server.tool(
    "lts_check",
    "Check if a specific LTS number exists in the system. Returns whether it exists in lts_records, in project_lts, or both. Includes full record details when found.",
    {
      ltsNumber: z.string().min(1).describe("The LTS number to look up (e.g., 'LS 0001234')"),
    },
    async ({ ltsNumber }) => {
      try {
        const result = await checkLTSNumber(client, ltsNumber);
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("LTS check failed.", err);
      }
    }
  );
}
