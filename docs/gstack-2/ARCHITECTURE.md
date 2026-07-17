# GStack 2 architecture

Status: implemented in the candidate branch, with release evidence still
pending. This document describes the candidate; it is not a 2.0 release claim.
The authoritative gate state is [STATUS.md](./STATUS.md).

## Product boundary

GStack 2 is an engineering judgment layer with exactly six public skills:

```text
plan -> design -> qa -> debug -> review -> ship
```

This is a navigation surface, not a linear workflow and not a compression of
specialists into generic prompts. Each dispatcher selects a mode from
structured stage, surface, artifact, mutation-authority, evidence, and deploy
signals. It prints the target, mode, depth, mutation boundary, active modules,
skipped modules, and web-context choice before work. It then loads only the
selected preserved module.

The canonical tree is:

```text
skills/
  plan|design|qa|debug|review|ship/
    SKILL.md                    thin dispatcher
    agents/openai.yaml          optional host presentation metadata
    references/
      legacy/*.md               lazily loaded preserved specialists
      ASSETS.md                 relocated-asset index
      COMPATIBILITY.md          old-name routes within this tree
    assets/                     copied assets with pinned blob evidence
compat/*.md                     internal aliases, never default skills
evals/parity/                   contracts, scenarios, regressions, manifest
```

`scripts/gstack2/generate-skill-tree.ts` mechanically renders 55 pinned legacy
modules, inlines 16 carved sections, and carries 78 assets. The generator
records source Git blob IDs and normalized render hashes. It adds only reviewed
upstream bug-fix overlays, each with a PR link, stable anchor, and regression fixture. The parity
runner checks nine behavioral dimensions: question order, pressure, smart
skips, STOP/approval gates, evidence, artifacts, mutation, exit behavior, and
voice.

The public dispatcher cannot substitute for its selected module. Its
completeness invariant explicitly requires reading that module in full. See
[JUDGMENT-PROVENANCE.json](./JUDGMENT-PROVENANCE.json),
[JUDGMENT-PARITY.md](./JUDGMENT-PARITY.md), and
[SKILL-MIGRATION.md](./SKILL-MIGRATION.md).

The reproducible semantic layer adds 295 checks across 14 suites, 15
executions, 15 dimensions, 16 sections, and nine authority-policy unit cases.
Exact source preservation remains the primary oracle. These are deterministic
policy checks, not behavioral-adversarial proof. Paid live-model comparisons
are supplemental; the currently retained semantic samples are regressions and
do not support a release-pass claim.

The separate installed-host adversarial lane also has no passing live result:
v1 failed; immutable v2 failed despite QA passing because its classifier
produced false negatives for debug, review, and ship; and v3 has 18 pass / 0
fail / 111 assertions offline but has not run live and has no artifact. See the
[installed-host evidence overview](../../evals/host-adversarial/README.md).

## Specialist modes

The primary modes are summarized here; internal compatibility modes are in the
migration map.

| Skill | Public top-level modes and preserved refinements |
|---|---|
| `/plan` | exactly **Discovery, Product, Engineering, DX, Specification, Full chain**, refined to office-hours, CEO, engineering, DX, spec, or autoplan judgment |
| `/design` | **Explore, Generate, Critique, Implement**, refined to consultation, alternatives, HTML/CSS, plan/live review, physical-iOS HIG, diagram, or PDF |
| `/qa` | **Report** or **Fix**, refined by web, physical-iOS, DX, performance, or canary surface |
| `/debug` | **Diagnose-only** or **Fix**, refined to general investigation or the physical-iOS fix loop |
| `/review` | **Normal, Security, Performance, Deep**, with health and genuinely independent outside voices selected only when applicable |
| `/ship` | **Prepare, Land, Deploy, Monitor, Resume**, refined to PR, queue, docs, deploy setup, land/deploy, canary, or context restoration modules |

Old commands are opt-in aliases for the compatibility window. An alias points
to one exact module, prints the replacement invocation, and carries no copied
judgment. This prevents an alias from drifting away from the canonical source.

## Installation boundary

The standard Agent Skills tree is the unit of distribution:

```bash
npx skills add time-attack/gstack
```

The installer—not GStack—owns host detection, project/global scope, destination
paths, selected-skill installation, copies versus symlinks, updates, and
removal. GStack does not silently enroll a detected host. The former
host-placement behavior of `./setup` and ten-host generated trees is historical
compatibility/development machinery, not the 2.0 installation architecture;
the current `./setup` installs only the optional runtime described below.

The standards installer matrix passed 470/470 checks with CLI 1.5.19. It
verified project/global copies for Claude Code, Codex, Cursor, Pi, OpenClaw, and
GitHub Copilot plus selected-skill and opt-in compatibility-alias cases,
removal, spaces, source symlink, copy mode, and canonical hashes across 16
installs and two removals. The committed artifact is
[`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json).
This is installer-layer verification; it is Markdown-only placement and does
not prove a passing live installed-host judgment run.

Pure judgment is Markdown and works when the optional runtime is absent. A
capability-dependent module performs one runtime check and must degrade with an
actionable setup choice rather than make the six skills undiscoverable.

## Optional host-neutral runtime

`bin/gstack` calls a Node-built-ins runtime under `runtime/`. It does not own
skill placement and is installed once per user, not once per host. The
host-neutral `./setup` wrapper installs only this runtime/capability bundle. It
stages an explicit allowlist, rejects internal symlinks/path escapes,
hash-validates files, smoke-tests the CLI, atomically activates the version,
and writes stable POSIX/Windows launchers plus an uninstall manifest under
`$GSTACK_HOME`. Runtime capability builds use a dedicated target that does not
regenerate skills or require repository history; Windows targets use `.exe`
suffixes and Darwin-only iOS artifacts are omitted elsewhere. Its public
operations are setup, doctor, config, state
inspection/resume, Context.dev status/options/select/setup/smoke, cleanup,
upgrade/rollback, and uninstall.

The deterministic clean macOS arm64 managed-bundle audit records 110
components, 1,829 files, 450,044,315 bytes, and 50 capability launchers. This
is a platform-specific bundle measurement, not a universal byte count;
platform-native package payloads differ. Setup installs frozen production-only
dependencies; the development-only Claude Agent SDK is excluded. The
Sharp/ngrok dependency closure is included. The Hugging Face sidecar is
excluded and its package is development-only, so setup installs neither its
inference runtime nor model weights and reports the L4 capability unavailable.

A clean Linux arm64 runtime smoke installed only production dependencies with
the development SDK absent, completed a local-browser journey and Sharp
full-page screenshot, and uninstalled while preserving state. This is Linux
container evidence, not native Windows evidence.

The authoritative root is `$GSTACK_HOME` or `~/.gstack`; host-specific variables
do not redirect it. Paths are passed as values and never emitted for shell
evaluation. The state shape is human-readable:

```text
~/.gstack/
  config.json
  secrets.json                       mode 0600 where supported
  migration.json
  locks/
  tmp/
  versions/current.json
  projects/<repo+worktree-id>/
    state.json
    timeline.jsonl
    decisions.jsonl
    evidence/
    artifacts/
    reviews/
    checkpoints/
```

Repository identity is shared across linked worktrees; worktree identity is
stable and distinct. Their combination selects project state, preventing one
worktree from resuming another's run. Updates use atomic replace plus lock
leases. External actions are durably claimed before execution. A process death
after a claim marks the action uncertain on resume and refuses automatic
repetition until explicitly reconciled.

Migrations are forward-only and idempotent. Runtime upgrades copy into a staged
version, verify, switch an atomic pointer, and retain the last known good
version. A failed health check or interrupted pending pointer restores the
previous active version. This is bounded release plumbing, not a distributed
workflow engine.

## Context.dev boundary

Context.dev is the only new external service and handles only public web
content. `network.mode` and `network.consent` both start off. The client checks
both before DNS or fetch. It rejects credentials in URLs, localhost, local and
private names, private/link-local IP literals, cloud-metadata targets, and a
public hostname that resolves to a private address.

Supported candidate operations use the documented scrape-Markdown,
scrape-HTML, crawl, sitemap, and screenshot endpoints. The current general
search endpoint is deprecated, so `search()` returns a typed unsupported error
without a network request. A workflow must instead use an explicitly selected
host-native public search, the local browser, or no web research and label the
result unverified. It must not invent a replacement API.

`gstack context options` presents those choices. `gstack context select
host|local-browser|none` persists the explicit fallback while keeping
Context.dev consent false; `context setup` is the only path that selects
Context.dev and persists export consent with the protected key.

The deterministic Context contract is green at 22 pass / 0 fail and 139
assertions. A verified-key live smoke also passed the official Markdown scrape
endpoint with protected input and an isolated temporary home. The redacted
artifact records the endpoint and cleanup guarantees without storing the key or
provider response body.

See [CONTEXT-DEV.md](./CONTEXT-DEV.md) and [PRIVACY.md](./PRIVACY.md).

## Local browser and physical iOS

The existing Chromium/Playwright daemon remains the sole browser-automation
backend. It binds loopback, requires bearer authorization for mutations,
preserves authenticated sessions locally, denies tunnel commands by default,
and treats page/console/network content as untrusted. Context.dev complements
public research; it does not replace browser QA. No cloud browser was added.

The existing DebugBridge/CoreDevice harness remains the sole physical-iOS
backend. The candidate distinguishes hardware UDID from CoreDevice UUID,
returns bounded 504 responses for a suspended app, asserts the expected bundle
around coordinate mutations, preserves typed snapshot/mutation/restoration,
and keeps bridge symbols debug-only. Device signing, provisioning, and
CoreDevice compatibility are setup gates, not product failures. A live
signed-device pass is still required before release. The earlier target's
preflight evidence is 9 pass / 0 fail / 1 deploy skip and 29 assertions; its
direct smoke returned `signing_unavailable`. The latest explicitly selected
target returned `device_not_wired` because iOS 16.7.10 exposes no supported
CoreDevice service. Neither attempt installed or launched an app, and no pass
artifact was written.

PDF rendering and Mermaid/Excalidraw remain internal capabilities. GStack does
not add Typst, hosted document rendering, alternate diagram services, local
image weights, ComfyUI, or a GPU runtime.

## Infrastructure-defect disposition

“Contained” means the defect is outside the canonical GStack 2 path, not that
legacy code was proven bug-free. “Implemented” names candidate code. “Pending”
means the replacement still lacks its required release evidence.

| # | Legacy defect | GStack 2 disposition / replacement | Replacement evidence |
|---:|---|---|---|
| 1 | Ten registered hosts; setup fully installs five | **Contained:** placement is delegated to the standard installer. | 470/470 checks across six hosts, 16 installs, two removals, project/global scopes, and selections. Passing live v3/host UI launch remains separate. |
| 2 | Kiro rewrites Codex output | **Contained:** one canonical standards tree; no Kiro rewrite in the 2.0 path. | Six-host matrix installs byte-matching canonical copies without host rewrites. |
| 3 | Gitignored external trees defeat freshness CI | **Implemented:** canonical `skills/`, `compat/`, and parity fixtures are committed. | 4,681 parity checks plus installed-file hash equality. |
| 4 | External `--dry-run` mutates files | **Contained:** external host generation/dry-run is not used for 2.0 distribution. | Canonical regeneration/parity check exists; a non-mutating canonical check mode is not yet present. |
| 5 | Single-host generation failures only warn | **Contained:** no per-host generation in the canonical path; canonical generation throws on failure. | Generator/parity suite and final build rerun are green. |
| 6 | Setup continues after failed generation | **Implemented/contained:** standard installer handles skills; runtime setup fails before activation and preserves last known good. | Failure tests plus the real two-version default lifecycle and rollback pass. |
| 7 | Removed/renamed generated skills are not pruned | **Implemented for canonical references:** regeneration removes each reference/asset tree and parity corpus before writing the fixed six. | Parity inventory test; stale-public-directory fixture pending. |
| 8 | Freshness misses generator/design/PDF changes | **Implemented:** build invokes canonical generation; parity hashes source, sections, assets, and fixtures. | Design is green at 101/0/381, PDF at 189/0/398, and the uninterrupted broad singleton run is green at 6,255 pass / 226 expected skips / 0 fail across all 384 files. |
| 9 | State paths bypass canonical resolver | **Implemented:** `runtime/paths.js` is authoritative for 2.0 runtime state. | `gstack2-runtime-core.test.ts`. |
| 10 | Shell-evaluated path assignments are unsafe | **Implemented:** runtime paths are JavaScript values; shell-looking input remains literal. | Core test covers spaces, `$()`, semicolon, and `$HOME` text. |
| 11 | Relinking omits carved section links | **Contained:** no per-section host relinking; sections are inlined into pinned modules. | Parity checks all 16 sections. |
| 12 | External preambles omit PDF paths | **Contained:** PDF is indexed as an internal design capability/assets route, not copied host preamble prose. | Asset parity plus 189/0/398 PDF strict tests and a visually checked four-page live render pass. |
| 13 | Production model benchmark imports test helpers | **Implemented:** the runner, pricing, providers, and optional judge live under `lib/model-benchmark/`; the production CLI imports only production modules. | `benchmark-production-boundary.test.ts` rejects imports from `test/` across `bin/` and `lib/`; focused runner and CLI tests exercise the relocated implementation. |
| 14 | Default tests omit `design/test` | **Implemented:** package default and free-test roots include `design/test`. | Design is green at 101/0/381 and is included in the uninterrupted 384-file broad pass. |
| 15 | Default tests omit `ios-qa/daemon/test` | **Implemented:** package default and free-test roots include the daemon tests. | Focused daemon run: 95 pass / 0 fail / 229 assertions; daemon tests are also included in the uninterrupted broad pass. |
| 16 | Host setup contradicts config-driven claim | **Contained:** host setup is no longer a 2.0 responsibility. | Standard installer CLI 1.5.19 passed all six configured host targets. |
| 17 | Host-generated judgment copies drift | **Implemented:** one canonical module corpus with source-blob/render hashes. | 4,681 parity checks and installed-copy hashes pass. |
| 18 | Updating one host leaves another stale | **Contained:** one tree is installed by each host's standard installer. | Project/global copies across six hosts matched canonical hashes; remote update flow remains installer-owned. |
| 19 | State identity crosses worktrees | **Implemented:** repo plus stable worktree identity selects state. | Linked-worktree core test passes. |
| 20 | Partial ship failures are not reliably idempotent | **Implemented at runtime primitive:** claimed effects become uncertain and are not automatically repeated. | Crash/resume and completed-effect tests pass. End-to-end ship resume remains pending. |
| 21 | Parser failures become empty success | **Implemented in iOS device discovery:** parse/tool failures are typed errors. | `tunnel-bootstrap.test.ts` malformed-JSON regression passes in the focused daemon suite. |
| 22 | Setup failures become product failures | **Partly implemented:** iOS discovery/setup categories and runtime doctor return actionable setup state. | Automated categories exist; live signing/build/install/launch/tunnel passed, while session acquisition and the five-check loop remain open and user-waived. |
| 23 | Runtime network activity is not obvious | **Implemented for Context runtime:** selection, mode, and consent are explicit; status/doctor report them; zero lookup/fetch before Context selection+consent. | Context contract: 22 pass / 0 fail / 139 assertions, including persisted non-export fallbacks; verified-key official-endpoint live smoke passed. |
| 24 | Context restore selects another worktree | **Implemented for canonical state resume:** current repo+worktree project ID scopes inspection/resume. | Linked-worktree identity test passes; compatibility end-to-end restore test pending. |
| 25 | Preambles repeat large sections in every skill | **Implemented structurally:** six thin lazy dispatchers share infrastructure and load one preserved module on demand. | Current generated six-name/description catalog is 982 characters, about 246 token-equivalents versus the correctly parsed baseline of about 1,100 (77.6% lower). Re-measure if frontmatter changes. |

No defect in this table should be closed from prose alone. The final claim must
link its reproduction and passing test in [TEST-EVIDENCE.md](./TEST-EVIDENCE.md).

## Explicit non-architecture

GStack 2 does not contain a generic provider or plugin marketplace, distributed
workflow engine, mandatory cloud service, cloud browser/device farm,
Browserbase/Browser Use/Agent Device/Appium/XCUITest driver layer, mandatory
telemetry, mandatory GBrain/Docker/image generation, local model weights,
ComfyUI, or a new runtime database. Existing development-only dependencies are
not promoted into user setup or the GStack 2 architecture.
