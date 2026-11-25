# How to document a feature before it ships

This is the pre-merge documentation workflow: the feature is implemented and you want to audit coverage and fill gaps. `/gstack-ship` already runs the relevant documentation audit before publication; use standalone `/document-release` on a committed feature branch to revisit it, then `/document-generate` for missing pages.

## Prerequisites

- gstack installed (`./setup` complete; verify with `which gstack` or by typing `/` in Claude Code and seeing skills listed)
- The committed feature branch is checked out, before merge
- Optional: an existing GitHub or GitLab PR lets standalone `/document-release` update its body with the coverage map

No PR is required to audit. `/gstack-ship` runs its audit before creating or updating the PR; a standalone invocation without a PR skips the PR-body update.

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

Items with zero coverage are **critical gaps**. Items with only reference coverage are **common gaps**. The audit reports both; when a PR exists, it also adds a `### Documentation Debt` subsection for reviewers.

If `/document-release` reports everything is covered, you're done. Skip the rest of this how-to.

### 2. Read the reported documentation gaps

Use the audit's coverage map and gap summary. If a PR exists, open `## Documentation` → `### Documentation Debt` in its body. Each item is tagged with the Diataxis quadrant that would fill it:

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

The coverage map should now show the previously-flagged entities with green checkmarks in the previously-empty quadrants. Reported documentation debt, including the PR-body section when present, should be empty or reduced to items you intentionally deferred.

## Verification

Read the audit output and, when present, the PR body. Confirm:

1. The audit summarizes the docs reviewed and changed; an existing PR has a `## Documentation` section with a doc-diff preview.
2. The reported documentation debt lists zero critical gaps (or only items you knowingly deferred).
3. Each generated doc file in `docs/` opens cleanly and cross-links to siblings (reference → how-to → tutorial → explanation).
4. Run `grep -rE '\]\([^)]*\.md\)' docs/` and verify no link points to a missing file.

These checks complete the documentation pass, with any deferred gaps recorded. They do not replace `/gstack-ship`'s code review, tests or final verification.

## Troubleshooting

**`/document-release` reports "No public surface changes detected."**
There may be no new public surface, but still check affected setup, testing, architecture and workflow instructions. A completed audit can report current documentation; an empty public-surface map alone is not that audit.

**The Diataxis quadrant tag on a gap doesn't match what you'd expect.**
The skill uses an entity taxonomy to decide which quadrants matter (CLI flags want reference + how-to; internal modules want reference + explanation; user-facing features want all four). If you disagree, you can override by hand-editing the docs after generation. The audit is a guide, not a constraint.

**`/document-generate` writes a tutorial that takes 8 steps to reach a working result.**
Tutorials should hit a working result in 3 steps or fewer. Re-run the skill and ask it to compress, or hand-edit. The Step 8 Quality Self-Review catches some of these but not all.

**You want to document a feature but no PR exists yet.**
Run standalone `/document-release` on the committed feature branch; it can audit without a PR and skips the PR-body update. Or run `/gstack-ship`, which includes the audit before publication.

**A generated reference doc has hallucinated API signatures.**
File a bug. The skill's Step 1 archaeology is supposed to read implementation files end-to-end, not just signatures, specifically to prevent this. Include the generated text and the actual code so we can trace why the archaeology missed it.

## Related

- **Tutorial: first time using `/document-generate`:** [tutorial-document-generate.md](./tutorial-document-generate.md)
- **Why gstack uses the Diataxis framework:** [explanation-diataxis-in-gstack.md](./explanation-diataxis-in-gstack.md)
- **Reference for the audit skill:** [`document-release/SKILL.md`](../document-release/SKILL.md)
- **Reference for the generation skill:** [`document-generate/SKILL.md`](../document-generate/SKILL.md)
