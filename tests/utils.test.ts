import { describe, it, expect, vi } from "vitest";
import { getTodayPH, getFutureDatePH, toolResult, toolError, safeToolError, logError } from "../src/utils";

describe("getTodayPH", () => {
  it("returns a string in YYYY-MM-DD format", () => {
    const result = getTodayPH();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a valid date", () => {
    const result = getTodayPH();
    const parsed = new Date(result);
    expect(parsed.toString()).not.toBe("Invalid Date");
  });

  it("uses Asia/Manila timezone", () => {
    // The function uses toLocaleDateString with Asia/Manila.
    // We verify it produces the same result as an explicit Manila conversion.
    const expected = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    expect(getTodayPH()).toBe(expected);
  });
});

describe("getFutureDatePH", () => {
  it("with 0 days returns today's date", () => {
    expect(getFutureDatePH(0)).toBe(getTodayPH());
  });

  it("with 1 day returns tomorrow", () => {
    const today = new Date();
    today.setDate(today.getDate() + 1);
    const expected = today.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    expect(getFutureDatePH(1)).toBe(expected);
  });

  it("returns valid date format for 30 days", () => {
    expect(getFutureDatePH(30)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns valid date format for 365 days", () => {
    expect(getFutureDatePH(365)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles year boundary correctly", () => {
    // 365+ days from now should be a valid date in a future year
    const result = getFutureDatePH(400);
    const parsed = new Date(result);
    expect(parsed.toString()).not.toBe("Invalid Date");
  });
});

describe("toolResult", () => {
  const meta = {
    source: "Test Source",
    source_url: "https://example.com",
    dataset: "Test Dataset",
    last_synced: "2025-01-01",
  };

  it("returns correct MCP response structure", () => {
    const result = toolResult({ foo: "bar" }, meta);
    expect(result).toHaveProperty("content");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("content text is valid JSON", () => {
    const result = toolResult({ foo: "bar" }, meta);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toBeDefined();
  });

  it("JSON contains _meta and data fields", () => {
    const result = toolResult({ count: 42 }, meta);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("_meta");
    expect(parsed).toHaveProperty("data");
    expect(parsed._meta).toEqual(meta);
    expect(parsed.data).toEqual({ count: 42 });
  });

  it("works with array data", () => {
    const result = toolResult([1, 2, 3], meta);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toEqual([1, 2, 3]);
  });

  it("works with null data", () => {
    const result = toolResult(null, meta);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toBeNull();
  });
});

describe("toolError", () => {
  it("returns isError true", () => {
    const result = toolError("Something went wrong");
    expect(result.isError).toBe(true);
  });

  it("returns correct structure", () => {
    const result = toolError("fail");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("fail");
  });
});

describe("safeToolError", () => {
  it("returns generic user message, not internal error details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const internalError = new Error("SQL injection detected in column xyz_secret");
    const result = safeToolError("Search failed", internalError);

    expect(result.content[0].text).toBe("Search failed");
    expect(result.content[0].text).not.toContain("SQL");
    expect(result.content[0].text).not.toContain("xyz_secret");
    expect(result.isError).toBe(true);
    spy.mockRestore();
  });

  it("logs the full error server-side", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("detailed internal failure");
    safeToolError("Generic message", err);

    expect(spy).toHaveBeenCalled();
    const loggedMessage = spy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain("detailed internal failure");
    spy.mockRestore();
  });
});

describe("logError", () => {
  it("handles Error objects", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("test", new Error("boom"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("boom"));
    spy.mockRestore();
  });

  it("handles string errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("test", "string error");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("string error"));
    spy.mockRestore();
  });

  it("handles undefined error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("test", undefined);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("test"));
    spy.mockRestore();
  });

  it("handles null error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("test", null);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("test"));
    spy.mockRestore();
  });

  it("message-only call works without error argument", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("just a message");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("just a message"));
    spy.mockRestore();
  });
});
