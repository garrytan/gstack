# gstack — AI engineering judgment layer

GStack 2 exposes exactly six default public skills. Treat this as a routing
surface over preserved specialist judgment, not permission to simplify that
judgment into generic checklists.

## Public skills

| Skill | Primary responsibility |
|---|---|
| `/plan` | Product framing, CEO scope, engineering architecture, DX, autoplan, executable specs, and planning preferences. |
| `/design` | Design systems, alternatives, HTML/CSS, plan and live-interface review, and physical-iOS HIG review. |
| `/qa` | Report-only or fix-and-verify web QA, physical-iOS QA, DX journeys, performance, and canaries. |
| `/debug` | Root-cause investigation, physical-iOS fixes, and internal safety controls. |
| `/review` | Diff, security, repository-health, and independent outside-voice review. |
| `/ship` | PR preparation, landing/deployment, queue inspection, release docs, upgrade, and internal iOS release operations. |

`/plan` has exactly six top-level modes: **Discovery, Product, Engineering,
DX, Specification, and Full chain**. Planning preferences and other old names
are internal routing aliases, not additional top-level modes.

Each dispatcher must infer from product stage, surface, requested artifact,
mutation authority, evidence needs, and deployment state—not prompt keywords.
Before executing, state:

```text
Target:
Mode:
Depth:
Mutation:
Active modules:
Skipped modules:
Web context:
```

Then read every active file under `skills/<skill>/references/legacy/` in full.
Its question order, pressure, smart skips, STOP/approval gates, evidence,
artifacts, mutation boundary, exit behavior, and voice are binding. Preserve
report-only versus fix behavior. List skipped primary modules and why.

The exhaustive 55-command compatibility map is in
[`docs/gstack-2/SKILL-MIGRATION.md`](docs/gstack-2/SKILL-MIGRATION.md). Old
names are opt-in routing aliases and must print their replacement invocation;
they contain no copied judgment. Representative mappings:

| Old invocation | GStack 2 replacement |
|---|---|
| `/office-hours` | `/plan --mode product` |
| `/plan-ceo-review` | `/plan --mode ceo` |
| `/plan-eng-review` | `/plan --mode eng` |
| `/design-consultation` | `/design --mode consult` |
| `/design-review` | `/design --mode live-review` |
| `/qa-only` | `/qa --mode report` |
| `/investigate` | `/debug --mode investigate` |
| `/cso` | `/review --mode security` |
| `/land-and-deploy` | `/ship --mode land` |

## Installation and capabilities

Canonical installation is standards-based:

```bash
npx skills add time-attack/gstack
```

Delegate host detection, placement, project/global scope, selected-skill
installation, updates, and removal to the Agent Skills installer. Never
silently enroll a host. Pure judgment works without the optional runtime.

The browser is the existing local Chromium/Playwright implementation. Do not
add a cloud browser or remote browser provider. Physical iOS uses only the
existing DebugBridge/CoreDevice harness; do not add an alternate device
backend. PDF and Mermaid/Excalidraw remain internal. Do not install ComfyUI,
local model weights, checkpoints, or GPU runtimes.

Context.dev is the only new external service and only for public web context.
It is off until explicit consent. Never send authenticated/private pages,
localhost, intranet/private URLs, cookies, tokens, repository content, or user
files. When unavailable, use an explicitly selected host-native public search,
the local browser, or continue without research and label the result unverified.
Persist that choice with `gstack context select host|local-browser|none`;
`gstack context options` prints the four-choice UX without granting consent.

## Build and verification

```bash
bun install
bun run gen:gstack2       # regenerate six dispatchers, preserved modules, parity fixtures
bun run test:gstack2      # GStack 2 routing, provenance, parity, runtime, privacy, upgrade
bun test                  # full free suite, including design + iOS daemon tests
bun run test:windows      # curated Windows-safe subset
bun run build
bun run skill:check
```

Legacy `SKILL.md` files outside `skills/` are generated from `.tmpl` templates;
edit the template, not its output. GStack 2 generated sources are identified by
their header; edit `scripts/gstack2/` inputs and regenerate instead.

## Contribution boundaries

- A new public command, external service, or first-party host adapter requires
  an accepted issue; an external service also requires maintainer approval.
- Contributions must improve judgment/evidence, remove surface, fix a linked
  reproduction, or repair infrastructure.
- New public nouns are a last resort. Prefer a mode, internal utility, or
  community extension.
- Do not mutate GitHub labels/templates merely because their design is present
  in this repository.
- State resolves through the host-neutral runtime under `$GSTACK_HOME` or
  `~/.gstack`; do not invent host-specific state roots or shell-evaluated path
  assignments.
- Never claim GStack 2 is done without the evidence in
  [`docs/gstack-2/STATUS.md`](docs/gstack-2/STATUS.md).

## Platform contract

Portable means the canonical skill tree follows the Agent Skills specification.
Verified must name its layer. The six-host project/global/selection/removal
matrix is **Verified — installer**; host UI/process execution is still pending.
Native means a necessary host API is covered while consuming the same canonical
judgment. These labels require evidence; see
[`docs/gstack-2/HOST-COMPATIBILITY.md`](docs/gstack-2/HOST-COMPATIBILITY.md).
