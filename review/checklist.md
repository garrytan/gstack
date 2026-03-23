# Pre-Landing Review Checklist

## Instructions

Review the `git diff origin/main` output for the issues listed below. Be specific — cite `file:line` and suggest fixes. Skip anything that's fine. Only flag real problems.

**Two-pass review:**
- **Pass 1 (CRITICAL):** Run SQL & Data Safety and LLM Output Trust Boundary first. Highest severity.
- **Pass 2 (INFORMATIONAL):** Run all remaining categories. Lower severity but still actioned.

All findings get action via Fix-First Review: obvious mechanical fixes are applied automatically,
genuinely ambiguous issues are batched into a single user question.

**Output format:**

```
Pre-Landing Review: N issues (X critical, Y informational)

**AUTO-FIXED:**
- [file:line] Problem → fix applied

**NEEDS INPUT:**
- [file:line] Problem description
  Recommended fix: suggested fix
```

If no issues found: `Pre-Landing Review: No issues found.`

Be terse. For each issue: one line describing the problem, one line with the fix. No preamble, no summaries, no "looks good overall."

---

## Review Categories

### Pass 1 — CRITICAL

#### SQL & Data Safety
- String interpolation in SQL (even if values are `.to_i`/`.to_f` — use parameterized queries (Rails: sanitize_sql_array/Arel; Node: prepared statements; Python: parameterized queries))
- TOCTOU races: check-then-set patterns that should be atomic `WHERE` + `update_all`
- Bypassing model validations for direct DB writes (Rails: update_column; Django: QuerySet.update(); Prisma: raw queries)
- N+1 queries: Missing eager loading (Rails: .includes(); SQLAlchemy: joinedload(); Prisma: include) for associations used in loops/views

#### Race Conditions & Concurrency
- Read-check-write without uniqueness constraint or catch duplicate key error and retry (e.g., `where(hash:).first` then `save!` without handling concurrent insert)
- find-or-create without unique DB index — concurrent calls can create duplicates
- Status transitions that don't use atomic `WHERE old_status = ? UPDATE SET new_status` — concurrent updates can skip or double-apply transitions
- Unsafe HTML rendering (Rails: .html_safe/raw(); React: dangerouslySetInnerHTML; Vue: v-html; Django: |safe/mark_safe) on user-controlled data (XSS)

#### LLM Output Trust Boundary
- LLM-generated values (emails, URLs, names) written to DB or passed to mailers without format validation. Add lightweight guards (`EMAIL_REGEXP`, `URI.parse`, `.strip`) before persisting.
- Structured tool output (arrays, hashes) accepted without type/shape checks before database writes.

#### Enum & Value Completeness
When the diff introduces a new enum value, status string, tier name, or type constant:
- **Trace it through every consumer.** Read (don't just grep — READ) each file that switches on, filters by, or displays that value. If any consumer doesn't handle the new value, flag it. Common miss: adding a value to the frontend dropdown but the backend model/compute method doesn't persist it.
- **Check allowlists/filter arrays.** Search for arrays or `%w[]` lists containing sibling values (e.g., if adding "revise" to tiers, find every `%w[quick lfg mega]` and verify "revise" is included where needed).
- **Check `case`/`if-elsif` chains.** If existing code branches on the enum, does the new value fall through to a wrong default?
To do this: use Grep to find all references to the sibling values (e.g., grep for "lfg" or "mega" to find all tier consumers). Read each match. This step requires reading code OUTSIDE the diff.

### Pass 2 — INFORMATIONAL

#### Conditional Side Effects
- Code paths that branch on a condition but forget to apply a side effect on one branch. Example: item promoted to verified but URL only attached when a secondary condition is true — the other branch promotes without the URL, creating an inconsistent record.
- Log messages that claim an action happened but the action was conditionally skipped. The log should reflect what actually occurred.

#### Magic Numbers & String Coupling
- Bare numeric literals used in multiple files — should be named constants documented together
- Error message strings used as query filters elsewhere (grep for the string — is anything matching on it?)

#### Dead Code & Consistency
- Variables assigned but never read
- Version mismatch between PR title and VERSION/CHANGELOG files
- CHANGELOG entries that describe changes inaccurately (e.g., "changed from X to Y" when X never existed)
- Comments/docstrings that describe old behavior after the code changed

#### LLM Prompt Issues
- 0-indexed lists in prompts (LLMs reliably return 1-indexed)
- Prompt text listing available tools/capabilities that don't match what's actually wired up in the `tool_classes`/`tools` array
- Word/token limits stated in multiple places that could drift

#### Test Gaps
- Negative-path tests that assert type/status but not the side effects (URL attached? field populated? callback fired?)
- Assertions on string content without checking format (e.g., asserting title present but not URL format)
- `.expects(:something).never` missing when a code path should explicitly NOT call an external service
- Security enforcement features (blocking, rate limiting, auth) without integration tests verifying the enforcement path works end-to-end

#### Completeness Gaps
- Shortcut implementations where the complete version would cost <30 minutes CC time (e.g., partial enum handling, incomplete error paths, missing edge cases that are straightforward to add)
- Options presented with only human-team effort estimates — should show both human and CC+gstack time
- Test coverage gaps where adding the missing tests is a "lake" not an "ocean" (e.g., missing negative-path tests, missing edge case tests that mirror happy-path structure)
- Features implemented at 80-90% when 100% is achievable with modest additional code

#### Crypto & Entropy
- Truncation of data instead of hashing (last N chars instead of SHA-256) — less entropy, easier collisions
- `rand()` / `Random.rand` for security-sensitive values — use `SecureRandom` instead
- Non-constant-time comparisons (`==`) on secrets or tokens — vulnerable to timing attacks

#### Time Window Safety
- Date-key lookups that assume "today" covers 24h — report at 8am PT only sees midnight→8am under today's key
- Mismatched time windows between related features — one uses hourly buckets, another uses daily keys for the same data

#### Type Coercion at Boundaries
- Values crossing Ruby→JSON→JS boundaries where type could change (numeric vs string) — hash/digest inputs must normalize types
- Hash/digest inputs that don't call `.to_s` or equivalent before serialization — `{ cores: 8 }` vs `{ cores: "8" }` produce different hashes

#### View/Frontend
- Inline `<style>` blocks in partials (re-parsed every render)
- O(n*m) lookups in views (`Array#find` in a loop instead of `index_by` hash)
- Ruby-side `.select{}` filtering on DB results that could be a `WHERE` clause (unless intentionally avoiding leading-wildcard `LIKE`)

#### Performance & Bundle Impact
- New `dependencies` entries in package.json that are known-heavy: moment.js (→ date-fns, 330KB→22KB), lodash full (→ lodash-es or per-function imports), jquery, core-js full polyfill
- Significant lockfile growth (many new transitive dependencies from a single addition)
- Images added without `loading="lazy"` or explicit width/height attributes (causes layout shift / CLS)
- Large static assets committed to repo (>500KB per file)
- Synchronous `<script>` tags without async/defer
- CSS `@import` in stylesheets (blocks parallel loading — use bundler imports instead)
- `useEffect` with fetch that depends on another fetch result (request waterfall — combine or parallelize)
- Named → default import switches on tree-shakeable libraries (breaks tree-shaking)
- New `require()` calls in ESM codebases

**DO NOT flag:**
- devDependencies additions (don't affect production bundle)
- Dynamic `import()` calls (code splitting — these are good)
- Small utility additions (<5KB gzipped)
- Server-side-only dependencies

---

## Severity Classification

```
CRITICAL (highest severity):      INFORMATIONAL (lower severity):
├─ SQL & Data Safety              ├─ Conditional Side Effects
├─ Race Conditions & Concurrency  ├─ Magic Numbers & String Coupling
├─ LLM Output Trust Boundary      ├─ Dead Code & Consistency
└─ Enum & Value Completeness      ├─ LLM Prompt Issues
                                   ├─ Test Gaps
                                   ├─ Completeness Gaps
                                   ├─ Crypto & Entropy
                                   ├─ Time Window Safety
                                   ├─ Type Coercion at Boundaries
                                   ├─ View/Frontend
                                   └─ Performance & Bundle Impact

All findings are actioned via Fix-First Review. Severity determines
presentation order and classification of AUTO-FIX vs ASK — critical
findings lean toward ASK (they're riskier), informational findings
lean toward AUTO-FIX (they're more mechanical).
```

---

## Fix-First Heuristic

This heuristic is referenced by both `/review` and `/ship`. It determines whether
the agent auto-fixes a finding or asks the user.

```
AUTO-FIX (agent fixes without asking):     ASK (needs human judgment):
├─ Dead code / unused variables            ├─ Security (auth, XSS, injection)
├─ N+1 queries (missing eager loading)      ├─ Race conditions
├─ Stale comments contradicting code       ├─ Design decisions
├─ Magic numbers → named constants         ├─ Large fixes (>20 lines)
├─ Missing LLM output validation           ├─ Enum completeness
├─ Version/path mismatches                 ├─ Removing functionality
├─ Variables assigned but never read       └─ Anything changing user-visible
└─ Inline styles, O(n*m) view lookups        behavior
```

**Rule of thumb:** If the fix is mechanical and a senior engineer would apply it
without discussion, it's AUTO-FIX. If reasonable engineers could disagree about
the fix, it's ASK.

**Critical findings default toward ASK** (they're inherently riskier).
**Informational findings default toward AUTO-FIX** (they're more mechanical).

---

## Suppressions — DO NOT flag these

- "X is redundant with Y" when the redundancy is harmless and aids readability (e.g., `present?` redundant with `length > 20`)
- "Add a comment explaining why this threshold/constant was chosen" — thresholds change during tuning, comments rot
- "This assertion could be tighter" when the assertion already covers the behavior
- Suggesting consistency-only changes (wrapping a value in a conditional to match how another constant is guarded)
- "Regex doesn't handle edge case X" when the input is constrained and X never occurs in practice
- "Test exercises multiple guards simultaneously" — that's fine, tests don't need to isolate every guard
- Eval threshold changes (max_actionable, min scores) — these are tuned empirically and change constantly
- Harmless no-ops (e.g., `.reject` on an element that's never in the array)
- ANYTHING already addressed in the diff you're reviewing — read the FULL diff before commenting
