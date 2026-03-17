#!/usr/bin/env bun
/**
 * Generate SKILL.md files from .tmpl templates.
 *
 * Pipeline:
 *   read .tmpl → find {{PLACEHOLDERS}} → resolve from source → format → write .md
 *
 * Supports --dry-run: generate to memory, exit 1 if different from committed file.
 * Used by skill:check and CI freshness checks.
 */

import { COMMAND_DESCRIPTIONS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Placeholder Resolvers ──────────────────────────────────

function generateCommandReference(): string {
  // Group commands by category
  const groups = new Map<string, Array<{ command: string; description: string; usage?: string }>>();
  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const list = groups.get(meta.category) || [];
    list.push({ command: cmd, description: meta.description, usage: meta.usage });
    groups.set(meta.category, list);
  }

  // Category display order
  const categoryOrder = [
    'Navigation', 'Reading', 'Interaction', 'Inspection',
    'Visual', 'Snapshot', 'Meta', 'Tabs', 'Server',
  ];

  const sections: string[] = [];
  for (const category of categoryOrder) {
    const commands = groups.get(category);
    if (!commands || commands.length === 0) continue;

    // Sort alphabetically within category
    commands.sort((a, b) => a.command.localeCompare(b.command));

    sections.push(`### ${category}`);
    sections.push('| Command | Description |');
    sections.push('|---------|-------------|');
    for (const cmd of commands) {
      const display = cmd.usage ? `\`${cmd.usage}\`` : `\`${cmd.command}\``;
      sections.push(`| ${display} | ${cmd.description} |`);
    }
    sections.push('');
  }

  return sections.join('\n').trimEnd();
}

function generateSnapshotFlags(): string {
  const lines: string[] = [
    'The snapshot is your primary tool for understanding and interacting with pages.',
    '',
    '```',
  ];

  for (const flag of SNAPSHOT_FLAGS) {
    const label = flag.valueHint ? `${flag.short} ${flag.valueHint}` : flag.short;
    lines.push(`${label.padEnd(10)}${flag.long.padEnd(24)}${flag.description}`);
  }

  lines.push('```');
  lines.push('');
  lines.push('All flags can be combined freely. `-o` only applies when `-a` is also used.');
  lines.push('Example: `$B snapshot -i -a -C -o /tmp/annotated.png`');
  lines.push('');
  lines.push('**Ref numbering:** @e refs are assigned sequentially (@e1, @e2, ...) in tree order.');
  lines.push('@c refs from `-C` are numbered separately (@c1, @c2, ...).');
  lines.push('');
  lines.push('After snapshot, use @refs as selectors in any command:');
  lines.push('```bash');
  lines.push('$B click @e3       $B fill @e4 "value"     $B hover @e1');
  lines.push('$B html @e2        $B css @e5 "color"      $B attrs @e6');
  lines.push('$B click @c1       # cursor-interactive ref (from -C)');
  lines.push('```');
  lines.push('');
  lines.push('**Output format:** indented accessibility tree with @ref IDs, one element per line.');
  lines.push('```');
  lines.push('  @e1 [heading] "Welcome" [level=1]');
  lines.push('  @e2 [textbox] "Email"');
  lines.push('  @e3 [button] "Submit"');
  lines.push('```');
  lines.push('');
  lines.push('Refs are invalidated on navigation — run `snapshot` again after `goto`.');

  return lines.join('\n');
}

function generatePreamble(): string {
  return `## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch, and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** \\\`RECOMMENDATION: Choose [X] because [one-line reason]\\\`
4. **Options:** Lettered options: \\\`A) ... B) ... C) ...\\\`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.`;
}

function generateBrowseSetup(): string {
  return `## SETUP (run this check BEFORE any browse command)

\`\`\`bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
\`\`\`

If \`NEEDS_SETUP\`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: \`cd <SKILL_DIR> && ./setup\`
3. If \`bun\` is not installed: \`curl -fsSL https://bun.sh/install | bash\``;
}

function generateBaseBranchDetect(): string {
  return `## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   \`gh pr view --json baseRefName -q .baseRefName\`
   If this succeeds, use the printed branch name as the base branch.

2. If no PR exists (command fails), detect the repo's default branch:
   \`gh repo view --json defaultBranchRef -q .defaultBranchRef.name\`

3. If both commands fail, fall back to \`main\`.

Print the detected base branch name. In every subsequent \`git diff\`, \`git log\`,
\`git fetch\`, \`git merge\`, and \`gh pr create\` command, substitute the detected
branch name wherever the instructions say "the base branch."

---`;
}

function generateQAMethodology(): string {
  return `## Modes

### Diff-aware (automatic when on a feature branch with no URL)

This is the **primary mode** for developers verifying their work. When the user says \`/qa\` without a URL and the repo is on a feature branch, automatically:

1. **Analyze the branch diff** to understand what changed:
   \`\`\`bash
   git diff main...HEAD --name-only
   git log main..HEAD --oneline
   \`\`\`

2. **Identify affected pages/routes** from the changed files:
   - Route/page files → which URL paths they serve
   - Component files → which pages render them
   - Hook/service/util files → which pages use them (check components that import them)
   - CSS/style files → which pages include those stylesheets
   - API endpoints → test them directly with \`$B js "await fetch('/api/...')"\`
   - Static pages (markdown, HTML) → navigate to them directly

3. **Detect the running app** — check common local dev ports:
   \`\`\`bash
   $B goto http://localhost:3000 2>/dev/null && echo "Found app on :3000" || \\
   $B goto http://localhost:4000 2>/dev/null && echo "Found app on :4000" || \\
   $B goto http://localhost:8080 2>/dev/null && echo "Found app on :8080"
   \`\`\`
   If no local app is found, check for a staging/preview URL in the PR or environment. If nothing works, ask the user for the URL.

4. **Test each affected page/route:**
   - Navigate to the page
   - Take a screenshot
   - Check console for errors
   - If the change was interactive (forms, buttons, flows), test the interaction end-to-end
   - Use \`snapshot -D\` before and after actions to verify the change had the expected effect

5. **Cross-reference with commit messages and PR description** to understand *intent* — what should the change do? Verify it actually does that.

6. **Check TODOS.md** (if it exists) for known bugs or issues related to the changed files. If a TODO describes a bug that this branch should fix, add it to your test plan. If you find a new bug during QA that isn't in TODOS.md, note it in the report.

7. **Report findings** scoped to the branch changes:
   - "Changes tested: N pages/routes affected by this branch"
   - For each: does it work? Screenshot evidence.
   - Any regressions on adjacent pages?

**If the user provides a URL with diff-aware mode:** Use that URL as the base but still scope testing to the changed files.

### Full (default when URL is provided)
Systematic exploration. Visit every reachable page. Document 5-10 well-evidenced issues. Produce health score. Takes 5-15 minutes depending on app size.

### Quick (\`--quick\`)
30-second smoke test. Visit homepage + top 5 navigation targets. Check: page loads? Console errors? Broken links? Produce health score. No detailed issue documentation.

### Regression (\`--regression <baseline>\`)
Run full mode, then load \`baseline.json\` from a previous run. Diff: which issues are fixed? Which are new? What's the score delta? Append regression section to report.

---

## Workflow

### Phase 1: Initialize

1. Find browse binary (see Setup above)
2. Create output directories
3. Copy report template from \`qa/templates/qa-report-template.md\` to output dir
4. Start timer for duration tracking

### Phase 2: Authenticate (if needed)

**If the user specified auth credentials:**

\`\`\`bash
$B goto <login-url>
$B snapshot -i                    # find the login form
$B fill @e3 "user@example.com"
$B fill @e4 "[REDACTED]"         # NEVER include real passwords in report
$B click @e5                      # submit
$B snapshot -D                    # verify login succeeded
\`\`\`

**If the user provided a cookie file:**

\`\`\`bash
$B cookie-import cookies.json
$B goto <target-url>
\`\`\`

**If 2FA/OTP is required:** Ask the user for the code and wait.

**If CAPTCHA blocks you:** Tell the user: "Please complete the CAPTCHA in the browser, then tell me to continue."

### Phase 3: Orient

Get a map of the application:

\`\`\`bash
$B goto <target-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/initial.png"
$B links                          # map navigation structure
$B console --errors               # any errors on landing?
\`\`\`

**Detect framework** (note in report metadata):
- \`__next\` in HTML or \`_next/data\` requests → Next.js
- \`csrf-token\` meta tag → Server-rendered framework
- \`wp-content\` in URLs → WordPress
- Client-side routing with no page reloads → SPA

**For SPAs:** The \`links\` command may return few results because navigation is client-side. Use \`snapshot -i\` to find nav elements (buttons, menu items) instead.

### Phase 4: Explore

Visit pages systematically. At each page:

\`\`\`bash
$B goto <page-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/page-name.png"
$B console --errors
\`\`\`

Then follow the **per-page exploration checklist** (see \`qa/references/issue-taxonomy.md\`):

1. **Visual scan** — Look at the annotated screenshot for layout issues
2. **Interactive elements** — Click buttons, links, controls. Do they work?
3. **Forms** — Fill and submit. Test empty, invalid, edge cases
4. **Navigation** — Check all paths in and out
5. **States** — Empty state, loading, error, overflow
6. **Console** — Any new JS errors after interactions?
7. **Responsiveness** — Check mobile viewport if relevant:
   \`\`\`bash
   $B viewport 375x812
   $B screenshot "$REPORT_DIR/screenshots/page-mobile.png"
   $B viewport 1280x720
   \`\`\`

**Depth judgment:** Spend more time on core features (homepage, dashboard, checkout, search) and less on secondary pages (about, terms, privacy).

**Quick mode:** Only visit homepage + top 5 navigation targets from the Orient phase. Skip the per-page checklist — just check: loads? Console errors? Broken links visible?

### Phase 5: Document

Document each issue **immediately when found** — don't batch them.

**Two evidence tiers:**

**Interactive bugs** (broken flows, dead buttons, form failures):
1. Take a screenshot before the action
2. Perform the action
3. Take a screenshot showing the result
4. Use \`snapshot -D\` to show what changed
5. Write repro steps referencing screenshots

\`\`\`bash
$B screenshot "$REPORT_DIR/screenshots/issue-001-step-1.png"
$B click @e5
$B screenshot "$REPORT_DIR/screenshots/issue-001-result.png"
$B snapshot -D
\`\`\`

**Static bugs** (typos, layout issues, missing images):
1. Take a single annotated screenshot showing the problem
2. Describe what's wrong

\`\`\`bash
$B snapshot -i -a -o "$REPORT_DIR/screenshots/issue-002.png"
\`\`\`

**Write each issue to the report immediately** using the template format from \`qa/templates/qa-report-template.md\`.

### Phase 6: Wrap Up

1. **Compute health score** using the rubric below
2. **Write "Top 3 Things to Fix"** — the 3 highest-severity issues
3. **Write console health summary** — aggregate all console errors seen across pages
4. **Update severity counts** in the summary table
5. **Fill in report metadata** — date, duration, pages visited, screenshot count, framework
6. **Save baseline** — write \`baseline.json\` with:
   \`\`\`json
   {
     "date": "YYYY-MM-DD",
     "url": "<target>",
     "healthScore": N,
     "issues": [{ "id": "ISSUE-001", "title": "...", "severity": "...", "category": "..." }],
     "categoryScores": { "console": N, "links": N, ... }
   }
   \`\`\`

**Regression mode:** After writing the report, load the baseline file. Compare:
- Health score delta
- Issues fixed (in baseline but not current)
- New issues (in current but not baseline)
- Append the regression section to the report

---

## Health Score Rubric

Compute each category score (0-100), then take the weighted average.

### Console (weight: 15%)
- 0 errors → 100
- 1-3 errors → 70
- 4-10 errors → 40
- 10+ errors → 10

### Links (weight: 10%)
- 0 broken → 100
- Each broken link → -15 (minimum 0)

### Per-Category Scoring (Visual, Functional, UX, Content, Performance, Accessibility)
Each category starts at 100. Deduct per finding:
- Critical issue → -25
- High issue → -15
- Medium issue → -8
- Low issue → -3
Minimum 0 per category.

### Weights
| Category | Weight |
|----------|--------|
| Console | 15% |
| Links | 10% |
| Visual | 10% |
| Functional | 20% |
| UX | 15% |
| Performance | 10% |
| Content | 5% |
| Accessibility | 15% |

### Final Score
\`score = Σ (category_score × weight)\`

---

## Framework-Specific Guidance

### Next.js
- Check console for hydration errors (\`Hydration failed\`, \`Text content did not match\`)
- Monitor \`_next/data\` requests in network — 404s indicate broken data fetching
- Test client-side navigation (click links, don't just \`goto\`) — catches routing issues
- Check for CLS (Cumulative Layout Shift) on pages with dynamic content

### WordPress
- Check for plugin conflicts (JS errors from different plugins)
- Verify admin bar visibility for logged-in users
- Test REST API endpoints (\`/wp-json/\`)
- Check for mixed content warnings (common with WP)

### General SPA (React, Vue, Angular)
- Use \`snapshot -i\` for navigation — \`links\` command misses client-side routes
- Check for hydration errors (\`Hydration failed\`, \`Text content did not match\`)
- Check for stale state (navigate away and back — does data refresh?)
- Test client-side routing (click links, don't just \`goto\`) — catches routing issues
- Test browser back/forward — does the app handle history correctly?
- Check for CLS (Cumulative Layout Shift) on pages with dynamic content
- Check for memory leaks (monitor console after extended use)

---

## Important Rules

1. **Repro is everything.** Every issue needs at least one screenshot. No exceptions.
2. **Verify before documenting.** Retry the issue once to confirm it's reproducible, not a fluke.
3. **Never include credentials.** Write \`[REDACTED]\` for passwords in repro steps.
4. **Write incrementally.** Append each issue to the report as you find it. Don't batch.
5. **Never read source code.** Test as a user, not a developer.
6. **Check console after every interaction.** JS errors that don't surface visually are still bugs.
7. **Test like a user.** Use realistic data. Walk through complete workflows end-to-end.
8. **Depth over breadth.** 5-10 well-documented issues with evidence > 20 vague descriptions.
9. **Never delete output files.** Screenshots and reports accumulate — that's intentional.
10. **Use \`snapshot -C\` for tricky UIs.** Finds clickable divs that the accessibility tree misses.`;
}

function generateSerenaSetup(): string {
  return `## Serena Code Navigation (optional, reduces token usage)

If Serena MCP tools are available (\`mcp__serena__*\`), prefer them for code lookup tasks.
They provide symbol-level precision that avoids reading entire files.

**Activation (run once at start):**
Try \`mcp__serena__activate_project\` with the repo root path. If it succeeds, Serena
is active. If it fails or the tool is unavailable, skip all Serena tools and use
Grep + Read instead.

**If activation succeeds but symbol lookups return empty results:** Run
\`mcp__serena__onboarding\` once — Serena needs a one-time index build per project.

**When Serena is active, prefer these patterns:**

| Task | Without Serena | With Serena |
|------|---------------|-------------|
| Understand file structure | Read the whole file | \`get_symbols_overview\` (~90% fewer tokens) |
| Find where a symbol is used | Grep for name → Read each file | \`find_referencing_symbols\` (returns snippets only) |
| Read a specific function | Read the whole file | \`find_symbol\` with \`include_body=true\` |
| Search for a pattern | Grep | \`search_for_pattern\` (equivalent) |

**Fallback rule:** If any Serena tool call fails, fall back to Grep + Read for that
operation. Do not retry — switch immediately.`;
}

const RESOLVERS: Record<string, () => string> = {
  COMMAND_REFERENCE: generateCommandReference,
  SNAPSHOT_FLAGS: generateSnapshotFlags,
  PREAMBLE: generatePreamble,
  BROWSE_SETUP: generateBrowseSetup,
  BASE_BRANCH_DETECT: generateBaseBranchDetect,
  QA_METHODOLOGY: generateQAMethodology,
  SERENA_SETUP: generateSerenaSetup,
};

// ─── Template Processing ────────────────────────────────────

const GENERATED_HEADER = `<!-- AUTO-GENERATED from {{SOURCE}} — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n`;

function processTemplate(tmplPath: string): { outputPath: string; content: string } {
  const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, tmplPath);
  const outputPath = tmplPath.replace(/\.tmpl$/, '');

  // Replace placeholders
  let content = tmplContent.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const resolver = RESOLVERS[name];
    if (!resolver) throw new Error(`Unknown placeholder {{${name}}} in ${relTmplPath}`);
    return resolver();
  });

  // Check for any remaining unresolved placeholders
  const remaining = content.match(/\{\{(\w+)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }

  // Prepend generated header (after frontmatter)
  const header = GENERATED_HEADER.replace('{{SOURCE}}', path.basename(tmplPath));
  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (fmEnd !== -1) {
    const insertAt = content.indexOf('\n', fmEnd) + 1;
    content = content.slice(0, insertAt) + header + content.slice(insertAt);
  } else {
    content = header + content;
  }

  return { outputPath, content };
}

// ─── Main ───────────────────────────────────────────────────

function findTemplates(): string[] {
  const templates: string[] = [];
  const candidates = [
    path.join(ROOT, 'SKILL.md.tmpl'),
    path.join(ROOT, 'browse', 'SKILL.md.tmpl'),
    path.join(ROOT, 'qa', 'SKILL.md.tmpl'),
    path.join(ROOT, 'qa-only', 'SKILL.md.tmpl'),
    path.join(ROOT, 'setup-browser-cookies', 'SKILL.md.tmpl'),
    path.join(ROOT, 'ship', 'SKILL.md.tmpl'),
    path.join(ROOT, 'review', 'SKILL.md.tmpl'),
    path.join(ROOT, 'plan-ceo-review', 'SKILL.md.tmpl'),
    path.join(ROOT, 'plan-eng-review', 'SKILL.md.tmpl'),
    path.join(ROOT, 'retro', 'SKILL.md.tmpl'),
    path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'),
    path.join(ROOT, 'document-release', 'SKILL.md.tmpl'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) templates.push(p);
  }
  return templates;
}

let hasChanges = false;

for (const tmplPath of findTemplates()) {
  const { outputPath, content } = processTemplate(tmplPath);
  const relOutput = path.relative(ROOT, outputPath);

  if (DRY_RUN) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
    if (existing !== content) {
      console.log(`STALE: ${relOutput}`);
      hasChanges = true;
    } else {
      console.log(`FRESH: ${relOutput}`);
    }
  } else {
    fs.writeFileSync(outputPath, content);
    console.log(`GENERATED: ${relOutput}`);
  }
}

if (DRY_RUN && hasChanges) {
  console.error('\nGenerated SKILL.md files are stale. Run: bun run gen:skill-docs');
  process.exit(1);
}
