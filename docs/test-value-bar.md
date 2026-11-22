# Test value bar

gstack's test workflows share one rule: a test earns its place by protecting
behavior that a real regression would break. Test count is not a goal. The bar is
embedded in `/plan-eng-review`, `/review`, `/qa`, `/qa-only` and `/ship`, so every
new or changed test in a diff meets it without a separate step. `/test-audit`
applies the same bar to tests that already exist.

The source of truth is `scripts/resolvers/test-value.ts`. It was adapted from
OpenClaw's `test-audit` skill (openclaw/openclaw@a214e76,
`.agents/skills/test-audit/SKILL.md`), generalized to any test runner.

## Glossary

- **Authoring gate**: four questions every new or changed test must answer. What
  behavior, invariant or contract does it protect? What credible regression makes it
  fail? Why does existing coverage not already catch that? Does it need a production
  seam no production caller needs? A missing answer means extend an existing test or
  drop the proposal.
- **Value bar**: the authoring gate plus the rule that a test which breaks under a
  behavior-preserving refactor asserts implementation, unless its exact output is the
  declared contract (goldens, prompt bytes, wire formats).
- **Prompt-byte contract**: the machine-read tokens inside a prompt, nothing wider.
  A token qualifies when software consumes its exact bytes: a marker or sentinel
  line a parser, hook or grader matches; a field name or JSON shape a script reads;
  a command line, flag or environment variable the agent runs; an enum value or
  status word a caller branches on; a file path or placeholder another step opens;
  or an exact string a security boundary emits into model input. An English
  sentence is not a prompt-byte contract because the model reads it: rewording it
  must not break a test. Pin a sentence only when a recorded eval shows that exact
  wording changes behavior, and cite that eval next to the pin.
- **Sentence pin**: a test that asserts an English sentence or clause (40 or more
  characters of prose, or a prose regex) against SKILL.md, a `.tmpl` template or a
  section file. Convert it to a structural check (the section or heading is
  present, steps keep their order, the machine-read token is present in the right
  section), or delete it when a behavioral eval already covers the behavior and
  name that eval in the commit. Check safety lines on meaning (a case-insensitive
  keyword in the right section), never on capitalization or emphasis.
- **Retention bar**: keep a test that independently enforces a public API, protocol,
  config, migration, storage, security, platform, default, prompt-byte (as defined
  above), generated-output (SKILL.md golden), package, release or architecture
  contract; call order when order is observable; source inspection when it is the
  cheapest independent guard. Static or slow is not a reason to delete. Anything
  reachable from the package entrypoint is never retired.
- **Value card**: the gate's four answers as one line,
  `Value: protects=<...>; fails_when=<...>; why_new=<...>; seam=none`. Each field is
  at most 160 UTF-8 bytes in that line (clamped to 157 bytes plus `...`); JSON keeps
  full values and header comments wrap instead of truncating.
- **Retirement card**: the evidence a deletion needs, complete before any edit:
  `test`, `detects`, `non_test_callers`, `search_command`, `stronger_proof`,
  `history`, `unlocks`, `validation`.
- **Weak path**: a changed path whose only tests are weak: a ★ test (smoke,
  existence, trivial assertion), a new test that fails the gate, or a test written in
  this `/ship` run that the rating pass has not rated. Reasons:
  `star_one | gate_failed | unrated`.
- **X and Y**: X = paths with a ★★ or ★★★ test / total paths (value-weighted; the
  `/ship` gate uses X). Y = paths with any test / total paths. Total paths is the
  diff's codepath trace, capped at 30; zero paths skips the gate.
- **Base control**: running a new regression test against the base branch in a
  temporary worktree to prove the behavior existed and the test is valid.
- **Grep-only**: caller evidence from a text search. It cannot see re-exports,
  dynamic dispatch or generated code, so production code is never removed on grep
  evidence alone.

## Worked X/Y example

A diff touches 10 paths. Four have ★★ or ★★★ tests, three have only a ★ smoke test,
and three have no test.

- X = 4 / 10 = 40% value-weighted. The gate uses this number.
- Y = 7 / 10 = 70% including weakly covered paths.
- `gaps` = 3 (no test); `weak_gaps` = the 3 ★-only paths with reason `star_one`.

The PR body shows `Coverage: 40% value-weighted (70% including 3 weakly covered paths)`.

## Cards

A good value card:

```text
Value: protects=refundPayment rejects an empty reason; fails_when=the reason guard is removed or inverted; why_new=billing.test.ts covers processPayment only; seam=none
```

A rejected proposal:

```text
Rejected (covered_elsewhere): "checkout renders"; checkout.e2e.ts:15 covers it, so extend that test.
```

Rejection codes: `duplicate_protects`, `needs_seam`, `incomplete_card`,
`no_credible_regression`, `covered_elsewhere`, `implementation_coupled`.

## Header comments written by `/ship`

TypeScript:

```ts
// Generated by /ship coverage audit
// Value: protects=refundPayment rejects an empty reason;
//   fails_when=the reason guard is removed or inverted;
//   why_new=billing.test.ts covers processPayment only; seam=none
test('refundPayment rejects an empty reason', () => {
  expect(() => refundPayment('pay_1', '')).toThrow('Reason required');
});
```

Python:

```python
# Generated by /ship coverage audit
# Value: protects=refund rejects an empty reason;
#   fails_when=the reason guard is removed or inverted;
#   why_new=test_billing.py covers process_payment only; seam=none
def test_refund_rejects_empty_reason():
    with pytest.raises(ValueError, match="Reason required"):
        refund_payment("pay_1", "")
```

A file type with no known comment syntax gets its card in the PR body's Test value
details instead.

## Sample PR body block

```markdown
## Test Coverage
<coverage diagram>
Tests: 41 → 44 (+3 new)
Coverage: 58% value-weighted (81% including 4 weakly covered paths)
Test value: 3 tests written, 2 rejected by the authoring gate, 1 existing test extended, 4 paths weakly covered (weak = ★, gate-failing or unrated).
Regression proof — fails at HEAD: yes · passes at base: yes · passes after fix: yes
```

## Sample `/test-audit` report section

```markdown
### Owner: src/billing/refund.ts (1 candidate, production -12 LOC, test -40 LOC)

- test: test/refund-exports.test.ts "exports the refund helpers"
- detects: a renamed export, not a behavior change
- non_test_callers: 0 for `normalizeRefundReason` (grep-only)
- search_command: git grep -n -F -w -e 'normalizeRefundReason' -- . ':!test/' ...
- stronger_proof: test/refund.test.ts covers refund reasons through refundPayment
- history: added in a1b2c3d to keep the helper exported during a refactor
- unlocks: delete the test-only export `normalizeRefundReason`
- validation: bun test test/refund.test.ts; bunx tsc --noEmit
- verdict: retire

Retained: test/fixtures/golden/ship-SKILL.md check (generated-output contract).
Suppressed: test/legacy-api.test.ts (reason="public API snapshot for v1 clients").
```

## Overrides

Projects tune `/ship` in their CLAUDE.md `## Test Coverage` section. Every key is
optional; absent keys use the defaults.

```markdown
## Test Coverage
Minimum: 60%
Target: 80%
Generation cap: 5
Base control: auto
Base control budget: 90
Star rating: auto
```

- `Generation cap:` tests per generation pass (default 5; 2 passes max).
- `Base control:` `auto` runs regression tests at the base branch; `off` skips it.
- `Base control budget:` seconds per base-control run (default 90; 3 minutes total).
- `Star rating:` `off` makes the gate use `coverage_pct` (any test); weak paths are
  still listed.

A per-test pragma, in the file's comment syntax, makes `/review` and `/test-audit`
skip a deliberate test and report the reason:

```ts
// gstack:test-value keep reason="pins the v1 wire format for external clients"
```

## Messages

Each degraded-mode message names the problem, its consequence and the fix.

### rating-unavailable

`rating unavailable`: the read-only rating dispatch failed or timed out, so the
coverage gate is skipped for this run. Re-run Step 7 of `/ship` to re-rate the tests.

### value-weighted-coverage-unavailable

The coverage audit returned no usable `coverage_pct_value`, usually because the
installed skill is older than this change. The gate used `coverage_pct` (any test)
for this run. Run `/gstack-upgrade`.

### inconsistent-coverage-inputs

`coverage_pct_value` was above `coverage_pct`, which cannot happen when both are
computed from the same paths. It was clamped to `coverage_pct`. Re-run Step 7 if the
numbers look wrong.

### malformed-key-ignored

A Step 7 JSON key had the wrong type (for example `weak_gaps` not an array), so it
counts as empty. The likely cause is an outdated installed skill; run `/gstack-upgrade`.

### all-generated-tests-rejected

Every test written in a generation pass failed the machine checks (incomplete card,
duplicate `protects`, or a seam with no non-test caller). The rejected files were
removed and the gate proceeds with the unchanged value-weighted coverage. See
`tests_rejected` for each reason.

### base-control-unavailable

The regression test could not run at the base branch: `ecosystem` (not a Node/Bun
project), `no base remote`, `base not fetched`, `worktree add failed`, `budget`, or
`collection error` (the test could not load at base). The fails-at-HEAD result still
stands. To check by hand:

```bash
git worktree add --detach /tmp/base-check origin/<base>
cp <test> /tmp/base-check/<test>          # plus any new test-only fixtures
(cd /tmp/base-check && <test command for that file>)
git worktree remove --force /tmp/base-check
```

Then report `passes at base: manual`.

### caller-check-unavailable

The non-test caller search failed, or the symbol is not a plain identifier
(`unsupported symbol`). The finding stays INFORMATIONAL and nothing is proposed for
deletion. Run the search by hand to complete the evidence.

### unknown-test-value-bar-mode

A template used `{{TEST_VALUE_BAR:<mode>}}` with a mode other than
`plan|ship|qa|audit`. Fix the placeholder or add the mode in
`scripts/resolvers/test-value.ts`.
