# Module loadouts

gstack can render a smaller or larger set of its instructions for a given model. Each toggleable piece is a **module** with an id. A **loadout** is a named set of modules, and `modules/loadouts.json` maps each model **rung** to a loadout. Today every rung loads `full`, which is the same render gstack has always shipped. A loadout changes only when the shared skill eval (GSTA-2) measures a smaller one that matches `full` within its preregistered margin.

Install-time model detection, which picks a loadout for the model you run, ships with the first loadout that is not `full`. Until then, loadouts are an eval tool: `bin/gstack-modules render` produces any loadout as a byte-exact tree with a lock file.

## Terms

| Term | Meaning |
|---|---|
| Module | One of four kinds. `skill:<dir>` is a whole skill. `section:<skill>/<id>` is one entry of `<skill>/sections/manifest.json`. `overlay:<name>` is one `model-overlays/<name>.md`; excluding a base overlay also removes the base's text from every overlay that inherits it; the inheriting overlay's own text stays. `preamble:<id>` is one piece of the shared preamble (`PREAMBLE_PIECES` in `scripts/resolvers/preamble.ts`). |
| Pinned | A module no loadout can remove where `full` renders it: the start command, plan-mode rules, the question format, completion status, the unattended profile, /ship's review army and adversarial pass, the router and `/gstack-upgrade`. A skill's `preamble-tier` still applies, so a tier-1 skill has no question-format section in any loadout. |
| Rung | How much scaffolding a model gets: `frontier`, `strong`, `mid`, `light`, or `unknown`. Model ids are matched after lowercasing and stripping a `provider/` prefix (`anthropic/claude-haiku-5-5` is `mid`). Rungs are separate from the frontier/smart tiers in `lib/model-catalog.ts`, which choose which model runs a role. |
| Loadout | `{ base, exclude, include, preamble_tier_max, note }`. `full` (include `*`) is always present. An unknown model gets `default.unknown`, which is `full`. |

## Commands

```bash
bin/gstack-modules list [--json] [--pinned]   # every module id, kind, source, pin, source bytes and sha256
bin/gstack-modules validate                   # check modules/loadouts.json against the catalog
bin/gstack-modules render --host claude --loadout full --out-dir ~/arms/control
bin/gstack-modules render --host claude \
  --modules 'full,-section:office-hours/second-opinion,-section:office-hours/visual-design' \
  --out-dir ~/arms/oh-lean
```

`render` writes the whole host tree into a staging directory beside `--out-dir`. It checks that no rendered file still points at an excluded module, writes `loadout.lock.json` last (loadout name or `adhoc`, the normalized spec and its sha256, host, model, every excluded id, and the sha256 and byte count of every file), then swaps the result into place. A failure leaves an earlier render at `--out-dir` untouched. Claude section links name `--out-dir`, so point the eval harness at that directory. Pass the same `--model`, `--install-root` and `--plan-mode` the install under test uses, so the arms differ only by the modules. Codex renders default to the host's generic `gpt` overlay, while `./setup` uses `gpt-6-astra`.

`bun run gen:skill-docs --loadout <name> --out-dir <dir>` and `--modules <spec> --out-dir <dir>` apply the same filter to a generation run without the staging, dangling-reference check or lock file; a selection with exclusions and no `--out-dir` is refused with `MODULE_SPEC_INVALID`, because the committed tree is always the `full` render. A non-`full` render adds `<!-- loadout: <name> -->` to each SKILL.md header.

## Building an eval arm

1. Render the control with `--loadout full` and each arm with `--modules full,-<id>,…`. Every refusal names its code and fix ([troubleshooting](troubleshooting.md#module-loadouts-gstack-modules)).
2. Preregister the lock files' `spec_sha256` and per-file sha256 values with the eval.
3. Excluding a section removes its STOP pointer, its Section-index row and its file. The step becomes `> Not loaded in the <loadout> loadout: skip <trigger>. Do not offer it, and treat it as not run.` Skeleton text that belongs to the section, such as office-hours' Phase 3.5 offer, sits inside `{{IF_SECTION:<id>}}…{{/IF_SECTION}}` in the template and goes with it.
4. The autoplan runner (`gstack-autoplan`) reads review methodology from the source tree, not from a rendered loadout, so autoplan-runner arms always measure `full` methodology.

## Changing a loadout

Add or edit an entry under `loadouts` and cite the GSTA-2 run (preregistration, margin, per-rung result) in its `note` and in the PR body. A model-specific loadout that wins a preregistered comparison is allowed even if it breaks the expected nesting (light ⊇ mid ⊇ strong). Committed SKILL.md files are always the `full` render, so the parity suite, the SKILL.md size guard, the size ledger and the catalog and context budgets keep measuring `full`.
