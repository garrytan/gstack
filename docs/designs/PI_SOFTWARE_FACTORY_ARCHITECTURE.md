# Pi Software Factory Architecture

Status: first implementation slice.

## Goal

Make gstack's software-factory workflow reusable in Pi and in applications built on the Pi SDK without making Markdown slash commands the only API.

The core design rule is ACD:

- **Data**: workflow specs, run requests, run plans, policy, events, artifacts.
- **Calculations**: workflow selection, plan compilation, capability checks, risk detection, event reduction.
- **Actions**: Pi SDK sessions, shell/git/browser calls, user questions, CI, PR creation, persistence.

Actions stay behind runtime adapters. The factory core stays pure.

## First slice

This slice adds two foundations:

1. **Pi as a generated gstack host** via `hosts/pi.ts`.
   - Generates Agent Skills under `.pi/skills/gstack-*`.
   - Emits Pi-valid frontmatter names that match generated directories.
   - Rewrites Claude-specific paths toward Pi paths and `AGENTS.md`.
   - Suppresses cross-agent resolvers that require host-specific orchestration.

2. **Reusable factory core contracts and calculations** via `lib/factory-core.ts`.
   - No filesystem, network, browser, shell, or Pi SDK calls.
   - Provides typed data contracts for future Pi extension and SDK adapters.
   - Provides pure helpers for planning, policy merge, capability gaps, and event-sourced run state.

## Intended layering

```text
Applications
  Pi TUI, web apps, CLIs, internal dashboards
        │
Runtime adapters
  Pi SDK adapter, Pi extension, browser CLI, git/CI adapters
        │
Factory orchestrator
  schedules phases, calls adapters, emits events, persists artifacts
        │
Pure factory core
  WorkflowSpec, RunRequest, RunPlan, PolicySpec, FactoryEvent, reducers
        │
Existing gstack assets
  SKILL.md.tmpl, host configs, browse daemon, checklists, docs
```

## Public core contracts

The stable contracts begin in `lib/factory-core.ts`:

- `WorkflowSpec`
- `PhaseSpec`
- `PolicySpec`
- `FactoryRunRequest`
- `FactoryRunPlan`
- `FactoryEvent`
- `FactoryRunState`
- `ArtifactRef`

External apps should eventually call a factory API like:

```ts
const plan = factory.plan({ workflow: 'autoplan', goal, cwd, mode: 'build' });
const run = factory.run({ workflow: 'autoplan', goal, cwd, mode: 'build' });
for await (const event of run.events) render(event);
```

They should not need to prompt `/ship` and scrape prose.

## Runtime adapter boundaries

Future adapters should implement capabilities rather than letting workflow logic call actions directly:

- `AgentRuntime`: starts Pi SDK sessions and sends prompts.
- `BrowserCapability`: wraps the existing gstack browser daemon or a Pi tool.
- `GitCapability`: exposes status, diff, commit, push, PR operations.
- `QuestionCapability`: asks, pauses, auto-decides, or delegates user gates.
- `ArtifactStore`: writes and reads artifacts.

All adapters are Actions. The core only decides what capabilities are required and what risks exist.

## Event-sourced state

Factory runs should persist append-only events:

```text
.factory/runs/<run-id>/events.jsonl
.factory/runs/<run-id>/artifacts/
.factory/runs/<run-id>/manifest.json
```

`reduceFactoryEvents()` reconstructs run state from events. This makes runs inspectable, resumable, and embeddable.

## Pi host notes

Generate Pi skills with:

```bash
bun run gen:skill-docs --host pi
```

The generated files are local build artifacts under `.pi/skills/` and are ignored by git. In this first slice they are **compatibility artifacts for inspection and adapter development**, not a complete runnable Pi installation.

Direct project-local execution still needs the action-layer slice because several generated skills reference runtime sidecars and tools that this slice intentionally does not provide yet:

- review support files under a runtime root such as `$GSTACK_ROOT/review/checklist.md`
- a structured `ask_user_question` capability
- Pi slash-command aliases for gstack names
- a browser tool or `$B` runtime wrapper
- a strategy for subagent / parallel-session flows

This slice does **not** yet add:

- `./setup --host pi`
- a Pi package manifest
- Pi extension slash aliases
- `ask_user_question` tool
- browser custom tool wrapper
- SDK orchestrator

Those are action-layer slices and should consume `lib/factory-core.ts` instead of duplicating workflow state.

## Migration path

1. Keep existing skills as generated host output.
2. Add `WorkflowSpec` definitions for one workflow at a time, starting with `office-hours`.
3. Render the same workflow to Pi skills and SDK run plans.
4. Add a Pi extension that calls the factory core and adapts UI/tools.
5. Add a Pi SDK adapter for external applications.
6. Port action-heavy workflows last: `qa`, `ship`, `land-and-deploy`.

## ACD guardrails

- Do not import Pi SDK types into `lib/factory-core.ts`.
- Do not perform filesystem or shell work inside core calculations.
- Do not make `SKILL.md` the only external contract.
- Treat user questions as gate events, not inline prose.
- Treat browser/git/CI/PR operations as capability adapters.
- Keep write timelines queued unless isolated worktrees and an integration plan exist.
