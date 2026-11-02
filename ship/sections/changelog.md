<!-- AUTO-GENERATED from changelog.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 13: CHANGELOG (auto-generate)

1. Read `CHANGELOG.md` header to know the format.

2. **First, enumerate every commit on the branch:**
   ```bash
   git log origin/<base>..HEAD --oneline
   ```
   Copy the full list. Count the commits. You will use this as a checklist.

3. **Read the full diff** to understand what each commit actually changed:
   ```bash
   git diff origin/<base>
   ```

4. **Group commits by theme** before writing anything. Common themes:
   - New features / capabilities
   - Performance improvements
   - Bug fixes
   - Dead code removal / cleanup
   - Infrastructure / tooling / tests
   - Refactoring

5. **Write the CHANGELOG entry** covering ALL groups:
   - If existing CHANGELOG entries on the branch already cover some commits, replace them with one unified entry for the new version
   - Categorize changes into applicable sections:
     - `### Added` — new features
     - `### Changed` — changes to existing functionality
     - `### Fixed` — bug fixes
     - `### Removed` — removed features
   - Write concise, descriptive bullet points
   - Insert after the observed file header, before the first release entry, dated today
   - Format: `## [X.Y.Z.W] - YYYY-MM-DD`
   - **Voice:** Lead with what the user can now **do** that they couldn't before. Use plain language, not implementation details. Never mention TODOS.md, internal tracking, or contributor-facing details.

6. **Cross-check:** Compare your CHANGELOG entry against the commit list from step 2.
   Every user-facing change in that list must be represented; add any that is missing.
   Commits with no user-facing effect (merges, version bumps, fixes to work introduced
   earlier on this branch) need no bullet. The entry must reflect every user-facing theme.

**Do NOT ask the user to describe changes.** Infer from the diff and commit history.

7. **Lint the entry:** `~/.claude/skills/gstack/bin/gstack-prose-lint CHANGELOG.md --base origin/<base> --gate` reads only the lines this branch added; rewrite each `PROSE:` line it names and rerun until the trailer is `PROSE_LINT: ok`.

**NO_VERSION (Step 12):** skip this step; write no CHANGELOG entry or version header.

**Kept (Step 12 `VERSION: <v> kept`):** no version header. Put the entry where the repo's own rule
puts unit-PR notes (its CHANGELOG preamble or a fragment directory it names), else under
`## [Unreleased]`, never under a released heading.

**No CHANGELOG:** when the policy's `changelog` is `null`, or the file it names
(`CHANGELOG.md` by default) is absent at HEAD, print one line,
`CHANGELOG: skipped (none at <path>)`, write nothing and never create the file;
Step 19's PR body carries the release notes instead. A repository with neither a
version source nor a CHANGELOG ships with both lines printed and a receipt whose
`version` is `"none"` (docs/ship-policy.md#ship-receipt).

---
