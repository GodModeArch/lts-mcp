import { describe, it, expect } from "vitest";
import {
  escapeLikePattern,
  quoteFilterValue,
  ilikeContainsTerm,
  buildRecordSearchFilter,
  buildProjectSearchFilter,
} from "../src/db/queries";
import { parseOrFilter, toLikePattern, ilikeMatches, matchesThroughFilter } from "./helpers/postgrest";

/**
 * These tests assert what the filters MEAN to PostgREST, not what the escaping
 * function returns. The version of this file they replace asserted the latter
 * and stayed green against a live-exploitable hole
 * (docs/adversarial-audit-2026-08-29.md, N1 and N9).
 *
 * tests/helpers/postgrest.ts documents the live probes the model is based on.
 */

const RECORD_COLUMNS = ["normalized_project_name", "lts_number", "normalized_developer"];
const PROJECT_COLUMNS = ["name", "canonical_name", "lts_number"];

/** Every input below is either a live-confirmed exploit or a breakout attempt. */
const HOSTILE_INPUTS: Array<[name: string, input: string]> = [
  ["comma injection, confirmed live as a whole-table read", "zzqq,lts_number.neq.zzqq"],
  ["comma injection on a second column, confirmed live", "zzqq,normalized_region.neq.zzqq"],
  ["comma injection that returned a 500 in production", "zzqq,normalized_region.eq.CAR"],
  ["several injected predicates", "x,a.eq.1,b.eq.2"],
  ["backslash evasion of the old comma escaping", "test\\,scraped_region.eq.NCR"],
  ["trailing backslash", "trailing\\"],
  ["lone double quote, trying to open a quoted value", 'a"b'],
  ["escaped quote, trying to survive the quoting layer", 'a\\"'],
  ["quote then comma, trying to close our quotes and split", '",lts_number.neq.zzqq'],
  ["paren, trying to close the or() group", '"),(lts_number.neq.zzqq'],
  ["only reserved characters", '\\",()'],
  ["a legitimate term that used to break the tool", "Land, Inc"],
];

describe("or() filter construction", () => {
  describe("no input can add, remove or alter a filter term", () => {
    for (const [name, input] of HOSTILE_INPUTS) {
      it(`record search survives ${name}`, () => {
        const terms = parseOrFilter(buildRecordSearchFilter(input));
        expect(terms.map((t) => t.column)).toEqual(RECORD_COLUMNS);
        expect(terms.every((t) => t.operator === "ilike")).toBe(true);
      });

      it(`project search survives ${name}`, () => {
        const terms = parseOrFilter(buildProjectSearchFilter(input));
        expect(terms.map((t) => t.column)).toEqual(PROJECT_COLUMNS);
        expect(terms.every((t) => t.operator === "ilike")).toBe(true);
      });
    }
  });

  it("carries the injection payload as a literal substring to search for", () => {
    const payload = "zzqq,lts_number.neq.zzqq";
    const body = buildRecordSearchFilter(payload);

    // The payload is the thing being searched for, not a predicate.
    expect(matchesThroughFilter(body, "lts_number", `LS 1 ${payload} X`)).toBe(true);
    expect(matchesThroughFilter(body, "lts_number", "LS 0001210")).toBe(false);

    // And specifically: the column it tried to inject is not in the filter.
    expect(parseOrFilter(body).some((t) => t.column === "normalized_region")).toBe(false);
  });

  it("does not error on a company name containing a comma", () => {
    // Confirmed broken in production on 2026-08-29:
    // lts_records?search=Land, Inc -> "LTS records query failed."
    const body = buildRecordSearchFilter("Land, Inc");
    expect(() => parseOrFilter(body)).not.toThrow();
    expect(matchesThroughFilter(body, "normalized_developer", "ALVEO LAND, INC.")).toBe(true);
    expect(matchesThroughFilter(body, "normalized_developer", "ALVEO LAND CORPORATION")).toBe(false);
  });

  it("still finds ordinary search terms", () => {
    const body = buildRecordSearchFilter("mergent");
    expect(matchesThroughFilter(body, "normalized_project_name", "MERGENT RESIDENCES")).toBe(true);
    expect(matchesThroughFilter(body, "normalized_project_name", "BROOKLYN HOUSE")).toBe(false);
  });

  it("matches on a substring, not the whole value", () => {
    const body = buildRecordSearchFilter("0001210");
    expect(matchesThroughFilter(body, "lts_number", "LS 0001210")).toBe(true);
  });
});

describe("LIKE wildcards in user input", () => {
  it("treats % as a literal, not a wildcard", () => {
    // Confirmed live on 2026-08-29: query=%% returned all 8,401 records.
    const body = buildRecordSearchFilter("%");
    expect(matchesThroughFilter(body, "lts_number", "50% OFF")).toBe(true);
    expect(matchesThroughFilter(body, "lts_number", "LS 0001210")).toBe(false);
  });

  it("treats _ as a literal, not a single-character wildcard", () => {
    // Confirmed live on 2026-08-29: query=Merg_nt matched MERGENT.
    const body = buildRecordSearchFilter("Merg_nt");
    expect(matchesThroughFilter(body, "normalized_project_name", "MERG_NT")).toBe(true);
    expect(matchesThroughFilter(body, "normalized_project_name", "MERGENT")).toBe(false);
  });

  it("treats a backslash as a literal", () => {
    const body = buildRecordSearchFilter("A\\B");
    expect(matchesThroughFilter(body, "lts_number", "A\\B")).toBe(true);
    expect(matchesThroughFilter(body, "lts_number", "AB")).toBe(false);
  });

  it("keeps * as the one wildcard, because PostgREST rewrites it to % and a literal * cannot be sent", () => {
    // Confirmed live on 2026-08-29: query=Merg*nt matched both MERGENT and
    // MERG REALTY AND DEVELOPMENT. This is now the documented behaviour rather
    // than an accident. If PostgREST ever stops rewriting *, this test fails
    // and the tool descriptions need updating.
    const body = buildRecordSearchFilter("Merg*nt");
    expect(matchesThroughFilter(body, "normalized_project_name", "MERGENT")).toBe(true);
    expect(matchesThroughFilter(body, "normalized_project_name", "MERG REALTY AND DEVELOPMENT")).toBe(true);
    expect(matchesThroughFilter(body, "normalized_project_name", "BROOKLYN HOUSE")).toBe(false);
  });

  it("never emits a pattern ending in a lone escape character", () => {
    // Postgres rejects those: "LIKE pattern must not end with escape character".
    for (const [, input] of HOSTILE_INPUTS) {
      const terms = parseOrFilter(buildRecordSearchFilter(input));
      for (const term of terms) {
        expect(() => ilikeMatches(toLikePattern(term.value), "anything")).not.toThrow();
      }
    }
  });
});

describe("escapeLikePattern", () => {
  it("leaves ordinary text alone", () => {
    expect(escapeLikePattern("LS 0001210")).toBe("LS 0001210");
    expect(escapeLikePattern("foo.bar-baz")).toBe("foo.bar-baz");
  });

  it("escapes the LIKE metacharacters", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves * alone, since PostgREST rewrites it before Postgres sees it", () => {
    expect(escapeLikePattern("a*b")).toBe("a*b");
  });

  it("does not touch commas, which are the quoting layer's problem", () => {
    expect(escapeLikePattern("a,b")).toBe("a,b");
  });
});

describe("quoteFilterValue", () => {
  it("wraps the value in the double quotes PostgREST needs", () => {
    expect(quoteFilterValue("plain")).toBe('"plain"');
  });

  it("escapes quotes and backslashes inside the value", () => {
    expect(quoteFilterValue('a"b')).toBe('"a\\"b"');
    expect(quoteFilterValue("a\\b")).toBe('"a\\\\b"');
  });

  it("leaves a comma alone, because the quotes already neutralise it", () => {
    expect(quoteFilterValue("a,b")).toBe('"a,b"');
  });
});

describe("ilikeContainsTerm", () => {
  it("builds a quoted, wildcard-wrapped ilike term", () => {
    expect(ilikeContainsTerm("lts_number", "LS 123")).toBe('lts_number.ilike."%LS 123%"');
  });

  it("puts the surrounding wildcards outside the escaped value", () => {
    expect(ilikeContainsTerm("lts_number", "100%")).toBe('lts_number.ilike."%100\\\\%%"');
  });
});
