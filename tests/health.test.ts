import { describe, it, expect, vi } from "vitest";
import {
  checkRequiredConfig,
  probeDatabase,
  buildHealthReport,
  healthHttpStatus,
} from "../src/health";
import type { ConfigCheck, DbProbe } from "../src/health";
import type { SupabaseClient } from "../src/db/client";

describe("checkRequiredConfig", () => {
  it("ok when both secrets present", () => {
    const result = checkRequiredConfig({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_ANON_KEY: "key",
    });
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("flags an absent secret", () => {
    const result = checkRequiredConfig({ SUPABASE_URL: "https://x.supabase.co" });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["SUPABASE_ANON_KEY"]);
  });

  it("treats an empty string as missing", () => {
    const result = checkRequiredConfig({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "key" });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["SUPABASE_URL"]);
  });

  it("treats a whitespace-only value as missing", () => {
    const result = checkRequiredConfig({ SUPABASE_URL: "   ", SUPABASE_ANON_KEY: "key" });
    expect(result.missing).toEqual(["SUPABASE_URL"]);
  });

  it("flags both when env is empty (the regression we hit in prod)", () => {
    const result = checkRequiredConfig({});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  });

  it("treats a non-string value as missing", () => {
    const result = checkRequiredConfig({ SUPABASE_URL: 123, SUPABASE_ANON_KEY: null });
    expect(result.missing).toEqual(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  });
});

describe("probeDatabase", () => {
  function mockClient(result: { error: { message: string } | null }): SupabaseClient {
    const chain = {
      select: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
    };
    return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  }

  it("ok when the query returns no error", async () => {
    const probe = await probeDatabase(mockClient({ error: null }));
    expect(probe).toEqual({ ok: true, error: null });
  });

  it("not ok and surfaces the message on a query error", async () => {
    const probe = await probeDatabase(mockClient({ error: { message: "permission denied" } }));
    expect(probe).toEqual({ ok: false, error: "permission denied" });
  });

  it("catches a thrown error (e.g. bad client) instead of rejecting", async () => {
    const client = {
      from: () => {
        throw new Error("Invalid URL");
      },
    } as unknown as SupabaseClient;
    const probe = await probeDatabase(client);
    expect(probe).toEqual({ ok: false, error: "Invalid URL" });
  });
});

describe("buildHealthReport", () => {
  const okConfig: ConfigCheck = { ok: true, missing: [] };
  const badConfig: ConfigCheck = { ok: false, missing: ["SUPABASE_URL"] };
  const okDb: DbProbe = { ok: true, error: null };
  const badDb: DbProbe = { ok: false, error: "boom" };

  it("ok when config and db both pass", () => {
    expect(buildHealthReport(okConfig, okDb, "1.0.0").status).toBe("ok");
  });

  it("misconfigured when config fails, regardless of db", () => {
    expect(buildHealthReport(badConfig, okDb, "1.0.0").status).toBe("misconfigured");
    expect(buildHealthReport(badConfig, badDb, "1.0.0").status).toBe("misconfigured");
  });

  it("degraded when config passes but db fails", () => {
    expect(buildHealthReport(okConfig, badDb, "1.0.0").status).toBe("degraded");
  });

  it("carries through version and check details", () => {
    const report = buildHealthReport(okConfig, okDb, "1.2.3");
    expect(report.version).toBe("1.2.3");
    expect(report.checks).toEqual({ config: okConfig, database: okDb });
  });
});

describe("healthHttpStatus", () => {
  it("200 only for ok", () => {
    expect(healthHttpStatus("ok")).toBe(200);
  });

  it("503 for degraded and misconfigured", () => {
    expect(healthHttpStatus("degraded")).toBe(503);
    expect(healthHttpStatus("misconfigured")).toBe(503);
  });
});
