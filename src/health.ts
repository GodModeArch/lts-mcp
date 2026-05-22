import type { SupabaseClient } from "./db/client";

// Secrets the Worker cannot run without. Missing any of these is the failure
// that caused a silent MCP handshake hang (the DO threw "supabaseUrl is
// required" deep inside the transport). The health check and the /mcp guard
// turn that into a loud, explicit 503 instead.
const REQUIRED_SECRETS = ["SUPABASE_URL", "SUPABASE_ANON_KEY"] as const;

export interface ConfigCheck {
  ok: boolean;
  missing: string[];
}

/** Pure: which required secrets are absent or blank on this env. */
export function checkRequiredConfig(env: Record<string, unknown>): ConfigCheck {
  const missing = REQUIRED_SECRETS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim() === "";
  });
  return { ok: missing.length === 0, missing };
}

export interface DbProbe {
  ok: boolean;
  error: string | null;
}

/**
 * Live connectivity probe: a head-count on lts_records. Verifies the URL/key
 * actually work (right project, valid key, RLS lets the role read) rather than
 * just that the secrets are present. head:true returns no rows, only a count.
 */
export async function probeDatabase(client: SupabaseClient): Promise<DbProbe> {
  try {
    const { error } = await client
      .from("lts_records")
      .select("lts_number", { count: "exact", head: true })
      .limit(1);
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type HealthStatus = "ok" | "degraded" | "misconfigured";

export interface HealthReport {
  status: HealthStatus;
  version: string;
  checks: {
    config: ConfigCheck;
    database: DbProbe;
  };
}

/** Pure: roll the config + db results into a single status. */
export function buildHealthReport(config: ConfigCheck, database: DbProbe, version: string): HealthReport {
  let status: HealthStatus;
  if (!config.ok) status = "misconfigured";
  else if (!database.ok) status = "degraded";
  else status = "ok";
  return { status, version, checks: { config, database } };
}

/** ok -> 200, anything else -> 503 (so uptime checks fail on degraded too). */
export function healthHttpStatus(status: HealthStatus): number {
  return status === "ok" ? 200 : 503;
}
