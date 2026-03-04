import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "../db/client";
import type { ApiMeta } from "../response";
import { search, getQueueItems, getProjectLTS, findProjectByName, getStats, checkLTSNumber } from "../db/queries";
import { toolResult, toolError, safeToolError } from "../utils";

export function registerReadTools(server: McpServer, client: SupabaseClient, meta: ApiMeta) {
  // -- lts_search --
  server.tool(
    "lts_search",
    "Search across DHSUD LTS records and published projects by name, LTS number, developer, or city. Returns matches from both the verification queue and the projects database. Use this as the universal entry point when looking for any LTS-related data.",
    {
      query: z.string().min(2).describe("Search term: project name, LTS number, developer name, or city"),
      limit: z.number().int().positive().max(50).default(20).describe("Max results per category (queue and projects each return up to this limit)"),
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

  // -- lts_queue --
  server.tool(
    "lts_queue",
    "Browse the LTS verification queue with filters. Shows scraped DHSUD records and their match status. Use status='pending' to see items awaiting review. Use expiringWithinDays to find records expiring soon. Sorted by match_score (highest first) by default.",
    {
      status: z
        .enum(["pending", "auto_matched", "manual_matched", "no_match", "skipped", "new_project"])
        .optional()
        .describe("Filter by match status. 'pending' shows items needing review"),
      region: z.string().optional().describe("Filter by DHSUD region (use lts_filters to get valid values)"),
      minScore: z.number().min(0).max(100).optional().describe("Minimum match score (0-100). Use 85+ for high-confidence matches"),
      search: z.string().optional().describe("Text search within queue: project name, LTS number, or developer"),
      expiringWithinDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Show records with scraped expiry date within N days from today"),
      sortBy: z
        .enum(["match_score", "scraped_expiry_date", "created_at"])
        .default("match_score")
        .describe("Sort field"),
      sortOrder: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
      limit: z.number().int().positive().max(100).default(20).describe("Max results"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ status, region, minScore, search, expiringWithinDays, sortBy, sortOrder, limit, offset }) => {
      try {
        const results = await getQueueItems(client, {
          status,
          region,
          minScore,
          search,
          expiringWithinDays,
          sortBy,
          sortOrder,
          limit,
          offset,
        });
        return toolResult(results, meta);
      } catch (err) {
        return safeToolError("Queue query failed. Adjust filters and retry.", err);
      }
    }
  );

  // -- lts_project --
  server.tool(
    "lts_project",
    "Get the complete LTS picture for a single project: all LTS records with computed fields (is_expired, days_until_expiry), summary counts (verified, expired, expiring soon), and the primary LTS number. Pass either a project UUID or a project name (fuzzy matched).",
    {
      projectId: z.string().uuid().optional().describe("Project UUID. Takes priority over projectName if both provided"),
      projectName: z.string().optional().describe("Project name or slug for fuzzy lookup. Use when you don't have the UUID"),
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
    "Get system-wide LTS statistics. Returns two sections: (1) queue stats from the verification pipeline (total, pending, matched, expired, expiring soon), and (2) project LTS stats (total records, verified, expired, expiring within 30 days, projects with LTS). Use this for a health check or dashboard overview.",
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
    "Check if a specific LTS number exists in the system. Returns whether it exists in the verification queue, in the project_lts table, or both. Includes full record details when found. Use this to verify a single LTS number before taking action.",
    {
      ltsNumber: z.string().min(1).describe("The LTS number to look up (e.g., 'HLURB-LTS-0001-2024')"),
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
