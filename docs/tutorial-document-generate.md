# Tutorial: generate docs for a feature in 90 seconds

You'll run `/document-generate` against a project you already have, watch it write tutorial / how-to / reference / explanation docs in the right places, and end with a coverage map you can drop into a PR. By the end, you'll know the four moves: scope, archaeology, partition, write.

## What you'll need

- gstack installed (`git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`)
- Claude Code running in any project that has at least one piece of public surface (a CLI command, an exported function, a config option, a skill, an API endpoint)
- About 90 seconds

You do not need a `docs/` directory in advance — the skill creates one if it's missing. You do not need to know Diataxis terminology — the skill labels the output for you.

## Step 1: Invoke the skill in any project

Open Claude Code in the project you want to document. Type:

```
/document-generate
```

You'll see the skill ask one question about output target:

```
A) Write documentation inline in existing files (README, ARCHITECTURE, etc.)
B) Create standalone documentation files (e.g., docs/ directory)
C) Both — inline summaries in existing files + deep docs in standalone files

RECOMMENDATION: Choose C because it maximizes both discoverability and depth.
```

Pick C. You'll get a README pointer plus a full set of standalone docs.

## Step 2: Watch the archaeology run

The skill goes silent for ~30 seconds while it reads the codebase. This is intentional — the Step 1 "Codebase Archaeology" phase is the most important step in the workflow. The skill is reading:

- The full repository structure
- README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md (the entry points)
- The implementation files for whatever you're documenting (full file, not just signatures)
- The tests (which reveal edge cases and intended behavior)
- Inline comments tagged `// NOTE:`, `// DESIGN:`, `// WHY:`

When it finishes, you'll see a line like:

```
Researched 47 files, identified 12 public surface items, 8 concepts, and 4 design decisions.
```

That number tells you the skill actually read the code rather than guessing from filenames.

## Step 3: See the Diataxis partition plan

The skill prints a partition plan showing which quadrants it'll write for which entity:

```
Documentation plan:
  [entity]              [tutorial] [how-to] [reference] [explanation]
  WidgetService         ✅ new     ✅ new   ✅ new      ✅ new
  --verbose flag        ❌        ✅ new   ✅ inline   ❌
  Bayesian scheduler    ❌        ❌       ✅ new      ✅ new
```

Not every entity needs all four quadrants. CLI flags get reference + how-to. Internal modules get reference + explanation. User-facing features get all four. The skill picks based on entity type.

If the plan has more than 5 documents, the skill asks you to confirm before proceeding. Otherwise it goes.

## Step 4: Read the first doc that lands

Reference docs land first because they fix the vocabulary. You'll see lines like:

```
GENERATED: docs/reference-widget-service.md
```

Open that file. It has a strict structure: one-paragraph intro, complete API listing with types and defaults, 2-3 runnable examples, and a Related section linking to the how-to and tutorial that will land next.

This is what reference docs look like in Diataxis: factual, exhaustive, no narrative. If you find yourself wanting to explain *why* an option exists, that belongs in the explanation doc the skill will write next.

## Step 5: See the explanation, how-to, and tutorial appear

In quick succession (each ~5-10 seconds), the skill writes the remaining quadrants:

```
GENERATED: docs/explanation-widget-architecture.md
GENERATED: docs/howto-create-a-custom-widget.md
GENERATED: docs/tutorial-build-your-first-widget.md
```

Open each one. Notice they don't repeat each other:

- **Explanation** leads with the problem, then the approach, then trade-offs and alternatives considered
- **How-to** has prerequisites, numbered steps with exact commands, a verification section, and a troubleshooting section
- **Tutorial** gets you to a working result in under 3 steps, ends with "What you built"

The skill enforces these structures. If a how-to was missing a verification section, the Step 8 Quality Self-Review caught it before commit.

## Step 6: Check cross-linking

Every doc links to the others. Reference doc Related section: links to how-to and tutorial. How-to Related section: links to reference. Tutorial "What you built" section: links to reference for deeper exploration.

Run a grep to verify no broken links:

```bash
grep -rE '\]\([^)]*\.md\)' docs/ | head -10
```

Every linked file should exist. The skill's Step 7 "Cross-Document Linking & Discoverability" checks this before commit.

## Step 7: See the coverage summary in the PR body

If you're on a feature branch with an open PR, the skill updates the PR body with a `## Documentation Generated` table:

```
## Documentation Generated

| File | Quadrant | Description |
|------|----------|-------------|
| docs/tutorial-build-your-first-widget.md | Tutorial | Walk-through from install to first working widget |
| docs/reference-widget-service.md | Reference | Complete widget API with types, defaults, examples |
| docs/explanation-widget-architecture.md | Explanation | Why widgets are isolated services |
| docs/howto-create-a-custom-widget.md | How-to | Creating and registering custom widgets |
```

A reviewer opening the PR sees the table and knows immediately what kind of coverage shipped.

## What you built

You now have four documents that serve four different readers:

- A newcomer to your project can read `tutorial-*.md` and get something working
- An experienced user can read `howto-*.md` to accomplish a specific task
- An API caller can read `reference-*.md` for exact signatures
- A code reviewer can read `explanation-*.md` to understand the design

Each one is short enough to maintain. Each one has a single job. The PR body shows which quadrants were covered. If you run `/document-release` later, the Diataxis coverage map will report this entity as fully covered (4/4 quadrants).

## What to do next

- **If you have gaps** /document-release flagged but didn't fill: run `/document-generate` again, scoped to those entities specifically.
- **If you want to understand why the four quadrants exist:** read [explanation-diataxis-in-gstack.md](./explanation-diataxis-in-gstack.md).
- **If you want to document one specific shipped feature** (not the whole project): read [howto-document-a-shipped-feature.md](./howto-document-a-shipped-feature.md).
- **Reference for the skill itself:** [`document-generate/SKILL.md`](../document-generate/SKILL.md).
