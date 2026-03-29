# Plan: `/codebase-audit` PR 2 — Focused Mode + CI Mode

## Status: SUPERSEDED

**This plan is stale.** Line numbers and E2E test patterns are outdated after two rebases
onto upstream/main. The authoritative plan is:

> **`~/.claude/plans/harmonic-juggling-gray.md`**

That plan includes CEO review (SELECTIVE EXPANSION) and eng review decisions:
- 5 accepted expansions: `--json`, quick+focused combo, per-category thresholds, `--baseline-path`, skipped categories summary
- Per-category sub-scores DEFERRED to PR 3 (breaks regression compat)
- Per-category gating uses finding-severity impact, not sub-scores
- `--ci` without threshold defaults to score 0 (record-only, always PASS)
- `--ci --quick` combo documented
- Template stays as one file (550-600 lines acceptable)
- Approach A (template-only, no shell wrapper)

The old detailed edits below are preserved for reference but the line numbers are wrong.
Re-verify against current source before implementing.

---

## Original plan (stale — line numbers shifted after rebases)

---

## File 1: `codebase-audit/SKILL.md.tmpl`

### Edit A: Add focused mode flags to Arguments section (after line 39)

Insert after the `--quick` argument line:

```markdown
- `/codebase-audit --security-only` — audit security category only
- `/codebase-audit --tests-only` — audit tests category only
- `/codebase-audit --architecture-only` — audit architecture category only
- `/codebase-audit --performance-only` — audit performance category only
- `/codebase-audit --debt-only` — audit tech debt category only
- `/codebase-audit --correctness-only` — audit correctness category only
- `/codebase-audit --reliability-only` — audit reliability category only
- `/codebase-audit --security-only --tests-only` — combinable: runs both categories
- `/codebase-audit --ci --min-score 70` — CI mode: score gate, baseline.json only, PASS/FAIL output
- `/codebase-audit --ci --min-score 70 --security-only` — CI + focused: security-only gate
```

### Edit B: Add Focused Mode section to Modes (after line 34, the Regression bullet)

Insert a new mode bullet:

```markdown
- **Focused** (`--security-only`, `--tests-only`, `--architecture-only`, `--performance-only`, `--debt-only`, `--correctness-only`, `--reliability-only`): Runs Phases 1-4, but Phase 3 is filtered to only the matching checklist categories. Health score is calculated over included categories only — not penalized for categories not scanned. Flags are combinable: `--security-only --tests-only` runs both. Report metadata notes which categories were included/excluded. The baseline.json `scope` field records the category list (e.g., `"scope": "security,tests"`).
- **CI** (`--ci --min-score N`): Dedicated early-exit path. See "CI Mode" section below. No markdown report, no AskUserQuestion, no fix plan. Outputs a single PASS/FAIL line. Combinable with focused flags.
```

### Edit C: Add CI Mode section — NEW section between "Arguments" and "Phase 1" (between lines 41 and 43)

Insert a new top-level section:

```markdown
---

## CI Mode (`--ci --min-score N`)

**This is a completely separate execution path.** If `--ci` is detected in arguments, execute ONLY this section, then STOP. Do not proceed to the normal Phase 1-4 flow.

CI mode is designed for automated pipelines (GitHub Actions, etc.). It is non-interactive, produces machine-readable output only, and exits with a clear PASS/FAIL verdict.

### CI Step 1: Orientation (silent)

Run Phase 1 steps 1.1-1.3 (project identity, language detection, codebase stats) without printing anything to the conversation. Skip steps 1.4-1.8 (docs, git state, churn, dependency check, sizing strategy). Do NOT use AskUserQuestion — even for large codebases, just proceed with sampling.

### CI Step 2: Checklist scan (grep only)

Determine which categories to scan:
- If focused flags are present (`--security-only`, `--tests-only`, etc.), run only matching categories
- If no focused flags, run all 7 categories

Read the checklist at `~/.claude/skills/gstack/codebase-audit/checklist.md`. For each active category, run the grep patterns using `files_with_matches` mode. For each match, read surrounding context to confirm it's a real finding. Apply the same severity calibration as the normal flow (Critical, Important, Worth noting, Opportunity).

Do NOT run Phase 2 (architecture scan). Do NOT do deep reads beyond confirming grep matches.

### CI Step 3: Calculate health score

Same formula as Phase 4.2:
- Start at 100
- Critical: -25 each
- Important: -10 each
- Worth noting: -3 each
- Opportunity: no deduction
- Floor at 0

If focused mode is active, score is calculated over included categories only.

### CI Step 4: Write baseline.json

Write `{datetime}-baseline.json` to `~/.gstack/projects/$SLUG/audits/`. Use `"mode": "ci"` and populate `scope` with the category list (e.g., `"scope": "security,tests"` or `"scope": "full"`).

Do NOT write a markdown report. baseline.json is the only file output.

### CI Step 5: Print verdict

Parse `--min-score N` from the arguments. Print exactly one line:

```
PASS: score 82 (threshold: 70)
```

or:

```
FAIL: score 45 (threshold: 70)
```

This is the entire conversation output. No executive summary, no findings list, no report path. The PASS/FAIL line is the contract — CI pipelines parse this.

### CI Step 6: Stop

Do not proceed to Phase 1. Do not write a fix plan. Do not use AskUserQuestion. Do not offer review chaining. The audit is complete.

---
```

### Edit D: Add focused mode filtering to Phase 3 (modify section at line 167-201)

After the existing line 169 ("In full mode, run the complete checklist."), insert:

```markdown

**Focused mode filtering:** If any `--*-only` flags are present, run only the matching categories from the checklist:
- `--security-only` → Security
- `--correctness-only` → Correctness
- `--reliability-only` → Reliability
- `--architecture-only` → Architecture
- `--tests-only` → Tests
- `--debt-only` → Tech Debt
- `--performance-only` → Performance

Multiple flags are additive: `--security-only --tests-only` runs both Security and Tests categories. Skip all other categories entirely — do not run their grep patterns, do not report findings for them.
```

### Edit E: Add focused mode scoping to Phase 4.2 (modify section at line 256-263)

After the existing health score formula, insert:

```markdown

**Focused mode scoring:** If focused flags are active, the health score is calculated over included categories only. A `--security-only` audit with zero security findings scores 100 — it is not penalized for not scanning other categories. The report metadata and baseline.json record which categories were included.
```

### Edit F: Update Phase 4.4 baseline.json schema (modify section at lines 296-328)

Update the JSON schema example to show the new mode/scope values:

Change `"mode": "full"` line to show all valid values:
```json
"mode": "full|quick|focused|ci",
```

Add after the `"mode"` line:
```json
"scope": "full|security|tests|security,tests|...",
```

And add a note after the schema:

```markdown
**Mode values:**
- `"full"` — default full audit
- `"quick"` — quick mode (`--quick`)
- `"focused"` — one or more `--*-only` flags without `--ci`
- `"ci"` — CI mode (`--ci`)

**Scope values:**
- `"full"` — all 7 categories scanned
- Comma-separated category names when focused (e.g., `"security,tests"`)
```

### Edit G: Update Phase 4.5 regression comparison (modify section at lines 334-345)

After the existing regression comparison logic, insert:

```markdown

**Scope-aware regression:** Only compare baselines with matching `scope` values. If the previous baseline has `"scope": "full"` and the current run has `"scope": "security"`, do not compute deltas — instead note in the report:

> "Regression comparison skipped: previous audit scope (full) differs from current scope (security). Run a full audit to compare against the full baseline, or run with matching focused flags."

This prevents misleading deltas (e.g., a security-only audit appearing to have "fixed" all architecture findings).
```

### Edit H: Update AskUserQuestion rule (line 452)

Update rule 7 to add CI mode exception. Change:

```
7. AskUserQuestion fires in two places: (1) Phase 1 if >50K LOC, to scope the audit; (2) Phase 4.7 after the plan is written, to offer review chaining (/plan-eng-review, /plan-ceo-review, or accept as-is). Do not use AskUserQuestion elsewhere during the audit.
```

To:

```
7. AskUserQuestion fires in two places: (1) Phase 1 if >50K LOC, to scope the audit; (2) Phase 4.7 after the plan is written, to offer review chaining (/plan-eng-review, /plan-ceo-review, or accept as-is). Do not use AskUserQuestion elsewhere during the audit. **Exception: In CI mode (`--ci`), AskUserQuestion NEVER fires — not even for large codebases. CI mode is non-interactive.**
```

---

## File 2: `codebase-audit/report-template.md`

### Edit A: Add scope to metadata table (after line 13)

Insert a new row after the Mode row:

```markdown
| **Scope** | {SCOPE} |
```

### Edit B: Add focused mode note section (after line 18, after the Health Score section)

Insert:

```markdown
{FOCUSED_MODE_NOTE_START}

> **Focused audit:** This report covers only the following categories: {INCLUDED_CATEGORIES}. Categories not scanned: {EXCLUDED_CATEGORIES}. Health score reflects included categories only.

{FOCUSED_MODE_NOTE_END}
```

---

## File 3: `codebase-audit/report-template.md` — baseline.json schema update

The baseline.json schema lives in SKILL.md.tmpl (handled in File 1 Edit F above), not in report-template.md. No additional changes needed here.

---

## File 4: `test/skill-validation.test.ts`

### Edit A: Add focused/CI mode structural tests (insert after line 1463, before the closing `});`)

Add new tests inside the existing `'Codebase audit skill structure'` describe block:

```typescript
  test('generated SKILL.md contains focused mode flags', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codebase-audit', 'SKILL.md'), 'utf-8');
    const flags = ['--security-only', '--tests-only', '--architecture-only',
                   '--performance-only', '--debt-only', '--correctness-only', '--reliability-only'];
    for (const flag of flags) {
      expect(content).toContain(flag);
    }
  });

  test('generated SKILL.md contains CI mode section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codebase-audit', 'SKILL.md'), 'utf-8');
    expect(content).toContain('CI Mode');
    expect(content).toContain('--ci');
    expect(content).toContain('--min-score');
    expect(content).toContain('PASS:');
    expect(content).toContain('FAIL:');
  });

  test('generated SKILL.md contains scope-aware regression', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codebase-audit', 'SKILL.md'), 'utf-8');
    expect(content).toContain('scope');
    expect(content).toContain('incompar');  // "incomparable" or similar
  });

  test('CI mode section is before Phase 1', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codebase-audit', 'SKILL.md'), 'utf-8');
    const ciPos = content.indexOf('CI Mode');
    const phase1Pos = content.indexOf('## Phase 1');
    expect(ciPos).toBeGreaterThan(-1);
    expect(ciPos).toBeLessThan(phase1Pos);
  });
```

---

## File 5: `test/skill-e2e.test.ts`

### Edit A: Add CI mode E2E test (insert after the existing codebase-audit-quick test block, before the module-level afterAll)

Add a new describe block:

```typescript
// --- Codebase Audit CI Mode E2E ---

describeIfSelected('Codebase Audit CI E2E', ['codebase-audit-ci'], () => {
  let auditDir: string;

  beforeAll(() => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-codebase-audit-ci-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: auditDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(auditDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { express: '^4.18.0' },
    }, null, 2));

    fs.writeFileSync(path.join(auditDir, 'index.ts'), `import express from 'express';
const app = express();
app.get('/users', (req, res) => {
  const id = req.query.id;
  const query = \`SELECT * FROM users WHERE id = \${id}\`;
  res.json({ query });
});
app.listen(3000);
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'codebase-audit'), path.join(auditDir, 'codebase-audit'));
  });

  afterAll(() => {
    try { fs.rmSync(auditDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('codebase-audit-ci', async () => {
    const result = await runSkillTest({
      prompt: `Read the file codebase-audit/SKILL.md for the codebase-audit workflow instructions.

Run /codebase-audit --ci --min-score 50 on this repo.

IMPORTANT:
- Do NOT use AskUserQuestion — CI mode is non-interactive.
- Write baseline.json as described in the CI mode section.
- Print exactly one PASS or FAIL line as described.
- Do NOT write a markdown report.`,
      workingDirectory: auditDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 180_000,
      testName: 'codebase-audit-ci',
      runId,
    });

    logCost('/codebase-audit --ci', result);

    const output = result.output || '';

    // Check for PASS or FAIL line in output
    const passFailMatch = output.match(/(PASS|FAIL): score \d+ \(threshold: \d+\)/);

    // Check for baseline.json (no markdown report)
    const gstackDir = path.join(os.homedir(), '.gstack', 'projects');
    const blFind = spawnSync('find', [auditDir, '-name', '*baseline.json'], {
      stdio: 'pipe', timeout: 5000,
    });
    const blGlobal = spawnSync('find', [gstackDir, '-name', '*baseline.json', '-newer', path.join(auditDir, 'package.json')], {
      stdio: 'pipe', timeout: 5000,
    });
    const baselineFound = blFind.stdout.toString().trim().length > 0 || blGlobal.stdout.toString().trim().length > 0;

    // Check NO markdown report was written
    const mdFind = spawnSync('find', [auditDir, '-name', '*audit.md', '-path', '*/audits/*'], {
      stdio: 'pipe', timeout: 5000,
    });
    const mdGlobal = spawnSync('find', [gstackDir, '-name', '*audit.md', '-newer', path.join(auditDir, 'package.json')], {
      stdio: 'pipe', timeout: 5000,
    });
    // CI mode should NOT produce markdown report (soft check — agent may or may not comply perfectly)

    console.log(`PASS/FAIL line found: ${!!passFailMatch}`);
    console.log(`PASS/FAIL line: ${passFailMatch?.[0] ?? 'none'}`);
    console.log(`Baseline found: ${baselineFound}`);

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    recordE2E('/codebase-audit --ci', 'Codebase Audit CI E2E', result, {
      passed: exitOk && (!!passFailMatch || baselineFound),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    // At minimum, either PASS/FAIL line or baseline.json should exist
    expect(!!passFailMatch || baselineFound).toBe(true);
  }, 240_000);
});
```

### Edit B: Add --security-only E2E test (insert after the CI mode block)

```typescript
// --- Codebase Audit Focused Mode E2E ---

describeIfSelected('Codebase Audit Focused E2E', ['codebase-audit-security-only'], () => {
  let auditDir: string;

  beforeAll(() => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-codebase-audit-focused-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: auditDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(auditDir, 'package.json'), JSON.stringify({
      name: 'test-project', version: '1.0.0',
      dependencies: { express: '^4.18.0' },
    }, null, 2));

    fs.writeFileSync(path.join(auditDir, 'index.ts'), `import express from 'express';
const app = express();
app.get('/users', (req, res) => {
  const id = req.query.id;
  const query = \`SELECT * FROM users WHERE id = \${id}\`;
  res.json({ query });
});
app.listen(3000);
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'codebase-audit'), path.join(auditDir, 'codebase-audit'));
  });

  afterAll(() => {
    try { fs.rmSync(auditDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('codebase-audit-security-only', async () => {
    const result = await runSkillTest({
      prompt: `Read the file codebase-audit/SKILL.md for the codebase-audit workflow instructions.

Run /codebase-audit --quick --security-only on this repo.

IMPORTANT:
- Do NOT use AskUserQuestion — auto-approve everything.
- This is quick + security-only: Phase 1 + security checklist patterns only.
- Write the report and baseline.json as described.
- The report should contain ONLY security findings.`,
      workingDirectory: auditDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 180_000,
      testName: 'codebase-audit-security-only',
      runId,
    });

    logCost('/codebase-audit --security-only', result);

    const output = result.output || '';
    const gstackDir = path.join(os.homedir(), '.gstack', 'projects');

    // Check for report
    let reportFound = false;
    const findFiles = spawnSync('find', [auditDir, '-name', '*.md', '-path', '*/audits/*'], {
      stdio: 'pipe', timeout: 5000,
    });
    const auditFiles = findFiles.stdout.toString().trim().split('\n').filter(Boolean);
    if (auditFiles.length > 0) reportFound = true;

    if (!reportFound) {
      const globalFind = spawnSync('find', [gstackDir, '-name', '*audit.md', '-newer', path.join(auditDir, 'package.json')], {
        stdio: 'pipe', timeout: 5000,
      });
      if (globalFind.stdout.toString().trim().length > 0) reportFound = true;
    }

    console.log(`Report found: ${reportFound}`);

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    recordE2E('/codebase-audit --security-only', 'Codebase Audit Focused E2E', result, {
      passed: exitOk && reportFound,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(reportFound).toBe(true);
  }, 240_000);
});
```

---

## File 6: `test/helpers/touchfiles.ts`

### Edit A: Add new E2E touchfile entries (insert after line 123, the existing codebase-audit-quick entry)

```typescript
  'codebase-audit-ci':            ['codebase-audit/**', 'scripts/gen-skill-docs.ts'],
  'codebase-audit-security-only': ['codebase-audit/**', 'scripts/gen-skill-docs.ts'],
```

---

## File 7: `test/skill-llm-eval.test.ts`

No changes needed. The existing `codebase-audit/SKILL.md workflow` eval already covers the full SKILL.md with `startMarker: '## Phase 1: Orientation'` and `endMarker: '## Edge Cases'`. The new CI Mode section sits *before* Phase 1, so it won't be in the eval window — but adding a separate eval for the CI section is overkill since it's structurally validated by the Tier 1 tests. The existing LLM judge test still validates the core workflow quality.

---

## File 8: `docs/skills.md`

### Edit A: Update modes list (modify line 811, add focused and CI)

After the existing three bullets (Full, Quick, Regression), add:

```markdown
- **Focused** (`--security-only`, `--tests-only`, etc.) — Run the full workflow but only scan selected categories. Combinable: `--security-only --tests-only` runs both. Health score reflects only what was scanned.
- **CI** (`--ci --min-score N`) — Automated quality gate. Runs orientation + grep patterns, computes health score, writes `baseline.json`, prints `PASS` or `FAIL`. No markdown report, no interactive prompts. For GitHub Actions: one YAML step, every engineer sees a health score on every PR.
```

### Edit B: Add CI example to the example section (after line 850)

```markdown

### CI integration

```yaml
# .github/workflows/audit.yml
- name: Codebase audit gate
  run: claude -p "/codebase-audit --ci --min-score 70"
```

```
You:    claude -p "/codebase-audit --ci --min-score 70"
stdout: PASS: score 82 (threshold: 70)
```

### Focused audit

```
You:    /codebase-audit --security-only
Claude: [Orientation... Security deep dive only...]

        Health Score: 85/100 (security category only)

        3 findings (all security):
        1. FINDING-001: SQL injection in user search (Critical)
        2. FINDING-002: Missing rate limiting on /api/auth (Important)
        3. FINDING-003: Hardcoded API key in config.ts (Critical)

        Categories excluded: Correctness, Reliability, Architecture,
        Tests, Tech Debt, Performance
```
```

### Edit C: Add scoring model note (after the existing "Health scoring" paragraph at line 816)

```markdown

> **Note on CI mode + focused flags:** `--ci --min-score 70 --security-only` is the killer combo for CI pipelines — gate on security findings only, skip the noise. The `baseline.json` output enables trend tracking: chart your security score across builds.
```

---

## File 9: `README.md`

### Edit A: No structural changes needed

The README already lists `/codebase-audit` in the skills table (line 144), the install prompts (line 251), and the troubleshooting section. The skill count says "Sixteen" (line 204). None of these need updating — this PR adds modes to an existing skill, not a new skill.

---

## File 10: `CHANGELOG.md`

### Edit A: Add new version entry (insert before line 3, the existing `[0.9.5.0]` entry)

```markdown
## [0.9.6.0] - 2026-03-20

### Added

- **`/codebase-audit --ci --min-score N` — automated quality gates.** One line in your GitHub Action: `claude -p "/codebase-audit --ci --min-score 70"`. Prints `PASS: score 82 (threshold: 70)` or `FAIL: score 45 (threshold: 70)`. Writes `baseline.json` for trend tracking. No markdown report, no interactive prompts. Combinable with focused flags for targeted gates (e.g., `--ci --min-score 80 --security-only`).

- **Focused audit modes.** `--security-only`, `--tests-only`, `--architecture-only`, `--performance-only`, `--debt-only`, `--correctness-only`, `--reliability-only`. Flags are combinable. Health score calculated over included categories only — a security-only audit isn't penalized for not scanning tests. Regression comparison only works between audits with matching scope.

```

---

## File 11: `TODOS.md`

### Edit A: Add Codebase Audit section

Append to the end of TODOS.md:

```markdown
## Codebase Audit

### HTML report format

**What:** Add `--format html` flag that generates an HTML version of the audit report, viewable in a browser.

**Why:** Markdown reports are great for developers but harder to share with non-technical stakeholders. HTML with collapsible sections, syntax highlighting, and a visual score indicator would make audit reports presentable.

**Effort:** M (human: ~1 week / CC: ~30 min)
**Priority:** P3
**Depends on:** /codebase-audit shipped (PR 1)

### Auto-fix suggestions mode

**What:** Include unified diff format code patches for each finding directly in the audit report. The fix plan already classifies findings into mechanical/substantive — this makes the report self-contained by embedding the patches inline.

**Why:** Transitions the audit from "here's what's wrong" to "here's what's wrong and here's how to fix it." Reduces time from finding to resolution.

**Effort:** L (human: ~2 weeks / CC: ~1 hour)
**Priority:** P3
**Depends on:** /codebase-audit shipped (PR 1)

### Cross-repo comparison

**What:** Aggregate baseline.json files across multiple projects. Compare health scores, finding patterns, and category distributions. Dashboard or summary report.

**Why:** Organizations with multiple repos want a fleet-level view of code health. "Which of our 20 repos has the worst security posture?"

**Effort:** L (human: ~2 weeks / CC: ~1 hour)
**Priority:** P4
**Depends on:** /codebase-audit with baseline.json (PR 1), multiple repos with audit history
```

---

## Implementation Order

1. **SKILL.md.tmpl** — All 8 edits (A-H). CI mode section first, then focused mode additions.
2. **report-template.md** — 2 edits (scope row, focused mode note).
3. **Regenerate**: `bun run gen:skill-docs` → generates `codebase-audit/SKILL.md`
4. **test/skill-validation.test.ts** — Add 4 new tests in existing describe block.
5. **test/helpers/touchfiles.ts** — Add 2 E2E touchfile entries.
6. **test/skill-e2e.test.ts** — Add 2 new describe blocks (CI mode, focused mode).
7. **Run tests**: `bun test` — verify Tier 1 passes.
8. **docs/skills.md** — 3 edits (modes, CI example, scoring note).
9. **CHANGELOG.md** — New version entry.
10. **TODOS.md** — New section.

## Commits

1. `feat: add focused mode and CI mode to /codebase-audit` — SKILL.md.tmpl + report-template.md + regenerated SKILL.md
2. `test: add focused/CI mode validation and E2E tests` — skill-validation + touchfiles + skill-e2e
3. `docs: add focused/CI modes to skills docs, changelog, and todos` — docs/skills.md + CHANGELOG + TODOS.md

## Verification

1. `bun run gen:skill-docs` — no errors
2. `bun run gen:skill-docs --dry-run` — FRESH for all
3. `bun test` — all pass
4. `bun run skill:check` — codebase-audit healthy
