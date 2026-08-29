# LTS MCP: adversarial audit

Date: 2026-08-29
Target: `https://lts.godmode.ph/mcp` (Worker v1.0.1) + `main` @ 5a6eb53
Method: full source read (1,540 lines across `src/`), local suite (182/182 pass), and 14 live tool calls against production.

Input: `lts-mcp-findings.md` (session of 2026-08-28), 12 findings.

**Result: 12 of 12 original findings confirmed.** None were false positives. Root causes located in-repo for 6 of them. Plus 13 new findings, one of which (N1) is more serious than anything in the original list.

---

## Part 1: verdict on the original 12

| # | Finding | Verdict | Root cause |
|---|---|---|---|
| 1 | Null expiry counted as expired | **Confirmed** | `src/db/analytics.ts:36` |
| 2 | 8,401 vs 8,405 totals | **Confirmed** | Two different row populations, see N6 |
| 3 | Same project counted many times | **Confirmed** | By design, undocumented |
| 4 | `inferred_project_type` wrong for condos | **Confirmed** | Upstream pipeline, not this repo |
| 5 | `linked_to_project` is 0 | **Confirmed** | Upstream backfill never ran |
| 6 | Verification status contradicts itself | **Confirmed** | Upstream + `src/db/queries.ts:296` (N4) |
| 7 | `_meta.last_synced` stale | **Confirmed** | `wrangler.jsonc:12` hardcoded |
| 8 | `lts_filters` returns almost nothing | **Confirmed** | `src/db/queries.ts:350` (N5) |
| 9 | Law unknown for 5 whole regions | **Confirmed** | Upstream, arithmetic verified exactly |
| 10 | City names not normalized | **Confirmed** | `src/db/analytics.ts:437` (see N13) |
| 11 | Partial year vs full year YoY | **Confirmed** | `analytics.ts:398-405`, `analytics.ts:336-348` |
| 12 | Junk values carry `confidence: high` | **Confirmed** | Upstream |

### Evidence for the ones worth pinning down

**#1 is a deliberate, tested choice.** `deriveStatus()` at `src/db/analytics.ts:36` reads:

```ts
/** Null expiry = expired. DHSUD records without an expiry date are treated as lapsed. */
export function deriveStatus(expiryDate: string | null, today: string): "active" | "expired" {
  if (!expiryDate) return "expired";
  return expiryDate >= today ? "active" : "expired";
}
```

`tests/analytics.test.ts:91` asserts `deriveStatus(null, "2025-01-01") === "expired"`. So the suite locks the bug in. Live confirmation: `lts_by_region` active sums to 1,345 and expired to 7,060 (1,345 + 7,060 = 8,405 exactly), against `lts_stats` reporting 1,344 active / 2,732 expired. Expired is overstated **2.58x**.

Blast radius is wider than the original doc says. `deriveStatus` feeds four aggregators (`aggregateByRegionFromRows`, `aggregateByDeveloperFromRows`, `aggregateByCityFromRows`) **and** the `status` filter in `fetchFilteredRows:186`. So `status: "expired"` on any analytics tool silently returns null-expiry records too. `statusEnum` in `src/tools/analytics.ts:21-24` documents only "active (expiry >= today) or expired" and never mentions nulls.

**#2 is not a rounding difference, it is two populations.** The read path (`search`, `getLTSRecordItems`) applies `.neq("confidence", "low")`. The analytics path applies no confidence filter at all. Measured live:

| Query | Total |
|---|---|
| `lts_records` (no filters) | 8,401 |
| `lts_by_region` / `lts_trends` | 8,405 |
| `lts_records` region=Region 04A | 2,751 |
| `lts_by_region` bucket, Region 04A | 2,753 |
| `lts_records` region=CAR | 83 |
| `lts_by_region` bucket, CAR | 83 |

I checked whether the gap was pagination double-counting at `fetchFilteredRows` page boundaries and it is not: Region 04A returns 2,753 both from a 9-page global fetch and from a 3-page region-scoped fetch (`lts_by_law?region=Region 04A`). The count is stable across different boundary placements, so the paging is sound. See N6 for what the 4 rows actually are.

**#8 root cause is a missing `ORDER BY` plus a missing `.limit()`.** `getFilterValues` (`src/db/queries.ts:350-389`) fires two unordered `select()` calls and dedupes in JS. PostgREST caps at `db-max-rows` (1,000 on Supabase default), so each query gets an arbitrary 1,000-row slice. The two slices differ, which is why the live response lists only `CAR` and `NCR` as regions while simultaneously listing Cebu, Davao and Bacolod cities that belong to neither. `lts_stats` reports 520 unique cities; the tool returns roughly 230.

The irony: `fetchFilteredRows:159-163` carries a comment warning about exactly this failure mode. The fix was applied to analytics and never back-ported to `getFilterValues`.

**#9 arithmetic checks out exactly.** Regions 09/10/11/12/13 unknown law: 85 + 294 + 311 + 192 + 97 = 979, with zero BP220 and zero PD957 in all five. Total unknown across all 17 regions sums to 1,808. 979/1,808 = 54.1%. Both figures in the original doc are correct to the digit.

**#11 confirmed live.** `lts_trends` returns `yoy_growth_pct: -89.1` comparing 2026 (97 records) to 2025 (893). `LAST_SYNCED` says 2026-03-04 and today is 2026-08-29, so 2026 is a two-month stub. `lts_by_law?region=Region 04A` returns `bp220_share_delta: 15.9` off the same partial year. Neither response carries any partial-period flag.

**#3, #4, #5, #6 all reproduce in a single `lts_search?query=Mergent` call.** Three licences (LS 0001210, PLS NCR-087, HL 35174) for one Makati building, all `project_id: null`, all `inferred_project_type: "house_and_lot"` despite `raw_project_type: "OM Condo - PD 957"` and `raw_units: "325 - Residential Condo Unit, 321 - Parking"`, against a project row with `lts_count: 3, active_lts_count: 0, lts_number: null, lts_status: "verified"`. LS 0001210 expires 2026-09-30, which is active with 32 days left.

That record also confirms #12: `HL 35174` has `lts_format: "unknown"` and two `parsing_notes` entries and still carries `confidence: "high"`.

---

## Part 2: new findings

### N1. PostgREST filter injection in `lts_search` and `lts_records` (HIGH)

`sanitizeFilterValue` (`src/db/queries.ts:5-7`) escapes commas with a backslash:

```ts
return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
```

**PostgREST does not honour backslash escaping outside double-quoted values.** Reserved characters are only neutralised by wrapping the value in `"..."`. A bare backslash is a literal character and the comma still delimits the `or=()` list.

Confirmed live, twice:

| Query | Expected | Actual |
|---|---|---|
| `zzqq,lts_number.neq.zzqq` | 0 records | **8,401 records** (whole table) |
| `zzqq,normalized_region.eq.CAR` | 0 records | **500, "Search failed"** |

The first splits into six filter terms instead of three; the injected `lts_number.neq.zzqq%` matches every row. The projects side of the same response returned exactly 19, which is the count of projects with a non-null `lts_number` (`col <> x` is NULL for NULL, so those rows drop out). That is a precise signature of the injected predicate executing, not a coincidence.

**`tests/sanitize.test.ts:86-93` asserts this exact attack is blocked.** The test is green. It asserts on the shape of the returned string, never on PostgREST's actual parsing, so it provides false assurance rather than coverage.

Impact: read-only against `lts_records` and `projects` via the anon key. It cannot write, and it cannot cross to other tables (the `.eq()` filters are separate query params and stay ANDed). What it does give an unauthenticated caller is arbitrary predicate control over the `or=()` clause: blind enumeration of columns that are never returned, defeat of the intended result scoping, whole-table dumps from a public MCP endpoint, and 500s from malformed filters.

Fix: double-quote the value and escape `"` and `\` inside it, rather than escaping commas.

```ts
export function sanitizeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
// call site: `lts_number.ilike."%${q}%"`
```

Both call sites need the quotes added: `queries.ts:42-43` and `queries.ts:131-133`. Verify against live PostgREST after changing, since the exact quoting behaviour is what the current code got wrong.

### N2. LIKE wildcards pass through unescaped (MEDIUM)

`%` and `_` are never escaped. `lts_search?query=%%` returns **all 8,401 records and all 4,902 projects**. `tests/sanitize.test.ts:27-29` explicitly asserts `%` is preserved, calling it intentional. On a public endpoint this is a free full-table dump and a cost vector. If literal matching is wanted, escape `%`, `_` and `\` and set an `ESCAPE` character. Fix alongside N1.

### N3. `getStats` silently reports 0 when a query fails (MEDIUM)

`src/db/queries.ts:267-298` runs six queries in parallel and checks `.error` on exactly one of them (`ltsStats`). The other five use `count ?? 0`. A failed query returns `count: null`, so the tool reports `total: 0, withLTS: 0, activeLTS: 0` as if those were real measurements. There is no test covering `getStats` at all. Check every `.error` and fail the tool rather than emitting zeros.

### N4. `projects.activeLTS` is a verification count, not an active count (MEDIUM)

`queries.ts:271` counts `project_lts` rows with `status = 'verified'` and `queries.ts:296` assigns it to `activeLTS`. `status` is the `LTSStatus` enum (`unverified | verified | expired | none`), which is a workflow state, not a date derivation. A verified-but-long-expired licence counts as active. This is the repo-side half of original finding #6, and it is why live `lts_stats` shows `activeLTS: 192` next to `expiringSoon: 1`.

### N5. `getFilterValues` has no `ORDER BY` and no pagination (MEDIUM)

Root cause of #8, detailed above. The two sub-queries return mutually inconsistent slices. Fix by paging like `fetchFilteredRows` does, or better, move the distinct to the database with an RPC.

### N6. Four records are invisible to every read tool (LOW, but it is the #2 gap)

`lts_stats` reports `high: 8,325 + medium: 76 + low: 0 = 8,401 = total_records`, while analytics counts 8,405 rows. Since paging is sound (proven above), 4 rows carry a `confidence` that is neither high, medium nor low, almost certainly NULL. In Postgres `confidence <> 'low'` evaluates to NULL for a NULL column and the row is dropped, so those 4 rows are excluded from `lts_search`, `lts_records` and the `lts_stats` buckets, while being counted in all six analytics tools. Two of them are in Region 04A. Worth a `SELECT ... WHERE confidence IS NULL` to see what they are.

### N7. City grouping splits on province capitalisation (MEDIUM, sharpens #10)

`aggregateByCityFromRows:437` keys on `` `${city}|||${province}` `` using raw display strings. Live `lts_by_city` returns **two separate rows for Davao City**:

- `City of Davao` / `Davao Del sur` / Region 11: count 111
- `City of Davao` / `Davao del Sur` / Region 11: count 40

Identical city, identical province, differing only in the case of "del". Davao City's real total is 151, which would move it from 15th to 9th in the national ranking. Same response also splits `Sto. Tomas`/Batangas (89) from `City of Sto. Tomas`/Batangas (20), and shows `City of Las Pinas` where `lts_filters` reports `City of Las Piñas`.

The original doc's recommendation is right and the column already exists: `city_slug` is on `LTSRecordRow` (`types.ts:25`) and populates correctly (`makati`, `gen-mariano-alvarez`, `tabuk`, `pasay`). It is simply **not in `ANALYTICS_COLUMNS`** (`analytics.ts:66-78`), so the aggregator cannot see it. Add it, group on `city_slug`, and keep a display name for output. Province needs the same treatment or a slug of its own.

### N8. `AnalyticsRow.inferred_project_type` is declared but never selected (LOW)

`types.ts:143` declares the field; `ANALYTICS_COLUMNS` does not request it. At runtime it is always `undefined` while TypeScript reports it as `string | null`. Nothing reads it today, so it is latent. There is no runtime validation that the select list matches the row type, which is what let this drift.

### N9. The test suite locks in the wrong behaviour (MEDIUM, process)

182/182 pass against a build with all 12 confirmed defects. Two specific cases: `analytics.test.ts:91` asserts null expiry is expired, and `sanitize.test.ts:86-93` asserts an injection is blocked that is live-exploitable. Both tests are unit tests of pure functions asserting on the buggy contract. Any fix to #1 or N1 must change these tests, which is the signal that they were written to describe the code rather than the requirement.

### N10. README still documents a tool that does not exist (LOW)

Original finding #8 caught `lts_queue` in the `lts_filters` description (`maintenance.ts:12`). It is also in `README.md` lines 23, 33, 41 and 63. The tool was renamed to `lts_records`.

### N11. `/health` returns raw database error text to unauthenticated callers (LOW)

`health.ts:39` puts `error.message` into the response body and `index.ts:50` serves it unauthenticated. Supabase error strings can carry schema and project detail. Log the detail and return a generic reason, matching what `safeToolError` already does for tools.

### N12. `MAX_ROWS` boundary sets a false `truncated` flag (LOW)

`analytics.ts:166-170`: at exactly 25,000 rows the loop enters the `from >= MAX_ROWS` branch and reports `truncated: true` despite having fetched everything. Cosmetic today at 8.4k rows.

### N13. No maximum length on search input (LOW)

`read.ts:14` is `z.string().min(2)` with no `.max()`. Same for the `search` field at `read.ts:42`. Unbounded input reaches three `ilike` patterns per query.

---

## Part 3: suggested order

Reordered from the original doc to put the security finding first and to group by where the fix lives.

**In this repo, ship together:**

1. **N1 + N2**, filter injection and wildcard passthrough. Only live security finding. Rewrite `sanitizeFilterValue` to quote rather than backslash-escape, add quotes at both call sites, and rewrite `sanitize.test.ts` to assert against live PostgREST rather than string shape.
2. **#1**, the null-expiry bucketing. Change `deriveStatus` to return `"active" | "expired" | "unknown"`, add an `unknown` field to every `active`/`expired` pair in the response types, extend `statusEnum` to accept `unknown`, and update the four aggregators plus the `status` filter. This is the one producing confidently wrong published numbers.
3. **#7 + #8 + N5**, both visible on every single call and both small. Derive `last_synced` from `max(scraped_at)` at init instead of the `wrangler.jsonc` var; page `getFilterValues` or move it to an RPC.
4. **N3 + N4**, `getStats` error handling and the `activeLTS` mislabel. Add the missing test coverage.
5. **#10 + N7**, add `city_slug` to `ANALYTICS_COLUMNS` and group on it.
6. **#11**, add `partial_period: true` to `lts_trends` and `lts_by_law` when the newest period is incomplete relative to `last_synced`, or suppress the headline figure the way `truncated` already does.
7. **#3**, decide the licence-vs-project counting policy and state it in all six aggregation tool descriptions. `count` currently reads as project supply to any consumer.
8. **N10, N11, N12, N13**, cleanup pass.

**Upstream of this repo (pipeline / DB, cannot be fixed here):**

- **#5** backfill `lts_records.project_id` from `project_lts`. Until then the `linked` filter on `lts_records` is dead.
- **#6** recompute `projects.active_lts_count` and `projects.lts_number`.
- **#4** audit `inferred_project_type`. It ignores both `raw_project_type` and `raw_units`.
- **#12** make `confidence` reflect parse quality. A record with `lts_format: "unknown"` and populated `parsing_notes` should not be `high`.
- **#9** investigate the Region 09/10/11/12/13 source format. 979 records, zero law parsed.
- **N6** identify the 4 records with non-enum `confidence`.
- **#2** follows from N6 and from picking one authoritative population. Recommend: analytics adopts the read path's confidence filter, so all 12 tools agree on 8,401.

---

## Notes on method

- Original findings were validated against the live production Worker, not against local code alone, because 6 of the 12 are data-dependent.
- The 8,401 vs 8,405 gap was tested against two competing hypotheses (NULL confidence vs pagination double-counting) with a discriminating experiment, because the two have different fixes. Pagination was ruled out.
- No credentials were available (`.env` holds empty placeholders, secrets live in Cloudflare Worker config), so DB-side items are inferred from tool behaviour and arithmetic rather than direct SQL. Items marked "upstream" should be confirmed with a query before fixing.
