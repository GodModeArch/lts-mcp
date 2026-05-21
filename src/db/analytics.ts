import type { SupabaseClient } from "./client";
import { getTodayPH, getFutureDatePH } from "../utils";
import type {
  AnalyticsRow,
  NormalizedLaw,
  LawBreakdown,
  ByRegionResponse,
  ByDeveloperResponse,
  ByLawResponse,
  TrendsResponse,
  TrendPeriod,
  ByCityResponse,
  ExpiryRiskResponse,
  ExpiryRiskRecord,
} from "../types";

// ── Pure Helpers ────────────────────────────────────────────────────────────

// Law is encoded in raw_project_type, e.g. "EH Subd - BP 220", "RC - PD 957",
// "BP220 -", "- PD 957". Other suffixes (NR, EO 648) and blanks normalize to
// null (unknown). No bare-number fallback: every real law value carries the
// BP/PD prefix, so matching a stray "220"/"957" would only create false
// positives in values like "220 sqm" or "Block 957".
const BP220_RE = /\b(?:bp|b\.?p\.?)\s*220\b/i;
const PD957_RE = /\b(?:pd|p\.?d\.?)\s*957\b/i;

export function normalizeLaw(raw: string | null): NormalizedLaw {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  if (BP220_RE.test(s)) return "BP220";
  if (PD957_RE.test(s)) return "PD957";
  return null;
}

/** Null expiry = expired. DHSUD records without an expiry date are treated as lapsed. */
export function deriveStatus(expiryDate: string | null, today: string): "active" | "expired" {
  if (!expiryDate) return "expired";
  return expiryDate >= today ? "active" : "expired";
}

export function computeSharePct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

export function emptyLawBreakdown(): LawBreakdown {
  return { BP220: 0, PD957: 0, unknown: 0 };
}

export function incrementLaw(breakdown: LawBreakdown, law: NormalizedLaw): void {
  if (law === "BP220") breakdown.BP220++;
  else if (law === "PD957") breakdown.PD957++;
  else breakdown.unknown++;
}

export function getPeriodKey(isoDate: string, granularity: "annual" | "quarterly"): string {
  const year = isoDate.slice(0, 4);
  if (granularity === "annual") return year;
  const month = parseInt(isoDate.slice(5, 7), 10);
  const quarter = Math.ceil(month / 3);
  return `${year}-Q${quarter}`;
}

// ── Columns selected for analytics queries ──────────────────────────────────

const ANALYTICS_COLUMNS = [
  "lts_number",
  "normalized_project_name",
  "normalized_developer",
  "normalized_city",
  "normalized_province",
  "normalized_region",
  "issue_date",
  "expiry_date",
  // raw_project_type carries the law (BP 220 / PD 957); inferred_project_type
  // is the project category (house_and_lot, condominium, ...) and is NOT a law.
  "raw_project_type",
].join(",");

// ── Shared Data Fetcher ─────────────────────────────────────────────────────

export interface FetchFilters {
  year?: number;
  from_year?: number;
  to_year?: number;
  region?: string;
  law?: NormalizedLaw;
  status?: "active" | "expired";
  expiryFrom?: string;
  expiryTo?: string;
  /**
   * Ordering applied across the paged fetch. Stable order (the chosen column
   * plus the lts_number PK) makes range pagination deterministic. Expiry-risk
   * paths order by expiry_date asc so the soonest-expiring records survive if
   * the dataset ever exceeds MAX_ROWS.
   */
  orderBy?: { column: "issue_date" | "expiry_date"; ascending?: boolean };
}

// Page size for range fetches. Matches Supabase's default db-max-rows so a
// single page is never capped below what we ask for.
const PAGE_SIZE = 1_000;
// Hard ceiling on rows pulled into the Worker for client-side aggregation.
// Crossing it sets truncated=true; the real fix at that scale is DB-side
// aggregation rather than fetching everything.
const MAX_ROWS = 100_000;

export interface FetchResult {
  rows: AnalyticsRow[];
  truncated: boolean;
}

export async function fetchFilteredRows(
  client: SupabaseClient,
  filters: FetchFilters = {}
): Promise<FetchResult> {
  const order = filters.orderBy ?? { column: "issue_date" as const, ascending: true };

  // Rebuilt per page so .range() applies to a fresh query each time.
  const buildQuery = () => {
    let query = client.from("lts_records").select(ANALYTICS_COLUMNS);

    // DB-level filters
    if (filters.year) {
      query = query
        .gte("issue_date", `${filters.year}-01-01`)
        .lte("issue_date", `${filters.year}-12-31`);
    } else {
      if (filters.from_year) {
        query = query.gte("issue_date", `${filters.from_year}-01-01`);
      }
      if (filters.to_year) {
        query = query.lte("issue_date", `${filters.to_year}-12-31`);
      }
    }

    if (filters.region) {
      // .eq() values are sent literally by PostgREST; do not escape with
      // sanitizeFilterValue (that is only for .or() filter strings).
      query = query.eq("normalized_region", filters.region);
    }

    if (filters.expiryFrom) {
      query = query.gte("expiry_date", filters.expiryFrom);
    }
    if (filters.expiryTo) {
      query = query.lte("expiry_date", filters.expiryTo);
    }

    // Stable order across pages: the chosen column, then lts_number (PK).
    return query
      .order(order.column, { ascending: order.ascending ?? true, nullsFirst: false })
      .order("lts_number", { ascending: true });
  };

  // Page through the full result set. A single .limit() is unsafe: if the
  // project's PostgREST db-max-rows is below the table size (Supabase
  // defaults to 1000), one request silently returns a biased slice with no
  // error and truncated would read false. Stable ordering makes range
  // paging deterministic.
  const allRows: AnalyticsRow[] = [];
  let truncated = false;
  for (let from = 0; ; from += PAGE_SIZE) {
    if (from >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Analytics query failed: ${error.message}`);
    const page = (data ?? []) as unknown as AnalyticsRow[];
    allRows.push(...page);
    if (page.length < PAGE_SIZE) break; // short page = end of data
  }

  let rows = allRows;

  // Client-side filters
  if (filters.law) {
    rows = rows.filter((r) => normalizeLaw(r.raw_project_type) === filters.law);
  }

  if (filters.status) {
    const today = getTodayPH();
    rows = rows.filter((r) => deriveStatus(r.expiry_date, today) === filters.status);
  }

  return { rows, truncated };
}

// ── Aggregation Functions ───────────────────────────────────────────────────

export async function aggregateByRegion(
  client: SupabaseClient,
  filters: { year?: number; law?: NormalizedLaw; status?: "active" | "expired" } = {}
): Promise<ByRegionResponse> {
  const { rows, truncated } = await fetchFilteredRows(client, filters);
  return { ...aggregateByRegionFromRows(rows, getTodayPH()), truncated };
}

export function aggregateByRegionFromRows(rows: AnalyticsRow[], today: string): Omit<ByRegionResponse, "truncated"> {
  const map = new Map<string, { count: number; by_law: LawBreakdown; active: number; expired: number }>();

  for (const row of rows) {
    const region = row.normalized_region ?? "Unknown";
    let bucket = map.get(region);
    if (!bucket) {
      bucket = { count: 0, by_law: emptyLawBreakdown(), active: 0, expired: 0 };
      map.set(region, bucket);
    }
    bucket.count++;
    incrementLaw(bucket.by_law, normalizeLaw(row.raw_project_type));
    if (deriveStatus(row.expiry_date, today) === "active") bucket.active++;
    else bucket.expired++;
  }

  const total = rows.length;
  const regions = [...map.entries()]
    .map(([region, b]) => ({
      region,
      count: b.count,
      share_pct: computeSharePct(b.count, total),
      by_law: b.by_law,
      active: b.active,
      expired: b.expired,
    }))
    .sort((a, b) => b.count - a.count);

  return { total, regions };
}

export async function aggregateByDeveloper(
  client: SupabaseClient,
  filters: { year?: number; region?: string; law?: NormalizedLaw } = {},
  limit = 25
): Promise<ByDeveloperResponse> {
  const { rows, truncated } = await fetchFilteredRows(client, filters);
  return { ...aggregateByDeveloperFromRows(rows, limit, getTodayPH()), truncated };
}

export function aggregateByDeveloperFromRows(rows: AnalyticsRow[], limit: number, today: string): Omit<ByDeveloperResponse, "truncated"> {
  const map = new Map<
    string,
    { count: number; regions: Set<string>; by_law: LawBreakdown; active: number; expired: number }
  >();

  for (const row of rows) {
    const dev = row.normalized_developer ?? "Unknown";
    let bucket = map.get(dev);
    if (!bucket) {
      bucket = { count: 0, regions: new Set(), by_law: emptyLawBreakdown(), active: 0, expired: 0 };
      map.set(dev, bucket);
    }
    bucket.count++;
    if (row.normalized_region) bucket.regions.add(row.normalized_region);
    incrementLaw(bucket.by_law, normalizeLaw(row.raw_project_type));
    if (deriveStatus(row.expiry_date, today) === "active") bucket.active++;
    else bucket.expired++;
  }

  const total = rows.length;
  const developers = [...map.entries()]
    .map(([developer, b]) => ({
      developer,
      count: b.count,
      share_pct: computeSharePct(b.count, total),
      regions: [...b.regions].sort(),
      by_law: b.by_law,
      active: b.active,
      expired: b.expired,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { total, developers };
}

export async function aggregateByLaw(
  client: SupabaseClient,
  filters: { year?: number; region?: string } = {}
): Promise<ByLawResponse> {
  const { rows, truncated } = await fetchFilteredRows(client, filters);
  const result = aggregateByLawFromRows(rows, !filters.year);
  // A YoY figure computed on a partial dataset would look authoritative but
  // point the wrong way; suppress it rather than emit a confident wrong number.
  if (truncated) result.yoy_shift = null;
  return { ...result, truncated };
}

export function aggregateByLawFromRows(rows: AnalyticsRow[], computeYoy: boolean): Omit<ByLawResponse, "truncated"> {
  const map = new Map<string, { count: number; by_region: Map<string, number> }>();

  for (const row of rows) {
    const law = normalizeLaw(row.raw_project_type) ?? "unknown";
    let bucket = map.get(law);
    if (!bucket) {
      bucket = { count: 0, by_region: new Map() };
      map.set(law, bucket);
    }
    bucket.count++;
    const region = row.normalized_region ?? "Unknown";
    bucket.by_region.set(region, (bucket.by_region.get(region) ?? 0) + 1);
  }

  const total = rows.length;
  const breakdown = [...map.entries()]
    .map(([law, b]) => ({
      law,
      count: b.count,
      share_pct: computeSharePct(b.count, total),
      by_region: [...b.by_region.entries()]
        .map(([region, count]) => ({ region, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  let yoy_shift: ByLawResponse["yoy_shift"] = null;

  if (computeYoy) {
    const yearBp220 = new Map<number, { bp220: number; total: number }>();
    for (const row of rows) {
      if (!row.issue_date) continue;
      const year = parseInt(row.issue_date.slice(0, 4), 10);
      if (isNaN(year)) continue;
      let entry = yearBp220.get(year);
      if (!entry) {
        entry = { bp220: 0, total: 0 };
        yearBp220.set(year, entry);
      }
      entry.total++;
      if (normalizeLaw(row.raw_project_type) === "BP220") entry.bp220++;
    }

    const years = [...yearBp220.keys()].sort((a, b) => a - b);
    if (years.length >= 2) {
      const recentYear = years[years.length - 1];
      const prevYear = years[years.length - 2];
      const recentEntry = yearBp220.get(recentYear)!;
      const prevEntry = yearBp220.get(prevYear)!;
      const recentShare = recentEntry.total > 0 ? (recentEntry.bp220 / recentEntry.total) * 100 : 0;
      const prevShare = prevEntry.total > 0 ? (prevEntry.bp220 / prevEntry.total) * 100 : 0;
      yoy_shift = {
        from_year: prevYear,
        to_year: recentYear,
        bp220_share_delta: Math.round((recentShare - prevShare) * 10) / 10,
      };
    }
  }

  return { total, breakdown, yoy_shift };
}

export async function aggregateTrends(
  client: SupabaseClient,
  filters: { region?: string; law?: NormalizedLaw; from_year?: number; to_year?: number } = {},
  granularity: "annual" | "quarterly" = "annual"
): Promise<TrendsResponse> {
  const { rows, truncated } = await fetchFilteredRows(client, filters);
  const result = aggregateTrendsFromRows(rows, granularity);
  // Trend headline numbers are unreliable on a partial dataset; suppress
  // them when truncated so a consumer cannot mistake them for authoritative.
  if (truncated) {
    result.yoy_growth_pct = null;
    result.peak_period = null;
  }
  return { ...result, truncated };
}

export function aggregateTrendsFromRows(
  rows: AnalyticsRow[],
  granularity: "annual" | "quarterly"
): Omit<TrendsResponse, "truncated"> {
  const map = new Map<string, { count: number; by_law: LawBreakdown }>();

  for (const row of rows) {
    if (!row.issue_date) continue;
    const key = getPeriodKey(row.issue_date, granularity);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { count: 0, by_law: emptyLawBreakdown() };
      map.set(key, bucket);
    }
    bucket.count++;
    incrementLaw(bucket.by_law, normalizeLaw(row.raw_project_type));
  }

  const periods: TrendPeriod[] = [...map.entries()]
    .map(([period, b]) => ({ period, count: b.count, by_law: b.by_law }))
    .sort((a, b) => a.period.localeCompare(b.period));

  const total = periods.reduce((sum, p) => sum + p.count, 0);
  const peak_period = periods.length > 0
    ? periods.reduce((max, p) => (p.count > max.count ? p : max)).period
    : null;

  let yoy_growth_pct: number | null = null;
  if (granularity === "annual" && periods.length >= 2) {
    const last = periods[periods.length - 1];
    const prev = periods[periods.length - 2];
    if (prev.count > 0) {
      yoy_growth_pct = Math.round(((last.count - prev.count) / prev.count) * 1000) / 10;
    }
  }

  return { total, granularity, periods, peak_period, yoy_growth_pct };
}

export async function aggregateByCity(
  client: SupabaseClient,
  filters: { region?: string; year?: number; law?: NormalizedLaw } = {},
  limit = 25
): Promise<ByCityResponse> {
  const { rows, truncated } = await fetchFilteredRows(client, filters);
  return { ...aggregateByCityFromRows(rows, limit, getTodayPH()), truncated };
}

export function aggregateByCityFromRows(rows: AnalyticsRow[], limit: number, today: string): Omit<ByCityResponse, "truncated"> {
  const map = new Map<
    string,
    {
      city: string;
      province: string | null;
      region: string | null;
      count: number;
      by_law: LawBreakdown;
      active: number;
      expired: number;
      devCounts: Map<string, number>;
    }
  >();

  for (const row of rows) {
    const city = row.normalized_city ?? "Unknown";
    const province = row.normalized_province ?? "Unknown";
    const key = `${city}|||${province}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        city,
        province: row.normalized_province,
        region: row.normalized_region,
        count: 0,
        by_law: emptyLawBreakdown(),
        active: 0,
        expired: 0,
        devCounts: new Map(),
      };
      map.set(key, bucket);
    }
    bucket.count++;
    incrementLaw(bucket.by_law, normalizeLaw(row.raw_project_type));
    if (deriveStatus(row.expiry_date, today) === "active") bucket.active++;
    else bucket.expired++;
    const dev = row.normalized_developer ?? "Unknown";
    bucket.devCounts.set(dev, (bucket.devCounts.get(dev) ?? 0) + 1);
  }

  const total = rows.length;
  const cities = [...map.values()]
    .map((b) => {
      let topDev: string | null = null;
      let topCount = 0;
      for (const [dev, count] of b.devCounts) {
        if (count > topCount) {
          topDev = dev;
          topCount = count;
        }
      }
      return {
        city: b.city,
        province: b.province,
        region: b.region,
        count: b.count,
        share_pct: computeSharePct(b.count, total),
        by_law: b.by_law,
        active: b.active,
        expired: b.expired,
        top_developer: topDev,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { total, cities };
}

export async function aggregateExpiryRisk(
  client: SupabaseClient,
  filters: { region?: string; law?: NormalizedLaw } = {},
  days = 90
): Promise<ExpiryRiskResponse> {
  const today = getTodayPH();
  const futureDate = getFutureDatePH(days);

  const { rows, truncated } = await fetchFilteredRows(client, {
    ...filters,
    expiryFrom: today,
    expiryTo: futureDate,
    // Keep the soonest-expiring rows if the window exceeds ROW_LIMIT.
    orderBy: { column: "expiry_date", ascending: true },
  });

  return { ...aggregateExpiryRiskFromRows(rows, today, days), truncated };
}

export function aggregateExpiryRiskFromRows(
  rows: AnalyticsRow[],
  today: string,
  days: number
): Omit<ExpiryRiskResponse, "truncated"> {
  const todayMs = new Date(today).getTime();

  const records: ExpiryRiskRecord[] = rows
    .filter((r) => r.expiry_date !== null)
    .map((r) => {
      const expiryMs = new Date(r.expiry_date!).getTime();
      const daysRemaining = Math.ceil((expiryMs - todayMs) / (1000 * 60 * 60 * 24));
      return {
        lts_number: r.lts_number,
        project_name: r.normalized_project_name,
        developer: r.normalized_developer,
        city: r.normalized_city,
        region: r.normalized_region,
        expiry_date: r.expiry_date!,
        days_remaining: daysRemaining,
      };
    })
    .sort((a, b) => a.days_remaining - b.days_remaining);

  const regionCounts = new Map<string, number>();
  const devCounts = new Map<string, number>();

  for (const rec of records) {
    const region = rec.region ?? "Unknown";
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    const dev = rec.developer ?? "Unknown";
    devCounts.set(dev, (devCounts.get(dev) ?? 0) + 1);
  }

  return {
    total: records.length,
    days_window: days,
    summary: {
      by_region: [...regionCounts.entries()]
        .map(([region, count]) => ({ region, count }))
        .sort((a, b) => b.count - a.count),
      by_developer: [...devCounts.entries()]
        .map(([developer, count]) => ({ developer, count }))
        .sort((a, b) => b.count - a.count),
    },
    records,
  };
}
