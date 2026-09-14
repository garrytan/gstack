<!-- AUTO-GENERATED from changelog.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 13: CHANGELOG (auto-generate)

1. Read `CHANGELOG.md` header to know the format.

2. **First, enumerate every commit on the branch:**
   ```bash
   git log <base>..HEAD --oneline
   ```
   Copy the full list. Count the commits. You will use this as a checklist.

3. **Read the full diff** to understand what each commit actually changed:
   ```bash
   git diff <base>...HEAD
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
   - Insert after the file header (line 5), dated today
   - Format: `## [X.Y.Z.W] - YYYY-MM-DD`
   - **Voice:** Lead with what the user can now **do** that they couldn't before. Use plain language, not implementation details. Never mention TODOS.md, internal tracking, or contributor-facing details.

6. **Cross-check:** Compare your CHANGELOG entry against the commit list from step 2.
   Every commit must map to at least one bullet point. If any commit is unrepresented,
   add it now. If the branch has N commits spanning K themes, the CHANGELOG must
   reflect all K themes.

**Do NOT ask the user to describe changes.** Infer from the diff and commit history.

---
