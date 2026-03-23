# RFC: define a standard host integration contract for gstack

## Summary

This is a design proposal / RFC, not just a request for one-off OpenCode compatibility.

gstack already has the beginnings of a multi-host architecture, but today it still behaves more like:

- Claude Code as the primary path
- Codex as a special-case adaptation

The proposal is to make multi-host support explicit and first-class by introducing a host/runtime adapter layer, then using OpenCode as the first new host to validate the design.

The goal is to avoid a future where Claude/Codex/OpenCode/Cursor compatibility grows through one-off branches, hardcoded path rewrites, and incremental string replacement that eventually conflict.

I’m less interested in a one-off OpenCode patch than in creating the right abstraction point for all adjacent runtimes.

## Status

This issue started as an RFC / enhancement discussion before implementation.

The immediate goal was to align on the abstraction boundary first, so future OpenCode support and similar runtime work can build on the same model instead of landing as parallel special cases.

### Status update — 2026-03-23

This branch now has a concrete phase-1 implementation of the install/runtime contract.

Completed in the current branch:

- added `scripts/host-registry.ts` as the single source of truth for host layouts, discovery modes, runtime roots, path rewrites, generated output paths, and runtime asset policy
- made `~/.gstack` the canonical shared runtime home and `.gstack` the workspace sidecar/fallback, instead of treating host-specific skill roots as the primary runtime copy
- updated `scripts/gen-skill-docs.ts`, `setup`, and `scripts/skill-check.ts` to use the shared contract rather than ad hoc host-specific logic
- updated install semantics so normal installs materialize runtime assets into `~/.gstack`, while host-specific directories remain thin discoverability layers
- added a minimal published-install entrypoint via `bin/gstack` plus package file whitelisting in `package.json`
- added setup hardening for self-overwrite protection, nested-runtime avoidance, packaged `browse` validation, and explicit failure semantics for unsupported `--host auto` / Gemini workspace-only cases
- added regression coverage in `test/gen-skill-docs.test.ts`, `test/helpers/touchfiles.ts`, and `test/touchfiles.test.ts`

Validated so far:

- `./setup --host auto`
- `bun test test/gen-skill-docs.test.ts browse/test/find-browse.test.ts test/touchfiles.test.ts`
- `bun run skill:check`
- `npm pack --dry-run --json`

### Review checkpoint pushed for this tranche

The current remote branch checkpoint intentionally contains the host/runtime contract work as two reviewable commits:

- `e106007` — `feat(hosts): centralize shared runtime contract`
- `e178d39` — `docs(hosts): record phase-one runtime checkpoint`

Those commits are the review target for the current tranche.

### Intentionally deferred from this checkpoint

The current working tree still contains follow-up work that is deliberately not part of the pushed checkpoint yet:

- `/gstack-upgrade` contract cleanup against the new `~/.gstack` primary-install model
- `browse/src/find-browse.ts` resolution-policy cleanup and its related tests
- small supporting docs updates that should land with that follow-up rather than muddying this review checkpoint

### Scoped follow-up after this tranche

The current branch is at a good checkpoint for review, but three follow-up items should land before calling the install/runtime refactor fully complete:

1. collapse `/gstack-upgrade` onto the new model so `~/.gstack` is always the primary install and workspace `.gstack` is only a sync target
2. change `browse/src/find-browse.ts` resolution policy so a stale workspace sidecar cannot silently shadow a newer shared runtime without validation
3. add behavior-level tests for upgrade/sync flows and shared-vs-workspace resolution precedence, not just string-contract validation

That follow-up should stay intentionally narrow. The adapter/runtime contract is now concrete enough that OpenCode or other adjacent hosts can build on it after these remaining install/runtime edges are cleaned up.

## Why now

There is already community demand for OpenCode support:

- issue #16 requests OpenCode / OpenRouter documentation
- PR #86 adds an OpenCode compatibility guide
- there are community repos experimenting with `gstack-on-opencode`

That suggests the demand is real, but the current direction is mostly documentation-level compatibility.
This feels like the right moment to insert a proper abstraction point before multiple partial adaptations diverge.

## What already exists

There is already a strong foundation for this:

- `scripts/gen-skill-docs.ts` has host-aware generation for `claude` and `codex`
- `setup` already supports `--host claude|codex|auto`
- `.agents/skills/` support already exists for non-Claude runtimes
- `browse` is already a standalone CLI, so it should adapt well once the runtime abstraction is clean

## Core idea

Introduce a first-class host integration contract, implemented by host adapters, instead of adding more `if host === ...` branches.

The contract should define both install/discovery behavior and runtime capability translation.
Each host adapter would define things like:

- `skillRoot`
- `localSkillRoot`
- `binDir`
- `skillDiscoveryRoots`
- `frontmatterProfile`
- `interactionPrimitive`
- `skillInvocationPrimitive`
- `toolCapabilityProfile`
- `pathRewriteRules`
- `installStrategy`
- `runtimeAssetStrategy`
- `sessionRunner`

This would let gstack treat Claude, Codex, OpenCode, Cursor, Droid, and similar runtimes as peers rather than "primary host + exceptions".

## Why `skillRoot` / discovery is a key abstraction

The most important part of this is not just frontmatter or docs.
It is the skill root / discovery model.

That determines:

1. where a host discovers skills
2. how runtime assets like `browse/dist` and `bin/` are referenced
3. how generated templates should resolve local vs global installs
4. how vendored/project installs should behave across runtimes

Right now this logic is partially embedded in setup, partially embedded in template generation, and partially embedded in hardcoded path rewrites.
Making it explicit would simplify all future host support.

## Template abstraction proposal

Many templates currently embed host-specific assumptions directly.

A better direction would be to introduce explicit template placeholders / injected blocks for host-specific behavior, for example:

- host-specific skill root references
- host-specific local skill root references
- host-specific bin path references
- host-specific interaction tool names / invocation patterns
- host-specific safety / frontmatter transformations

That would make the template layer stable while letting host adapters inject the right behavior.

## Proposed host integration contract

The longer-term goal is not just to support more hosts, but to define the minimum contract a runtime must satisfy in order for gstack skills to work predictably.

At a minimum, a compatible host/runtime should provide:

- **Skill discovery** — a stable way to discover skills from one or more configured roots
- **File and shell execution** — enough support for reading files, writing files, and running shell commands used throughout gstack workflows
- **Interactive user questioning** — an equivalent of `AskUserQuestion`, even if the host uses a different name or invocation shape
- **Skill invocation or skill handoff semantics** — either native skill-to-skill invocation or a clearly defined fallback model
- **Metadata/frontmatter compatibility** — a known profile for what frontmatter fields are supported and any limits (for example, description length caps)
- **Runtime asset resolution** — a reliable way for generated skills to locate `bin/`, `browse/dist/`, review docs, and other shared assets
- **Validation path** — a way to verify generated skills actually run on that host (smoke test, session runner, or equivalent)

This contract is useful even beyond OpenCode. Once defined, any new host integration can be evaluated against the same checklist instead of inventing its own compatibility model.

## AskUserQuestion / interactive prompting

A major cross-host abstraction point is interactive user questioning.

My current understanding is that Claude, Codex, OpenCode, Cursor, and similar runtimes all have some equivalent capability, but the naming / invocation shape may differ.

So this likely should not remain a Claude-specific literal embedded in templates.
Instead, it should become a host-level abstraction, something like:

- a generic "interactive prompt" placeholder in templates
- host-specific rendering or invocation per runtime
- a declared capability in the host integration contract

This feels like one of the most important design points to investigate before deeper implementation.

## Shared gstack library vs host-specific install roots

Once multiple runtimes are supported on the same machine, duplicating the full gstack tree into each runtime-specific directory becomes increasingly unattractive.

A likely better model is to separate:

- a **shared gstack home/library** that owns common assets
- one or more **host-specific entry roots** that expose the runtime-specific skill layout

Under that model, shared assets such as `bin/`, `browse/dist/`, templates, docs, and review references would live in a single canonical gstack home. Individual hosts would then either:

- symlink into that shared home, or
- receive a materialized copy when symlinks are unsupported or undesirable

This suggests the host integration contract should also declare whether a host supports:

- **symlink-based installs**
- **copy-based installs**
- or both

That way gstack can avoid maintaining many redundant copies on one machine while still supporting runtimes that require a full physical copy.

Related to this, executable/runtime assets such as `bin/` should likely belong to the shared gstack home rather than being treated as host-local duplicates. Hosts should expose those assets via their own runtime roots, but the canonical source should stay centralized whenever possible.

## Suggested implementation phases

### Phase 1 - formalize the adapter layer

- refactor host handling in `gen-skill-docs.ts` into a real adapter model
- separate host config from one-off string replacement
- make skill roots / local roots / bin dirs / discovery roots explicit

### Phase 2 - abstract template host semantics

- introduce placeholders / injected blocks for host-specific template behavior
- abstract interactive question behavior
- eliminate remaining hardcoded `~/.claude/...` assumptions from generated output

### Phase 3 - add OpenCode as the first new host

- implement OpenCode adapter
- support install + generation + local/global discovery
- get a small set of skills working end-to-end (`/browse`, `/retro`, plan skills)

### Phase 4 - fold existing hosts back into the contract

- migrate existing Codex-specific behavior onto the same adapter surface
- account for other in-flight hosts and host-like runtimes (for example Droid, Gemini, or similar integrations)
- use real host differences to validate whether the contract is complete or still missing pieces

### Phase 5 - runtime validation

- add an OpenCode session runner / smoke-test path
- validate at least one interactive skill and one browse workflow
- extend validation so newly added hosts are checked against the same contract rather than bespoke rules

## Why this issue first

I think the most valuable thing right now is to align on the abstraction before more OpenCode-compatible work lands in parallel.

Without that, it's easy to end up with:

- docs-only compatibility in one place
- a community fork doing path remaps elsewhere
- another PR adding OpenCode branches in setup
- later conflicts when trying to support Cursor or another runtime

With a clear adapter model, contributors can work in parallel without fighting each other.

## Open questions worth answering in-thread

- What is the right canonical abstraction for skill discovery roots?
- Should runtime asset discovery (`bin/`, `browse/dist/`, sidecars) be part of the host adapter or a separate install/runtime layer?
- What is the best abstraction for interactive user questions across runtimes?
- Should `setup` become registry-driven rather than adding another `elif` branch per runtime?
- Should OpenCode support land as a single initial RFC PR that creates the abstraction points first, before any full runtime rollout?

## Happy to help

If this direction makes sense, I’m happy to help with:

- scoping the adapter interface
- identifying the current hardcoded host assumptions
- drafting the first OpenCode adapter
- or opening a follow-up PR that creates the initial abstraction points without trying to solve every host at once
