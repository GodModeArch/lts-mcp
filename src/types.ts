// ── LTS Status Enum ──────────────────────────────────────────────────────────
export type LTSStatus = "unverified" | "verified" | "expired" | "none";
export type LTSSource = "dhsud_import" | "manual" | "admin";
export type ConfidenceLevel = "high" | "medium" | "low";
export type LTSFormat = "standard" | "regional" | "amendment" | "numeric_only" | "unknown";

// ── LTS Record (lts_records table) ──────────────────────────────────────────
export interface LTSRecordRow {
  lts_number: string;
  raw_project_name: string;
  raw_developer: string | null;
  raw_city: string | null;
  raw_province: string | null;
  raw_region: string | null;
  raw_issue_date: string | null;
  raw_expiry_date: string | null;
  raw_project_type: string | null;
  raw_barangay: string | null;
  raw_units: string | null;
  normalized_project_name: string;
  base_project_name: string;
  phase_name: string | null;
  normalized_developer: string | null;
  normalized_city: string;
  city_slug: string;
  normalized_province: string | null;
  normalized_region: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  lts_format: LTSFormat;
  confidence: ConfidenceLevel;
  inferred_project_type: string | null;
  parsing_notes: string[] | null;
  project_id: string | null;
  source_url: string | null;
  scraped_at: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Project LTS (project_lts) ───────────────────────────────────────────────
export interface ProjectLTSRow {
  id: string;
  project_id: string;
  lts_number: string;
  phase_name: string | null;
  scraped_project_name: string | null;
  scraped_developer: string | null;
  scraped_city: string | null;
  scraped_province: string | null;
  scraped_region: string | null;
  scraped_project_type: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  status: LTSStatus;
  verified_at: string | null;
  verified_by: string | null;
  document_url: string | null;
  source: LTSSource;
  source_url: string | null;
  queue_item_id: string | null;
  is_primary: boolean;
  display_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// RPC get_project_lts_records returns these computed fields
export interface ProjectLTSWithComputed extends ProjectLTSRow {
  is_expired: boolean;
  days_until_expiry: number | null;
}

// ── Project (projects table, LTS-relevant fields) ───────────────────────────
export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  province: string | null;
  region: string | null;
  publish_status: string;
  lts_number: string | null;
  lts_issue_date: string | null;
  lts_expiry_date: string | null;
  lts_status: LTSStatus;
  lts_count: number;
  active_lts_count: number;
  developers?: { name: string; slug: string }[] | { name: string; slug: string } | null;
}

// ── LTS Stats (get_lts_stats RPC) ───────────────────────────────────────────
export interface LTSStatsResult {
  total_records: number;
  high_confidence: number;
  medium_confidence: number;
  low_confidence: number;
  linked_to_project: number;
  unlinked: number;
  active_lts: number;
  expired_lts: number;
  unique_developers: number;
  unique_cities: number;
}

// ── Paginated Response ──────────────────────────────────────────────────────
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ── Tool Response Wrappers ──────────────────────────────────────────────────
export interface StatsResponse {
  ltsRecords: LTSStatsResult;
  projects: {
    total: number;
    withLTS: number;
    activeLTS: number;
    expiredLTS: number;
    expiringSoon: number;
  };
}

// ── Analytics Types ─────────────────────────────────────────────────────────

/** Lightweight row for aggregation queries (subset of LTSRecordRow). */
export interface AnalyticsRow {
  lts_number: string;
  normalized_project_name: string;
  normalized_developer: string | null;
  normalized_city: string | null;
  normalized_province: string | null;
  normalized_region: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  inferred_project_type: string | null;
}

export type NormalizedLaw = "BP220" | "PD957" | null;

export interface LawBreakdown {
  BP220: number;
  PD957: number;
  unknown: number;
}

export interface ByRegionItem {
  region: string;
  count: number;
  share_pct: number;
  by_law: LawBreakdown;
  active: number;
  expired: number;
}

export interface ByRegionResponse {
  total: number;
  truncated: boolean;
  regions: ByRegionItem[];
}

export interface ByDeveloperItem {
  developer: string;
  count: number;
  share_pct: number;
  regions: string[];
  by_law: LawBreakdown;
  active: number;
  expired: number;
}

export interface ByDeveloperResponse {
  total: number;
  truncated: boolean;
  developers: ByDeveloperItem[];
}

export interface LawRegionItem {
  region: string;
  count: number;
}

export interface ByLawItem {
  law: string;
  count: number;
  share_pct: number;
  by_region: LawRegionItem[];
}

export interface ByLawResponse {
  total: number;
  truncated: boolean;
  breakdown: ByLawItem[];
  yoy_shift: { from_year: number; to_year: number; bp220_share_delta: number } | null;
}

export interface TrendPeriod {
  period: string;
  count: number;
  by_law: LawBreakdown;
}

export interface TrendsResponse {
  total: number;
  truncated: boolean;
  granularity: "annual" | "quarterly";
  periods: TrendPeriod[];
  peak_period: string | null;
  yoy_growth_pct: number | null;
}

export interface ByCityItem {
  city: string;
  province: string | null;
  region: string | null;
  count: number;
  share_pct: number;
  by_law: LawBreakdown;
  active: number;
  expired: number;
  top_developer: string | null;
}

export interface ByCityResponse {
  total: number;
  truncated: boolean;
  cities: ByCityItem[];
}

export interface ExpiryRiskRecord {
  lts_number: string;
  project_name: string;
  developer: string | null;
  city: string | null;
  region: string | null;
  expiry_date: string;
  days_remaining: number;
}

export interface ExpiryRiskSummary {
  by_region: { region: string; count: number }[];
  by_developer: { developer: string; count: number }[];
}

export interface ExpiryRiskResponse {
  total: number;
  truncated: boolean;
  days_window: number;
  summary: ExpiryRiskSummary;
  records: ExpiryRiskRecord[];
}
