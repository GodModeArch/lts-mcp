# Changelog

All notable changes to the LTS MCP Server are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-03-04

### Added

- **Cloudflare Workers deployment.** Migrated from local stdio server to public-facing Cloudflare Workers MCP server using the `agents` SDK. Accessible at `https://lts-mcp.godmodearch.workers.dev/mcp`.

- **Six read-only tools for LTS verification:**
  - `lts_search`: universal search across DHSUD queue and published projects
  - `lts_queue`: filtered browsing of the DHSUD verification queue
  - `lts_project`: complete LTS picture for a single project (by UUID or name)
  - `lts_stats`: system-wide queue and project LTS statistics
  - `lts_check`: verify if a specific LTS number exists
  - `lts_filters`: get available regions and cities for filtering

- **DHSUD provenance envelope.** All responses wrapped in `{ _meta, data }` with source attribution to DHSUD and last-synced timestamp.

- **Anon key + RLS security model.** Public endpoint uses Supabase anon key instead of service role key. All data access enforced through Row Level Security policies. No write operations exposed.

- **Durable Object-backed MCP transport.** Uses `McpAgent` from the `agents` SDK with Cloudflare Durable Objects for connection management.

### Changed

- **Supabase client: singleton to factory.** Client is now created per-request via `createSupabaseClient()` instead of a module-level singleton that read from `process.env`.

- **Query functions accept client parameter.** All database query functions take `SupabaseClient` as first argument instead of importing a global instance.

- **Logging: stderr to console.** Replaced `process.stderr.write()` with `console.error()` / `console.log()` for Cloudflare Workers compatibility.

### Removed

- **`lts_expire_stale` tool.** Admin mutation removed. This is a public, read-only server. Expiry management remains in the admin pipeline.

- **Stdio transport.** Replaced with HTTP transport at `/mcp`.

- **Service role key dependency.** No longer requires or accepts `SUPABASE_SERVICE_ROLE_KEY`.
