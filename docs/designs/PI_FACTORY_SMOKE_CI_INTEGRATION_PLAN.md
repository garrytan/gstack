# Pi Factory Smoke CI Integration Plan

Status: documentation-only integration plan. No package manifest, workflow, dependency, or hosted app changes in this slice.

## Goal

Make the factory production-readiness smoke runner easy to place in future local and CI gates without pretending the common-user web cockpit is ready. The current implementation surfaces the smoke runner through:

```bash
bin/gstack-factory-smoke
```

That wrapper calls `runFactoryProductionSmoke()` directly, creates a temp workdir by default, supports `--json`, and exits nonzero only when a required non-deferred check fails. S11 web `/health` remains `deferred` until an approved production web app exists.

## Guardrails

- Do not edit `package.json`, lockfiles, or package scripts without explicit approval.
- Do not add dependencies.
- Do not edit GitHub workflows without explicit approval.
- Do not start or scaffold a production web app from this plan.
- Do not treat S11 web `/health` as pass until a real app and stack are approved.
- Keep smoke output free of tag/push/publish/deploy/release-success language.

## Local invocation

Preferred direct command:

```bash
bin/gstack-factory-smoke
```

Machine-readable form:

```bash
bin/gstack-factory-smoke --json
```

Caller-owned workdir form:

```bash
bin/gstack-factory-smoke --work-dir /absolute/temp/dir
```

The direct `bin/` command is intentional. It avoids package-manifest churn while still giving maintainers a memorable command.

## Future CI insertion points

### 1. Fast PR gate, factory-only diff

When workflow edits are approved, add a job step that runs only when factory files change:

```bash
bin/gstack-factory-smoke --json
```

Suggested path filter:

```text
lib/factory-*.ts
test/factory-*.test.ts
.pi/extensions/pi-gstack/index.ts
docs/designs/PI_SOFTWARE_FACTORY_*.md
docs/designs/PI_FACTORY_*.md
bin/gstack-factory-smoke
```

Expected behavior:

- job passes when S1-S10 pass and S11 is deferred;
- job fails if any S1-S10 check fails;
- CI summary calls out deferred S11 separately.

### 2. Nightly factory readiness signal

A scheduled job can run the same command and archive the JSON summary as a CI artifact. This creates a longitudinal readiness signal without contacting external services or starting a web app.

Suggested JSON fields to surface in job summary:

| Field | Meaning |
|---|---|
| `status` | `pass` only when all required checks passed |
| `allRequiredPassed` | boolean gate for S1-S10 |
| `hasDeferredGates` | true while S11 or future gates are not implemented |
| `passCount` / `failCount` / `deferredCount` | compact dashboard counters |
| `checks[]` | per-check evidence for debugging |

### 3. Pre-merge maintainer command

Until workflow edits are approved, maintainers can run:

```bash
bun test test/factory-production-smoke.test.ts test/factory-production-smoke-cli.test.ts
bin/gstack-factory-smoke
```

This validates both the pure runner contract and the direct command surface.

## Future S11 web `/health` transition

S11 can move from `deferred` to `pass` only after a separate approved web-app slice defines:

1. stack/framework;
2. app location;
3. dependency/package changes;
4. auth/workspace model;
5. `/health` response contract with no secrets in the response body;
6. CI startup command and teardown command.

Until then, the smoke runner should keep S11 visible and deferred. A green engine smoke is not the same thing as a ready public cockpit.

## Proposed workflow shape after approval

This is illustrative only. Do not add it without explicit workflow-change approval.

```yaml
- name: Factory production-readiness smoke
  run: |
    bin/gstack-factory-smoke --json > factory-smoke.json
    bin/gstack-factory-smoke
```

If a job-summary parser is added later, it should read `factory-smoke.json`, list any `fail` checks first, then list `deferred` checks. Deferred S11 should be clear but should not flip the command exit code by itself.

## Open decisions

- Whether this belongs in the main free test workflow or a factory-specific workflow.
- Whether CI should upload the JSON summary as an artifact on every run or failures only.
- Whether to add a package script after the direct `bin/` command has proven useful.
