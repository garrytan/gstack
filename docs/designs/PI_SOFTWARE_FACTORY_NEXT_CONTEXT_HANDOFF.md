# Pi / Universe AI Software Factory — Next Context Handoff

Status: handoff for a fresh context window after the smoke/prototype/host-design round.

Repo:

```text
/home/claude/workspaces/garrytan/gstack
```

Branch:

```text
pi-software-factory-core
```

Latest integrated commit at handoff:

```text
e6a06789 Update readiness after smoke and prototype round
```

## 1. Critical working-tree state

Expected `git status --short --branch` in the main checkout:

```text
## pi-software-factory-core
 M CLAUDE.md
?? package-lock.json
```

These are protected/pre-existing local noise. Do **not** edit, stage, commit, reset, clean, or delete them unless the user explicitly asks.

No push has been performed.

## 2. Important guardrails for the next context

Do not violate these defaults:

- Do not touch `CLAUDE.md` or `package-lock.json`.
- Do not add, remove, or upgrade dependencies.
- Do not edit package manifests unless explicitly approved.
- Do not scaffold a production web app until stack/location/dependencies are approved.
- Do not push, tag, publish, deploy, or run release automation.
- Do not expose `/factory-qa-fix`.
- Keep `lib/factory-core.ts` pure: no filesystem, shell, browser, network, Pi SDK, or UI actions.
- Runtime/filesystem/shell/browser/Pi SDK actions stay in adapter/facade/store/runtime boundary modules.
- Ship-readiness remains handoff/readiness only; no tag/publish/push/deploy language or behavior.
- Raw event `path`/`uri` metadata remains untrusted; render it as metadata-only unless artifact-store/runtime provenance says otherwise.

## 3. What just landed

Latest commits in order:

```text
e6a06789 Update readiness after smoke and prototype round
63298674 Design host guard enforcement contract for QA-fix exposure
8e26c50a Add static cockpit P0 prototype under docs/prototypes/
38a83f65 Add Beta 2 production-readiness smoke runner
220fdff4 Consolidate alpha beta execution results
be140bb6 Build fixture-backed cockpit view models for Alpha 1
1ec464e2 Audit safe-command guard decisions without leaking secrets
593ce346 Inventory live safe-command guard paths for QA fix
20ab65b9 Connect artifact descriptors into project views
2351fc45 Contract factory beta operations and security
b51ed88a Add factory distribution dry-run bundle helpers
a668f3c6 Recover factory QA from durable log
b0e10877 Add durable factory project catalog store
```

### 3.1 Production-readiness smoke runner

Added:

```text
lib/factory-production-smoke.ts
test/factory-production-smoke.test.ts
```

Purpose:

- deterministic smoke runner with S1-S11 checks from the Beta 2 operations/security contract;
- no external network;
- no shell-out;
- no env/secret reads;
- uses caller-provided absolute temp workdir;
- S11 web `/health` is explicitly `deferred`, not green.

Covered checks:

- S1 module load;
- S2 facade plan;
- S3 facade status;
- S4 facade list;
- S5 facade artifact read;
- S6 project catalog round-trip;
- S7 QA log parse;
- S8 QA recover fixture;
- S9 guarded denial audit;
- S10 distribution dry-run;
- S11 web health deferred.

### 3.2 Static no-dependency cockpit prototype

Added:

```text
docs/prototypes/factory-cockpit-p0/index.html
docs/prototypes/factory-cockpit-p0/styles.css
docs/prototypes/factory-cockpit-p0/README.md
```

Properties:

- static HTML/CSS;
- no JavaScript;
- no external assets;
- no dependencies;
- no production runtime claim;
- demonstrates Universe AI framing, Easy Mode, Hands-on 3-bay map, dashboard/resume, idea wizard, gate decision, QA evidence, guard-denial placeholder, artifact provenance, ship-readiness/handoff, and mobile responsive states.

To view:

```bash
xdg-open docs/prototypes/factory-cockpit-p0/index.html
# or open the file manually in a browser
```

### 3.3 Host guard enforcement design

Added:

```text
docs/designs/PI_FACTORY_HOST_GUARD_ENFORCEMENT_DESIGN.md
```

Purpose:

- design of record for eventually making `/factory-qa-fix` safe;
- defines required host APIs such as guarded agent sessions and guarded subprocess/file hooks;
- defines per-run guard session, command/file write policy, browser sidecar output dir constraints, attestation, validation, blockers, and migration path.

Current decision:

```text
/factory-qa-fix remains hidden.
```

Reason:

- dispatched Pi/Claude skill Bash/Read/Write/Edit tool paths are not enforceable from repository code today.

### 3.4 Readiness map and roadmap updated

Updated:

```text
docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md
docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md
```

Current readiness estimates:

```text
Internal Pi/CLI factory core:       ~82–85%
Common-user web cockpit/platform:   ~65–70%
Weighted overall production ready:  ~66–70%
```

The branch is still **not production-ready** for public users.

## 4. Last validation run

Final integrated validation before this handoff:

```bash
bun test \
  test/factory-production-smoke.test.ts \
  test/factory-project-store.test.ts \
  test/factory-project.test.ts \
  test/factory-artifact-content.test.ts \
  test/factory-cockpit-view.test.ts \
  test/factory-qa-capture.test.ts \
  test/pi-extension.test.ts \
  test/factory-qa-workflow.test.ts \
  test/factory-distribution.test.ts \
  test/factory-guarded-runtime.test.ts \
  test/factory-command-guard.test.ts \
  test/factory-facade.test.ts \
  test/factory-artifact-store.test.ts \
  test/factory-event-store.test.ts \
  test/factory-core.test.ts
```

Result:

```text
171 pass
0 fail
1078 expect() calls
```

Diff whitespace check passed:

```bash
git diff --check -- docs/designs docs/prototypes lib test .pi/extensions/pi-gstack/index.ts qa qa-only .pi/skills bin
```

Read-only security/reviewer pass reported:

```text
No blocking findings.
```

## 5. Key docs to read first in the new context

Read these in order:

```text
CLAUDE.md

docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md
docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md
docs/designs/PI_SOFTWARE_FACTORY_BETA_OPERATIONS_SECURITY_CONTRACT.md
docs/designs/PI_FACTORY_HOST_GUARD_ENFORCEMENT_DESIGN.md
docs/designs/PI_SOFTWARE_FACTORY_COCKPIT_BETA1_CONTRACT.md
docs/designs/PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md
```

Then inspect relevant code:

```text
lib/factory-production-smoke.ts
lib/factory-file-write-guard.ts             # does not exist yet; next candidate
lib/factory-guarded-runtime.ts
lib/factory-command-guard.ts
lib/factory-distribution.ts
lib/factory-project-store.ts
lib/factory-cockpit-view.ts
.pi/extensions/pi-gstack/index.ts
```

## 6. Recommended next bucket

The best next autonomous bucket is:

### Bucket A — Smoke runner surfacing without manifest edits

Goal: make the smoke runner easy to invoke without changing package manifests.

Allowed autonomous work:

- add a tiny no-dependency CLI wrapper under `bin/`, for example:

```text
bin/gstack-factory-smoke
```

- CLI should call `runFactoryProductionSmoke()`;
- create a temp workdir unless the caller provides one;
- print deterministic human-readable summary and/or JSON;
- return nonzero only when non-deferred checks fail;
- clearly show S11 web health as `deferred`, not pass;
- avoid release/deploy/publish/tag/push vocabulary in output;
- no package script yet unless package-manifest changes are explicitly approved.

Suggested tests:

```text
test/factory-production-smoke-cli.test.ts
```

Suggested validation:

```bash
bun test test/factory-production-smoke.test.ts test/factory-production-smoke-cli.test.ts
```

### Bucket B — Factory-side host guard primitives

Goal: implement repo-side primitives that a future host can call, while keeping `/factory-qa-fix` hidden.

Allowed autonomous work:

- add `lib/factory-file-write-guard.ts`;
- add tests for path/write policy;
- add attestation DTO/helpers in a new module or additive to `lib/factory-guarded-runtime.ts` if appropriate;
- add a test-only guarded host shim, but do **not** wire it to public `/factory-qa-fix` exposure;
- keep default Pi adapter `safe-command-guard` capability absent.

Start from:

```text
docs/designs/PI_FACTORY_HOST_GUARD_ENFORCEMENT_DESIGN.md §7, §9, §10, §11
```

Suggested tests:

```text
test/factory-file-write-guard.test.ts
test/factory-host-attestation.test.ts
```

Suggested validation:

```bash
bun test \
  test/factory-file-write-guard.test.ts \
  test/factory-host-attestation.test.ts \
  test/factory-command-guard.test.ts \
  test/factory-guarded-runtime.test.ts \
  test/pi-extension.test.ts
```

### Bucket C — Documentation-only CI/smoke integration plan

Goal: plan how to run the smoke runner in CI without editing package manifests yet.

Allowed autonomous work:

- docs only, unless user approves workflow/package changes;
- add a design note describing where the smoke runner will plug into CI and local gates;
- if changing GitHub workflows, ask first.

### Bucket D — Do **not** start production web app yet

The static prototype exists. Do not scaffold a production app unless the user explicitly approves:

- stack/framework;
- app location;
- dependency/package changes;
- auth/hosted workspace model.

## 7. Suggested parallel worktree plan for next context

If using parallel agents, create new sibling worktrees from the current main HEAD, not nested under the repo.

Example:

```bash
cd /home/claude/workspaces/garrytan/gstack
BASE=$(git rev-parse HEAD)
cd /home/claude/workspaces/garrytan

git -C gstack worktree add gstack-wt-smoke-cli -b sf/smoke-cli "$BASE"
git -C gstack worktree add gstack-wt-file-write-guard -b sf/file-write-guard "$BASE"
git -C gstack worktree add gstack-wt-host-attestation -b sf/host-attestation "$BASE"
git -C gstack worktree add gstack-wt-next-validation -b sf/next-validation "$BASE"
```

Recommended integration order:

1. smoke CLI wrapper;
2. file-write guard;
3. host attestation helpers;
4. validation/review;
5. roadmap/readiness consolidation.

Do not run concurrent write-capable agents in the same worktree.

## 8. Existing old worktrees

There are many old sibling worktrees from prior waves, e.g.:

```text
gstack-wt-smoke-runner
gstack-wt-cockpit-prototype
gstack-wt-host-guard-design
gstack-wt-project-catalog
gstack-wt-qa-logs
gstack-wt-distribution-dryrun
...
```

Their commits have been integrated into `pi-software-factory-core`. For the next bucket, prefer fresh worktrees from the current HEAD or reset old ones carefully after checking they are clean.

Do not delete worktrees with destructive commands unless the user explicitly approves cleanup.

## 9. Quick smoke command for new context

After any next-bucket changes, run at least:

```bash
bun test \
  test/factory-production-smoke.test.ts \
  test/factory-command-guard.test.ts \
  test/factory-guarded-runtime.test.ts \
  test/pi-extension.test.ts

git diff --check -- docs/designs docs/prototypes lib test .pi/extensions/pi-gstack/index.ts bin
```

For a broader confidence pass, run the full validation command from §4.

## 10. Stop conditions

Stop and report if the next bucket appears to require:

- editing `CLAUDE.md` or `package-lock.json`;
- package/dependency/manifest changes;
- production web scaffold/framework selection;
- GitHub workflow changes without approval;
- exposing `/factory-qa-fix`;
- advertising `safe-command-guard` from the default Pi adapter;
- external systems, deploy, publish, tag, push, or release behavior;
- secrets/credential access;
- destructive cleanup/reset commands.
