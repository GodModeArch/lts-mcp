# LTS MCP build journal

## Phase: adversarial audit (2026-08-29)

### What we built
Validation pass over a 12-item findings doc from an external test session, plus an independent scan for defects that session missed. Full source read, local suite, and 14 live calls against production. Output: `docs/adversarial-audit-2026-08-29.md`.

### Challenges

### Challenge: the comma sanitizer never worked, and a green test said it did
`sanitizeFilterValue` escapes commas with a backslash before interpolating user input into a PostgREST `.or()` string. The wrong assumption was that PostgREST honours backslash escaping the way most query languages do. It does not. Reserved characters are only neutralised inside double quotes; a bare backslash is a literal and the comma still delimits.

Live proof: `lts_search?query=zzqq,lts_number.neq.zzqq` returned all 8,401 records instead of zero. The projects half of the same response returned exactly 19, which is the count of projects with a non-null `lts_number`, because `col <> x` is NULL for NULL rows. That signature only appears if the injected predicate actually executed.

The part worth remembering: `tests/sanitize.test.ts` has a test literally named "escapes PostgREST filter injection via comma" and it passes. It asserts on the shape of the string the function returns, never on what PostgREST does with that string. A unit test of a pure function cannot validate a claim about a remote parser. The test made the hole harder to see, not easier.

Fix: quote the value (`ilike."%v%"`) and escape `"` and `\` inside it, rather than escaping commas. Not yet applied.

<!-- content: blog -->

### Challenge: two hypotheses for one four-record gap
`lts_stats` reports 8,401 records, every analytics tool reports 8,405. Two candidate causes with completely different fixes: rows with NULL `confidence` being dropped by `.neq("confidence", "low")` on the read path, or `fetchFilteredRows` double-counting at `.range()` page boundaries.

Rather than guess, ran a discriminating test. Region 04A returns 2,753 both from a 9-page global fetch and from a 3-page region-scoped fetch. Different boundary placements, identical count, so paging is sound. That leaves NULL confidence: in Postgres `confidence <> 'low'` is NULL for a NULL column and the row silently drops out.

Worth doing because "the two paths query differently" was as far as the original session got, and the two fixes are unrelated.

<!-- content: blog -->

### Challenge: the same paging bug, fixed in one file and not the other
`fetchFilteredRows` carries a careful comment explaining that a single `.limit()` is unsafe because Supabase caps at `db-max-rows: 1000` and silently returns a biased slice. `getFilterValues`, in a different file, does exactly that, with no `ORDER BY` either.

The visible symptom is strange enough to have looked like a data problem rather than a code one: `lts_filters` reports only CAR and NCR as regions while listing Cebu, Davao and Bacolod cities, because the two sub-queries each get a different arbitrary 1,000-row slice.

<!-- content: blog -->

### Decision: report only, do not fix
Findings were recorded without applying fixes, so the fix session and the review session stay separate. A reviewer that fixes is reviewing its own code by the next round.

Reason: 8 of the 20 confirmed items live upstream in the pipeline or the database, not in this repo, and no credentials were available in this session to confirm them with SQL. Applying the 12 in-repo fixes without first settling the licence-vs-project counting policy (original finding #3) would bake a counting decision into six tool descriptions by accident.

<!-- content: none -->

### Open questions
- Licence-vs-project counting policy. Every aggregation counts licences; Mergent Residences alone contributes three rows for one building. Deduplicate, or label it in all six tool descriptions?
- What are the 4 records whose `confidence` is neither high, medium nor low?
- Do Regions 09/10/11/12/13 use a different DHSUD source format? 979 records, zero law parsed, regional rather than random.

## Phase: audit fixes, in-repo (2026-08-29)

### What we built
First fix from `docs/adversarial-audit-2026-08-29.md`: N1 (PostgREST filter injection) and N2 (LIKE wildcard passthrough), shipped together because they are the same two call sites. Replaced `sanitizeFilterValue` with a quoting layer (`quoteFilterValue`), a LIKE layer (`escapeLikePattern`) and one term builder (`ilikeContainsTerm`) that no call site can bypass.

### Challenges

### Challenge: a literal asterisk cannot be sent through a PostgREST ilike filter
The audit listed two leaking wildcard characters, `%` and `_`. There are three. PostgREST rewrites `*` to `%` for the `like` and `ilike` operators, on the already-parsed value, before the pattern reaches Postgres. Confirmed live: `lts_search?query=Merg*nt` matched both MERGENT and MERG REALTY AND DEVELOPMENT.

The wrong assumption was that anything leaking through can be escaped. It cannot. The rewrite runs after the quoted-value parser has consumed backslashes, so `\*` arrives as `*` and still becomes `%`. There is no byte sequence that delivers a literal `*` to the pattern. Every escaping scheme tried on paper failed for the same reason.

Fix: stop fighting it. `%` and `_` are escaped so they match literally, and `*` is documented as the one wildcard in all three tool descriptions. Three undocumented wildcards became one documented one. A test asserts the `*` behaviour so that if PostgREST ever drops the rewrite, the tool descriptions get flagged instead of silently going stale.

<!-- content: blog -->

### Challenge: the injection was also breaking ordinary searches
Chasing the security finding turned up a functional bug nobody had reported. `lts_records?search=Land, Inc` returns "LTS records query failed." in production. The comma splits the `or=()` list, the fragment ` Inc` is not a valid `column.operator.value` triple, and PostgREST answers 500.

Philippine company names contain `, Inc.` constantly. So the same defect that let an anonymous caller dump the table was also making a whole class of legitimate searches fail, and it had been sitting there since launch without a bug report. The security framing is what got it looked at.

Worth remembering: the exploit and the outage were one bug. Nobody reported the outage.

<!-- content: blog -->

### Decision: test against a model of PostgREST's grammar, not against the escaped string
The test this replaces was named "escapes PostgREST filter injection via comma", it passed, and the attack it named worked in production. It asserted that the returned string had a backslash before each comma. That is a claim about the function. The requirement is a claim about a remote parser, and a unit test of a pure function cannot reach it.

Alternatives considered: integration tests against live PostgREST (no credentials in this repo, `.env` holds empty placeholders, so they would be skipped in CI and rot), or asserting on the exact emitted string (sharper than before, still a shape assertion).

Chose a third option. `tests/helpers/postgrest.ts` models the subset of the PostgREST grammar this repo emits: or-list splitting, quoted-value backslash rules, the `*` rewrite, and a SQL LIKE evaluator. Every rule in it was checked against production first, and the probe results are in the file header. Tests now assert the requirement: for twelve hostile inputs, the filter parses to exactly three ilike terms and the payload is matched as a literal substring.

Tradeoff accepted: a model can drift from the real parser. It is still strictly better than the string assertion, because it is falsifiable and it names what it assumes. Live verification against the deployed Worker remains the final check.

<!-- content: blog -->

### Challenge: documenting a wildcard is not the same as bounding it
Round 1 of premerge caught the previous entry claiming more than it delivered. Escaping `%` and `_` and promoting `*` to "the documented wildcard" closed two of the three leaks and renamed the third. `lts_search?query=**` still returned 8,401 records and 4,902 projects, the whole of both tables, from an unauthenticated endpoint. Identical numbers to the `%%` read the audit had recorded as the original finding. The commit subject said "and wildcard passthrough in search"; the passthrough was still there under a new name.

The wrong assumption was that the fix was about which characters reach Postgres. It was never about the characters. It was about whether a caller can send a term that constrains nothing. Escaping cannot answer that, and for `*` escaping is not even available, since the rewrite discards the backslash before it runs.

Fix: `isUnboundedSearchTerm` strips the wildcard and asks whether anything is left. Nothing left means the term is an empty search, and the three callers that take free text now treat it as one. `search()` returns empty without touching the client, `getLTSRecordItems()` returns an empty page rather than an unfiltered table, and `findProjectByName()` returns null instead of the first project in the table presented as an exact match. `*` still works as a wildcard everywhere it narrows something.

<!-- content: blog -->

### Decision: assert on the string the Supabase builder is actually called with
Round 1's second finding: `search()`, the exact path the audit live-exploited, had no test asserting the filter it hands `.or()`. `tests/sanitize.test.ts` exercises the builders as pure functions and `tests/queries.test.ts` asserted the wiring only for `getLTSRecordItems`. Rewiring `search()` back to a raw template string left the whole suite green.

Verified rather than assumed: rewired `search()` to the pre-fix template, ran the suite, and the 42 pure-function tests all passed. That is the gap.

Chose to assert on `builder.or.mock.calls[0][0]`, the real argument, then push it through the same PostgREST model the pure-function tests use. Alternative considered was asserting the builders are called, via a spy on the module, which proves the call happened but not that its result reaches the query. Under the same rewire the four new tests fail. The check was watched failing before it was kept.

<!-- content: none -->

### Challenge: the fix's load-bearing assumption could not be tested until it shipped
The whole quoting approach rests on PostgREST rewriting `*` to `%` on the *quoted* value path, not just the unquoted one. If that were wrong, `*` would silently stop matching anything and the wildcard would be dead in production while every local test still passed. Premerge round 1 checked it against the PostgREST parser source (`pQuotedValue` discards the quote marker, `T.map star val` runs afterwards with no quoted/unquoted distinction) and round 2 flagged that source reading was all we had. It could not be confirmed live before deploy, because production was still running the unquoted code, so every probe up to that point exercised the old path.

Fix: capture baselines on the old path, deploy, re-run the same calls, compare. Deployed 2026-08-29, version `46138faa`.

| Call | Before | After |
|---|---|---|
| `query=**` | 8,401 records / 4,902 projects | 0 / 0 |
| `query=zzqq,lts_number.neq.zzqq` (the N1 exploit) | 8,401 records | 0 |
| `query=Merg*nt` | 5 records / 1 project | 5 / 1 |
| `query=Land, Inc` | n/a | 755 records, Filinvest Land, Inc. |

The third row is the one that mattered: unchanged means the `*` rewrite does happen on the quoted path and the wildcard survived the fix. The fourth is the other half of it, a legitimate comma in a developer name now searches instead of splitting the filter list. Blocking the injection alone would have been easy to get right by breaking commas entirely.

<!-- content: blog -->

### Decision: null expiry becomes a third status, not a re-labelled expired
Audit finding #1: `deriveStatus` (`src/db/analytics.ts:36`) returns `"expired"` for a null expiry date, with a comment calling it deliberate and `tests/analytics.test.ts:91` asserting it. Live, that overstates expired by 2.58x across every analytics tool, and roughly half the dataset has no expiry date, so this is not an edge case being tidied away.

Alternatives considered. Keep two buckets and drop null-expiry rows out of both, surfacing `no_expiry_date` as a sibling of `total`: least disruptive to anyone reading `active`/`expired` today, but it hides the population inside a field nobody filters on. Add the third bucket to responses but leave the `status` filter at two values: smaller public API change, but a consumer can then see 823 unknown records and have no way to ask for them.

Chose the third bucket, filterable. `deriveStatus` returns `"active" | "expired" | "unknown"`, every `active`/`expired` pair in the response types gains `unknown`, and `statusEnum` accepts it.

Reason: the numbers are published and are currently wrong in a direction that reads as a data-quality story about DHSUD when it is actually ours. A bucket a consumer can query is also the fastest route to the upstream fix, since it names the 4,000-odd records that need an expiry date backfilled. Tradeoff accepted: the response shape changes for all six analytics tools, and `tests/analytics.test.ts:91` has to flip, which is the N9 signal that the test was written to describe the code rather than the requirement.

<!-- content: blog -->

### Challenge: the null-expiry population was half the dataset, not an edge case
The decision entry above estimated the affected rows arithmetically ("roughly half", "4,000-odd") because the audit could only infer them: live `lts_by_region` reported active 1,345 / expired 7,060 against `lts_stats` reporting 1,344 active / 2,732 expired, and the gap was the null-expiry rows hiding inside `expired`. Nobody had counted them, and the local `.env` is an empty template, so there were no credentials to count them with.

Counted them through the live endpoint instead. `getLTSRecordItems` orders with `nullsFirst: false`, so sorting by `expiry_date` puts every null at the end and the null count is just the table size minus the offset of the first null row. Binary search on `offset` with `limit: 1`: offset 4075 is the last non-null (`PLS LS-R8-00030`, expiry `3023-06-01`), offset 4076 is the first null (`LS 0001366`). So **4,325 of 8,401 records have no expiry date, 51.5%**. Three probes, no credentials needed.

That lands exactly where the audit's arithmetic said it would: 7,060 reported expired minus ~4,325 nulls leaves ~2,735 real expired, against `lts_stats`' 2,732 on its slightly smaller population. 7,060 / 2,735 = 2.58x, to the digit.

Fix: `deriveStatus` returns `"unknown"` for null expiry. The three aggregators count a third bucket, the `status` filter gained a third value, the three response-type pairs gained `unknown`, and `statusEnum` accepts it.

<!-- content: blog -->

### Challenge: the test asserted the bug, so it had to be watched failing first
`tests/analytics.test.ts:91` asserted `deriveStatus(null, "2025-01-01") === "expired"`. A test that green-lights the defect is worse than no test: it makes the fix look like the regression. The flip was run against unmodified `main` before any source change, and the failure read `AssertionError: expected 'expired' to be 'unknown'`, an assertion on the null case, not a missing-symbol import error that would have proven nothing about behaviour.

The same trap sits one layer up. The three aggregators had "tracks active/expired split" tests that never asserted a third bucket, so they would have stayed green through the entire change while silently covering nothing. Reverting the one-line `deriveStatus` change with the new tests in place fails 7 tests across all three aggregators, the status filter and the helper. Before the new tests, that same revert failed exactly 1.

Fix: added null-expiry rows to each aggregator's split test, an invariant test that `active + expired + unknown === count`, and two filter tests covering that `status: "expired"` now excludes nulls and `status: "unknown"` selects exactly them.

<!-- content: blog -->

### Challenge: a licence expiring in the year 3023
Offset 4075, the last non-null expiry in the whole table, is `PLS LS-R8-00030` with `raw_expiry_date: "1-Jun-3023"`, normalized faithfully to `3023-06-01`. It is an upstream DHSUD typo for 2023, and it currently derives as `active`.

Fix: none. Out of scope for this branch and it is a single row, but it means `active` has a ceiling problem the same way `expired` had a floor problem: nothing validates that a derived-active expiry is within a plausible range. Logged so the next person does not rediscover it as a mystery.

<!-- content: none -->

### Decision: verify the null-expiry fix by an invariant, not by the predicted count
The obvious post-deploy check was "unknown should be about 4,325", the number the binary search produced. That check would have been noise: the analytics tools read 8,405 rows while `lts_records` and the `get_lts_stats` RPC both report 8,401 on the same table, so the predicted count could never land exactly and a 2-row miss would read as a defect in the fix.

Reason: picked criteria the arithmetic forces instead. Active must not move at all (the fix only touches the null branch), `expired + unknown` must equal the old expired count to the row, and the three buckets must sum to `count` per region. Live after deploy: active 1,345 unchanged, expired 2,733 plus unknown 4,327 equals 7,060, exactly the pre-deploy expired. Tradeoff accepted: this does not confirm the absolute null count, which stays a filed question along with the 8,405 vs 8,401 population gap.

<!-- content: blog -->

### Challenge: two premerge rounds filed a finding about files that do not exist
Both rounds ended by flagging untracked dotfiles in the repo root (`.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.idea`, `.vscode`) as needing a `.gitignore` entry before anyone ran `git add -A`. The wrong assumption was that `git status` inside a review session shows the repository. It shows the repository as the sandbox presents it, and the sandbox mounts `/dev/null` over dotfile paths so tooling cannot read a developer's shell config. `ls -la` gave it away: every entry was a character device `1, 3`, owned by `nobody`, all with the same timestamp.

Fix: none needed, which was the point. Outside the sandbox the tree is clean and none of those paths exist. The note is marked rejected in `docs/premerge-rounds.md` rather than deleted, since two rounds acted on it. Acting on it would have been worse than ignoring it: `.gitmodules` and `.mcp.json` are legitimate project files, and the recommended fix was to gitignore them.

<!-- content: blog -->
