# Module loadouts

gstack can render a smaller or larger set of its instructions for a given model. Each toggleable piece is a **module** with an id. A **loadout** is a named set of modules, and `modules/loadouts.json` maps each model **rung** to a loadout. Every rung loads `full`, which is the same render gstack has always shipped. A loadout changes only when a preregistered eval measures a smaller one that matches `full` within its margin.

One model has its own loadout: Claude Opus 5.5 gets `lite` ([below](#lite-on-claude-opus-55)). Every other model, and any model gstack is not told about, gets `full`. `bin/gstack-modules render` also produces any loadout as a byte-exact tree with a lock file for evals.

## Terms

| Term | Meaning |
|---|---|
| Module | One of four kinds. `skill:<dir>` is a whole skill. `section:<skill>/<id>` is one entry of `<skill>/sections/manifest.json`. `overlay:<name>` is one `model-overlays/<name>.md`; excluding a base overlay also removes the base's text from every overlay that inherits it; the inheriting overlay's own text stays. `preamble:<id>` is one piece of the shared preamble (`PREAMBLE_PIECES` in `scripts/resolvers/preamble.ts`). |
| Pinned | A module no loadout can remove where `full` renders it: the start command, plan-mode rules, the question format, completion status, the unattended profile, /ship's review army and adversarial pass, the router and `/gstack-upgrade`. A skill's `preamble-tier` still applies, so a tier-1 skill has no question-format section in any loadout. |
| Rung | How much scaffolding a model gets: `frontier`, `strong`, `mid`, `light`, or `unknown`. Model ids are matched after lowercasing and stripping a `provider/` prefix (`anthropic/claude-haiku-5-5` is `mid`). Rungs are separate from the frontier/smart tiers in `lib/model-catalog.ts`, which choose which model runs a role. |
| Loadout | `{ base, exclude, include, preamble_tier_max, note }`. `full` (include `*`) is always present. An unknown model gets `default.unknown`, which is `full`. |
| Model map | `models` in `modules/loadouts.json`: an exact model id to a loadout, checked before rungs. The id also matches its dated snapshot (`-YYYYMMDD`) and `-latest`, never a point release or any other suffix (`claude-opus-5-5` matches `claude-opus-5-5-20261101`, not `claude-opus-5-50` or `claude-opus-5-5-1`). |

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

## Lite on Claude Opus 5.5

`lite` is `full` minus eleven coaching pieces of the shared preamble: voice, writing style, completeness, confusion, evidence, context health, question tuning, search before building, repo mode, brain health and context recovery. It keeps every pinned piece, the upgrade check (the PROACTIVE and skill-prefix rules) and brain sync (the privacy stop-gate). Only `claude-opus-5-5` maps to it, because only Opus 5.5 has been measured: office-hours showed no loss on Opus 5.5 (GSTA-161 preamble run), and the land-and-deploy confirmation (GSTA-161, PR 1b) compared full, lite and no gstack on the same tasks. Haiku 5.5 leaned slightly against a larger cut on the same office-hours run, so small models stay on `full`. Two skills point at a preamble section lite drops: office-hours and plan-ceo-review name ETHOS.md through the "Search Before Building" section, so under lite they find ETHOS.md in the gstack checkout instead.

### How gstack picks a loadout

gstack never guesses the model. It uses, in order:

1. An explicit loadout: `./setup --loadout <name>` on Claude Code, or `bin/gstack-modules install --loadout <name>`. It is served as asked and bound to no model.
2. An explicit model id: `--model <id>` on the Capy installer (`scripts/install.sh --model <id>`, which passes it to `bin/gstack-capy-install`), else `GSTACK_MODEL`.
3. Nothing: `full`.

A model id is lowercased, its `provider/` prefix and a trailing `[…]` are dropped, and it must then be a plain id (`^[a-z0-9][a-z0-9._-]{0,79}$`). An unmapped id serves `full`; an id that is not plain also serves `full` and prints `LOADOUT_INVALID_MODEL`. Nothing reads Claude Code settings or an inherited loadout variable, so a Sonnet subagent of an Opus session gets `full` unless its own install names Opus.

### Capy

The Capy skill passes the thread's model id: `bash scripts/install.sh --check --for <skill> --model <id>`. The installer prints two lines before the launch lines:

```
LOADOUT: lite model=claude-opus-5-5 source=model-flag digest=3f2a9c01d4e7 reused=yes
SKILL_ROOT: /home/user/.gstack/loadouts/lite-3f2a9c01d4e7
```

Read skills from `SKILL_ROOT` (`<root>/gstack/SKILL.md` routes, `<root>/<skill>/SKILL.md` runs) and source the printed `GSTACK_LAUNCH_FILE`, which adds `GSTACK_LOADOUT_SKILL_ROOT`. For `full`, `SKILL_ROOT` is `~/.claude/skills` and the launch file is the install verdict's own.

The lite tree is published by `bin/gstack-modules install` under `<state root>/loadouts/<loadout>-<digest12>/`, beside the full install; the checkout and its committed SKILL.md files stay the full render. The digest covers the selection, the bound model, the full root, host, overlay, plan mode and the source tree (the git HEAD tree plus any uncommitted change), so an upgrade or a different model gets a new folder and an unchanged one is reused after its files are re-hashed against `loadout.lock.json`. Each folder is a complete skill tree: the rendered SKILL.md and section files plus every tracked runtime asset of each skill (templates, references, scripts). A published folder is never replaced; the newest three per loadout are kept. Two Capy threads with different models on one machine share one install verdict and get one launch file each (`<verdict>.loadout-<name>-<digest>.env` for lite). Any failure serves `full` and prints `LOADOUT_FALLBACK`.

### The start line carries the model

A lite tree chosen for a model bakes that model and the full root into each skill's start command, so `gstack-skill-start` prints:

```
LOADOUT: lite model=claude-opus-5-5 full_root=/home/user/.claude/skills
LOADOUT_RULE: this file was rendered for claude-opus-5-5. If you are not running claude-opus-5-5, read /home/user/.claude/skills/qa/SKILL.md now and follow it instead of this file.
```

When `GSTACK_MODEL` is set to a different model, it adds `LOADOUT_MISMATCH`. A preamble already read cannot be unread, so the remedy is always to read the full file. An explicit loadout (`./setup --loadout lite`) carries no model and prints neither line.

### Claude Code

`./setup --loadout lite` saves `claude_loadout` and renders the Claude skills into the untracked render dir (`<state root>/render/claude`) through setup's own render, the same path a pinned overlay or `plan_mode_preamble=off` takes, so later upgrades and `gstack-config gbrain-refresh` keep it. `./setup --loadout full` returns to the committed files. A plain `./setup` never selects lite.

## Changing a loadout

Add or edit an entry under `loadouts` (and `models`, for a model-specific one) and cite the measurement (preregistration, margin, per-rung result) in its `note` and in the PR body. A model-specific loadout that wins a preregistered comparison is allowed even if it breaks the expected nesting (light ⊇ mid ⊇ strong). Committed SKILL.md files are always the `full` render, so the parity suite, the SKILL.md size guard, the size ledger and the catalog and context budgets keep measuring `full`.
