// ── LTS Status Enum ──────────────────────────────────────────────────────────
export type LTSStatus = "unverified" | "verified" | "expired" | "none";
export type LTSSource = "dhsud_import" | "manual" | "admin";
export type MatchStatus =
  | "pending"
  | "auto_matched"
  | "manual_matched"
  | "no_match"
  | "skipped"
  | "new_project";
export type MatchType = "exact_lts" | "exact_name" | "fuzzy" | "manual" | "new";

// ── Queue Item (lts_verification_queue) ─────────────────────────────────────
export interface QueueItemRow {
  id: string;
  lts_number: string;
  scraped_project_name: string;
  scraped_developer: string | null;
  scraped_city: string | null;
  scraped_city_slug: string | null;
  scraped_province: string | null;
  scraped_region: string | null;
  scraped_issue_date: string | null;
  scraped_expiry_date: string | null;
  scraped_project_type: string | null;
  phase_name: string | null;
  source_url: string;
  match_status: MatchStatus;
  matched_project_id: string | null;
  match_score: number | null;
  match_type: MatchType | null;
  candidates: MatchCandidate[];
  linked_project_lts_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  scraped_at: string;
  created_at: string;
  updated_at: string;
}

export interface MatchCandidate {
  projectId: string;
  projectName: string;
  developerName: string;
  developerSlug: string;
  city: string;
  score: number;
  matchReason: string;
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

// ── Verification Stats (get_lts_verification_stats RPC) ─────────────────────
export interface VerificationStats {
  total_records: number;
  pending_count: number;
  auto_matched_count: number;
  manual_matched_count: number;
  no_match_count: number;
  expired_lts_count: number;
  expiring_soon_count: number;
  total_project_lts: number;
  verified_project_lts: number;
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
  queue: VerificationStats;
  projects: {
    total: number;
    withLTS: number;
    activeLTS: number;
    expiredLTS: number;
    expiringSoon: number;
  };
}

// ── Analytics Types ─────────────────────────────────────────────────────────

/** Lightweight row for aggregation queries (subset of QueueItemRow). */
export interface AnalyticsRow {
  lts_number: string;
  scraped_project_name: string;
  scraped_developer: string | null;
  scraped_city: string | null;
  scraped_province: string | null;
  scraped_region: string | null;
  scraped_issue_date: string | null;
  scraped_expiry_date: string | null;
  scraped_project_type: string | null;
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
