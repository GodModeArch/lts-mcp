import type { SupabaseClient } from "./client";
import { getTodayPH, getFutureDatePH } from "../utils";

/**
 * Escape a value for use inside a SQL LIKE/ILIKE pattern. Postgres treats
 * backslash as the escape character by default, so a prefixed % or _ is matched
 * literally instead of acting as a wildcard.
 *
 * `*` is deliberately not escaped. PostgREST rewrites * to % for the like and
 * ilike operators before the pattern reaches Postgres, and nothing survives that
 * rewrite, so a literal * cannot be sent through an ilike filter at all. It is
 * documented as the search wildcard instead, and callers gate it with
 * isUnboundedSearchTerm so a wildcard-only term cannot read a whole table.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * True when a search term has nothing left to match on once the wildcard is
 * taken out. `*` is the documented wildcard and PostgREST rewrites it to % for
 * like/ilike, so `**` reaches Postgres as `%%%%` and returns every row.
 * Escaping cannot close that: the rewrite runs after the backslash is
 * discarded, so a literal * cannot be sent through an ilike filter at all. The
 * caller is the only place left to refuse it.
 *
 * Confirmed live on 2026-08-29 against production: lts_search?query=** returned
 * records.total 8,401 and projects.total 4,902, both whole tables, from an
 * unauthenticated endpoint (docs/adversarial-audit-2026-08-29.md, N2).
 */
export function isUnboundedSearchTerm(value: string): boolean {
  return value.replace(/\*/g, "").trim() === "";
}

/**
 * Wrap a value in the double quotes PostgREST needs for any value inside an
 * or=() list. Backslash escaping does not work outside quotes: the comma still
 * delimits the list and the backslash is just a literal character. Inside
 * quotes, backslash and double quote are the only characters that need escaping.
 */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build one `column.ilike."%value%"` term for an or=() list. Single choke point
 * so no call site can forget the quotes, which is how the injection this
 * replaces got in (docs/adversarial-audit-2026-08-29.md, N1).
 */
export function ilikeContainsTerm(column: string, value: string): string {
  return `${column}.ilike.${quoteFilterValue(`%${escapeLikePattern(value)}%`)}`;
}

/** The or=() body used to search lts_records by free text. */
export function buildRecordSearchFilter(value: string): string {
  return [
    ilikeContainsTerm("normalized_project_name", value),
    ilikeContainsTerm("lts_number", value),
    ilikeContainsTerm("normalized_developer", value),
  ].join(",");
}

/** The or=() body used to search projects by free text. */
export function buildProjectSearchFilter(value: string): string {
  return [
    ilikeContainsTerm("name", value),
    ilikeContainsTerm("canonical_name", value),
    ilikeContainsTerm("lts_number", value),
  ].join(",");
}

import type {
  LTSRecordRow,
  ProjectLTSWithComputed,
  ProjectRow,
  ProjectLTSRow,
  LTSStatsResult,
  PaginatedResponse,
  StatsResponse,
} from "../types";

// -- lts_search --

interface SearchResult {
  records: PaginatedResponse<LTSRecordRow>;
  projects: PaginatedResponse<ProjectRow>;
}

export async function search(
  client: SupabaseClient,
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<SearchResult> {
  const { limit = 20, offset = 0 } = options;
  const raw = query.trim();

  if (isUnboundedSearchTerm(raw)) {
    return {
      records: { items: [], total: 0, limit, offset, hasMore: false },
      projects: { items: [], total: 0, limit, offset, hasMore: false },
    };
  }

  const orFilter = buildRecordSearchFilter(raw);
  const projectOrFilter = buildProjectSearchFilter(raw);

  const [recordsRes, projectRes] = await Promise.all([
    client
      .from("lts_records")
      .select("*", { count: "exact" })
      .neq("confidence", "low")
      .or(orFilter)
      .order("normalized_project_name", { ascending: true })
      .range(offset, offset + limit - 1),

    client
      .from("projects")
      .select(
        `
        id, name, slug, city, province, region,
        publish_status, lts_number, lts_issue_date, lts_expiry_date,
        lts_status, lts_count, active_lts_count,
        developers!inner ( name, slug )
      `,
        { count: "exact" }
      )
      .eq("publish_status", "published")
      .gt("lts_count", 0)
      .or(projectOrFilter)
      .order("active_lts_count", { ascending: false })
      .order("lts_count", { ascending: false })
      .range(offset, offset + limit - 1),
  ]);

  if (recordsRes.error) throw new Error(`Records search failed: ${recordsRes.error.message}`);
  if (projectRes.error) throw new Error(`Project search failed: ${projectRes.error.message}`);

  return {
    records: {
      items: (recordsRes.data ?? []) as LTSRecordRow[],
      total: recordsRes.count ?? 0,
      limit,
      offset,
      hasMore: offset + limit < (recordsRes.count ?? 0),
    },
    projects: {
      items: (projectRes.data ?? []) as ProjectRow[],
      total: projectRes.count ?? 0,
      limit,
      offset,
      hasMore: offset + limit < (projectRes.count ?? 0),
    },
  };
}

// -- lts_records (was lts_queue) --

interface RecordFilters {
  confidence?: string;
  linked?: boolean;
  region?: string;
  search?: string;
  expiringWithinDays?: number;
  sortBy?: "expiry_date" | "created_at" | "normalized_project_name";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function getLTSRecordItems(
  client: SupabaseClient,
  filters: RecordFilters = {}
): Promise<PaginatedResponse<LTSRecordRow>> {
  const {
    limit = 20,
    offset = 0,
    sortBy = "created_at",
    sortOrder = "desc",
  } = filters;

  // A term that matches everything is not a filter. Returning the whole table
  // for it would be the same unbounded read search() refuses.
  if (filters.search !== undefined && filters.search !== "" && isUnboundedSearchTerm(filters.search)) {
    return { items: [], total: 0, limit, offset, hasMore: false };
  }

  let query = client
    .from("lts_records")
    .select("*", { count: "exact" })
    .neq("confidence", "low");

  if (filters.confidence) query = query.eq("confidence", filters.confidence);
  if (filters.region) query = query.eq("normalized_region", filters.region);
  if (filters.linked === true) query = query.not("project_id", "is", null);
  if (filters.linked === false) query = query.is("project_id", null);

  if (filters.search) {
    query = query.or(buildRecordSearchFilter(filters.search.trim()));
  }

  if (filters.expiringWithinDays !== undefined) {
    const today = getTodayPH();
    const future = getFutureDatePH(filters.expiringWithinDays);
    query = query.gte("expiry_date", today).lte("expiry_date", future);
  }

  const ascending = sortOrder === "asc";
  query = query.order(sortBy, { ascending, nullsFirst: false });
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) throw new Error(`LTS records query failed: ${error.message}`);

  return {
    items: (data ?? []) as LTSRecordRow[],
    total: count ?? 0,
    limit,
    offset,
    hasMore: offset + limit < (count ?? 0),
  };
}

// -- lts_project --

interface ProjectLTSResult {
  project: ProjectRow;
  records: ProjectLTSWithComputed[];
  summary: {
    total: number;
    verified: number;
    expired: number;
    expiringSoon: number;
    primaryLTS: string | null;
  };
}

export async function getProjectLTS(
  client: SupabaseClient,
  projectId: string
): Promise<ProjectLTSResult> {
  const [projectRes, recordsRes] = await Promise.all([
    client
      .from("projects")
      .select(
        `
        id, name, slug, city, province, region,
        publish_status, lts_number, lts_issue_date, lts_expiry_date,
        lts_status, lts_count, active_lts_count,
        developers ( name, slug )
      `
      )
      .eq("id", projectId)
      .single(),

    client.rpc("get_project_lts_records", { p_project_id: projectId }),
  ]);

  if (projectRes.error) throw new Error(`Project not found: ${projectRes.error.message}`);
  if (recordsRes.error) throw new Error(`LTS records query failed: ${recordsRes.error.message}`);

  const records = (recordsRes.data ?? []) as ProjectLTSWithComputed[];
  const today = getTodayPH();
  const thirtyDays = getFutureDatePH(30);

  const verified = records.filter((r) => r.status === "verified").length;
  const expired = records.filter((r) => r.status === "expired").length;
  const expiringSoon = records.filter(
    (r) =>
      r.status === "verified" &&
      r.expiry_date &&
      r.expiry_date >= today &&
      r.expiry_date <= thirtyDays
  ).length;
  const primary = records.find((r) => r.is_primary);

  return {
    project: projectRes.data as ProjectRow,
    records,
    summary: {
      total: records.length,
      verified,
      expired,
      expiringSoon,
      primaryLTS: primary?.lts_number ?? null,
    },
  };
}

export async function findProjectByName(
  client: SupabaseClient,
  query: string
): Promise<ProjectRow | null> {
  const q = query.trim();

  // `*` would reach the ilike below as %, so a wildcard-only name matches the
  // first project in the table and returns it as an exact answer.
  if (isUnboundedSearchTerm(q)) return null;

  const { data: slugMatch } = await client
    .from("projects")
    .select(
      `id, name, slug, city, province, region,
       publish_status, lts_number, lts_issue_date, lts_expiry_date,
       lts_status, lts_count, active_lts_count,
       developers ( name, slug )`
    )
    .eq("slug", q.toLowerCase().replace(/\s+/g, "-"))
    .single();

  if (slugMatch) return slugMatch as ProjectRow;

  const { data: nameMatch } = await client
    .from("projects")
    .select(
      `id, name, slug, city, province, region,
       publish_status, lts_number, lts_issue_date, lts_expiry_date,
       lts_status, lts_count, active_lts_count,
       developers ( name, slug )`
    )
    // A standalone filter param is not an or=() list, so the comma is not a
    // delimiter here and the value needs no quoting. The LIKE wildcards in it
    // still reach Postgres, so they still need escaping.
    .ilike("name", `%${escapeLikePattern(q)}%`)
    .eq("publish_status", "published")
    .gt("lts_count", 0)
    .limit(1)
    .single();

  return (nameMatch as ProjectRow) ?? null;
}

// -- lts_stats --

export async function getStats(client: SupabaseClient): Promise<StatsResponse> {
  const today = getTodayPH();
  const thirtyDays = getFutureDatePH(30);

  const [ltsStats, totalRes, verifiedRes, expiredRes, expiringRes, withLTSRes] =
    await Promise.all([
      client.rpc("get_lts_stats"),
      client.from("project_lts").select("*", { count: "exact", head: true }),
      client.from("project_lts").select("*", { count: "exact", head: true }).eq("status", "verified"),
      client.from("project_lts").select("*", { count: "exact", head: true }).eq("status", "expired"),
      client
        .from("project_lts")
        .select("*", { count: "exact", head: true })
        .eq("status", "verified")
        .gte("expiry_date", today)
        .lte("expiry_date", thirtyDays),
      client
        .from("projects")
        .select("*", { count: "exact", head: true })
        .eq("publish_status", "published")
        .gt("lts_count", 0),
    ]);

  if (ltsStats.error) throw new Error(`LTS stats failed: ${ltsStats.error.message}`);

  const stats = (ltsStats.data?.[0] || ltsStats.data || {}) as LTSStatsResult;

  return {
    ltsRecords: stats,
    projects: {
      total: totalRes.count ?? 0,
      withLTS: withLTSRes.count ?? 0,
      activeLTS: verifiedRes.count ?? 0,
      expiredLTS: expiredRes.count ?? 0,
      expiringSoon: expiringRes.count ?? 0,
    },
  };
}

// -- lts_check --

interface CheckResult {
  exists: boolean;
  inLTSRecords: boolean;
  inProjectLTS: boolean;
  ltsRecord?: LTSRecordRow;
  projectLTS?: ProjectLTSRow;
}

export async function checkLTSNumber(
  client: SupabaseClient,
  ltsNumber: string
): Promise<CheckResult> {
  const num = ltsNumber.trim();

  const [recordRes, pltsRes] = await Promise.all([
    client
      .from("lts_records")
      .select("*")
      .eq("lts_number", num)
      .maybeSingle(),
    client
      .from("project_lts")
      .select("*")
      .eq("lts_number", num)
      .maybeSingle(),
  ]);

  if (recordRes.error) throw new Error(`LTS records check failed: ${recordRes.error.message}`);
  if (pltsRes.error) throw new Error(`Project LTS check failed: ${pltsRes.error.message}`);

  return {
    exists: !!(recordRes.data || pltsRes.data),
    inLTSRecords: !!recordRes.data,
    inProjectLTS: !!pltsRes.data,
    ltsRecord: (recordRes.data as LTSRecordRow) ?? undefined,
    projectLTS: (pltsRes.data as ProjectLTSRow) ?? undefined,
  };
}

// -- lts_filters --

interface FilterValues {
  regions: string[];
  cities: string[];
}

export async function getFilterValues(
  client: SupabaseClient,
  region?: string
): Promise<FilterValues> {
  const [regionsRes, citiesQuery] = await Promise.all([
    client
      .from("lts_records")
      .select("normalized_region")
      .not("normalized_region", "is", null),

    (() => {
      let q = client
        .from("lts_records")
        .select("normalized_city")
        .not("normalized_city", "is", null);
      if (region) q = q.eq("normalized_region", region);
      return q;
    })(),
  ]);

  if (regionsRes.error) throw new Error(`Regions query failed: ${regionsRes.error.message}`);
  if (citiesQuery.error) throw new Error(`Cities query failed: ${citiesQuery.error.message}`);

  const regions = [
    ...new Set(
      (regionsRes.data ?? [])
        .map((r: Record<string, string | null>) => r.normalized_region)
        .filter(Boolean) as string[]
    ),
  ].sort();

  const cities = [
    ...new Set(
      (citiesQuery.data ?? [])
        .map((r: Record<string, string | null>) => r.normalized_city)
        .filter(Boolean) as string[]
    ),
  ].sort();

  return { regions, cities };
}
