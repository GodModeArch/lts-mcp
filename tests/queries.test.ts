import { describe, it, expect, vi } from "vitest";
import {
  search,
  getLTSRecordItems,
  getProjectLTS,
  findProjectByName,
  checkLTSNumber,
  getFilterValues,
} from "../src/db/queries";
import { parseOrFilter, matchesThroughFilter } from "./helpers/postgrest";

// -- Mock Supabase Client (chainable builder pattern) --

interface MockResponse {
  data: unknown;
  error: null | { message: string };
  count?: number | null;
}

const CHAIN_METHODS = [
  "select",
  "eq",
  "neq",
  "gt",
  "gte",
  "lte",
  "or",
  "ilike",
  "not",
  "is",
  "order",
  "range",
  "limit",
  "single",
  "maybeSingle",
];

function createMockBuilder(response: MockResponse) {
  const builder: Record<string, unknown> = {};

  for (const method of CHAIN_METHODS) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }

  // Terminal methods return the response
  builder.single = vi.fn().mockResolvedValue(response);
  builder.maybeSingle = vi.fn().mockResolvedValue(response);

  // Make builder itself thenable (for await on the chain)
  builder.then = (resolve: (val: MockResponse) => void) => resolve(response);

  return builder;
}

function createMockClient(overrides: {
  from?: Record<string, MockResponse>;
  rpc?: Record<string, MockResponse>;
} = {}) {
  const fromBuilders: Record<string, ReturnType<typeof createMockBuilder>> = {};

  const client = {
    from: vi.fn((table: string) => {
      if (!fromBuilders[table]) {
        const response = overrides.from?.[table] ?? { data: [], error: null, count: 0 };
        fromBuilders[table] = createMockBuilder(response);
      }
      return fromBuilders[table];
    }),
    rpc: vi.fn((fnName: string) => {
      const response = overrides.rpc?.[fnName] ?? { data: [], error: null };
      return Promise.resolve(response);
    }),
    _builders: fromBuilders,
  };

  return client as unknown as import("../src/db/client").SupabaseClient;
}

type Builders = Record<string, Record<string, ReturnType<typeof vi.fn>>>;
function buildersOf(client: unknown): Builders {
  return (client as unknown as { _builders: Builders })._builders;
}

// -- search() --

describe("search", () => {
  it("returns empty results for empty query", async () => {
    const client = createMockClient();
    const result = await search(client, "");
    expect(result.records.items).toEqual([]);
    expect(result.records.total).toBe(0);
    expect(result.projects.items).toEqual([]);
    expect(result.projects.total).toBe(0);
  });

  it("returns empty results for whitespace-only query", async () => {
    const client = createMockClient();
    const result = await search(client, "   ");
    expect(result.records.items).toEqual([]);
    expect(result.projects.items).toEqual([]);
  });

  it("queries lts_records and projects tables", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
        projects: { data: [], error: null, count: 0 },
      },
    });

    await search(client, "test");

    expect(client.from).toHaveBeenCalledWith("lts_records");
    expect(client.from).toHaveBeenCalledWith("projects");
  });

  it("excludes low-confidence records from search", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
        projects: { data: [], error: null, count: 0 },
      },
    });

    await search(client, "test");
    const builder = buildersOf(client).lts_records;
    expect(builder.neq).toHaveBeenCalledWith("confidence", "low");
  });

  it("respects pagination options", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
        projects: { data: [], error: null, count: 0 },
      },
    });

    const result = await search(client, "test", { limit: 10, offset: 5 });
    expect(result.records.limit).toBe(10);
    expect(result.records.offset).toBe(5);
  });

  it("computes hasMore correctly when more results exist", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [{ lts_number: "LTS-1" }], error: null, count: 50 },
        projects: { data: [{ id: "2" }], error: null, count: 30 },
      },
    });

    const result = await search(client, "test", { limit: 20, offset: 0 });
    expect(result.records.hasMore).toBe(true);
    expect(result.projects.hasMore).toBe(true);
  });

  it("computes hasMore as false at end of results", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [{ lts_number: "LTS-1" }], error: null, count: 5 },
        projects: { data: [{ id: "2" }], error: null, count: 3 },
      },
    });

    const result = await search(client, "test", { limit: 20, offset: 0 });
    expect(result.records.hasMore).toBe(false);
    expect(result.projects.hasMore).toBe(false);
  });

  it("throws on records search error", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: null, error: { message: "db error" }, count: null },
        projects: { data: [], error: null, count: 0 },
      },
    });

    await expect(search(client, "test")).rejects.toThrow("Records search failed");
  });

  it("throws on project search error", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
        projects: { data: null, error: { message: "db error" }, count: null },
      },
    });

    await expect(search(client, "test")).rejects.toThrow("Project search failed");
  });
});

// -- getLTSRecordItems() --

describe("getLTSRecordItems", () => {
  it("returns paginated response with defaults", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    const result = await getLTSRecordItems(client);
    expect(result.items).toEqual([]);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("always excludes low-confidence records", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client);
    const builder = buildersOf(client).lts_records;
    expect(builder.neq).toHaveBeenCalledWith("confidence", "low");
  });

  it("applies confidence filter", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { confidence: "high" });
    const builder = buildersOf(client).lts_records;
    expect(builder.eq).toHaveBeenCalledWith("confidence", "high");
  });

  it("applies region filter on normalized_region", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { region: "NCR" });
    const builder = buildersOf(client).lts_records;
    expect(builder.eq).toHaveBeenCalledWith("normalized_region", "NCR");
  });

  it("applies linked=true filter (has project_id)", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { linked: true });
    const builder = buildersOf(client).lts_records;
    expect(builder.not).toHaveBeenCalledWith("project_id", "is", null);
  });

  it("applies linked=false filter (no project_id)", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { linked: false });
    const builder = buildersOf(client).lts_records;
    expect(builder.is).toHaveBeenCalledWith("project_id", null);
  });

  it("sends a search term as one filter term per column, whatever it contains", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { search: "test,inject" });
    const builder = buildersOf(client).lts_records;
    expect(builder.or).toHaveBeenCalled();

    // Asserting on how PostgREST parses the string, not on its shape. The
    // assertion this replaces checked for a backslash before the comma and
    // passed while the query was injectable in production. See
    // docs/adversarial-audit-2026-08-29.md, N1 and N9.
    const orArg = (builder.or as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const terms = parseOrFilter(orArg);
    expect(terms.map((t) => t.column)).toEqual([
      "normalized_project_name",
      "lts_number",
      "normalized_developer",
    ]);
    expect(terms.every((t) => t.operator === "ilike")).toBe(true);
    expect(terms.every((t) => t.value === "%test,inject%")).toBe(true);
  });

  it("sorts by created_at descending by default", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client);
    const builder = buildersOf(client).lts_records;
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false, nullsFirst: false });
  });

  it("sorts by expiry_date when specified", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { sortBy: "expiry_date", sortOrder: "asc" });
    const builder = buildersOf(client).lts_records;
    expect(builder.order).toHaveBeenCalledWith("expiry_date", { ascending: true, nullsFirst: false });
  });

  it("sorts by normalized_project_name when specified", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
      },
    });

    await getLTSRecordItems(client, { sortBy: "normalized_project_name", sortOrder: "asc" });
    const builder = buildersOf(client).lts_records;
    expect(builder.order).toHaveBeenCalledWith("normalized_project_name", { ascending: true, nullsFirst: false });
  });

  it("throws on query error", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: null, error: { message: "timeout" }, count: null },
      },
    });

    await expect(getLTSRecordItems(client)).rejects.toThrow("LTS records query failed");
  });
});

// -- getProjectLTS() --

describe("getProjectLTS", () => {
  function createProjectLTSClient(
    projectData: unknown,
    projectError: null | { message: string },
    records: unknown[],
    recordsError: null | { message: string } = null
  ) {
    const projectBuilder = createMockBuilder({
      data: projectData,
      error: projectError,
    });

    const client = {
      from: vi.fn(() => projectBuilder),
      rpc: vi.fn(() =>
        Promise.resolve({
          data: records,
          error: recordsError,
        })
      ),
    };

    return client as unknown as import("../src/db/client").SupabaseClient;
  }

  it("returns project with summary counts", async () => {
    const project = { id: "p1", name: "Test Project" };
    const records = [
      { status: "verified", expiry_date: "2099-12-31", is_primary: true, lts_number: "LTS-001" },
      { status: "verified", expiry_date: "2099-12-31", is_primary: false, lts_number: "LTS-002" },
      { status: "expired", expiry_date: "2020-01-01", is_primary: false, lts_number: "LTS-003" },
    ];

    const client = createProjectLTSClient(project, null, records);
    const result = await getProjectLTS(client, "p1");

    expect(result.project).toEqual(project);
    expect(result.summary.total).toBe(3);
    expect(result.summary.verified).toBe(2);
    expect(result.summary.expired).toBe(1);
  });

  it("identifies primary LTS number", async () => {
    const records = [
      { status: "verified", expiry_date: "2099-12-31", is_primary: false, lts_number: "LTS-A" },
      { status: "verified", expiry_date: "2099-12-31", is_primary: true, lts_number: "LTS-B" },
    ];

    const client = createProjectLTSClient({ id: "p1" }, null, records);
    const result = await getProjectLTS(client, "p1");
    expect(result.summary.primaryLTS).toBe("LTS-B");
  });

  it("returns null primaryLTS when no primary record", async () => {
    const records = [
      { status: "verified", expiry_date: "2099-12-31", is_primary: false, lts_number: "LTS-A" },
    ];

    const client = createProjectLTSClient({ id: "p1" }, null, records);
    const result = await getProjectLTS(client, "p1");
    expect(result.summary.primaryLTS).toBeNull();
  });

  it("counts expiring soon records (within 30 days)", async () => {
    // We need dates relative to "today" in PH timezone
    const today = new Date();
    const in15Days = new Date(today);
    in15Days.setDate(in15Days.getDate() + 15);
    const soonDate = in15Days.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

    const records = [
      { status: "verified", expiry_date: soonDate, is_primary: false, lts_number: "LTS-SOON" },
      { status: "verified", expiry_date: "2099-12-31", is_primary: false, lts_number: "LTS-FAR" },
      { status: "expired", expiry_date: "2020-01-01", is_primary: false, lts_number: "LTS-OLD" },
    ];

    const client = createProjectLTSClient({ id: "p1" }, null, records);
    const result = await getProjectLTS(client, "p1");
    expect(result.summary.expiringSoon).toBe(1);
  });

  it("throws on project not found", async () => {
    const client = createProjectLTSClient(null, { message: "not found" }, []);
    await expect(getProjectLTS(client, "bad-id")).rejects.toThrow("Project not found");
  });

  it("throws on records query failure", async () => {
    const client = createProjectLTSClient({ id: "p1" }, null, [], { message: "rpc failed" });
    await expect(getProjectLTS(client, "p1")).rejects.toThrow("LTS records query failed");
  });
});

// -- findProjectByName() --

describe("findProjectByName", () => {
  it("returns slug match immediately (short-circuits)", async () => {
    const project = { id: "p1", name: "Test Project", slug: "test-project" };
    const builder = createMockBuilder({ data: project, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await findProjectByName(client, "Test Project");
    expect(result).toEqual(project);
    // single() is called once for slug match, should not proceed to ilike
    expect(builder.single).toHaveBeenCalledTimes(1);
  });

  it("falls back to ilike search when slug match fails", async () => {
    let callCount = 0;
    const nameMatch = { id: "p2", name: "Some Project", slug: "some-project" };

    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.single = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Slug match returns null
        return Promise.resolve({ data: null, error: null });
      }
      // Name match returns result
      return Promise.resolve({ data: nameMatch, error: null });
    });
    builder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await findProjectByName(client, "Some Project");
    expect(result).toEqual(nameMatch);
  });

  it("returns null when no match found", async () => {
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.single = vi.fn().mockResolvedValue({ data: null, error: null });
    builder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await findProjectByName(client, "Nonexistent");
    expect(result).toBeNull();
  });

  it("trims whitespace from query", async () => {
    const project = { id: "p1", name: "Test", slug: "test" };
    const builder = createMockBuilder({ data: project, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await findProjectByName(client, "  Test  ");
    expect(builder.eq).toHaveBeenCalledWith("slug", "test");
  });

  it("escapes LIKE wildcards in the fuzzy name lookup", () => {
    // .ilike() is its own query param, so a comma cannot split anything here,
    // but % and _ still reach Postgres as wildcards if they are not escaped.
    const builder = createMockBuilder({ data: null, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    return findProjectByName(client, "100% Homes_").then(() => {
      expect(builder.ilike).toHaveBeenCalledWith("name", "%100\\% Homes\\_%");
    });
  });
});

// -- checkLTSNumber() --

describe("checkLTSNumber", () => {
  function createCheckClient(
    recordData: unknown,
    pltsData: unknown,
    recordError: null | { message: string } = null,
    pltsError: null | { message: string } = null
  ) {
    const builders: Record<string, ReturnType<typeof createMockBuilder>> = {};

    const client = {
      from: vi.fn((table: string) => {
        if (!builders[table]) {
          if (table === "lts_records") {
            builders[table] = createMockBuilder({ data: recordData, error: recordError });
          } else {
            builders[table] = createMockBuilder({ data: pltsData, error: pltsError });
          }
        }
        return builders[table];
      }),
    } as unknown as import("../src/db/client").SupabaseClient;

    return client;
  }

  it("found in lts_records only", async () => {
    const record = { lts_number: "LTS-001", normalized_project_name: "Test" };
    const client = createCheckClient(record, null);
    const result = await checkLTSNumber(client, "LTS-001");

    expect(result.exists).toBe(true);
    expect(result.inLTSRecords).toBe(true);
    expect(result.inProjectLTS).toBe(false);
    expect(result.ltsRecord).toEqual(record);
    expect(result.projectLTS).toBeUndefined();
  });

  it("found in project_lts only", async () => {
    const pltsItem = { id: "pl1", lts_number: "LTS-002" };
    const client = createCheckClient(null, pltsItem);
    const result = await checkLTSNumber(client, "LTS-002");

    expect(result.exists).toBe(true);
    expect(result.inLTSRecords).toBe(false);
    expect(result.inProjectLTS).toBe(true);
    expect(result.ltsRecord).toBeUndefined();
    expect(result.projectLTS).toEqual(pltsItem);
  });

  it("found in both lts_records and project_lts", async () => {
    const record = { lts_number: "LTS-003" };
    const pltsItem = { id: "pl1", lts_number: "LTS-003" };
    const client = createCheckClient(record, pltsItem);
    const result = await checkLTSNumber(client, "LTS-003");

    expect(result.exists).toBe(true);
    expect(result.inLTSRecords).toBe(true);
    expect(result.inProjectLTS).toBe(true);
  });

  it("found in neither", async () => {
    const client = createCheckClient(null, null);
    const result = await checkLTSNumber(client, "LTS-NONE");

    expect(result.exists).toBe(false);
    expect(result.inLTSRecords).toBe(false);
    expect(result.inProjectLTS).toBe(false);
    expect(result.ltsRecord).toBeUndefined();
    expect(result.projectLTS).toBeUndefined();
  });

  it("trims whitespace from LTS number", async () => {
    const client = createCheckClient(null, null);
    await checkLTSNumber(client, "  LTS-001  ");

    const builder = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0].value;
    expect(builder.eq).toHaveBeenCalledWith("lts_number", "LTS-001");
  });

  it("throws on lts_records check error", async () => {
    const client = createCheckClient(null, null, { message: "db down" }, null);
    await expect(checkLTSNumber(client, "LTS-001")).rejects.toThrow("LTS records check failed");
  });

  it("throws on project LTS check error", async () => {
    const client = createCheckClient(null, null, null, { message: "db down" });
    await expect(checkLTSNumber(client, "LTS-001")).rejects.toThrow("Project LTS check failed");
  });
});

// -- getFilterValues() --

describe("getFilterValues", () => {
  function createFilterClient(response: MockResponse) {
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.then = (resolve: (val: MockResponse) => void) => resolve(response);

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    return { client, builder };
  }

  it("returns deduplicated sorted regions", async () => {
    const regionData = [
      { normalized_region: "NCR" },
      { normalized_region: "Region IV-A" },
      { normalized_region: "NCR" },
      { normalized_region: "Region III" },
    ];

    const { client } = createFilterClient({ data: regionData, error: null });
    const result = await getFilterValues(client);
    expect(result.regions).toEqual(["NCR", "Region III", "Region IV-A"]);
  });

  it("returns deduplicated sorted cities", async () => {
    const cityData = [
      { normalized_city: "Makati" },
      { normalized_city: "Taguig" },
      { normalized_city: "Makati" },
    ];

    const { client } = createFilterClient({ data: cityData, error: null });
    const result = await getFilterValues(client);
    expect(result.cities).toEqual(["Makati", "Taguig"]);
  });

  it("filters out null values", async () => {
    const data = [
      { normalized_region: "NCR" },
      { normalized_region: null },
      { normalized_region: "Region III" },
    ];

    const { client } = createFilterClient({ data, error: null });
    const result = await getFilterValues(client);
    expect(result.regions).toEqual(["NCR", "Region III"]);
  });

  it("applies region filter to cities query on normalized_region", async () => {
    const { client, builder } = createFilterClient({ data: [], error: null });

    await getFilterValues(client, "NCR");
    expect(builder.eq).toHaveBeenCalledWith("normalized_region", "NCR");
  });

  it("throws on regions query error", async () => {
    const { client } = createFilterClient({ data: null, error: { message: "fail" } });
    await expect(getFilterValues(client)).rejects.toThrow("query failed");
  });
});

// -- what search() actually hands PostgREST --

/**
 * tests/sanitize.test.ts exercises the filter builders as pure functions. That
 * leaves the wiring untested: rewiring search() back to a raw template string
 * would keep every one of those tests green. These assert on the string the
 * Supabase builder is really called with, for the exact path the audit
 * live-exploited (docs/adversarial-audit-2026-08-29.md, N1).
 */
describe("search filter wiring", () => {
  const searchClient = () =>
    createMockClient({
      from: {
        lts_records: { data: [], error: null, count: 0 },
        projects: { data: [], error: null, count: 0 },
      },
    });

  const orBodyFor = (client: unknown, table: string): string =>
    buildersOf(client)[table].or.mock.calls[0][0] as string;

  it("sends lts_records a well-formed or= list over the three record columns", async () => {
    const client = searchClient();
    await search(client, "zzqq,normalized_region.neq.zzqq");

    const terms = parseOrFilter(orBodyFor(client, "lts_records"));
    expect(terms.map((t) => t.column)).toEqual([
      "normalized_project_name",
      "lts_number",
      "normalized_developer",
    ]);
    expect(terms.every((t) => t.operator === "ilike")).toBe(true);
    expect(terms.some((t) => t.column === "normalized_region")).toBe(false);
  });

  it("sends projects a well-formed or= list over the three project columns", async () => {
    const client = searchClient();
    await search(client, "zzqq,lts_number.neq.zzqq");

    const terms = parseOrFilter(orBodyFor(client, "projects"));
    expect(terms.map((t) => t.column)).toEqual(["name", "canonical_name", "lts_number"]);
    expect(terms.every((t) => t.operator === "ilike")).toBe(true);
  });

  it("searches for the injection payload instead of executing it", async () => {
    const payload = "zzqq,lts_number.neq.zzqq";
    const client = searchClient();
    await search(client, payload);

    const body = orBodyFor(client, "lts_records");
    expect(matchesThroughFilter(body, "lts_number", `LS 1 ${payload} X`)).toBe(true);
    expect(matchesThroughFilter(body, "lts_number", "LS 0001210")).toBe(false);
  });

  it("does not break on a developer name containing a comma", async () => {
    const client = searchClient();
    await search(client, "Land, Inc");

    const body = orBodyFor(client, "lts_records");
    expect(() => parseOrFilter(body)).not.toThrow();
    expect(matchesThroughFilter(body, "normalized_developer", "ALVEO LAND, INC.")).toBe(true);
  });

  it("keeps * working as the documented wildcard", async () => {
    const client = searchClient();
    await search(client, "Merg*nt");

    const body = orBodyFor(client, "lts_records");
    expect(matchesThroughFilter(body, "normalized_project_name", "MERGENT")).toBe(true);
    expect(matchesThroughFilter(body, "normalized_project_name", "BROOKLYN HOUSE")).toBe(false);
  });
});

// -- wildcard-only queries must not read the whole table --

describe("unbounded search terms", () => {
  /**
   * Confirmed live on 2026-08-29 against production: lts_search?query=**
   * returned all 8,401 records and all 4,902 projects. The * -> % rewrite
   * happens inside PostgREST and cannot be escaped, so the caller has to
   * refuse the term.
   */
  for (const term of ["*", "**", " ** "]) {
    it(`search() returns nothing for ${JSON.stringify(term)} and never queries`, async () => {
      const client = createMockClient({
        from: {
          lts_records: { data: [{ lts_number: "LTS-1" }], error: null, count: 8401 },
          projects: { data: [{ id: "2" }], error: null, count: 4902 },
        },
      });

      const result = await search(client, term);

      expect(result.records.items).toEqual([]);
      expect(result.records.total).toBe(0);
      expect(result.projects.items).toEqual([]);
      expect(result.projects.total).toBe(0);
      expect(client.from).not.toHaveBeenCalled();
    });

    it(`getLTSRecordItems() returns nothing for search ${JSON.stringify(term)}`, async () => {
      const client = createMockClient({
        from: {
          lts_records: { data: [{ lts_number: "LTS-1" }], error: null, count: 8401 },
        },
      });

      const result = await getLTSRecordItems(client, { search: term });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(client.from).not.toHaveBeenCalled();
    });

    it(`findProjectByName() returns null for ${JSON.stringify(term)}`, async () => {
      const client = createMockClient({
        from: {
          projects: { data: { id: "1", name: "SOME PROJECT" }, error: null },
        },
      });

      expect(await findProjectByName(client, term)).toBeNull();
      expect(client.from).not.toHaveBeenCalled();
    });
  }

  it("getLTSRecordItems() still browses unfiltered when no search is given", async () => {
    const client = createMockClient({
      from: {
        lts_records: { data: [{ lts_number: "LTS-1" }], error: null, count: 8401 },
      },
    });

    const result = await getLTSRecordItems(client, {});

    expect(result.total).toBe(8401);
    expect(buildersOf(client).lts_records.or).not.toHaveBeenCalled();
  });
});
