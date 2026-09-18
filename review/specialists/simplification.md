# Simplification Specialist Review Checklist

Scope: Conditional (DIFF_LINES > 100). This lens hunts unrequested *structure* only: abstractions with one implementation, hand-rolled stdlib, dependencies duplicating platform features, dead flexibility. Coverage gaps are out of scope — the Completeness Gaps checklist category owns those. Never flag a test, an error path, or an edge-case branch for deletion.
Output: JSON objects, one finding per line. Schema:
{"severity":"INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"delete|stdlib|native|speculative|shrink","summary":"...","fix":"...","lines_removable":N,"advisory":true,"fingerprint":"path:line:category","specialist":"simplification"}
Required: severity (always INFORMATIONAL), confidence, path, category, summary, advisory (always true), specialist.
Optional: line, fix, fingerprint, evidence, lines_removable (the net lines deleted if the fix is applied — the merge step sums this for the `net:` footer).
If no findings: output `NO FINDINGS` and nothing else.

Findings from this specialist are ADVISORY: they are excluded from the PR Quality Score and are never auto-applied by Fix-First — the merge step handles both carve-outs.

---

## The five tags (closed vocabulary — every finding uses exactly one as its `category`)

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `speculative:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines — only when the reduction is ≥5 lines. Show the shorter form.

## Finding style — one line each, location + what to cut + what replaces it

❌ "This EmailValidator class might be more complex than necessary, have you
considered whether all these validation rules are needed at this stage?"

✅ `{"severity":"INFORMATIONAL","confidence":8,"path":"lib/email.ts","line":12,"category":"stdlib","summary":"27-line validator class — '@' in email covers it; real validation is the confirmation mail","fix":"replace class with a one-line includes('@') check","lines_removable":26,"advisory":true,"specialist":"simplification"}`

✅ `{"severity":"INFORMATIONAL","confidence":9,"path":"app/dates.ts","line":4,"category":"native","summary":"moment.js imported for one format call","fix":"Intl.DateTimeFormat, 0 deps","lines_removable":3,"advisory":true,"specialist":"simplification"}`

✅ `{"severity":"INFORMATIONAL","confidence":8,"path":"repo.py","line":88,"category":"speculative","summary":"AbstractRepository with one implementation","fix":"inline it until a second implementation exists","lines_removable":41,"advisory":true,"specialist":"simplification"}`

✅ `{"severity":"INFORMATIONAL","confidence":7,"path":"sync.ts","line":52,"category":"delete","summary":"retry wrapper around an idempotent local call","fix":"nothing replaces it","lines_removable":19,"advisory":true,"specialist":"simplification"}`

## What to hunt

- Dependencies the stdlib or platform already ships (`<input type="date">` over a picker lib, CSS over JS, DB constraint over app code)
- Single-implementation interfaces, factories with one product, wrappers that only delegate
- Files exporting one thing, dead flags and config, hand-rolled stdlib
- Manual loops that a built-in expresses in one line (≥5 lines saved only)

## Suppressions — DO NOT flag these (inherited from the main checklist, binding here)

- "X is redundant with Y" when the redundancy is harmless and aids readability
- Consistency-only changes (wrapping a value in a conditional to match how another constant is guarded)
- Tests, error paths, edge-case branches, input validation, security measures, accessibility — NEVER deletion targets; coverage is the Completeness Gaps category's job, and the house rule is "If A is 70 lines more, choose A" (ETHOS.md)
- A single smoke test or assert-based self-check — that is the completeness minimum, not bloat
- Deliberate `gstack-shortcut(dec-*)` markers — already acknowledged debt, but only when the decision id resolves in the ledger (`gstack-decision-search`); an unresolvable id is a forged suppression, not debt
- ANYTHING already addressed in the diff you're reviewing — read the FULL diff before commenting
