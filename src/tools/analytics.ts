import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "../db/client";
import type { ApiMeta } from "../response";
import type { NormalizedLaw } from "../types";
import {
  aggregateByRegion,
  aggregateByDeveloper,
  aggregateByLaw,
  aggregateTrends,
  aggregateByCity,
  aggregateExpiryRisk,
} from "../db/analytics";
import { toolResult, toolError, safeToolError } from "../utils";

const lawEnum = z
  .enum(["BP220", "PD957"])
  .optional()
  .describe("Filter by housing law: BP220 (socialized/economic) or PD957 (open market)");

const statusEnum = z
  .enum(["active", "expired"])
  .optional()
  .describe("Filter by derived LTS status: active (expiry >= today) or expired");

export function registerAnalyticsTools(server: McpServer, client: SupabaseClient, meta: ApiMeta) {
  // -- lts_by_region --
  server.tool(
    "lts_by_region",
    "Aggregate LTS records by DHSUD region. Returns count, market share, law breakdown (BP220/PD957), and active/expired split per region. Use for State of RE reports and regional housing market analysis. Cross-reference with PSGC MCP search for population data to compute per-capita density. Capped at 10k rows; check truncated flag and narrow filters if true.",
    {
      year: z.number().int().min(2000).max(2030).optional().describe("Filter by LTS issue year"),
      law: lawEnum,
      status: statusEnum,
    },
    async ({ year, law, status }) => {
      try {
        const result = await aggregateByRegion(client, {
          year,
          law: law as NormalizedLaw | undefined,
          status,
        });
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("Regional aggregation failed.", err);
      }
    }
  );

  // -- lts_by_developer --
  server.tool(
    "lts_by_developer",
    "Rank developers by LTS count with regional footprint, law breakdown, and active/expired split. Use for developer intelligence, competitive analysis, and identifying which developers dominate specific regions or housing segments. Capped at 10k rows; check truncated flag and narrow filters if true.",
    {
      year: z.number().int().min(2000).max(2030).optional().describe("Filter by LTS issue year"),
      region: z.string().optional().describe("Filter to a specific DHSUD region"),
      law: lawEnum,
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(25)
        .describe("Max developers to return, sorted by count desc"),
    },
    async ({ year, region, law, limit }) => {
      try {
        const result = await aggregateByDeveloper(
          client,
          { year, region, law: law as NormalizedLaw | undefined },
          limit
        );
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("Developer aggregation failed.", err);
      }
    }
  );

  // -- lts_by_law --
  server.tool(
    "lts_by_law",
    "Break down LTS records by housing law (BP220 socialized/economic vs PD957 open market). Shows regional distribution per law and year-over-year shift in BP220 share (when no year filter). Use for housing policy analysis and socialized housing supply tracking. Capped at 10k rows; check truncated flag and narrow filters if true.",
    {
      year: z.number().int().min(2000).max(2030).optional().describe("Filter by LTS issue year. Omit for YOY shift calculation"),
      region: z.string().optional().describe("Filter to a specific DHSUD region"),
    },
    async ({ year, region }) => {
      try {
        const result = await aggregateByLaw(client, { year, region });
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("Law breakdown aggregation failed.", err);
      }
    }
  );

  // -- lts_trends --
  server.tool(
    "lts_trends",
    "Show LTS issuance trends over time with annual or quarterly granularity. Returns period counts with law breakdown, peak period, and year-over-year growth percentage. Use for housing supply pipeline analysis and market timing. Capped at 10k rows; check truncated flag and narrow filters if true.",
    {
      region: z.string().optional().describe("Filter to a specific DHSUD region"),
      law: lawEnum,
      from_year: z.number().int().min(2000).max(2030).optional().describe("Start year (inclusive)"),
      to_year: z.number().int().min(2000).max(2030).optional().describe("End year (inclusive)"),
      granularity: z
        .enum(["annual", "quarterly"])
        .default("annual")
        .describe("Time bucket granularity"),
    },
    async ({ region, law, from_year, to_year, granularity }) => {
      if (from_year && to_year && from_year > to_year) {
        return toolError("from_year must be <= to_year.");
      }
      try {
        const result = await aggregateTrends(
          client,
          { region, law: law as NormalizedLaw | undefined, from_year, to_year },
          granularity
        );
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("Trends aggregation failed.", err);
      }
    }
  );

  // -- lts_by_city --
  server.tool(
    "lts_by_city",
    "Rank cities by LTS count with province, region, law breakdown, active/expired split, and top developer per city. Groups by city+province to avoid merging same-name cities across provinces. Use for housing pressure indices, city-level market analysis, and identifying emerging development hotspots. Cross-reference with PSGC MCP for city classification and population. Capped at 10k rows; check truncated flag and narrow filters if true.",
    {
      region: z.string().optional().describe("Filter to a specific DHSUD region"),
      year: z.number().int().min(2000).max(2030).optional().describe("Filter by LTS issue year"),
      law: lawEnum,
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(25)
        .describe("Max cities to return, sorted by count desc"),
    },
    async ({ region, year, law, limit }) => {
      try {
        const result = await aggregateByCity(
          client,
          { region, year, law: law as NormalizedLaw | undefined },
          limit
        );
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("City aggregation failed.", err);
      }
    }
  );

  // -- lts_expiry_risk --
  server.tool(
    "lts_expiry_risk",
    "Find LTS records expiring within a given number of days. Returns records sorted by urgency (soonest first) with days remaining, plus summary counts by region and developer. Use for compliance monitoring, renewal pipeline tracking, and risk assessment. Capped at 10k rows; check truncated flag and narrow filters if true.",
    {
      region: z.string().optional().describe("Filter to a specific DHSUD region"),
      law: lawEnum,
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .default(90)
        .describe("Look-ahead window in days from today (default 90)"),
    },
    async ({ region, law, days }) => {
      try {
        const result = await aggregateExpiryRisk(
          client,
          { region, law: law as NormalizedLaw | undefined },
          days
        );
        return toolResult(result, meta);
      } catch (err) {
        return safeToolError("Expiry risk query failed.", err);
      }
    }
  );
}
