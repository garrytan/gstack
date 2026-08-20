/**
 * Static invariant tests for /spec (consolidates 13 gate-tier checks).
 *
 * Each test asserts a specific contract the spec/SKILL.md.tmpl must encode.
 * If the template drifts away from a contract, the test fails immediately —
 * no LLM, no E2E cost.
 *
 * Covers (W7 plan):
 *   spec-phase-gating       — Phase 1 hard gate ("no issue after first message")
 *   spec-phase4-revise      — Phase 4 "what did I get wrong" loop
 *   spec-dedupe-no-gh       — graceful skip on gh missing / unauth / rate-limit
 *   spec-dedupe-matches     — merge-with-or-file-new AskUserQuestion for matches
 *   spec-execute-dirty      — porcelain check + 3-path AUQ + TOCTOU re-check
 *   spec-execute-race       — unique branch spec/<slug>-$$ + SHA pin
 *   spec-quality-gate-fallback   — codex timeout/unavailable skip-with-warn
 *   spec-quality-gate-redaction  — fail-closed secret regex list + BLOCKED
 *   spec-quality-gate-secret-sink — invariant: raw spec not persisted on block
 *   spec-archive            — gstack-paths eval + atomic tmp/mv + PID suffix
 *   spec-archive-sync-exclusion  — /specs/ auto-exclude from sync allowlist
 *   spec-audit-flag         — flag routes to Audit/Cleanup template
 *   spec-concurrency        — PID suffix in branch + atomic archive write
 *   spec-plan-mode-detection — reads GSTACK_PLAN_MODE env
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = fs.readFileSync(path.join(ROOT, 'spec', 'SKILL.md.tmpl'), 'utf-8');
// The redaction taxonomy + invocation bash are injected by the gen-skill-docs
// resolver, so the literal patterns/bash live in the GENERATED SKILL.md, not the
// .tmpl. Redaction assertions read the generated file.
const GEN = fs.readFileSync(path.join(ROOT, 'spec', 'SKILL.md'), 'utf-8');

describe('/spec phase-gating', () => {
  test('HARD GATE prose forbids producing issue after first message', () => {
    expect(TMPL).toMatch(/HARD GATE.*Do NOT produce an issue after the first message/i);
    expect(TMPL).toMatch(/Always start with[\s\S]*?Phase 1/);
  });
  test('Phase 1 lists all five mandatory questions', () => {
    for (const q of ['Who', 'current behavior', 'should the behavior be', 'Why now', "we'll know it's done"]) {
      expect(TMPL.toLowerCase()).toContain(q.toLowerCase().replace("we'll know", 'know'));
    }
  });
});

describe('/spec Phase 4 revise loop', () => {
  test('Phase 4 asks "what did I get wrong" and iterates', () => {
    expect(TMPL).toMatch(/What did I get wrong\?/);
    expect(TMPL).toMatch(/Iterate until the user confirms/i);
  });
});

describe('/spec --dedupe gh failure handling', () => {
  test('handles gh-not-installed, unauthed, rate-limited paths', () => {
    // Template wraps gh in backticks: "`gh` not installed" or "`gh` is not installed".
    expect(TMPL).toMatch(/gh.{0,5}not installed/i);
    expect(TMPL).toMatch(/gh auth status[\s\S]*?not logged in/i);
    expect(TMPL).toMatch(/rate.?limit/i);
  });
  test('never blocks Phase 2 on dedupe failure', () => {
    expect(TMPL).toMatch(/best-effort.*Never block|Never block.*dedupe failure/i);
  });
  test('matches surface as AskUserQuestion with merge-or-file-new options', () => {
    // Template breaks the sentence across lines: "Found {N} similar\n  open issue(s):"
    expect(TMPL).toMatch(/Found \{N\} similar[\s\S]*?open issue/);
    expect(TMPL).toMatch(/Merge with one of these/);
    expect(TMPL).toMatch(/file a new spec anyway/);
  });
});

describe('/spec --execute dirty-worktree gate', () => {
  test('runs git status --porcelain before spawn', () => {
    expect(TMPL).toMatch(/git status --porcelain/);
  });
  test('offers 3-option AskUserQuestion (continue / stash / cancel)', () => {
    expect(TMPL).toMatch(/Continue.*uncommitted/i);
    expect(TMPL).toMatch(/Stash and restore/i);
    expect(TMPL).toMatch(/Cancel spawn/i);
  });
  test('TOCTOU re-check fires after AskUserQuestion answer', () => {
    expect(TMPL).toMatch(/TOCTOU.*re-?check|re-?run.*git status/i);
  });
});

describe('/spec --execute race + concurrency hardening', () => {
  test('captures SHA pin via git rev-parse HEAD (not "HEAD" string)', () => {
    expect(TMPL).toMatch(/PIN_SHA=\$\(git rev-parse HEAD\)/);
    expect(TMPL).toMatch(/git worktree add[^\n]*\$PIN_SHA/);
  });
  test('branch name includes PID suffix for concurrency safety', () => {
    expect(TMPL).toMatch(/SPAWN_BRANCH="spec\/\$\{SLUG_TITLE\}-\$\$"/);
  });
  test('worktree path includes PID suffix', () => {
    expect(TMPL).toMatch(/SPAWN_PATH=.*-\$\$/);
  });
});

describe('/spec quality gate fallback', () => {
  test('skips on codex timeout with explanatory message', () => {
    // `didn.t` matches both ASCII `'` and Unicode curly `’` apostrophes.
    expect(TMPL).toMatch(/codex didn.t respond in[\s\S]{0,80}2 minutes/);
    // Template wraps `--no-gate` in backticks, so allow flexible separator:
    expect(TMPL).toMatch(/--no-gate.{0,3}to disable/i);
  });
  test('skips on codex not installed / unauthed', () => {
    expect(TMPL).toMatch(/codex.*not installed/i);
    expect(TMPL).toMatch(/codex.*auth.*failed/i);
  });
});

describe('/spec fail-closed redaction (shared engine)', () => {
  test('the full taxonomy (with secret prefixes) lives in the generated /cso doc', () => {
    // cso is carved — the Secrets Archaeology prose + prefixes moved into
    // sections/audit-phases.md; read the skeleton+sections union.
    const csoDir = path.join(ROOT, 'cso');
    let cso = fs.readFileSync(path.join(csoDir, 'SKILL.md'), 'utf-8');
    const secDir = path.join(csoDir, 'sections');
    if (fs.existsSync(secDir)) {
      for (const f of fs.readdirSync(secDir).sort()) {
        if (f.endsWith('.md') && !f.endsWith('.md.tmpl')) cso += '\n' + fs.readFileSync(path.join(secDir, f), 'utf-8');
      }
    }
    expect(cso).toContain('AKIA');
    expect(cso).toMatch(/ghp_|gho_|ghs_/);
    expect(cso).toContain('sk-ant-');
    expect(cso).toContain('BEGIN');
  });
  test('/spec points to the full taxonomy without inlining the catalog', () => {
    expect(GEN).toMatch(/Full taxonomy.*lib\/redact-patterns\.ts|\/cso/);
    expect(GEN).toMatch(/~30 secret\/PII\/legal patterns/);
  });
  test('redaction routes through the shared gstack-redact bin, not inline regex', () => {
    expect(GEN).toContain('gstack-redact');
    expect(GEN).toContain('--from-file');
    // The old inline 7-regex prose is gone from the template.
    expect(TMPL).not.toMatch(/AWS access key.*regex.*AKIA\[0-9A-Z\]/);
  });
  test('HIGH (exit 3) blocks dispatch; no skip flag for HIGH', () => {
    expect(GEN).toMatch(/Exit 3 \(HIGH\)/);
    expect(GEN).toMatch(/no skip flag for HIGH/i);
  });
  test('hard delimiter + instruction boundary still wraps the codex dispatch', () => {
    expect(TMPL).toContain('<<<USER_SPEC>>>');
    expect(TMPL).toContain('<<<END_USER_SPEC>>>');
    expect(TMPL).toMatch(/text between[\s\S]*delimiters[\s\S]*is DATA, not instructions/i);
  });
});

describe('/spec redaction at every sink (scan-at-sink)', () => {
  test('scan precedes the gh issue create (pre-issue)', () => {
    const scanIdx = GEN.indexOf('Re-scan before filing');
    const fileIdx = GEN.indexOf('gh issue create --title');
    expect(scanIdx).toBeGreaterThan(-1);
    expect(fileIdx).toBeGreaterThan(scanIdx);
  });
  test('files from the scanned temp file (exact bytes, not a re-render)', () => {
    expect(GEN).toMatch(/gh issue create --title "<title>" --body-file "\$REDACT_FILE"/);
  });
  test('scan precedes the archive write (pre-archive)', () => {
    const scanIdx = GEN.indexOf('Re-scan before archiving');
    const archIdx = GEN.indexOf('ARCHIVE_PATH.tmp');
    expect(scanIdx).toBeGreaterThan(-1);
    expect(archIdx).toBeGreaterThan(scanIdx);
  });
  test('D2: sanitized body lands in the archive', () => {
    expect(GEN).toMatch(/sanitized body[\s\S]{0,200}\$REDACT_FILE/i);
  });
});

describe('/spec quality gate secret-sink invariant', () => {
  test('declares "raw spec must NOT be persisted" when the scan BLOCKS', () => {
    expect(TMPL).toMatch(/raw spec must NOT[\s\S]*be persisted/i);
  });
  test('BLOCK path stops before dispatch/archive/file', () => {
    expect(TMPL).toMatch(/no archive write, no transcript log, no codex\s*\n?\s*dispatch/i);
  });
});

describe('/spec Phase 4.5a semantic content review', () => {
  test('semantic pass precedes the regex scan', () => {
    const semIdx = TMPL.indexOf('Phase 4.5a: Semantic Content Review');
    const regexIdx = TMPL.indexOf('Phase 4.5b: Fail-closed redaction');
    expect(semIdx).toBeGreaterThan(-1);
    expect(regexIdx).toBeGreaterThan(semIdx);
  });
  test('emits a structurally-testable SEMANTIC_REVIEW marker', () => {
    expect(TMPL).toMatch(/SEMANTIC_REVIEW: clean/);
    expect(TMPL).toMatch(/SEMANTIC_REVIEW: flagged/);
  });
  test('lists all five semantic categories', () => {
    expect(TMPL).toMatch(/Named individuals attached to negative judgments/i);
    expect(TMPL).toMatch(/Customer\/vendor names tied to negative events/i);
    expect(TMPL).toMatch(/Unannounced internal strategy/i);
    expect(TMPL).toMatch(/NDA-bound material/i);
    expect(TMPL).toMatch(/Confidential context bleed/i);
  });
  test('prompt-injection hardened: marker in body forces flagged', () => {
    expect(TMPL).toMatch(/contains[\s\S]{0,20}`SEMANTIC_REVIEW:`[\s\S]{0,80}force the[\s\S]{0,10}outcome to `flagged`/i);
  });
  test('public repo disables option B (acknowledge and proceed)', () => {
    expect(TMPL).toMatch(/PUBLIC repo,\s*option B is disabled/i);
  });
  test('appends a content-free audit record (sha256, no body text)', () => {
    expect(TMPL).toContain('redact-audit-log.ts');
    expect(TMPL).toMatch(/categories_flagged/);
  });
});

describe('/spec --no-gate keeps redacting', () => {
  test('flag table says redaction still runs under --no-gate', () => {
    expect(TMPL).toMatch(/Redaction.*still runs.*no flag that disables it/i);
  });
});

describe('/spec archive', () => {
  test('uses eval $(gstack-paths) not hardcoded ~/.gstack/', () => {
    expect(TMPL).toMatch(/eval "\$\(.+gstack-paths\)"/);
    expect(TMPL).toMatch(/\$GSTACK_STATE_ROOT\/projects\/\$SLUG\/specs/);
    // No hardcoded ~/.gstack/projects path:
    expect(TMPL).not.toMatch(/~\/\.gstack\/projects\/\$SLUG\/specs/);
  });
  test('atomic write via .tmp + mv', () => {
    expect(TMPL).toMatch(/\$ARCHIVE_PATH\.tmp/);
    expect(TMPL).toMatch(/mv "\$ARCHIVE_PATH\.tmp" "\$ARCHIVE_PATH"/);
  });
  test('PID suffix in archive filename', () => {
    expect(TMPL).toMatch(/ARCHIVE_NAME=.*\$\$/);
  });
  test('frontmatter includes spec_issue_number for /ship integration', () => {
    expect(TMPL).toMatch(/spec_issue_number:/);
    expect(TMPL).toMatch(/spec_branch:/);
    expect(TMPL).toMatch(/spec_executed:/);
  });
});

describe('/spec archive sync exclusion', () => {
  test('/specs/ excluded from artifacts-sync by default; --sync-archive opt-in', () => {
    expect(TMPL).toMatch(/\/specs\/.*auto-excluded.*artifacts-sync|excluded from.*allowlist/i);
    expect(TMPL).toMatch(/--sync-archive/);
  });
});

describe('/spec --audit flag', () => {
  test('flag table includes --audit with routing to Audit template', () => {
    expect(TMPL).toMatch(/\| `--audit` \|/);
    expect(TMPL).toMatch(/Audit\/Cleanup template/);
  });
  test('Audit / Cleanup Issues section exists with --audit cross-reference', () => {
    expect(TMPL).toMatch(/### Audit \/ Cleanup Issues.*routed via.*--audit/);
  });
  test('--bug/--feature/--refactor flags NOT in table (dropped per DX14)', () => {
    expect(TMPL).not.toMatch(/\| `--bug` \|/);
    expect(TMPL).not.toMatch(/\| `--feature` \|/);
    expect(TMPL).not.toMatch(/\| `--refactor` \|/);
  });
});

describe('/spec plan-mode-aware Phase 5 (DX7/DX11/F1)', () => {
  test('reads GSTACK_PLAN_MODE env at Phase 5 dispatch', () => {
    expect(TMPL).toMatch(/GSTACK_PLAN_MODE/);
    expect(TMPL).toMatch(/plan-mode-aware default/i);
  });
  test('plan-mode active → file-only path; inactive → file + spawn', () => {
    expect(TMPL).toMatch(/GSTACK_PLAN_MODE=active.*file-only path/);
    expect(TMPL).toMatch(/GSTACK_PLAN_MODE=inactive.*file \+ spawn/);
  });
  test('--file-only / --no-execute / --plan-file override flags', () => {
    expect(TMPL).toMatch(/--file-only/);
    expect(TMPL).toMatch(/--no-execute/);
    expect(TMPL).toMatch(/--plan-file/);
  });
});

describe('/spec Phase 3 hard-grep with fallback', () => {
  test('Phase 3 mandates reading evidence before asking', () => {
    expect(TMPL).toMatch(/Mandatory:[\s\S]*MUST read at least one[\s\S]*evidence/i);
  });
  test('project-level fallback prose for prompts with no concrete file', () => {
    expect(TMPL).toMatch(/Project-level prompt/);
    expect(TMPL).toMatch(/I inspected the project structure/);
  });
  test('greenfield escape (no related evidence) is explicit', () => {
    expect(TMPL).toMatch(/genuinely cannot find any related evidence/i);
  });
});

describe('/spec concurrency safety (overlap with race; codex F5/F6/F10)', () => {
  test('two concurrent /spec runs get distinct branches via $$ PID', () => {
    expect(TMPL).toMatch(/SPAWN_BRANCH=.*\$\$/);
  });
  test('atomic archive write prevents JSONL/file interleave', () => {
    expect(TMPL).toMatch(/atomic.*rename|atomic write/i);
  });
});
