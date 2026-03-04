import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  search,
  getQueueItems,
  getProjectLTS,
  findProjectByName,
  checkLTSNumber,
  getFilterValues,
} from "../src/db/queries";

// -- Mock Supabase Client (chainable builder pattern) --

interface MockResponse {
  data: unknown;
  error: null | { message: string };
  count?: number | null;
}

function createMockBuilder(response: MockResponse) {
  const builder: Record<string, unknown> = {};
  const chainMethods = [
    "select",
    "eq",
    "gt",
    "gte",
    "lte",
    "or",
    "ilike",
    "not",
    "order",
    "range",
    "limit",
    "single",
    "maybeSingle",
  ];

  for (const method of chainMethods) {
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

// -- search() --

describe("search", () => {
  it("returns empty results for empty query", async () => {
    const client = createMockClient();
    const result = await search(client, "");
    expect(result.queue.items).toEqual([]);
    expect(result.queue.total).toBe(0);
    expect(result.projects.items).toEqual([]);
    expect(result.projects.total).toBe(0);
  });

  it("returns empty results for whitespace-only query", async () => {
    const client = createMockClient();
    const result = await search(client, "   ");
    expect(result.queue.items).toEqual([]);
    expect(result.projects.items).toEqual([]);
  });

  it("calls Supabase with correct or filter", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
        projects: { data: [], error: null, count: 0 },
      },
    });

    await search(client, "test");

    expect(client.from).toHaveBeenCalledWith("lts_verification_queue");
    expect(client.from).toHaveBeenCalledWith("projects");
  });

  it("respects pagination options", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
        projects: { data: [], error: null, count: 0 },
      },
    });

    const result = await search(client, "test", { limit: 10, offset: 5 });
    expect(result.queue.limit).toBe(10);
    expect(result.queue.offset).toBe(5);
  });

  it("computes hasMore correctly when more results exist", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [{ id: "1" }], error: null, count: 50 },
        projects: { data: [{ id: "2" }], error: null, count: 30 },
      },
    });

    const result = await search(client, "test", { limit: 20, offset: 0 });
    expect(result.queue.hasMore).toBe(true);
    expect(result.projects.hasMore).toBe(true);
  });

  it("computes hasMore as false at end of results", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [{ id: "1" }], error: null, count: 5 },
        projects: { data: [{ id: "2" }], error: null, count: 3 },
      },
    });

    const result = await search(client, "test", { limit: 20, offset: 0 });
    expect(result.queue.hasMore).toBe(false);
    expect(result.projects.hasMore).toBe(false);
  });

  it("throws on queue search error", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: null, error: { message: "db error" }, count: null },
        projects: { data: [], error: null, count: 0 },
      },
    });

    await expect(search(client, "test")).rejects.toThrow("Queue search failed");
  });

  it("throws on project search error", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
        projects: { data: null, error: { message: "db error" }, count: null },
      },
    });

    await expect(search(client, "test")).rejects.toThrow("Project search failed");
  });
});

// -- getQueueItems() --

describe("getQueueItems", () => {
  it("returns paginated response with defaults", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    const result = await getQueueItems(client);
    expect(result.items).toEqual([]);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("applies status filter", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client, { status: "pending" });
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    expect(builder.eq).toHaveBeenCalledWith("match_status", "pending");
  });

  it("applies region filter", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client, { region: "NCR" });
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    expect(builder.eq).toHaveBeenCalledWith("scraped_region", "NCR");
  });

  it("applies minScore filter including 0", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client, { minScore: 0 });
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    expect(builder.gte).toHaveBeenCalledWith("match_score", 0);
  });

  it("applies search filter with sanitization", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client, { search: "test,inject" });
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    // The comma in the search should be escaped
    expect(builder.or).toHaveBeenCalled();
    const orArg = (builder.or as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(orArg).toContain("test\\,inject");
    expect(orArg).not.toContain("test,inject");
  });

  it("sorts by match_score by default (descending)", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client);
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    expect(builder.order).toHaveBeenCalledWith("match_score", { ascending: false, nullsFirst: false });
  });

  it("sorts by scraped_expiry_date when specified", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client, { sortBy: "scraped_expiry_date", sortOrder: "asc" });
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    expect(builder.order).toHaveBeenCalledWith("scraped_expiry_date", { ascending: true, nullsFirst: false });
  });

  it("sorts by created_at when specified", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: [], error: null, count: 0 },
      },
    });

    await getQueueItems(client, { sortBy: "created_at" });
    const builder = (client as unknown as { _builders: Record<string, Record<string, ReturnType<typeof vi.fn>>> })._builders.lts_verification_queue;
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("throws on query error", async () => {
    const client = createMockClient({
      from: {
        lts_verification_queue: { data: null, error: { message: "timeout" }, count: null },
      },
    });

    await expect(getQueueItems(client)).rejects.toThrow("Queue query failed");
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
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
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
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
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
});

// -- checkLTSNumber() --

describe("checkLTSNumber", () => {
  function createCheckClient(
    queueData: unknown,
    pltsData: unknown,
    queueError: null | { message: string } = null,
    pltsError: null | { message: string } = null
  ) {
    const builders: Record<string, ReturnType<typeof createMockBuilder>> = {};

    const client = {
      from: vi.fn((table: string) => {
        if (!builders[table]) {
          if (table === "lts_verification_queue") {
            builders[table] = createMockBuilder({ data: queueData, error: queueError });
          } else {
            builders[table] = createMockBuilder({ data: pltsData, error: pltsError });
          }
        }
        return builders[table];
      }),
    } as unknown as import("../src/db/client").SupabaseClient;

    return client;
  }

  it("found in queue only", async () => {
    const queueItem = { id: "q1", lts_number: "LTS-001" };
    const client = createCheckClient(queueItem, null);
    const result = await checkLTSNumber(client, "LTS-001");

    expect(result.exists).toBe(true);
    expect(result.inQueue).toBe(true);
    expect(result.inProjectLTS).toBe(false);
    expect(result.queueItem).toEqual(queueItem);
    expect(result.projectLTS).toBeUndefined();
  });

  it("found in project_lts only", async () => {
    const pltsItem = { id: "pl1", lts_number: "LTS-002" };
    const client = createCheckClient(null, pltsItem);
    const result = await checkLTSNumber(client, "LTS-002");

    expect(result.exists).toBe(true);
    expect(result.inQueue).toBe(false);
    expect(result.inProjectLTS).toBe(true);
    expect(result.queueItem).toBeUndefined();
    expect(result.projectLTS).toEqual(pltsItem);
  });

  it("found in both queue and project_lts", async () => {
    const queueItem = { id: "q1", lts_number: "LTS-003" };
    const pltsItem = { id: "pl1", lts_number: "LTS-003" };
    const client = createCheckClient(queueItem, pltsItem);
    const result = await checkLTSNumber(client, "LTS-003");

    expect(result.exists).toBe(true);
    expect(result.inQueue).toBe(true);
    expect(result.inProjectLTS).toBe(true);
  });

  it("found in neither", async () => {
    const client = createCheckClient(null, null);
    const result = await checkLTSNumber(client, "LTS-NONE");

    expect(result.exists).toBe(false);
    expect(result.inQueue).toBe(false);
    expect(result.inProjectLTS).toBe(false);
    expect(result.queueItem).toBeUndefined();
    expect(result.projectLTS).toBeUndefined();
  });

  it("trims whitespace from LTS number", async () => {
    const client = createCheckClient(null, null);
    await checkLTSNumber(client, "  LTS-001  ");

    const builder = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0].value;
    expect(builder.eq).toHaveBeenCalledWith("lts_number", "LTS-001");
  });

  it("throws on queue check error", async () => {
    const client = createCheckClient(null, null, { message: "db down" }, null);
    await expect(checkLTSNumber(client, "LTS-001")).rejects.toThrow("Queue check failed");
  });

  it("throws on project LTS check error", async () => {
    const client = createCheckClient(null, null, null, { message: "db down" });
    await expect(checkLTSNumber(client, "LTS-001")).rejects.toThrow("Project LTS check failed");
  });
});

// -- getFilterValues() --

describe("getFilterValues", () => {
  it("returns deduplicated sorted regions", async () => {
    const regionData = [
      { scraped_region: "NCR" },
      { scraped_region: "Region IV-A" },
      { scraped_region: "NCR" },
      { scraped_region: "Region III" },
    ];

    const builder: Record<string, unknown> = {};
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.then = (resolve: (val: MockResponse) => void) =>
      resolve({ data: regionData, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await getFilterValues(client);
    expect(result.regions).toEqual(["NCR", "Region III", "Region IV-A"]);
  });

  it("returns deduplicated sorted cities", async () => {
    const cityData = [
      { scraped_city: "Makati" },
      { scraped_city: "Taguig" },
      { scraped_city: "Makati" },
    ];

    const builder: Record<string, unknown> = {};
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.then = (resolve: (val: MockResponse) => void) =>
      resolve({ data: cityData, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await getFilterValues(client);
    expect(result.cities).toEqual(["Makati", "Taguig"]);
  });

  it("filters out null values", async () => {
    const data = [
      { scraped_region: "NCR" },
      { scraped_region: null },
      { scraped_region: "Region III" },
    ];

    const builder: Record<string, unknown> = {};
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.then = (resolve: (val: MockResponse) => void) =>
      resolve({ data, error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    const result = await getFilterValues(client);
    expect(result.regions).toEqual(["NCR", "Region III"]);
  });

  it("applies region filter to cities query", async () => {
    const builder: Record<string, unknown> = {};
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.then = (resolve: (val: MockResponse) => void) =>
      resolve({ data: [], error: null });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await getFilterValues(client, "NCR");
    expect(builder.eq).toHaveBeenCalledWith("scraped_region", "NCR");
  });

  it("throws on regions query error", async () => {
    const builder: Record<string, unknown> = {};
    const chainMethods = ["select", "eq", "gt", "gte", "lte", "or", "ilike", "not", "order", "range", "limit"];
    for (const method of chainMethods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.then = (resolve: (val: MockResponse) => void) =>
      resolve({ data: null, error: { message: "fail" } });

    const client = {
      from: vi.fn(() => builder),
    } as unknown as import("../src/db/client").SupabaseClient;

    await expect(getFilterValues(client)).rejects.toThrow("query failed");
  });
});
