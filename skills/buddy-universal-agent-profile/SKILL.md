---
name: buddy-universal-agent-profile
description: "Buddy + Lil' Buddy portable agent standard across platforms."
version: 1.0.0
author: Cody Sumpter (codysumpter-cloud), Hermes Agent
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [agent, orchestration, buddy, standard, multi-agent, workflow]
    related_skills: [github-repo-management]
---

# Buddy Universal Agent Profile (BUAP)

Loads the **Buddy** agent behavior standard so any coding agent in the session
operates as a Buddy orchestrator with a Lil' Buddy worker — consistent intent,
planning, delegation, review, and handoff across tools.

BUAP is a **behavior/orchestration standard**, not a sub-agent runtime. It ships
prompt tiers (Kernel → Lite → Standard → Full), platform adapters, schemas,
conformance tests, and CI. Source: `github.com/codysumpter-cloud/buddy-universal-agent-profile`.

## When to Use

- Starting work in a repo where BUAP is installed and you want to operate under the Buddy contract
- Needing a consistent agent identity/orchestration pattern across multiple AI tools (Codex, Claude, Gemini, Grok, Cursor, Windsurf, ChatGPT, Siri, ACP, etc.)
- Preparing a repo to adopt BUAP (install, verify conformance, handoff)
- Auditing whether a target tool actually follows BUAP (conformance checks)
- Needing the multi-agent loop: Human → Buddy → Lil' Buddy → Review → re-brief

Don't use for: running a sub-agent runtime (BUAP doesn't spawn processes by default), or when a repo's own agent contract takes precedence (BUAP respects that).

## Prerequisites

- The target repo has `buddy-universal-agent-profile/` copied into its root, OR
- A platform-specific install is done (Claude plugin, Codex plugin, ChatGPT Project, etc.)
- `gh` authenticated with `repo` scope (for inspecting/updating BUAP in repos)

## How to Run

### Inspect whether a repo uses BUAP

Check whether the BUAP folder exists in the repo, or whether the repo's agent
instructions reference BUAP.

### Load BUAP for the current session

Point the session at the BUAP root or a tier file. The BUAP file itself describes
what the agent should do — no additional writes are needed to operate.

Tier files (pick one, not all):
- `BUAP_KERNEL.md` — micro-profile for constrained tools
- `BUAP_LITE.md` — low-context, search boxes
- `BUAP_STANDARD.md` — normal AI chats
- `BUAP_FULL.md` — repo-aware agents

### Install BUAP into a repo (user action)

The repo consumer copies `buddy-universal-agent-profile/` into the repo root,
then points the repo's agent entry point at it. This is a one-time setup step;
the session does not perform it.

For Claude Code, the recommended path is the plugin:
`/plugin marketplace add codysumpter-cloud/buddy-universal-agent-profile` then
`/plugin install buap@buap`. This provides `/buap-audit`, `/buap-handoff`,
a `lil-buddy` subagent, and safety/receipts hooks.

### Run conformance checks

When working in a BUAP repo, the consumer runs:
`node scripts/buap-conformance-check.mjs` (required files + key text) and
`node scripts/buap-lint.mjs` (plugin manifests, frontmatter, links, invariants).

## Quick Reference

| Tier | File | Context |
|------|------|---------|
| Kernel | `BUAP_KERNEL.md` | Micro, constrained tools |
| Lite | `BUAP_LITE.md` | Low-context, search boxes |
| Standard | `BUAP_STANDARD.md` | Normal AI chats |
| Full | `BUAP_FULL.md` | Repo-aware agents |

| Platform | Install path |
|----------|-------------|
|| Claude Code | plugin install via marketplace, or load BUAP instructions file ||
|| Codex | symlink the BUAP entry file or follow Codex setup notes ||
|| ChatGPT | paste project instructions + upload knowledge files ||
|| Grok/xAI | paste the Grok profile into custom instructions ||
|| Siri/App Intents | SIRI_BUAP profile + README ||
|| Xcode/ACP | build the ACP agent package ||
|| Cursor | create a cursor rules file from the template ||
|| Windsurf | add rules from the template ||
|| Gemini CLI | point Gemini context at the BUAP folder ||
|| Cowork | connect folder, load BUAP instructions ||

## Procedure — Adopt BUAP in a repo

1. **Pick the tier** that fits the repo's agent surface (usually Standard or Full).
2. **Copy** `buddy-universal-agent-profile/` into the repo root (user action).
3. **Wire the entry point** — the repo's agent instructions reference BUAP (user action).
4. **Run conformance**: `node scripts/buap-conformance-check.mjs`.
5. **Run lint**: `node scripts/buap-lint.mjs`.
6. **Verify the loop** with a test task: intent → plan → delegate → review → handoff.
7. **Commit** the BUAP folder and the entry-point change together.

## Procedure — Operate as Buddy in-session

1. **Read the BUAP root** or tier file into context at session start.
2. **Buddy role**: clarify intent, plan the work, delegate to Lil' Buddy (or a subagent), review outputs.
3. **Lil' Buddy role**: implement, research, validate — report back with receipts.
4. **Review**: check against BUAP rules — no fake success claims, no hardcoded secrets, no duplicate systems, extend don't replace.
5. **Handoff**: produce copy-paste runnable prompts, commands, diffs, or checklists when the tool can't persist files.

## Pitfalls

- **Repo contract clash**: if the repo has its own agent instructions that conflict with BUAP, the repo contract takes precedence. BUAP supplies the orchestration beneath it — don't force it on top of an existing contract without checking.
- **Git clone as setup step**: the repo consumer clones BUAP as a one-time copy into their repo; the session does not clone repos as part of operating under BUAP.

## Verification

- Conformance passes: `node scripts/buap-conformance-check.mjs` exits 0.
- Lint passes: `node scripts/buap-lint.mjs` exits 0.
- Session behavior: after loading BUAP, the agent clarifies intent before implementing, delegates to a worker, reviews outputs, and produces handoffs — not just jumping to code.
- Plugin (if used): /buap-audit and /buap-handoff commands are available; lil-buddy subagent exists.

## Source

- Repo: `github.com/codysumpter-cloud/buddy-universal-agent-profile`
- Standards: `standards/runtime-contract.md`, `standards/capability-negotiation.md`, `standards/multi-agent-negotiation.md`
- Schemas: `schemas/receipt.schema.json`, `schemas/capability-declaration.schema.json`
- Conformance: `tests/conformance/`, `scripts/buap-conformance-check.mjs`
