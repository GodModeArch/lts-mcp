import { describe, it, expect, vi } from "vitest";
import type { AnalyticsRow } from "../src/types";
import {
  normalizeLaw,
  deriveStatus,
  computeSharePct,
  emptyLawBreakdown,
  incrementLaw,
  getPeriodKey,
  fetchFilteredRows,
  aggregateByRegionFromRows,
  aggregateByDeveloperFromRows,
  aggregateByLawFromRows,
  aggregateTrendsFromRows,
  aggregateByCityFromRows,
  aggregateExpiryRiskFromRows,
} from "../src/db/analytics";

// ── Pure Helper Tests ───────────────────────────────────────────────────────

describe("normalizeLaw", () => {
  it("normalizes 'BP 220' to BP220", () => {
    expect(normalizeLaw("BP 220")).toBe("BP220");
  });

  it("normalizes 'PD 957' to PD957", () => {
    expect(normalizeLaw("PD 957")).toBe("PD957");
  });

  it("normalizes lowercase 'bp220' to BP220", () => {
    expect(normalizeLaw("bp220")).toBe("BP220");
  });

  it("normalizes 'B.P. 220' to BP220", () => {
    expect(normalizeLaw("B.P. 220")).toBe("BP220");
  });

  it("normalizes 'P.D. 957' to PD957", () => {
    expect(normalizeLaw("P.D. 957")).toBe("PD957");
  });

  it("normalizes 'BP220' (no space) to BP220", () => {
    expect(normalizeLaw("BP220")).toBe("BP220");
  });

  it("normalizes a full raw_project_type value like 'EH Subd - BP 220'", () => {
    expect(normalizeLaw("EH Subd - BP 220")).toBe("BP220");
  });

  it("does not match a bare number without a BP/PD prefix (no false positive)", () => {
    expect(normalizeLaw("220 sqm lot")).toBeNull();
    expect(normalizeLaw("Block 957")).toBeNull();
  });

  it("returns null for non-LTS suffixes like 'NR' and 'EO 648'", () => {
    expect(normalizeLaw("MP - NR")).toBeNull();
    expect(normalizeLaw("Commercial Subd - EO 648")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(normalizeLaw(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeLaw("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeLaw("   ")).toBeNull();
  });

  it("returns null for unrecognized text", () => {
    expect(normalizeLaw("RA 7279")).toBeNull();
  });
});

describe("deriveStatus", () => {
  it("returns active for future date", () => {
    expect(deriveStatus("2099-12-31", "2025-01-01")).toBe("active");
  });

  it("returns expired for past date", () => {
    expect(deriveStatus("2020-01-01", "2025-01-01")).toBe("expired");
  });

  it("returns active when expiry equals today", () => {
    expect(deriveStatus("2025-06-15", "2025-06-15")).toBe("active");
  });

  it("returns expired for null expiry date", () => {
    expect(deriveStatus(null, "2025-01-01")).toBe("expired");
  });
});

describe("computeSharePct", () => {
  it("computes correct percentage", () => {
    expect(computeSharePct(25, 100)).toBe(25);
  });

  it("rounds to 1 decimal", () => {
    expect(computeSharePct(1, 3)).toBe(33.3);
  });

  it("returns 0 for zero total", () => {
    expect(computeSharePct(5, 0)).toBe(0);
  });

  it("returns 0 for zero count", () => {
    expect(computeSharePct(0, 100)).toBe(0);
  });

  it("returns 100 for full share", () => {
    expect(computeSharePct(50, 50)).toBe(100);
  });
});

describe("emptyLawBreakdown / incrementLaw", () => {
  it("starts with all zeros", () => {
    expect(emptyLawBreakdown()).toEqual({ BP220: 0, PD957: 0, unknown: 0 });
  });

  it("increments BP220", () => {
    const b = emptyLawBreakdown();
    incrementLaw(b, "BP220");
    expect(b.BP220).toBe(1);
  });

  it("increments PD957", () => {
    const b = emptyLawBreakdown();
    incrementLaw(b, "PD957");
    expect(b.PD957).toBe(1);
  });

  it("increments unknown for null", () => {
    const b = emptyLawBreakdown();
    incrementLaw(b, null);
    expect(b.unknown).toBe(1);
  });
});

describe("getPeriodKey", () => {
  it("returns year for annual granularity", () => {
    expect(getPeriodKey("2024-06-15", "annual")).toBe("2024");
  });

  it("returns Q1 for Jan-Mar", () => {
    expect(getPeriodKey("2024-02-15", "quarterly")).toBe("2024-Q1");
  });

  it("returns Q2 for Apr-Jun", () => {
    expect(getPeriodKey("2024-05-01", "quarterly")).toBe("2024-Q2");
  });

  it("returns Q3 for Jul-Sep", () => {
    expect(getPeriodKey("2024-08-20", "quarterly")).toBe("2024-Q3");
  });

  it("returns Q4 for Oct-Dec", () => {
    expect(getPeriodKey("2024-12-31", "quarterly")).toBe("2024-Q4");
  });
});

// ── Aggregation Tests (pure functions, no mocks) ────────────────────────────

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    lts_number: "LTS-001",
    normalized_project_name: "Test Project",
    normalized_developer: "Test Developer",
    normalized_city: "Makati",
    normalized_province: "Metro Manila",
    normalized_region: "NCR",
    issue_date: "2024-06-01",
    expiry_date: "2099-12-31",
    raw_project_type: "EH Subd - BP 220", // law lives here
    inferred_project_type: "house_and_lot", // project category, not a law
    ...overrides,
  };
}

describe("aggregateByRegionFromRows", () => {
  it("groups by region with correct counts", () => {
    const rows = [
      makeRow({ normalized_region: "NCR" }),
      makeRow({ normalized_region: "NCR" }),
      makeRow({ normalized_region: "Region IV-A" }),
    ];
    const result = aggregateByRegionFromRows(rows, "2025-06-01");
    expect(result.total).toBe(3);
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0].region).toBe("NCR");
    expect(result.regions[0].count).toBe(2);
    expect(result.regions[1].region).toBe("Region IV-A");
    expect(result.regions[1].count).toBe(1);
  });

  it("computes share_pct correctly", () => {
    const rows = [
      makeRow({ normalized_region: "NCR" }),
      makeRow({ normalized_region: "NCR" }),
      makeRow({ normalized_region: "NCR" }),
      makeRow({ normalized_region: "Region III" }),
    ];
    const result = aggregateByRegionFromRows(rows, "2025-06-01");
    expect(result.regions[0].share_pct).toBe(75);
    expect(result.regions[1].share_pct).toBe(25);
  });

  it("tracks law breakdown per region", () => {
    const rows = [
      makeRow({ normalized_region: "NCR", raw_project_type: "BP 220" }),
      makeRow({ normalized_region: "NCR", raw_project_type: "PD 957" }),
      makeRow({ normalized_region: "NCR", raw_project_type: null }),
    ];
    const result = aggregateByRegionFromRows(rows, "2025-06-01");
    expect(result.regions[0].by_law).toEqual({ BP220: 1, PD957: 1, unknown: 1 });
  });

  it("tracks active/expired split", () => {
    const rows = [
      makeRow({ normalized_region: "NCR", expiry_date: "2099-12-31" }),
      makeRow({ normalized_region: "NCR", expiry_date: "2020-01-01" }),
    ];
    const result = aggregateByRegionFromRows(rows, "2025-06-01");
    expect(result.regions[0].active).toBe(1);
    expect(result.regions[0].expired).toBe(1);
  });

  it("maps null region to Unknown", () => {
    const rows = [makeRow({ normalized_region: null })];
    const result = aggregateByRegionFromRows(rows, "2025-06-01");
    expect(result.regions[0].region).toBe("Unknown");
  });

  it("returns empty regions for empty rows", () => {
    const result = aggregateByRegionFromRows([], "2025-06-01");
    expect(result.total).toBe(0);
    expect(result.regions).toEqual([]);
  });

  it("sorts by count descending", () => {
    const rows = [
      makeRow({ normalized_region: "A" }),
      makeRow({ normalized_region: "B" }),
      makeRow({ normalized_region: "B" }),
      makeRow({ normalized_region: "B" }),
      makeRow({ normalized_region: "C" }),
      makeRow({ normalized_region: "C" }),
    ];
    const result = aggregateByRegionFromRows(rows, "2025-06-01");
    expect(result.regions.map((r) => r.region)).toEqual(["B", "C", "A"]);
  });
});

describe("aggregateByDeveloperFromRows", () => {
  it("groups by developer with regions tracked", () => {
    const rows = [
      makeRow({ normalized_developer: "DevA", normalized_region: "NCR" }),
      makeRow({ normalized_developer: "DevA", normalized_region: "Region III" }),
      makeRow({ normalized_developer: "DevB", normalized_region: "NCR" }),
    ];
    const result = aggregateByDeveloperFromRows(rows, 25, "2025-06-01");
    expect(result.total).toBe(3);
    expect(result.developers[0].developer).toBe("DevA");
    expect(result.developers[0].regions).toEqual(["NCR", "Region III"]);
  });

  it("applies limit", () => {
    const rows = [
      makeRow({ normalized_developer: "A" }),
      makeRow({ normalized_developer: "A" }),
      makeRow({ normalized_developer: "B" }),
      makeRow({ normalized_developer: "C" }),
    ];
    const result = aggregateByDeveloperFromRows(rows, 2, "2025-06-01");
    expect(result.developers).toHaveLength(2);
    expect(result.total).toBe(4);
  });

  it("maps null developer to Unknown", () => {
    const rows = [makeRow({ normalized_developer: null })];
    const result = aggregateByDeveloperFromRows(rows, 25, "2025-06-01");
    expect(result.developers[0].developer).toBe("Unknown");
  });
});

describe("aggregateByLawFromRows", () => {
  it("groups by normalized law", () => {
    const rows = [
      makeRow({ raw_project_type: "BP 220" }),
      makeRow({ raw_project_type: "BP 220" }),
      makeRow({ raw_project_type: "PD 957" }),
      makeRow({ raw_project_type: null }),
    ];
    const result = aggregateByLawFromRows(rows, false);
    expect(result.total).toBe(4);
    expect(result.breakdown).toHaveLength(3);
    const bp220 = result.breakdown.find((b) => b.law === "BP220");
    expect(bp220?.count).toBe(2);
  });

  it("includes by_region sub-array per law", () => {
    const rows = [
      makeRow({ raw_project_type: "BP 220", normalized_region: "NCR" }),
      makeRow({ raw_project_type: "BP 220", normalized_region: "Region III" }),
      makeRow({ raw_project_type: "BP 220", normalized_region: "NCR" }),
    ];
    const result = aggregateByLawFromRows(rows, false);
    const bp220 = result.breakdown.find((b) => b.law === "BP220")!;
    expect(bp220.by_region).toHaveLength(2);
    expect(bp220.by_region[0].region).toBe("NCR");
    expect(bp220.by_region[0].count).toBe(2);
  });

  it("computes yoy_shift when enabled and has 2+ years", () => {
    const rows = [
      makeRow({ issue_date: "2023-06-01", raw_project_type: "BP 220" }),
      makeRow({ issue_date: "2023-06-01", raw_project_type: "PD 957" }),
      makeRow({ issue_date: "2024-06-01", raw_project_type: "BP 220" }),
      makeRow({ issue_date: "2024-06-01", raw_project_type: "BP 220" }),
      makeRow({ issue_date: "2024-06-01", raw_project_type: "PD 957" }),
    ];
    const result = aggregateByLawFromRows(rows, true);
    expect(result.yoy_shift).not.toBeNull();
    expect(result.yoy_shift!.from_year).toBe(2023);
    expect(result.yoy_shift!.to_year).toBe(2024);
    // 2023: 1/2 = 50%, 2024: 2/3 = 66.7%, delta = 16.7
    expect(result.yoy_shift!.bp220_share_delta).toBe(16.7);
  });

  it("returns null yoy_shift when disabled", () => {
    const rows = [
      makeRow({ issue_date: "2023-06-01" }),
      makeRow({ issue_date: "2024-06-01" }),
    ];
    const result = aggregateByLawFromRows(rows, false);
    expect(result.yoy_shift).toBeNull();
  });

  it("returns null yoy_shift when less than 2 years of data", () => {
    const rows = [makeRow({ issue_date: "2024-06-01" })];
    const result = aggregateByLawFromRows(rows, true);
    expect(result.yoy_shift).toBeNull();
  });
});

describe("aggregateTrendsFromRows", () => {
  it("groups by annual periods sorted chronologically", () => {
    const rows = [
      makeRow({ issue_date: "2024-03-01" }),
      makeRow({ issue_date: "2023-06-01" }),
      makeRow({ issue_date: "2024-09-01" }),
    ];
    const result = aggregateTrendsFromRows(rows, "annual");
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0].period).toBe("2023");
    expect(result.periods[0].count).toBe(1);
    expect(result.periods[1].period).toBe("2024");
    expect(result.periods[1].count).toBe(2);
  });

  it("groups by quarterly periods", () => {
    const rows = [
      makeRow({ issue_date: "2024-01-15" }),
      makeRow({ issue_date: "2024-04-15" }),
      makeRow({ issue_date: "2024-01-20" }),
    ];
    const result = aggregateTrendsFromRows(rows, "quarterly");
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0].period).toBe("2024-Q1");
    expect(result.periods[0].count).toBe(2);
    expect(result.periods[1].period).toBe("2024-Q2");
    expect(result.periods[1].count).toBe(1);
  });

  it("excludes rows with null issue date", () => {
    const rows = [
      makeRow({ issue_date: "2024-01-01" }),
      makeRow({ issue_date: null }),
    ];
    const result = aggregateTrendsFromRows(rows, "annual");
    expect(result.total).toBe(1);
  });

  it("identifies peak period", () => {
    const rows = [
      makeRow({ issue_date: "2023-01-01" }),
      makeRow({ issue_date: "2024-01-01" }),
      makeRow({ issue_date: "2024-06-01" }),
    ];
    const result = aggregateTrendsFromRows(rows, "annual");
    expect(result.peak_period).toBe("2024");
  });

  it("computes yoy_growth_pct for annual", () => {
    const rows = [
      makeRow({ issue_date: "2023-01-01" }),
      makeRow({ issue_date: "2023-06-01" }),
      makeRow({ issue_date: "2024-01-01" }),
      makeRow({ issue_date: "2024-06-01" }),
      makeRow({ issue_date: "2024-09-01" }),
    ];
    const result = aggregateTrendsFromRows(rows, "annual");
    // 2023: 2, 2024: 3, growth = (3-2)/2 = 50%
    expect(result.yoy_growth_pct).toBe(50);
  });

  it("returns null yoy_growth_pct for quarterly", () => {
    const rows = [
      makeRow({ issue_date: "2024-01-01" }),
      makeRow({ issue_date: "2024-04-01" }),
    ];
    const result = aggregateTrendsFromRows(rows, "quarterly");
    expect(result.yoy_growth_pct).toBeNull();
  });

  it("returns null peak_period for empty dataset", () => {
    const result = aggregateTrendsFromRows([], "annual");
    expect(result.peak_period).toBeNull();
    expect(result.total).toBe(0);
  });
});

describe("aggregateByCityFromRows", () => {
  it("groups by city with province and region", () => {
    const rows = [
      makeRow({ normalized_city: "Makati", normalized_province: "Metro Manila", normalized_region: "NCR" }),
      makeRow({ normalized_city: "Makati", normalized_province: "Metro Manila", normalized_region: "NCR" }),
      makeRow({ normalized_city: "Taguig", normalized_province: "Metro Manila", normalized_region: "NCR" }),
    ];
    const result = aggregateByCityFromRows(rows, 25, "2025-06-01");
    expect(result.total).toBe(3);
    expect(result.cities[0].city).toBe("Makati");
    expect(result.cities[0].count).toBe(2);
    expect(result.cities[0].province).toBe("Metro Manila");
  });

  it("identifies top developer per city", () => {
    const rows = [
      makeRow({ normalized_city: "Makati", normalized_developer: "Ayala" }),
      makeRow({ normalized_city: "Makati", normalized_developer: "Ayala" }),
      makeRow({ normalized_city: "Makati", normalized_developer: "SMDC" }),
    ];
    const result = aggregateByCityFromRows(rows, 25, "2025-06-01");
    expect(result.cities[0].top_developer).toBe("Ayala");
  });

  it("applies limit", () => {
    const rows = [
      makeRow({ normalized_city: "A" }),
      makeRow({ normalized_city: "A" }),
      makeRow({ normalized_city: "B" }),
      makeRow({ normalized_city: "C" }),
    ];
    const result = aggregateByCityFromRows(rows, 2, "2025-06-01");
    expect(result.cities).toHaveLength(2);
  });

  it("maps null city to Unknown", () => {
    const rows = [makeRow({ normalized_city: null })];
    const result = aggregateByCityFromRows(rows, 25, "2025-06-01");
    expect(result.cities[0].city).toBe("Unknown");
  });

  it("keeps same-name cities in different provinces separate", () => {
    const rows = [
      makeRow({ normalized_city: "San Jose", normalized_province: "Batangas", normalized_region: "Region IV-A" }),
      makeRow({ normalized_city: "San Jose", normalized_province: "Batangas", normalized_region: "Region IV-A" }),
      makeRow({ normalized_city: "San Jose", normalized_province: "Nueva Ecija", normalized_region: "Region III" }),
    ];
    const result = aggregateByCityFromRows(rows, 25, "2025-06-01");
    expect(result.cities).toHaveLength(2);
    const batangas = result.cities.find((c) => c.province === "Batangas");
    const nuevaEcija = result.cities.find((c) => c.province === "Nueva Ecija");
    expect(batangas?.count).toBe(2);
    expect(nuevaEcija?.count).toBe(1);
  });
});

describe("aggregateExpiryRiskFromRows", () => {
  it("computes days_remaining and sorts by urgency", () => {
    const rows = [
      makeRow({ lts_number: "LTS-B", expiry_date: "2025-04-01" }),
      makeRow({ lts_number: "LTS-A", expiry_date: "2025-03-01" }),
    ];
    const result = aggregateExpiryRiskFromRows(rows, "2025-02-01", 90);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].lts_number).toBe("LTS-A");
    expect(result.records[0].days_remaining).toBe(28);
    expect(result.records[1].lts_number).toBe("LTS-B");
    expect(result.records[1].days_remaining).toBe(59);
  });

  it("filters out rows with null expiry date", () => {
    const rows = [
      makeRow({ expiry_date: "2025-03-01" }),
      makeRow({ expiry_date: null }),
    ];
    const result = aggregateExpiryRiskFromRows(rows, "2025-02-01", 90);
    expect(result.total).toBe(1);
  });

  it("builds summary by region and developer", () => {
    const rows = [
      makeRow({ normalized_region: "NCR", normalized_developer: "DevA", expiry_date: "2025-03-01" }),
      makeRow({ normalized_region: "NCR", normalized_developer: "DevB", expiry_date: "2025-03-15" }),
      makeRow({ normalized_region: "Region III", normalized_developer: "DevA", expiry_date: "2025-04-01" }),
    ];
    const result = aggregateExpiryRiskFromRows(rows, "2025-02-01", 90);
    expect(result.summary.by_region).toHaveLength(2);
    expect(result.summary.by_region[0]).toEqual({ region: "NCR", count: 2 });
    expect(result.summary.by_developer).toHaveLength(2);
    expect(result.summary.by_developer[0]).toEqual({ developer: "DevA", count: 2 });
  });

  it("returns empty result for empty rows", () => {
    const result = aggregateExpiryRiskFromRows([], "2025-02-01", 90);
    expect(result.total).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.summary.by_region).toEqual([]);
    expect(result.summary.by_developer).toEqual([]);
  });

  it("includes days_window in response", () => {
    const result = aggregateExpiryRiskFromRows([], "2025-02-01", 60);
    expect(result.days_window).toBe(60);
  });
});

// ── fetchFilteredRows Tests (mock Supabase client) ──────────────────────────

function createMockBuilder(response: { data: unknown; error: null | { message: string } }) {
  const builder: Record<string, unknown> = {};
  const chainMethods = ["select", "eq", "gte", "lte", "order", "limit"];
  for (const method of chainMethods) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (resolve: (val: typeof response) => void) => resolve(response);
  return builder;
}

describe("fetchFilteredRows", () => {
  it("selects only analytics columns and applies limit", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await fetchFilteredRows(client);
    expect(client.from).toHaveBeenCalledWith("lts_records");
    expect(builder.select).toHaveBeenCalled();
    expect(builder.limit).toHaveBeenCalledWith(10000);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("orders by issue_date then lts_number before the cap (deterministic truncation)", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await fetchFilteredRows(client);
    expect(builder.order).toHaveBeenCalledWith("issue_date", { ascending: true, nullsFirst: false });
    expect(builder.order).toHaveBeenCalledWith("lts_number", { ascending: true });
  });

  it("honors a custom orderBy (expiry_date asc for expiry-risk path)", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await fetchFilteredRows(client, { orderBy: { column: "expiry_date", ascending: true } });
    expect(builder.order).toHaveBeenCalledWith("expiry_date", { ascending: true, nullsFirst: false });
  });

  it("applies year filter as date range", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await fetchFilteredRows(client, { year: 2024 });
    expect(builder.gte).toHaveBeenCalledWith("issue_date", "2024-01-01");
    expect(builder.lte).toHaveBeenCalledWith("issue_date", "2024-12-31");
  });

  it("applies region filter", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await fetchFilteredRows(client, { region: "NCR" });
    expect(builder.eq).toHaveBeenCalledWith("normalized_region", "NCR");
  });

  it("applies expiry date range filters", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await fetchFilteredRows(client, { expiryFrom: "2025-01-01", expiryTo: "2025-03-31" });
    expect(builder.gte).toHaveBeenCalledWith("expiry_date", "2025-01-01");
    expect(builder.lte).toHaveBeenCalledWith("expiry_date", "2025-03-31");
  });

  it("applies client-side law filter", async () => {
    const rows = [
      { raw_project_type: "BP 220", expiry_date: "2099-12-31" },
      { raw_project_type: "PD 957", expiry_date: "2099-12-31" },
      { raw_project_type: null, expiry_date: "2099-12-31" },
    ];
    const builder = createMockBuilder({ data: rows, error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await fetchFilteredRows(client, { law: "BP220" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].raw_project_type).toBe("BP 220");
  });

  it("applies client-side status filter", async () => {
    const rows = [
      { expiry_date: "2099-12-31", raw_project_type: null },
      { expiry_date: "2020-01-01", raw_project_type: null },
    ];
    const builder = createMockBuilder({ data: rows, error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await fetchFilteredRows(client, { status: "active" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].expiry_date).toBe("2099-12-31");
  });

  it("sets truncated=true when row limit is hit", async () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({
      lts_number: `LTS-${i}`,
      raw_project_type: null,
      expiry_date: "2099-12-31",
    }));
    const builder = createMockBuilder({ data: rows, error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await fetchFilteredRows(client);
    expect(result.truncated).toBe(true);
  });

  it("throws on query error", async () => {
    const builder = createMockBuilder({ data: null, error: { message: "timeout" } });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await expect(fetchFilteredRows(client)).rejects.toThrow("Analytics query failed");
  });

  it("applies from_year and to_year filters", async () => {
    const builder = createMockBuilder({ data: [], error: null });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await fetchFilteredRows(client, { from_year: 2022, to_year: 2024 });
    expect(builder.gte).toHaveBeenCalledWith("issue_date", "2022-01-01");
    expect(builder.lte).toHaveBeenCalledWith("issue_date", "2024-12-31");
  });
});
