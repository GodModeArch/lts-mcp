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
