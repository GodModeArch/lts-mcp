import type { SupabaseClient } from "./client";
import { getTodayPH, getFutureDatePH } from "../utils";

/** Escape characters that PostgREST interprets as filter syntax inside .or() strings */
export function sanitizeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
}

import type {
  QueueItemRow,
  ProjectLTSWithComputed,
  ProjectRow,
  ProjectLTSRow,
  VerificationStats,
  PaginatedResponse,
  StatsResponse,
} from "../types";

// -- lts_search --

interface SearchResult {
  queue: PaginatedResponse<QueueItemRow>;
  projects: PaginatedResponse<ProjectRow>;
}

export async function search(
  client: SupabaseClient,
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<SearchResult> {
  const { limit = 20, offset = 0 } = options;
  const raw = query.trim();

  if (!raw) {
    return {
      queue: { items: [], total: 0, limit, offset, hasMore: false },
      projects: { items: [], total: 0, limit, offset, hasMore: false },
    };
  }

  const q = sanitizeFilterValue(raw);
  const orFilter = `lts_number.ilike.%${q}%,scraped_project_name.ilike.%${q}%,scraped_developer.ilike.%${q}%`;
  const projectOrFilter = `name.ilike.%${q}%,canonical_name.ilike.%${q}%,lts_number.ilike.%${q}%`;

  const [queueRes, projectRes] = await Promise.all([
    client
      .from("lts_verification_queue")
      .select(
        `
        *,
        projects:matched_project_id (
          id, name, slug, city,
          developers ( slug, name )
        )
      `,
        { count: "exact" }
      )
      .or(orFilter)
      .order("match_score", { ascending: false, nullsFirst: false })
      .order("scraped_project_name", { ascending: true })
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

  if (queueRes.error) throw new Error(`Queue search failed: ${queueRes.error.message}`);
  if (projectRes.error) throw new Error(`Project search failed: ${projectRes.error.message}`);

  return {
    queue: {
      items: (queueRes.data ?? []) as QueueItemRow[],
      total: queueRes.count ?? 0,
      limit,
      offset,
      hasMore: offset + limit < (queueRes.count ?? 0),
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

// -- lts_queue --

interface QueueFilters {
  status?: string;
  region?: string;
  minScore?: number;
  search?: string;
  expiringWithinDays?: number;
  sortBy?: "match_score" | "scraped_expiry_date" | "created_at";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function getQueueItems(
  client: SupabaseClient,
  filters: QueueFilters = {}
): Promise<PaginatedResponse<QueueItemRow>> {
  const {
    limit = 20,
    offset = 0,
    sortBy = "match_score",
    sortOrder = "desc",
  } = filters;

  let query = client
    .from("lts_verification_queue")
    .select("*", { count: "exact" });

  if (filters.status) query = query.eq("match_status", filters.status);
  if (filters.region) query = query.eq("scraped_region", filters.region);
  if (filters.minScore !== undefined) query = query.gte("match_score", filters.minScore);

  if (filters.search) {
    const s = sanitizeFilterValue(filters.search.trim());
    query = query.or(
      `scraped_project_name.ilike.%${s}%,lts_number.ilike.%${s}%,scraped_developer.ilike.%${s}%`
    );
  }

  if (filters.expiringWithinDays !== undefined) {
    const today = getTodayPH();
    const future = getFutureDatePH(filters.expiringWithinDays);
    query = query.gte("scraped_expiry_date", today).lte("scraped_expiry_date", future);
  }

  const ascending = sortOrder === "asc";
  if (sortBy === "match_score") {
    query = query.order("match_score", { ascending, nullsFirst: false });
  } else if (sortBy === "scraped_expiry_date") {
    query = query.order("scraped_expiry_date", { ascending, nullsFirst: false });
  } else {
    query = query.order("created_at", { ascending });
  }

  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) throw new Error(`Queue query failed: ${error.message}`);

  return {
    items: (data ?? []) as QueueItemRow[],
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
    .ilike("name", `%${q}%`)
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

  const [queueStats, totalRes, verifiedRes, expiredRes, _unverifiedRes, expiringRes, withLTSRes] =
    await Promise.all([
      client.rpc("get_lts_verification_stats"),

      client.from("project_lts").select("*", { count: "exact", head: true }),
      client.from("project_lts").select("*", { count: "exact", head: true }).eq("status", "verified"),
      client.from("project_lts").select("*", { count: "exact", head: true }).eq("status", "expired"),
      client.from("project_lts").select("*", { count: "exact", head: true }).eq("status", "unverified"),
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

  if (queueStats.error) throw new Error(`Queue stats failed: ${queueStats.error.message}`);

  const qs = queueStats.data as VerificationStats;

  return {
    queue: qs,
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
  inQueue: boolean;
  inProjectLTS: boolean;
  queueItem?: QueueItemRow;
  projectLTS?: ProjectLTSRow;
}

export async function checkLTSNumber(
  client: SupabaseClient,
  ltsNumber: string
): Promise<CheckResult> {
  const num = ltsNumber.trim();

  const [queueRes, pltsRes] = await Promise.all([
    client
      .from("lts_verification_queue")
      .select("*")
      .eq("lts_number", num)
      .maybeSingle(),
    client
      .from("project_lts")
      .select("*")
      .eq("lts_number", num)
      .maybeSingle(),
  ]);

  if (queueRes.error) throw new Error(`Queue check failed: ${queueRes.error.message}`);
  if (pltsRes.error) throw new Error(`Project LTS check failed: ${pltsRes.error.message}`);

  return {
    exists: !!(queueRes.data || pltsRes.data),
    inQueue: !!queueRes.data,
    inProjectLTS: !!pltsRes.data,
    queueItem: (queueRes.data as QueueItemRow) ?? undefined,
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
      .from("lts_verification_queue")
      .select("scraped_region")
      .not("scraped_region", "is", null),

    (() => {
      let q = client
        .from("lts_verification_queue")
        .select("scraped_city")
        .not("scraped_city", "is", null);
      if (region) q = q.eq("scraped_region", region);
      return q;
    })(),
  ]);

  if (regionsRes.error) throw new Error(`Regions query failed: ${regionsRes.error.message}`);
  if (citiesQuery.error) throw new Error(`Cities query failed: ${citiesQuery.error.message}`);

  const regions = [
    ...new Set(
      (regionsRes.data ?? [])
        .map((r: Record<string, string | null>) => r.scraped_region)
        .filter(Boolean) as string[]
    ),
  ].sort();

  const cities = [
    ...new Set(
      (citiesQuery.data ?? [])
        .map((r: Record<string, string | null>) => r.scraped_city)
        .filter(Boolean) as string[]
    ),
  ].sort();

  return { regions, cities };
}
