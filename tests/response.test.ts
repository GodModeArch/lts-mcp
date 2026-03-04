import { describe, it, expect } from "vitest";
import { buildMeta, wrapResponse } from "../src/response";
import type { ApiMeta, MetaConfig } from "../src/response";

describe("buildMeta", () => {
  const config: MetaConfig = { lastSynced: "2025-06-15" };

  it("returns correct DHSUD source", () => {
    const meta = buildMeta(config);
    expect(meta.source).toBe("Department of Human Settlements and Urban Development (DHSUD)");
  });

  it("returns correct source URL", () => {
    const meta = buildMeta(config);
    expect(meta.source_url).toBe("https://dhsud.gov.ph/");
  });

  it("returns correct dataset name", () => {
    const meta = buildMeta(config);
    expect(meta.dataset).toBe("License to Sell (LTS) Registry");
  });

  it("uses lastSynced from config", () => {
    const meta = buildMeta(config);
    expect(meta.last_synced).toBe("2025-06-15");
  });

  it("reflects different lastSynced values", () => {
    const meta = buildMeta({ lastSynced: "2024-01-01" });
    expect(meta.last_synced).toBe("2024-01-01");
  });
});

describe("wrapResponse", () => {
  const meta: ApiMeta = {
    source: "Test",
    source_url: "https://test.com",
    dataset: "Test Set",
    last_synced: "2025-01-01",
  };

  it("wraps data with _meta envelope", () => {
    const result = wrapResponse({ items: [] }, meta);
    expect(result).toHaveProperty("_meta");
    expect(result).toHaveProperty("data");
    expect(result._meta).toEqual(meta);
  });

  it("works with null data", () => {
    const result = wrapResponse(null, meta);
    expect(result.data).toBeNull();
    expect(result._meta).toEqual(meta);
  });

  it("works with array data", () => {
    const arr = [{ id: 1 }, { id: 2 }];
    const result = wrapResponse(arr, meta);
    expect(result.data).toEqual(arr);
  });

  it("works with object data", () => {
    const obj = { count: 42, label: "test" };
    const result = wrapResponse(obj, meta);
    expect(result.data).toEqual(obj);
  });
});
