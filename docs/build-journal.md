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
