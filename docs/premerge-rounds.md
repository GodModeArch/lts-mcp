# Premerge rounds

Scope rule: round 1 reads `git diff main...HEAD`; round N reads
`git diff <sha of round N-1>..HEAD` plus the blast radius of those hunks. Code unchanged
since a round that read it is out of scope.

## fix/postgrest-filter-injection

Exit checklist (reconstructed at round 1; no ledger existed before it):
- [x] preconditions green on the current head (`0e45772`): `npx vitest run` 226/226, `npx tsc --noEmit` clean. No linter configured; no build step beyond `wrangler deploy`.
- [x] central behaviour has a check watched failing: `tests/sanitize.test.ts` run against `main`'s `src/db/queries.ts` (helper renamed to satisfy the import) fails 25 of 42, naming the defect: "record search survives comma injection, confirmed live as a whole-table read". Restored clean.
- [x] no open critical or moderate shipped finding. Round 1's moderate is fixed in
  `0e45772` and round 2 reviewed that fix. Nothing open.
- [x] no open regression
- [x] every commit inside some round's range. `210bfb4` and `093ff80` in round 1,
  `0e45772` and `05809c1` in round 2.

| Round | Reviewed sha | Range | Verdict | Findings |
|---|---|---|---|---|
| 1 | `093ff80` | `main...093ff80` | MERGE WITH FIXES | 1 shipped moderate, 1 gate minor, 1 gate note |
| 2 | `05809c1` | `093ff80..05809c1` | SAFE TO MERGE | 0 blocking, 2 notes |

### Round 1 (`093ff80`)

1. **shipped / moderate / already-filed as audit N2, claimed closed by this branch.**
   `src/db/queries.ts:14` deliberately leaves `*` unescaped, and PostgREST maps `*` to `%`
   for `like`/`ilike`. `lts_search?query=**` therefore still returns the whole table from an
   unauthenticated endpoint. Confirmed live on 2026-08-29 against production: `records.total`
   8,401 and `projects.total` 4,902, identical to the `%%` result the audit recorded for N2.
   The branch closes `%` and `_` and renames the vector to `*`; the commit subject
   ("and wildcard passthrough in search") claims more than it delivers. → disposition pending.
2. **gate / minor / new.** `search()` (the `lts_search` path, the one the audit
   live-exploited) has no test asserting the string it hands `.or()`. `tests/queries.test.ts`
   asserts the wiring only for `getLTSRecordItems`; `tests/sanitize.test.ts` exercises the
   builders as pure functions. Rewiring `search()` back to a raw template leaves the suite
   green. → disposition pending.
3. **gate / note / new, no action.** `tests/helpers/postgrest.ts:10-22` cites live probes for
   its model, but every one of them ran through production's *unquoted* code path, while the
   model's load-bearing assumption is that the `*` rewrite and the backslash unescaping happen
   on the *quoted* path too. Checked against PostgREST source this round and it holds:
   `pQuotedValue = char '"' *> many pCharsOrSlashed <* char '"'` with
   `pCharsOrSlashed = noneOf "\\\"" <|> (char '\\' *> anyChar)` discards the quote marker, and
   `T.map star val` (`star c = if c == '*' then '%' else c`) runs afterwards with no
   quoted/unquoted distinction. Recorded so the next round does not re-derive it.

### Round 1 dispositions (builder session, fixed in `0e45772`)

1. **Fixed.** Accepted as written. The `*` rewrite happens inside PostgREST and cannot be
   escaped, so the character was never the place to fix it; the question is whether a term
   constrains anything at all. `isUnboundedSearchTerm` (`src/db/queries.ts:18`) strips the
   wildcard and reports whether anything is left. Three callers that take free text now
   treat a term with nothing left as an empty search: `search()` returns empty without
   touching the client, `getLTSRecordItems()` returns an empty page rather than the
   unfiltered table, and `findProjectByName()` returns null rather than the first row in
   the table presented as an exact match. That third one was not in the finding; it is the
   same helper's blast radius and was returning an arbitrary project for `projectName=*`.
   `*` still works wherever it narrows something (`Merg*nt` is covered by a test).
   Checks watched failing against `093ff80` first: 9 caller tests in
   `tests/queries.test.ts` under "unbounded search terms", each failing with the whole
   table or an arbitrary project rather than with a missing symbol.
   Not re-verified live: the fix is not deployed. Round 2 should treat the live
   confirmation as pending, not as done.

2. **Fixed.** Accepted as written, and the gap was confirmed before it was closed:
   rewiring `search()` back to the pre-fix raw template left all 42 pure-function tests in
   `tests/sanitize.test.ts` green. `tests/queries.test.ts` now has "search filter wiring",
   four tests asserting on `builder.or.mock.calls[0][0]`, the argument the Supabase builder
   actually receives, parsed through the same `tests/helpers/postgrest.ts` model. Under the
   same rewire those four fail. Also updated the three tool descriptions in
   `src/tools/read.ts`, which promised `*` as a wildcard without saying a wildcard-only
   term matches nothing.

3. **No action, as recorded.** Round 1 checked the quoted path against PostgREST source and
   the model holds. Nothing in `0e45772` changes the quoting layer.

### Round 2 (`05809c1`)

Range `093ff80..05809c1`: `0e45772` (the round 1 fixes) and `05809c1` (docs only).
Preconditions re-measured on this head, not quoted: `npx vitest run` 226/226,
`npx tsc --noEmit` clean. No linter configured; no build step beyond `wrangler deploy`.

Round 1's disposition claims were re-verified rather than accepted. Reverting the three
guards in `src/db/queries.ts` (restoring `if (!raw)` in `search()`, removing the
`getLTSRecordItems` early return and the `findProjectByName` early return) fails exactly
the 9 tests the builder named, 3 per caller, each on the whole table or an arbitrary
project rather than on a missing symbol. Restored clean; suite back to 226/226.

**No new blocking findings in this range.** The two notes below are recorded so round 3
does not re-derive them.

1. **shipped / minor / new, filed not fixed.** The guard is correct and does what its
   comments say, but the surrounding narrative reads wider than the code. `lts_records`
   with no filters at all returns `total` 8,401 with `hasMore` true, measured live on
   2026-08-29, so the table is enumerable by design with no wildcard involved. Measured
   in the same session: `lts_search?query=a*`, a term the new guard accepts, returns
   records 8,248 and projects 4,238. The guard removes no capability an attacker has by
   other means; what it actually buys is that a caller who believes it filtered gets an
   empty result instead of an unfiltered one, and that `findProjectByName` stops
   presenting an arbitrary project as an exact match. The open question, whether a public
   unauthenticated endpoint should expose exact counts and unbounded paging over the whole
   table, is a product decision that predates this branch and is not its to settle. File
   it; do not read the journal entry as having closed it.

2. **gate / minor / new, deploy-time check.** The load-bearing assumption behind the
   whole approach, that PostgREST rewrites `*` to `%` on the *quoted* value path as well
   as the unquoted one, still rests only on round 1's reading of the PostgREST source.
   It has no live confirmation and cannot get one before deploy: production runs the
   pre-branch unquoted code, so every live probe to date, including this round's,
   exercised the old path. If the assumption is wrong the failure is functional, not
   security: `*` silently stops matching anything. Baselines captured on the old path on
   2026-08-29, for comparison immediately after deploy:
   - `lts_search?query=Merg*nt` -> records total 5, projects total 1 (MERGENT)
   - `lts_search?query=**` -> records total 8,401, projects total 4,902 (still exposed;
     the fix is undeployed, and this is what should become 0 and 0)

Not covered by this verdict: the worktree has untracked files in the repo root
(`.bashrc`, `.gitconfig`, `.gitmodules`, `.idea`, `.mcp.json`, `.profile`, `.ripgreprc`,
`.vscode`, `.zprofile`, `.zshrc`), none of them ignored by `.gitignore`. No tracked file
is modified, so the verdict covers the full tracked tree at `05809c1`. Worth ignoring or
removing before any `git add -A`.
