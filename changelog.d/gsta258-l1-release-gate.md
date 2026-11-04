---
bump: minor
---
**A release gate can now gate main every 8 hours instead of on every push, and it feeds the stable release.** It is off until main's `.gstack/ship-policy.json` declares a `release_gate` block, so this release changes nothing on its own. With the block, `.github/workflows/release-gate.yml` runs `gstack-release-gate run` every 8 hours. When main moved since the last gate, it runs the full paid gate on main's head once, records the verdict as a `release` note in `refs/notes/gstack-trains`, and publishes the `main-backstop` check run on that commit. A red gate bisects its red cases within `bisect_spend_cap_usd` and names the first bad commit. The per-push main backstop stands down while the block is set, so main is never gated twice. `scripts/release-cut.ts` is still the only thing that moves `stable`, and its 72-hour floor and exceptions are unchanged. It now reads a green release record as proof the commit was gated, and it refuses every cut while the newest release gate is red with no green gate on a later commit. That hold is the freeze. See docs/ship-policy.md#release-gate.

### Added
- **`release_gate` policy key** (`lib/release-gate-policy.ts`, which needs `min_gstack_version` at this release): `cadence_hours` (8 to 168), `gate_workflow`, `branch`, `stable_ref`, `check_name`, `on_red: hold-release` and `bisect_spend_cap_usd`, every field required.
- **`bin/gstack-release-gate`** (`lib/release-gate.ts`): `run [--dry-run] [--sha] [--ignore-cadence]`, `status` and `bisect`. `--policy <file>` reads the block from a file, for a dry run or a proof before adoption. Exit 0 means gated, skipped, inert or a dry run; 1 means held, failed or a refused policy; 2 is a usage error.
- **`.github/workflows/release-gate.yml`**: an 8-hour schedule and a manual dispatch. The check run comes from a separate job that holds `checks: write` and runs no repository code.
- **Capy skill installer follows the update channel** (`capy/skill/gstack/scripts/install.sh`, wrapper revision 4). With `GSTACK_UPDATE_CHANNEL=stable` or a stable `update_channel`, a fresh clone or a floor upgrade goes to `stable` when it meets the support floor, and to main otherwise. `--revision` still wins.

### Changed
- **`evals-main-backstop.yml`** stands down (no gate, no freeze, no check run) when main's policy declares `release_gate`.
- **`evals.yml`** routes a release gate bisect (`release-gate/<id>` refs) only under a `release_gate` block at the base revision, and that bisect publishes its prefix records as `gstack-release-record`.

### Tests
- `test/release-gate.test.ts` drives run, bisect and status against a fake `gh` and a scratch remote. `test/release-gate-workflow.test.ts` runs the workflows' policy steps on scratch repositories and pins the cron to the cadence floor. `test/release-cut.test.ts` proves a red release record refuses the cut and a green one on a later commit releases it. `test/train-gate.test.ts` covers the bisect route, and `test/capy-skill-wrapper.test.ts` covers the stable channel and its fallback to main.
