# Pi Factory Distribution Package Path

Status: proposed packaging and install strategy for shipping the Pi factory runtime to non-developer users while preserving the current repo-driven developer workflow.

## Goal

Define how the Pi-specific gstack runtime should ship as one coherent product surface for:

- generated Pi skills under `.pi/skills/`;
- the Pi extension under `.pi/extensions/pi-gstack/`;
- the future Universe AI Software Factory cockpit path;
- internal/private pilots first, and public/common-user distribution later.

This is a design document only. It does not publish a package, add dependencies, change `package.json`, or change the roadmap.

## Current state

Pi support already exists in source form.

### Pi generation and install behavior today

Pi host config (`hosts/pi.ts`) defines:

- global runtime root: `~/.pi/agent/skills/gstack`;
- repo-local runtime root: `.pi/skills/gstack`;
- generated Pi host output under repo-local `.pi/`;
- generated skill directory names like `gstack-review` and `gstack-ship`;
- non-prefixable install behavior;
- runtime sidecars that Pi skills expect through `$GSTACK_ROOT`.

`./setup --host pi` currently does four important things:

1. runs `bun run gen:skill-docs --host pi`;
2. creates a repo-local runtime root at `.pi/skills/gstack`;
3. creates a global Pi runtime root at `~/.pi/agent/skills/gstack` plus top-level discoverable skill links like `~/.pi/agent/skills/gstack-review`;
4. installs the Pi extension at `~/.pi/agent/extensions/gstack`.

The setup helpers intentionally preserve unmanaged Pi runtime roots instead of overwriting them.

### How the extension finds Pi skills today

The extension resolves its repo root relative to `.pi/extensions/pi-gstack/index.ts` and advertises:

```ts
return { skillPaths: [GENERATED_PI_SKILLS_DIR] };
```

where `GENERATED_PI_SKILLS_DIR` is:

```ts
join(REPO_ROOT, '.pi', 'skills')
```

That means the extension expects the Pi-generated skill tree to live next to the extension in a stable relative layout.

### What is not packaged today

Today the Pi path is source-checkout oriented:

- `.pi/skills/` is gitignored;
- generated Pi skills are validated by tests but not committed as source-of-truth output;
- setup may build binaries locally via `bun run build` when needed;
- the installed Pi runtime is mostly a network of symlinks back into a working checkout.

That is good for developers, but not friendly for common users.

## Distribution problem

The current repo-driven path assumes users can tolerate:

- a git clone;
- Bun installation;
- local binary compilation when outputs are stale;
- symlinked runtime assets;
- Pi-specific filesystem concepts like `.pi/skills`, `.pi/extensions`, and `$GSTACK_ROOT`;
- slash-skill naming like `/skill:gstack-review`.

That is acceptable for internal builders and repo contributors. It is not the right default for a common-user-friendly Universe AI Software Factory product.

The main packaging requirement is therefore:

> **Ship Pi as one versioned runtime bundle, not as a source checkout that end users must understand or rebuild.**

## Design principles

1. **One installable unit for Pi runtime behavior.**
   - Generated Pi skills, runtime sidecars, and the Pi extension must move together.
   - Mixed versions are unsafe because the extension depends on relative layout and the skills depend on the sidecars exposed through `$GSTACK_ROOT`.

2. **Do not make generated `.pi/skills/` source-controlled application code.**
   - Keep `.pi/skills/` generated in the source repo.
   - Package the generated output into a release artifact for end users.

3. **Preserve the current relative-path contract.**
   - The packaged layout should still place `.pi/extensions/pi-gstack` and `.pi/skills` in the same bundle tree.
   - This avoids extension-specific path rewrites just for packaging.

4. **Keep developer mode and packaged mode separate.**
   - Source checkout installs are still the right path for local iteration.
   - Packaged installs should not require a mutable repo checkout.

5. **Version Pi atomically at the repo level.**
   - Use `VERSION` / `package.json` version as the package version.
   - Do not treat per-skill frontmatter `version:` fields as distribution versions.

6. **Universe AI should hide implementation jargon.**
   - Public/common-user UX should say “Universe AI Software Factory,” not “install gstack Pi skills and extension sidecars.”
   - Internal directory structure remains an implementation detail.

## 1. Ship two modes, not one

### A. Source/developer mode

Keep the current workflow for contributors and internal rapid iteration:

- clone repo;
- run `./setup --host pi`;
- generate `.pi/skills/` locally;
- install symlinks into `~/.pi/agent/skills` and `~/.pi/agent/extensions`;
- allow worktree-specific testing and extension development.

This mode is authoritative for development because:

- the generator and tests live in the repo;
- the extension currently points at repo-relative `.pi/skills`;
- worktree-local `.pi/skills/gstack` is useful for iterative Pi testing.

### B. Packaged/non-dev mode

For non-developer users, ship a **minimal Pi runtime bundle** produced from the repo, not the repo itself.

That bundle should contain the Pi runtime outputs that the current setup logic already assembles:

- `.pi/extensions/pi-gstack/`;
- `.pi/skills/gstack-*` generated Pi skill directories;
- `.pi/skills/gstack/` runtime root;
- the runtime assets that `link_pi_runtime_assets()` currently exposes:
  - `bin/`
  - `browse/dist`
  - `browse/bin`
  - `design/dist`
  - `make-pdf/dist`
  - `gstack-upgrade/SKILL.md`
  - `review/checklist.md`
  - `review/design-checklist.md`
  - `review/greptile-triage.md`
  - `review/TODOS-format.md`
  - `qa/templates`
  - `qa/references`
  - `plan-devex-review/dx-hall-of-fame.md`
  - `ETHOS.md`

In other words: **package the installed Pi runtime shape, not the full development repo shape**.

## 2. Package generated `.pi/skills/` as build output, not source

Recommended rule:

- **In source control:** keep `.pi/skills/` generated and gitignored.
- **In packaged distribution:** include the generated Pi skill tree as release content.

Why:

- the roadmap explicitly avoids committing generated `.pi/skills/` until a distribution plan exists;
- `scripts/gen-skill-docs.ts` and `test/gen-skill-docs.test.ts` already treat host output as generated material;
- non-dev users should not need to run a generator just to get working skills.

Recommended build path for a Pi bundle:

1. run `bun run build` or, at minimum, `bun run gen:skill-docs --host pi` plus any required runtime builds;
2. validate Pi generation with the existing Pi-focused tests;
3. stage the minimal Pi bundle layout;
4. publish or distribute that staged bundle through a private/internal or public channel.

### Why bundle the generated output

The generated Pi skill content already bakes in Pi-specific rules that matter at runtime:

- AGENTS.md rewrites instead of `CLAUDE.md`;
- `$GSTACK_ROOT`, `$GSTACK_BROWSE`, `$GSTACK_DESIGN`, `$GSTACK_MAKE_PDF` path assumptions;
- `/skill:gstack-*` command rewrites;
- Pi-only instructions like “ask_user_question is the Pi custom tool”;
- `disable-model-invocation: true` on sensitive skills.

Those are runtime deliverables, not just dev artifacts.

## 3. Use one package version for extension + skills + runtime sidecars

Recommended version contract:

- package version source of truth: `VERSION` and matching `package.json.version`;
- bundle version = extension version = generated Pi skill-set version = runtime sidecar version.

Do **not** version these independently for distribution:

- `.pi/extensions/pi-gstack`;
- `.pi/skills/gstack-*`;
- `.pi/skills/gstack` runtime root.

Reason:

- `index.ts` in the Pi extension assumes a fixed relative layout;
- generated skill content assumes specific sidecar paths and runtime files;
- setup currently installs them together, which is the right dependency boundary.

### Recommended manifest behavior

The final packaged bundle should carry a tiny install manifest or version marker that records at least:

- package version;
- source git SHA if available;
- host = `pi`;
- bundle build timestamp.

This is a recommendation, not a shipped file today. The goal is operational clarity during upgrades and support.

## 4. Install UX: developer path vs common-user path

### Developer install UX

Keep the current explicit command-driven path:

```bash
./setup --host pi
```

This remains the right path when the user is:

- editing the repo;
- testing worktrees;
- changing templates, setup logic, or the extension;
- validating Pi runtime behavior before packaging.

### Common-user install UX

For non-dev users, the install story should become:

- one branded installer or one guided setup flow;
- no visible `git clone`;
- no visible `bun install`;
- no requirement to understand `./setup --host pi`;
- no expectation that users know what a generated skill tree is.

The installer can still reuse the same underlying layout and validation logic, but the UX should say things like:

- “Install Universe AI Software Factory for Pi”;
- “Universe AI needs to update”;
- “Restart Pi to finish applying the update” if necessary.

It should **not** say things like:

- “Generate `.pi/skills/`”;
- “Link runtime sidecars”;
- “Install the Pi extension symlink.”

## 5. Update UX and upgrade behavior

### Source/developer upgrade path

Keep the existing source-oriented model:

- update checkout;
- rerun `./setup --host pi`;
- rerun migrations through the existing gstack upgrade path when applicable.

### Packaged/non-dev upgrade path

Recommended behavior:

1. download or stage the full new Pi bundle;
2. verify it is complete;
3. switch the stable Pi install pointers only after the bundle is ready;
4. run post-install migrations if the release requires them;
5. preserve rollback ability until the new bundle is known-good.

This should be treated as an **atomic bundle swap**, not a partial file-by-file mutation.

That matches the architecture better than trying to update:

- the extension first;
- some generated skills later;
- runtime sidecars after that.

### Migration policy

The existing repo already has a migration concept under `gstack-upgrade/migrations/`.
That should remain the mechanism for cross-version state fixes.

However, Pi packaged distribution needs two explicit rules:

1. **Pi runtime layout migrations must be first-class.**
   - Today the migration set is generic and Claude-oriented enough that Pi-specific install-layout cleanup is not yet a defined release contract.
   - The first packaged Pi rollout should add Pi-aware migration coverage when directory structure changes.

2. **Unmanaged user content must be preserved by default.**
   - Current setup already preserves unmanaged Pi runtime roots.
   - Packaged upgrades should keep that fail-safe posture.

## 6. Migration/adoption path for existing Pi users

There will be at least three install populations.

### A. Existing source-checkout Pi users

These users likely have:

- `~/.pi/agent/extensions/gstack` pointing into a git checkout;
- `~/.pi/agent/skills/gstack` and `gstack-*` links pointing into that same checkout;
- repo-local `.pi/skills/` generated beside source.

Recommended adoption behavior for the first packaged installer:

- detect that the current Pi install points into a git checkout;
- offer two modes:
  - **Keep developer mode**;
  - **Adopt packaged mode**.

If the user chooses packaged mode:

- install the packaged bundle;
- repoint stable Pi skill and extension links to the packaged bundle;
- leave the source checkout untouched.

### B. Existing managed Pi runtime roots

If the current runtime root is clearly gstack-managed, packaged adoption can update in place.

### C. Existing unmanaged/custom Pi roots

If the target Pi runtime root or extension path contains user-managed content, the installer should preserve current behavior:

- warn;
- do not overwrite;
- require the user to move or approve replacement.

This matches current setup’s conservative stance and avoids silent destruction of custom Pi setups.

## 7. Local dev vs packaged distribution

| Topic | Local dev / source mode | Packaged / non-dev mode |
|---|---|---|
| Authority | repo checkout | staged Pi bundle |
| Skill generation | local `gen:skill-docs --host pi` | generated before distribution |
| Runtime assets | symlinked from checkout | materialized in bundle |
| Extension path | symlink into checkout | stable link into packaged bundle |
| Binary production | local build when stale | prebuilt per release |
| Best for | contributors, internal iteration, worktrees | pilots, employees, customers |
| User mental model | developer tooling | product install |

## 8. Private/internal vs public distribution

### Private/internal

Recommended short-term path:

- keep using the existing gstack engine and Pi install shape;
- allow source-based installs for fast iteration;
- optionally distribute a private packaged Pi bundle for non-engineering pilot users;
- preserve direct access to advanced slash-skill flows and inspectability.

This is the right channel for:

- internal dogfooding;
- design validation;
- early operator/founder pilots;
- testing the Universe AI cockpit concept before broad release.

### Public/common-user

Recommended public path:

- ship a branded Universe AI Software Factory distribution on top of the Pi runtime bundle;
- make the bundle installer the default path;
- treat raw skill directories and Pi file paths as hidden implementation details;
- expose “hands-on” skill-level affordances only as an advanced mode.

For public users, the runtime engine can still be gstack-based internally, but the product should present:

- a project dashboard;
- a resume-first cockpit;
- visible approvals and evidence;
- easy mode by default;
- careful escalation into hands-on mode.

That matches the external design direction much better than exposing a bare library of slash skills as the primary product.

## 9. Universe AI cockpit path

The current web-app planning docs explicitly say:

- no production web app is shipped yet;
- P0 is a mocked prototype;
- project/workspace concepts should wrap the run-scoped facade later.

So the correct distribution stance today is:

- **do not pretend the cockpit is a shipping production package yet**;
- **treat the Pi runtime bundle as the first shippable engine slice**;
- **treat the cockpit as the future default shell for public/common-user distribution**.

### Recommended cockpit relationship to Pi distribution

When the cockpit becomes real, it should sit **above** the Pi runtime bundle, not replace it.

Proposed layering:

```text
Universe AI product shell / cockpit
  project + workspace views
  approvals, artifacts, evidence, resume UI
  easy mode / hands-on mode

Pi runtime bundle
  extension
  generated Pi skills
  runtime sidecars
  factory commands and tools

Factory core + facade
  run-scoped contracts
  event/artifact stores
  workflow execution
```

That layering fits the current architecture and the wireframes:

- dashboard and resume are first-class;
- easy mode hides most low-level mechanics;
- hands-on mode can still expose more of the underlying factory.

### Why this matters for common-user positioning

The Universe AI wireframes and web UX brief push toward:

- obvious resume state;
- visible decisions first;
- “Easy Mode” as the normal path;
- “Hands-on Mode” as an explicit opt-in;
- ship readiness clearly separated from deployment;
- artifacts and evidence more prominent than chat.

A common-user-friendly distribution path therefore should:

1. install the Pi engine as a background capability layer;
2. make the cockpit the primary surface when it is ready;
3. keep direct skill invocation available for advanced/internal users;
4. avoid teaching common users Pi-specific filesystem or packaging vocabulary.

## 10. Recommended release contract

The Pi distribution should release as a **single Pi runtime bundle per version** with these rules:

1. Build generated Pi skills from source at release time.
2. Bundle the generated Pi skill tree.
3. Bundle the Pi extension.
4. Bundle the runtime sidecars Pi skills require.
5. Use one repo version for all of the above.
6. Install by stable Pi paths, but stage from a managed bundle.
7. Preserve developer/source mode separately.
8. Treat cockpit/product branding as the public-facing shell, not the raw runtime internals.

## 11. Non-goals for this slice

This document does **not** recommend:

- committing generated `.pi/skills/` into the repo as source;
- publishing a package right now;
- changing the web stack or shipping the cockpit immediately;
- adding dependencies;
- changing `package.json` or the roadmap;
- exposing `/factory-qa-fix` before the safe-command runtime guard exists.

## 12. Follow-up work after this doc is accepted

1. Define the exact Pi bundle staging layout and install manifest.
2. Decide whether public bundles are platform-specific prebuilt artifacts, source-less bundles, or both.
   - Current build behavior suggests platform-specific prebuilt bundles are the right common-user path because browse/design/make-pdf are compiled outputs.
3. Add Pi-specific upgrade/adoption tests for packaged installs.
4. Decide which raw gstack skills remain visible in the first Universe AI public release.
5. When cockpit work is approved, define how the product shell and Pi runtime bundle share a release train without coupling web rollout to source checkout semantics.

## Bottom line

The right package path is **not** “teach non-dev users to clone gstack and run `./setup --host pi`.”

The right package path is:

- keep that source flow for developers;
- generate `.pi/skills/` at build time;
- bundle the Pi extension, generated skills, and runtime sidecars together;
- version them as one unit;
- install them through a managed Pi bundle;
- let Universe AI Software Factory present the friendly cockpit and easy-mode experience on top of that engine.
