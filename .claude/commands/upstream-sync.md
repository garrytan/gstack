# Upstream Sync

Sync this fork with the upstream garrytan/gstack repo, resolve conflicts, push, and install locally.

## Step 0: Ensure clean working tree

```bash
git status --porcelain
```

If there are uncommitted changes, ask the user whether to stash them or abort.

## Step 1: Fetch upstream

```bash
git remote add upstream https://github.com/garrytan/gstack.git 2>/dev/null || true
git fetch upstream main
```

## Step 2: Record current version and preview incoming changes

Save the current version before merging so we can diff changelogs accurately:

```bash
cat VERSION
```

Remember this as OLD_VERSION.

Show what's new from upstream before merging:

```bash
git log --oneline HEAD..upstream/main
```

If there are no new commits, tell the user "Already up to date with upstream" and skip to Step 6.

## Step 3: Merge upstream

```bash
git merge upstream/main --no-edit
```

If the merge succeeds with no conflicts, skip to Step 4.

### Conflict resolution

If there are merge conflicts, resolve them using these rules from CLAUDE.md:

1. **Generated SKILL.md files:** accept either side, then run `bun run gen:skill-docs` to regenerate.
2. **office-hours/SKILL.md.tmpl:** accept upstream's version, then re-remove Phase 4.5 (Founder Signal Synthesis), Phase 6 (Handoff — Founder Discovery), and YC branding.
3. **URL-only files** (README, bin/gstack-update-check, gstack-upgrade/SKILL.md.tmpl): keep our `donovan-yohan/gstack-adfree` URLs.
4. **Everything else:** review the conflict and resolve sensibly — prefer upstream's logic changes, keep our fork-specific customizations.

After resolving all conflicts:
```bash
bun run gen:skill-docs
git add -A
git commit --no-edit
```

## Step 4: Validate

Run the free test suite to make sure nothing broke:

```bash
bun run gen:skill-docs
bun test test/skill-validation.test.ts
```

If tests fail, fix the issues before proceeding.

## Step 5: Push to origin

```bash
git push origin main
```

## Step 6: Install locally via /gstack-upgrade

Run the `/gstack-upgrade` skill to pull the latest from our fork into the local skill install at `~/.claude/skills/gstack/`.

## Step 7: Summary

Read CHANGELOG.md and find ALL version entries between OLD_VERSION (from Step 2) and
the current version after merge. This may span multiple releases if we haven't synced
in a while.

Provide a summary with:
- Version jump (e.g. "v0.15.2.0 → v0.17.0.0")
- How many commits were merged from upstream
- **All changes across every version since OLD_VERSION**, grouped by theme (not by version).
  Read each `## [x.y.z.0]` section in CHANGELOG.md that's newer than OLD_VERSION.
- Any conflicts that were resolved and how
- Whether tests passed
- Whether the local install was updated
