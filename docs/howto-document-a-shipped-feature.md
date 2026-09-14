# How to document a feature you just shipped

This is the post-ship workflow: you merged a PR, the docs are stale, and you want a coverage map plus filled gaps in one pass. You'll run `/document-release` to audit, then `/document-generate` to fill the gaps it finds.

## Prerequisites

- gstack installed (`./setup` complete; verify with `which gstack` or by typing `/` in Claude Code and seeing skills listed)
- The branch with your shipped feature is checked out
- A PR exists on GitHub or GitLab (recommended — the workflow updates the PR body with a coverage map)

If no PR exists yet, run `/ship` first to create one; that's what `/document-release` is designed to run against.

## Steps

### 1. Audit current coverage

Run:

```
/document-release
```

The skill walks your diff against the base branch, extracts new public surface (skills, CLI flags, config options, API endpoints, new modules), and scores each entity across the four Diataxis quadrants. You'll see a coverage map like:

```
Coverage map:
  [entity]         [reference?] [how-to?] [tutorial?] [explanation?]
  /new-skill       ✅ AGENTS.md  ❌        ❌          ❌
  --new-flag       ✅ README     ✅ README  ❌          ❌
  FooProcessor     ❌            ❌        ❌          ❌
```

Items with zero coverage are **critical gaps**. Items with only reference coverage are **common gaps**. Both land in the PR body as a `### Documentation Debt` subsection so reviewers see them.

If `/document-release` reports everything is covered, you're done. Skip the rest of this how-to.

### 2. Read the documentation debt section in the PR body

Open your PR (the skill prints the URL). Scroll to `## Documentation` → `### Documentation Debt`. Each item is tagged with the Diataxis quadrant that would fill it:

```
### Documentation Debt

- ⚠️ /new-skill — has reference in AGENTS.md but no how-to example in README. Diataxis quadrant: how-to.
- ⚠️ FooProcessor — zero coverage. Diataxis quadrants: reference, explanation.
```

This is the input to the next step. Each line tells you what's missing and which quadrant fills it.

### 3. Fill the gaps with /document-generate

Run:

```
/document-generate
```

When the skill asks about scope, tell it the specific entities flagged in the debt section. The skill reads the codebase (its Step 1 archaeology phase is mandatory), partitions by Diataxis quadrant, and writes the missing docs.

You can also let the skill auto-discover: if /document-release passed you the gaps explicitly (it does this when chained), `/document-generate` already knows what to write.

### 4. Verify the gaps closed

Re-run `/document-release`:

```
/document-release
```

The coverage map should now show the previously-flagged entities with green checkmarks in the previously-empty quadrants. The PR body's Documentation Debt section should be empty or reduced to items you intentionally deferred.

## Verification

Open your PR and confirm:

1. The PR body has a `## Documentation` section with a doc-diff preview.
2. The `### Documentation Debt` subsection lists zero critical gaps (or only items you knowingly deferred).
3. Each generated doc file in `docs/` opens cleanly and cross-links to siblings (reference → how-to → tutorial → explanation).
4. Run `grep -rE '\]\([^)]*\.md\)' docs/` and verify no link points to a missing file.

If all four check, your PR is ready to land with complete documentation.

## Troubleshooting

**`/document-release` reports "No public surface changes detected."**
The diff is internal-only (refactors, tests, infra). No docs are needed. Skip to landing.

**The Diataxis quadrant tag on a gap doesn't match what you'd expect.**
The skill uses an entity taxonomy to decide which quadrants matter (CLI flags want reference + how-to; internal modules want reference + explanation; user-facing features want all four). If you disagree, you can override by hand-editing the docs after generation. The audit is a guide, not a constraint.

**`/document-generate` writes a tutorial that takes 8 steps to reach a working result.**
Tutorials should hit a working result in 3 steps or fewer. Re-run the skill and ask it to compress, or hand-edit. The Step 8 Quality Self-Review catches some of these but not all.

**You want to document a feature but no PR exists yet.**
Run `/ship` first to create the PR, then this workflow. Without a PR, `/document-release` can still audit but skips the PR-body update.

**A generated reference doc has hallucinated API signatures.**
File a bug. The skill's Step 1 archaeology is supposed to read implementation files end-to-end, not just signatures, specifically to prevent this. Include the generated text and the actual code so we can trace why the archaeology missed it.

## Related

- **Tutorial: first time using `/document-generate`:** [tutorial-document-generate.md](./tutorial-document-generate.md)
- **Why gstack uses the Diataxis framework:** [explanation-diataxis-in-gstack.md](./explanation-diataxis-in-gstack.md)
- **Reference for the audit skill:** [`document-release/SKILL.md`](../document-release/SKILL.md)
- **Reference for the generation skill:** [`document-generate/SKILL.md`](../document-generate/SKILL.md)
