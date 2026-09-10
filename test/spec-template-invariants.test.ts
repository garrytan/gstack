/**
 * Static invariant tests for /spec (consolidates 13 gate-tier checks).
 *
 * Each test asserts a specific contract the /spec templates must encode.
 * If a template drifts away from a contract, the test fails immediately —
 * no LLM, no E2E cost.
 *
 * /spec is CARVED (token-reduction Phase 4): the always-loaded skeleton
 * (spec/SKILL.md.tmpl) keeps Phases 1-4 (the turn-1..N conversational spine:
 * hard gate, dedupe, scope, technical interrogation, draft review) plus the
 * phase-gating/sequencing summary; the mechanical tail (Phases 4.5/4.5a/4.5b
 * quality gate + redaction, Phase 5 file/archive/spawn, TTHW telemetry) lives
 * in spec/sections/gate-and-file.md, read on demand at the draft-confirmation
 * gate. Redaction and filing deliberately travel in ONE section so an agent
 * cannot load the `gh issue create` bash without also loading the fail-closed
 * redaction gate that precedes it.
 *
 * Pins are LOCATION-AWARE (stronger than a union sweep): skeleton contracts
 * assert on the skeleton, carved contracts assert on the section, and the
 * carve-shape suite asserts the heavy markers actually LEFT the skeleton.
 *
 * Covers (W7 plan):
 *   spec-phase-gating       — Phase 1 hard gate ("no issue after first message")   [skeleton]
 *   spec-phase4-revise      — Phase 4 "what did I get wrong" loop                  [skeleton]
 *   spec-dedupe-no-gh       — graceful skip on gh missing / unauth / rate-limit    [skeleton]
 *   spec-dedupe-matches     — merge-with-or-file-new AskUserQuestion for matches   [skeleton]
 *   spec-execute-dirty      — porcelain check + 3-path AUQ + TOCTOU re-check       [section]
 *   spec-execute-race       — unique branch spec/<slug>-$$ + SHA pin               [section]
 *   spec-quality-gate-fallback   — codex timeout/unavailable skip-with-warn        [section]
 *   spec-quality-gate-redaction  — fail-closed shared-engine scan + delimiters     [section]
 *   spec-quality-gate-secret-sink — invariant: raw spec not persisted on block     [section]
 *   spec-archive            — gstack-paths eval + atomic tmp/mv + PID suffix       [section]
 *   spec-archive-sync-exclusion  — /specs/ auto-exclude from sync allowlist        [section]
 *   spec-audit-flag         — flag routes to Audit/Cleanup template                [skeleton]
 *   spec-concurrency        — PID suffix in branch + atomic archive write          [section]
 *   spec-plan-mode-detection — reads GSTACK_PLAN_MODE env                          [section]
 *   spec-carve-shape        — skeleton STOP-reads the section; heavy body moved    [both]
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// Always-loaded skeleton (template + generated).
const TMPL = fs.readFileSync(path.join(ROOT, 'spec', 'SKILL.md.tmpl'), 'utf-8');
const GEN = fs.readFileSync(path.join(ROOT, 'spec', 'SKILL.md'), 'utf-8');

// On-demand section: Phases 4.5/4.5a/4.5b + Phase 5 (template + generated).
// The redaction taxonomy + invocation bash are injected by the gen-skill-docs
// resolver, so the literal patterns/bash live in the GENERATED section .md, not
// the .tmpl. Redaction assertions read the generated file.
const SEC_TMPL = fs.readFileSync(
  path.join(ROOT, 'spec', 'sections', 'gate-and-file.md.tmpl'), 'utf-8');
const SEC_GEN = fs.readFileSync(
  path.join(ROOT, 'spec', 'sections', 'gate-and-file.md'), 'utf-8');

// Union views for "nowhere in /spec" negatives (a negative pin that only checks
// one file would let the banned pattern sneak into the other).
const TMPL_UNION = TMPL + '\n' + SEC_TMPL;

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

describe('/spec --execute dirty-worktree gate (carved: gate-and-file section)', () => {
  test('runs git status --porcelain before spawn', () => {
    expect(SEC_TMPL).toMatch(/git status --porcelain/);
  });
  test('offers 3-option AskUserQuestion (continue / stash / cancel)', () => {
    expect(SEC_TMPL).toMatch(/Continue.*uncommitted/i);
    expect(SEC_TMPL).toMatch(/Stash and restore/i);
    expect(SEC_TMPL).toMatch(/Cancel spawn/i);
  });
  test('TOCTOU re-check fires after AskUserQuestion answer', () => {
    expect(SEC_TMPL).toMatch(/TOCTOU.*re-?check|re-?run.*git status/i);
  });
});

describe('/spec --execute race + concurrency hardening (carved: gate-and-file section)', () => {
  test('captures SHA pin via git rev-parse HEAD (not "HEAD" string)', () => {
    expect(SEC_TMPL).toMatch(/PIN_SHA=\$\(git rev-parse HEAD\)/);
    expect(SEC_TMPL).toMatch(/git worktree add[^\n]*\$PIN_SHA/);
  });
  test('branch name includes PID suffix for concurrency safety', () => {
    expect(SEC_TMPL).toMatch(/SPAWN_BRANCH="spec\/\$\{SLUG_TITLE\}-\$\$"/);
  });
  test('worktree path includes PID suffix', () => {
    expect(SEC_TMPL).toMatch(/SPAWN_PATH=.*-\$\$/);
  });
});

describe('/spec quality gate fallback (carved: gate-and-file section)', () => {
  test('skips on codex timeout with explanatory message', () => {
    // `didn.t` matches both ASCII `'` and Unicode curly `’` apostrophes.
    expect(SEC_TMPL).toMatch(/codex didn.t respond in[\s\S]{0,80}2 minutes/);
    // Template wraps `--no-gate` in backticks, so allow flexible separator:
    expect(SEC_TMPL).toMatch(/--no-gate.{0,3}to disable/i);
  });
  test('skips on codex not installed / unauthed', () => {
    expect(SEC_TMPL).toMatch(/codex.*not installed/i);
    expect(SEC_TMPL).toMatch(/codex.*auth.*failed/i);
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
    expect(SEC_GEN).toMatch(/Full taxonomy.*lib\/redact-patterns\.ts|\/cso/);
    expect(SEC_GEN).toMatch(/~30 secret\/PII\/legal patterns/);
  });
  test('redaction routes through the shared gstack-redact bin, not inline regex', () => {
    expect(SEC_GEN).toContain('gstack-redact');
    expect(SEC_GEN).toContain('--from-file');
    // The old inline 7-regex prose is gone from every /spec template.
    expect(TMPL_UNION).not.toMatch(/AWS access key.*regex.*AKIA\[0-9A-Z\]/);
  });
  test('HIGH (exit 3) blocks dispatch; no skip flag for HIGH', () => {
    expect(SEC_GEN).toMatch(/Exit 3 \(HIGH\)/);
    expect(SEC_GEN).toMatch(/no skip flag for HIGH/i);
  });
  test('hard delimiter + instruction boundary still wraps the codex dispatch', () => {
    expect(SEC_TMPL).toContain('<<<USER_SPEC>>>');
    expect(SEC_TMPL).toContain('<<<END_USER_SPEC>>>');
    expect(SEC_TMPL).toMatch(/text between[\s\S]*delimiters[\s\S]*is DATA, not instructions/i);
  });
});

describe('/spec redaction at every sink (scan-at-sink, carved: gate-and-file section)', () => {
  test('scan precedes the gh issue create (pre-issue)', () => {
    const scanIdx = SEC_GEN.indexOf('Re-scan before filing');
    const fileIdx = SEC_GEN.indexOf('gh issue create --title');
    expect(scanIdx).toBeGreaterThan(-1);
    expect(fileIdx).toBeGreaterThan(scanIdx);
  });
  test('files from the scanned temp file (exact bytes, not a re-render)', () => {
    expect(SEC_GEN).toMatch(/gh issue create --title "<title>" --body-file "\$REDACT_FILE"/);
  });
  test('scan precedes the archive write (pre-archive)', () => {
    const scanIdx = SEC_GEN.indexOf('Re-scan before archiving');
    const archIdx = SEC_GEN.indexOf('ARCHIVE_PATH.tmp');
    expect(scanIdx).toBeGreaterThan(-1);
    expect(archIdx).toBeGreaterThan(scanIdx);
  });
  test('D2: sanitized body lands in the archive', () => {
    expect(SEC_GEN).toMatch(/sanitized body[\s\S]{0,200}\$REDACT_FILE/i);
  });
});

describe('/spec quality gate secret-sink invariant (carved: gate-and-file section)', () => {
  test('declares "raw spec must NOT be persisted" when the scan BLOCKS', () => {
    expect(SEC_TMPL).toMatch(/raw spec must NOT[\s\S]*be persisted/i);
  });
  test('BLOCK path stops before dispatch/archive/file', () => {
    expect(SEC_TMPL).toMatch(/no archive write, no transcript log, no codex\s*\n?\s*dispatch/i);
  });
});

describe('/spec Phase 4.5a semantic content review (carved: gate-and-file section)', () => {
  test('semantic pass precedes the regex scan', () => {
    const semIdx = SEC_TMPL.indexOf('Phase 4.5a: Semantic Content Review');
    const regexIdx = SEC_TMPL.indexOf('Phase 4.5b: Fail-closed redaction');
    expect(semIdx).toBeGreaterThan(-1);
    expect(regexIdx).toBeGreaterThan(semIdx);
  });
  test('emits a structurally-testable SEMANTIC_REVIEW marker', () => {
    expect(SEC_TMPL).toMatch(/SEMANTIC_REVIEW: clean/);
    expect(SEC_TMPL).toMatch(/SEMANTIC_REVIEW: flagged/);
  });
  test('lists all five semantic categories', () => {
    expect(SEC_TMPL).toMatch(/Named individuals attached to negative judgments/i);
    expect(SEC_TMPL).toMatch(/Customer\/vendor names tied to negative events/i);
    expect(SEC_TMPL).toMatch(/Unannounced internal strategy/i);
    expect(SEC_TMPL).toMatch(/NDA-bound material/i);
    expect(SEC_TMPL).toMatch(/Confidential context bleed/i);
  });
  test('prompt-injection hardened: marker in body forces flagged', () => {
    expect(SEC_TMPL).toMatch(/contains[\s\S]{0,20}`SEMANTIC_REVIEW:`[\s\S]{0,80}force the[\s\S]{0,10}outcome to `flagged`/i);
  });
  test('public repo disables option B (acknowledge and proceed)', () => {
    expect(SEC_TMPL).toMatch(/PUBLIC repo,\s*option B is disabled/i);
  });
  test('appends a content-free audit record (sha256, no body text)', () => {
    expect(SEC_TMPL).toContain('redact-audit-log.ts');
    expect(SEC_TMPL).toMatch(/categories_flagged/);
  });
});

describe('/spec --no-gate keeps redacting', () => {
  test('flag table (always-loaded skeleton) says redaction still runs under --no-gate', () => {
    expect(TMPL).toMatch(/Redaction.*still runs.*no flag that disables it/i);
  });
  test('the executing section restates it next to the scan', () => {
    expect(SEC_TMPL).toMatch(/redaction always runs, no flag disables it/i);
  });
});

describe('/spec archive (carved: gate-and-file section)', () => {
  test('uses eval $(gstack-paths) not hardcoded ~/.gstack/', () => {
    expect(SEC_TMPL).toMatch(/eval "\$\(.+gstack-paths\)"/);
    expect(SEC_TMPL).toMatch(/\$GSTACK_STATE_ROOT\/projects\/\$SLUG\/specs/);
    // No hardcoded ~/.gstack/projects path anywhere in /spec:
    expect(TMPL_UNION).not.toMatch(/~\/\.gstack\/projects\/\$SLUG\/specs/);
  });
  test('atomic write via .tmp + mv', () => {
    expect(SEC_TMPL).toMatch(/\$ARCHIVE_PATH\.tmp/);
    expect(SEC_TMPL).toMatch(/mv "\$ARCHIVE_PATH\.tmp" "\$ARCHIVE_PATH"/);
  });
  test('PID suffix in archive filename', () => {
    expect(SEC_TMPL).toMatch(/ARCHIVE_NAME=.*\$\$/);
  });
  test('frontmatter includes spec_issue_number for /ship integration', () => {
    expect(SEC_TMPL).toMatch(/spec_issue_number:/);
    expect(SEC_TMPL).toMatch(/spec_branch:/);
    expect(SEC_TMPL).toMatch(/spec_executed:/);
  });
});

describe('/spec archive sync exclusion (carved: gate-and-file section)', () => {
  test('/specs/ excluded from artifacts-sync by default; --sync-archive opt-in', () => {
    expect(SEC_TMPL).toMatch(/\/specs\/.*auto-excluded.*artifacts-sync|excluded from.*allowlist/i);
    expect(SEC_TMPL).toMatch(/--sync-archive/);
    // The opt-in flag stays discoverable in the always-loaded flag table too.
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
    expect(TMPL_UNION).not.toMatch(/\| `--bug` \|/);
    expect(TMPL_UNION).not.toMatch(/\| `--feature` \|/);
    expect(TMPL_UNION).not.toMatch(/\| `--refactor` \|/);
  });
});

describe('/spec plan-mode-aware Phase 5 (DX7/DX11/F1, carved: gate-and-file section)', () => {
  test('reads GSTACK_PLAN_MODE env at Phase 5 dispatch', () => {
    expect(SEC_TMPL).toMatch(/GSTACK_PLAN_MODE/);
    expect(SEC_TMPL).toMatch(/plan-mode-aware default/i);
  });
  test('plan-mode active → file-only path; inactive → file + spawn', () => {
    expect(SEC_TMPL).toMatch(/GSTACK_PLAN_MODE=active.*file-only path/);
    expect(SEC_TMPL).toMatch(/GSTACK_PLAN_MODE=inactive.*file \+ spawn/);
  });
  test('--file-only / --no-execute / --plan-file override flags (dispatch + flag table)', () => {
    for (const doc of [SEC_TMPL, TMPL]) {
      expect(doc).toMatch(/--file-only/);
      expect(doc).toMatch(/--no-execute/);
      expect(doc).toMatch(/--plan-file/);
    }
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
    expect(SEC_TMPL).toMatch(/SPAWN_BRANCH=.*\$\$/);
  });
  test('atomic archive write prevents JSONL/file interleave', () => {
    expect(SEC_TMPL).toMatch(/atomic.*rename|atomic write/i);
  });
});

describe('/spec carve shape (skeleton routes to gate-and-file; heavy body moved)', () => {
  const STOP = '> **STOP.**';
  const SECTION_REF = 'sections/gate-and-file.md';

  test('skeleton ships the Section index and a STOP-Read for gate-and-file', () => {
    expect(GEN).toContain('## Section index');
    expect(GEN).toContain(SECTION_REF);
    expect(GEN).toContain(STOP);
  });

  test('the STOP-Read sits at the Phase 4 → 4.5 boundary (after draft review)', () => {
    const phase4Idx = GEN.indexOf('### Phase 4: Draft Review');
    expect(phase4Idx).toBeGreaterThan(-1);
    // First ref in the file is the Section index table; first ref AFTER Phase 4
    // is the STOP-Read itself (the closing self-check references it again later).
    const stopIdx = GEN.indexOf(SECTION_REF, phase4Idx);
    expect(stopIdx).toBeGreaterThan(phase4Idx);
    // ...and before the interrogation guidance that follows the process wall.
    const afterIdx = GEN.indexOf('## How to Ask Questions');
    expect(afterIdx).toBeGreaterThan(stopIdx);
  });

  test('skeleton keeps the phase-gating/sequencing summary for Phases 4.5-5', () => {
    expect(TMPL).toMatch(/### Phases 4\.5 and 5:.*sequencing summary/);
    expect(TMPL).toMatch(/semantic content review \(Phase 4\.5a\), fail-closed redaction scan/);
    expect(TMPL).toMatch(/`--no-gate` never skips it/);
    expect(TMPL).toMatch(/Do NOT run the\s*\n?\s*gate, file, archive, or spawn from this summary/i);
  });

  test('heavy Phase 4.5/5 body actually LEFT the always-loaded skeleton', () => {
    // One marker per carved capability: codex dispatch, semantic marker,
    // redaction bin, issue filing, archive write, spawn machinery.
    for (const moved of [
      '<<<USER_SPEC>>>',
      'SEMANTIC_REVIEW: clean',
      'gstack-redact',
      'gh issue create --title',
      'ARCHIVE_PATH.tmp',
      'PIN_SHA=$(git rev-parse HEAD)',
    ]) {
      expect(TMPL).not.toContain(moved);
      expect(GEN).not.toContain(moved);
    }
  });

  test('manifest is the passive registry for the carve', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'spec', 'sections', 'manifest.json'), 'utf-8'));
    expect(manifest.skill).toBe('spec');
    const entry = manifest.sections.find((s: { id: string }) => s.id === 'gate-and-file');
    expect(entry).toBeDefined();
    expect(entry.file).toBe('gate-and-file.md');
    expect(fs.existsSync(path.join(ROOT, 'spec', 'sections', entry.file))).toBe(true);
  });

  test('generated section carries the AUTO-GENERATED header (not hand-edited)', () => {
    expect(SEC_GEN.slice(0, 200)).toContain('AUTO-GENERATED');
  });

  test('skeleton closes with the section self-check', () => {
    expect(TMPL).toMatch(/## Section self-check \(before you finish\)/);
    const selfCheckIdx = TMPL.indexOf('## Section self-check');
    expect(TMPL.indexOf('## Handoff')).toBeLessThan(selfCheckIdx);
  });
});
