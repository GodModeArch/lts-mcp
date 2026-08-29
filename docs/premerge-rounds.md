# Premerge rounds

Scope rule: round 1 reads `git diff main...HEAD`; round N reads
`git diff <sha of round N-1>..HEAD` plus the blast radius of those hunks. Code unchanged
since a round that read it is out of scope.

## fix/postgrest-filter-injection

Exit checklist (reconstructed at round 1; no ledger existed before it):
- [x] preconditions green on the current head (`0e45772`): `npx vitest run` 226/226, `npx tsc --noEmit` clean. No linter configured; no build step beyond `wrangler deploy`.
- [x] central behaviour has a check watched failing: `tests/sanitize.test.ts` run against `main`'s `src/db/queries.ts` (helper renamed to satisfy the import) fails 25 of 42, naming the defect: "record search survives comma injection, confirmed live as a whole-table read". Restored clean.
- [ ] no open critical or moderate shipped finding. Round 1's moderate is fixed in
  `0e45772`, but that fix is itself unreviewed. Round 2 decides.
- [x] no open regression
- [ ] every commit inside some round's range. `0e45772` and the ledger commit after it
  are outside every round so far. Round 2 range: `093ff80..HEAD`.

| Round | Reviewed sha | Range | Verdict | Findings |
|---|---|---|---|---|
| 1 | `093ff80` | `main...093ff80` | MERGE WITH FIXES | 1 shipped moderate, 1 gate minor, 1 gate note |
| 2 | pending | `093ff80..HEAD` | not yet run | |

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
