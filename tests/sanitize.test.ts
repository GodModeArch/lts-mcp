import { describe, it, expect } from "vitest";
import { sanitizeFilterValue } from "../src/db/queries";

describe("sanitizeFilterValue", () => {
  // -- Normal inputs pass through unchanged --

  it("returns empty string unchanged", () => {
    expect(sanitizeFilterValue("")).toBe("");
  });

  it("returns simple string unchanged", () => {
    expect(sanitizeFilterValue("hello")).toBe("hello");
  });

  it("returns string with spaces unchanged", () => {
    expect(sanitizeFilterValue("hello world")).toBe("hello world");
  });

  it("returns alphanumeric string unchanged", () => {
    expect(sanitizeFilterValue("ABC123")).toBe("ABC123");
  });

  it("preserves dots and other safe characters", () => {
    expect(sanitizeFilterValue("foo.bar-baz_qux")).toBe("foo.bar-baz_qux");
  });

  it("preserves percent signs used in ilike patterns", () => {
    expect(sanitizeFilterValue("%search%")).toBe("%search%");
  });

  // -- Comma escaping --

  it("escapes a single comma", () => {
    expect(sanitizeFilterValue("foo,bar")).toBe("foo\\,bar");
  });

  it("escapes multiple commas", () => {
    expect(sanitizeFilterValue("a,b,c")).toBe("a\\,b\\,c");
  });

  it("escapes leading comma", () => {
    expect(sanitizeFilterValue(",leading")).toBe("\\,leading");
  });

  it("escapes trailing comma", () => {
    expect(sanitizeFilterValue("trailing,")).toBe("trailing\\,");
  });

  // -- Backslash escaping --

  it("escapes a single backslash", () => {
    expect(sanitizeFilterValue("foo\\bar")).toBe("foo\\\\bar");
  });

  it("escapes multiple backslashes", () => {
    expect(sanitizeFilterValue("a\\b\\c")).toBe("a\\\\b\\\\c");
  });

  // -- Combined: backslash + comma interactions --

  it("escapes backslash before comma in same string", () => {
    expect(sanitizeFilterValue("a\\b,c")).toBe("a\\\\b\\,c");
  });

  it("handles backslash immediately before comma", () => {
    // Input: a\,b  -> backslash becomes \\, comma becomes \, -> a\\\\,b? No.
    // Input literal: a\,b
    // Step 1: replace \ with \\ -> a\\,b
    // Step 2: replace , with \, -> a\\\,b
    expect(sanitizeFilterValue("a\\,b")).toBe("a\\\\\\,b");
  });

  // -- Order of operations: backslashes escaped before commas --

  it("does not double-escape the backslash introduced by comma escaping", () => {
    // If commas were escaped first: "a,b" -> "a\,b" -> then backslash pass: "a\\,b" (WRONG)
    // Correct order: backslashes first (no-op on "a,b"), then commas: "a\,b"
    const result = sanitizeFilterValue("a,b");
    expect(result).toBe("a\\,b");
    // The result should have exactly one backslash before the comma
    expect(result).not.toBe("a\\\\,b");
  });

  // -- Injection attempts --

  it("escapes PostgREST filter injection via comma", () => {
    // An attacker tries to inject a second filter condition
    const malicious = "test,scraped_region.eq.NCR";
    const result = sanitizeFilterValue(malicious);
    expect(result).toBe("test\\,scraped_region.eq.NCR");
    // Every comma in the result must be preceded by a backslash (escaped)
    expect(result).not.toMatch(/(?<!\\),/);
  });

  it("escapes injection with multiple filter conditions", () => {
    const malicious = "x,a.eq.1,b.eq.2";
    expect(sanitizeFilterValue(malicious)).toBe("x\\,a.eq.1\\,b.eq.2");
  });

  it("escapes injection attempt with backslash evasion", () => {
    // Attacker tries: test\,scraped_region.eq.NCR hoping backslash unescapes the comma
    const malicious = "test\\,scraped_region.eq.NCR";
    const result = sanitizeFilterValue(malicious);
    // Backslash becomes \\, comma becomes \, -> test\\\,scraped_region.eq.NCR
    expect(result).toBe("test\\\\\\,scraped_region.eq.NCR");
    // Must not contain an unescaped comma
    expect(result.replace(/\\,/g, "").replace(/\\\\/g, "")).not.toContain(",");
  });
});
