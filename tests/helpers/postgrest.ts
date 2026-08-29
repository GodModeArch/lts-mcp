/**
 * A model of how PostgREST parses the filter strings this repo builds.
 *
 * Why a model instead of asserting on the escaped string: the previous
 * sanitize.test.ts asserted the shape of the string `sanitizeFilterValue`
 * returned, and passed green while the escaping it described was live
 * exploitable. A unit test of a pure function cannot make a claim about a
 * remote parser. See docs/adversarial-audit-2026-08-29.md, findings N1 and N9.
 *
 * These rules were checked against production PostgREST on 2026-08-29:
 *
 *   lts_records?search=zzqq,normalized_region.neq.zzqq
 *     -> 8,390 records, not 0. An unquoted comma splits the or= list, and a
 *        backslash before it does not prevent that; the backslash is just a
 *        literal character. 8,390 is 8,401 minus the 11 rows with a NULL
 *        normalized_region, which is the injected predicate executing.
 *   lts_records?search=Land, Inc   -> error. The split produced a fragment
 *        that is not a valid column.operator.value triple.
 *   lts_search?query=Merg_nt       -> matched MERGENT. _ reaches SQL LIKE.
 *   lts_search?query=Merg*nt       -> matched MERGENT and MERG REALTY.
 *        PostgREST rewrites * to % for like/ilike before Postgres sees it.
 *
 * Only the subset this repo emits is modelled: a flat or= list of
 * column.operator.value triples. Negation prefixes and nested and()/or()
 * groups are not modelled because no query here builds them.
 */

export interface OrTerm {
  column: string;
  operator: string;
  /** The value as PostgREST hands it to Postgres, after unquoting. */
  value: string;
}

class PostgrestParseError extends Error {}

/**
 * Parse an or=() body into its terms. Throws on a fragment that is not a valid
 * triple, which is what production answers with a 500.
 */
export function parseOrFilter(body: string): OrTerm[] {
  const terms: OrTerm[] = [];
  let i = 0;

  const readUntilDot = (): string => {
    const start = i;
    while (i < body.length && body[i] !== "." && body[i] !== ",") i++;
    if (i >= body.length || body[i] !== ".") {
      throw new PostgrestParseError(
        `expected column.operator.value, got "${body.slice(start)}"`
      );
    }
    const out = body.slice(start, i);
    i++; // consume the dot
    return out;
  };

  while (i < body.length) {
    const column = readUntilDot();
    const operator = readUntilDot();

    let value: string;
    if (body[i] === '"') {
      i++; // opening quote
      let out = "";
      let closed = false;
      while (i < body.length) {
        const ch = body[i];
        if (ch === "\\") {
          const next = body[i + 1];
          if (next === undefined) {
            throw new PostgrestParseError("quoted value ends with a lone backslash");
          }
          out += next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        out += ch;
        i++;
      }
      if (!closed) throw new PostgrestParseError("unterminated quoted value");
      if (i < body.length && body[i] !== ",") {
        throw new PostgrestParseError(
          `trailing junk after quoted value: "${body.slice(i)}"`
        );
      }
      value = out;
    } else {
      // An unquoted value runs to the next comma. Backslash is not special.
      const start = i;
      while (i < body.length && body[i] !== ",") i++;
      value = body.slice(start, i);
    }

    terms.push({ column, operator, value });
    if (i < body.length && body[i] === ",") i++;
  }

  return terms;
}

/**
 * PostgREST rewrites * to % for the like and ilike operators, on the parsed
 * value, before the pattern reaches Postgres.
 */
export function toLikePattern(value: string): string {
  return value.replace(/\*/g, "%");
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Evaluate a SQL LIKE pattern the way Postgres does: % matches any run of
 * characters, _ matches exactly one, and backslash is the default escape
 * character. Case insensitive, matching ILIKE.
 */
export function ilikeMatches(pattern: string, subject: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        // Postgres: "LIKE pattern must not end with escape character"
        throw new PostgrestParseError("LIKE pattern ends with a lone escape character");
      }
      re += next.replace(REGEX_META, "\\$&");
      i++;
      continue;
    }
    if (ch === "%") {
      re += "[\\s\\S]*";
      continue;
    }
    if (ch === "_") {
      re += "[\\s\\S]";
      continue;
    }
    re += ch.replace(REGEX_META, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(subject);
}

/**
 * The full path a user's search term takes: the or= body this repo emits, as
 * PostgREST parses it, rewritten for ilike, evaluated against a subject.
 */
export function matchesThroughFilter(
  orBody: string,
  column: string,
  subject: string
): boolean {
  const term = parseOrFilter(orBody).find((t) => t.column === column);
  if (!term) throw new PostgrestParseError(`no term for column "${column}"`);
  return ilikeMatches(toLikePattern(term.value), subject);
}
