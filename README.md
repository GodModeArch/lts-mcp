# LTS MCP Server

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that provides Philippine License to Sell (LTS) verification data to LLMs. Built on Cloudflare Workers with Supabase.

Public, read-only, no authentication required. Data sourced from the [Department of Human Settlements and Urban Development (DHSUD)](https://dhsud.gov.ph/) License to Sell registry and cross-referenced with published real estate projects on [REN.PH](https://ren.ph).

## Why This Exists

Philippine real estate developers are required by law to obtain a License to Sell (LTS) from DHSUD before marketing or selling condominium units, subdivision lots, and other real estate projects. Buyers can check whether a project has a valid LTS, but the official verification process involves navigating government websites and manually looking up records.

This MCP server makes that data queryable by any LLM. Ask your AI assistant "Does [project name] have a valid License to Sell?" and get an answer backed by DHSUD records.

## Tools

| Tool | Description |
|------|-------------|
| `lts_search` | Search across DHSUD records and published projects by name, LTS number, developer, or city |
| `lts_queue` | Browse the DHSUD verification queue with filters (status, region, expiry, score) |
| `lts_project` | Get the complete LTS picture for a project (by UUID or name) |
| `lts_stats` | System-wide statistics: queue pipeline health and project LTS counts |
| `lts_check` | Check if a specific LTS number exists in the system |
| `lts_filters` | Get available regions and cities for filtering |

### Tool Details

**`lts_search`** is the universal entry point. It searches both the DHSUD verification queue (scraped records) and the REN.PH projects database simultaneously. Use this when you have a project name, developer name, LTS number, or city and want to find everything related.

**`lts_queue`** gives access to the raw DHSUD scrape data. Each record represents an LTS entry from DHSUD's registry, with match status indicating whether it has been linked to a project in the REN.PH database. Supports filtering by match status, region, minimum match score, text search, and expiring-soon windows.

**`lts_project`** returns the full LTS picture for a single project: all LTS records with computed fields (`is_expired`, `days_until_expiry`), a summary with counts (verified, expired, expiring soon), and the primary LTS number. Accepts either a project UUID or a project name for fuzzy lookup.

**`lts_stats`** returns two sections: queue stats from the verification pipeline (total records, pending, auto-matched, manual-matched, no-match, expired, expiring soon) and project LTS stats (total records, verified, expired, expiring within 30 days, projects with active LTS).

**`lts_check`** verifies whether a specific LTS number exists. Returns whether it was found in the DHSUD queue, in the verified project LTS table, or both, along with the full record details.

**`lts_filters`** returns distinct regions and cities available in the verification queue. Use this before calling `lts_queue` with region or city filters to get valid values. Optionally pass a region to get only cities within that region.

## Response Format

All data responses are wrapped in a standard metadata envelope:

```json
{
  "_meta": {
    "source": "Department of Human Settlements and Urban Development (DHSUD)",
    "source_url": "https://dhsud.gov.ph/",
    "dataset": "License to Sell (LTS) Registry",
    "last_synced": "2026-03-04"
  },
  "data": { ... }
}
```

Error responses (`isError: true`) are returned as plain text without wrapping.

### Paginated Responses

Tools that return lists (`lts_search`, `lts_queue`) use a standard pagination wrapper:

| Field | Type | Description |
|-------|------|-------------|
| `items` | `array` | The result records |
| `total` | `number` | Total matching records |
| `limit` | `number` | Page size used |
| `offset` | `number` | Current offset |
| `hasMore` | `boolean` | Whether more results exist |

### LTS Status Values

| Status | Meaning |
|--------|---------|
| `verified` | LTS confirmed valid by verification process |
| `unverified` | LTS exists but not yet verified |
| `expired` | LTS past its expiry date |
| `none` | Project has no LTS on record |

### Match Status Values (Queue)

| Status | Meaning |
|--------|---------|
| `pending` | DHSUD record awaiting review |
| `auto_matched` | Automatically linked to a project |
| `manual_matched` | Manually linked by a reviewer |
| `no_match` | No matching project found |
| `skipped` | Skipped during review |
| `new_project` | Record suggests a new project not yet in the database |

## Connect

Add to your MCP client configuration:
```json
{
  "mcpServers": {
    "lts": {
      "url": "https://lts-mcp.godmodearch.workers.dev/mcp"
    }
  }
}
```

### Quick test
```bash
curl -X POST https://lts-mcp.godmodearch.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "lts_check",
      "arguments": { "ltsNumber": "HLURB-LTS-0001-2024" }
    }
  }'
```

## Data Sources

| Source | Description |
|--------|-------------|
| [DHSUD LTS Registry](https://dhsud.gov.ph/) | Scraped License to Sell records: LTS numbers, project names, developers, cities, issue/expiry dates |
| [REN.PH](https://ren.ph) | Published real estate project database with verified LTS linkages |

The DHSUD verification queue contains scraped records from DHSUD's public registry. These records are matched against REN.PH's project database using a combination of exact LTS number matching, project name matching, and fuzzy scoring. Verified matches are stored in the `project_lts` table with full provenance.

Last synced: March 4, 2026.

## Security

This is a public, read-only endpoint. The Supabase connection uses an anon key (not a service role key), and all data access is enforced through Row Level Security (RLS) policies:

- `projects`: only published projects are visible
- `project_lts`: all verified/public LTS records are visible
- `lts_verification_queue`: all DHSUD public data is visible

Even if the Worker is compromised, the attacker can only read what RLS allows. No write operations are exposed.

## What is a License to Sell?

Under Philippine law ([PD 957](https://dhsud.gov.ph/the-agency/pd-957/) and [BP 220](https://dhsud.gov.ph/the-agency/bp-220/)), real estate developers must secure a **License to Sell (LTS)** from DHSUD before offering any subdivision lot, condominium unit, or similar real estate project for sale to the public. The LTS confirms that the project has been reviewed for compliance with zoning, land use, environmental, and development standards.

Buying from a project without a valid LTS is one of the most common risks in Philippine real estate. This MCP server makes that verification accessible to AI assistants, chatbots, and any MCP-compatible application.

## Related Projects

Part of a suite of Philippine public data MCP servers:

- [**PSGC MCP**](https://github.com/GodModeArch/psgc-mcp) - Philippine Standard Geographic Code data
- **LTS MCP** (this repo) - DHSUD License to Sell verification
- **PH Holidays MCP** - Coming soon
- **BSP Bank Directory MCP** - Coming soon

All servers are free, public, and read-only. Data pulled from official Philippine government sources.

## Development

```bash
npm install
npm run cf-typegen
npm run dev
```

`cf-typegen` generates `worker-configuration.d.ts` (gitignored) with Cloudflare runtime types. Run it once after cloning and again after changing `wrangler.jsonc`.

Dev server starts at `http://localhost:8787`. Connect your MCP client to `http://localhost:8787/mcp`.

### Deployment

Before first deploy, set the Supabase secrets:
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

Then deploy:
```bash
npm run deploy
```

### Type Generation

After changing `wrangler.jsonc`:
```bash
npm run cf-typegen
```

## Contributing and Issues

Found a data discrepancy or a project with incorrect LTS status? Open an issue. DHSUD data is scraped periodically and matched against the REN.PH database. Mismatches, missing records, and edge cases in the matching pipeline are tracked through issues.

If data looks stale, open an issue and it will be refreshed ahead of the next scheduled sync.

## Built by

**Aaron Zara** - Fractional CTO at [Godmode Digital](https://godmode.ph)

Built [REN.PH](https://ren.ph), a programmatic real estate platform with 60,000+ structured pages covering every Philippine province, city, and barangay. The LTS MCP came out of needing to make DHSUD license verification accessible to AI agents, because buyers deserve to know if a project is licensed before they sign anything.

For enterprise SLAs, custom integrations, or other PH data sources:
[godmode.ph](https://godmode.ph)

## License

MIT
