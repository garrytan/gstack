**gstack now lints its own JavaScript and TypeScript files with oxlint, held to a ratchet (GSTA-203 PR 4).** CI had no JS/TS linter, and the one real error oxlint found (a second `import * as os` in `browse/test/commands.test.ts`) slipped past the product typecheck. `bun run lint` runs oxlint's correctness rules in well under a second and fails only on findings that are new; the 971 existing ones are recorded in a baseline that can only shrink.

### Added
- **`bun run lint`** (`scripts/lint-ratchet.ts`, `.oxlintrc.json`, `scripts/lint-baseline.json`): oxlint 1.90.0, pinned exactly, with its correctness rules over the repository, skipping `design-html/vendor` and `test/fixtures`. oxlint picks files by extension, so the extensionless Bun scripts in `bin/` are not linted yet. Findings are keyed by file, rule and message, not line, so moving code does not churn the baseline. Each failure prints a stable code: `LINT_RATCHET_NEW` (file:line, rule, "Fix them; do not add them to the baseline" and a reproduce command), `LINT_RATCHET_FIXED` (run `--write-baseline`, which only shrinks), `LINT_BASELINE_INVALID` (an unreadable or malformed baseline, or one written by another oxlint version; never rewritten on its own), `OXLINT_MISSING` (run `bun install`) and `OXLINT_CRASH` (with the oxlint version and config path). After an oxlint bump, `bun run lint --write-baseline --oxlint-upgrade` rebuilds the baseline in the same change.
- **A lint step in the required `free-tests` check**, inside the existing typecheck job.

### Changed
- **`browse/test/commands.test.ts`**: the duplicate `import * as os` is gone; the test asserts the same things. `scripts/typecheck-test-baseline.json` drops the matching TS2300 entry.
- **Dependabot skips oxlint**, because a bump needs the baseline rebuilt by a maintainer.
- **`lib/run-evidence.ts`**: `NAME`'s character class drops a needless `\/` escape that landed on main before the ratchet (the same strings match).
- **`lib/gate-diff/classify.ts`**: `.oxlintrc*` and `oxlint.config*` count as lint configuration, so /review lists an edit to them as a gate edit.
- **`docs/ship-policy.md`** (A lint finding that appears only in the train): when a stamp commit's lint step reports `LINT_RATCHET_NEW`, the slot owner fixes the finding on the PR branch as a new pin and the train is rebuilt, or the controller drops that slot. The baseline never grows.
