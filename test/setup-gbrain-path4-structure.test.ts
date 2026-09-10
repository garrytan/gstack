// setup-gbrain Path 4 structural lint.
//
// Verifies the skill's templates carry the prose contract that Path 4
// (Remote MCP) depends on: STOP gates after verify failures, never-write-token
// rules, mode-aware CLAUDE.md block, idempotent re-run path.
//
// Carve-aware (token-reduction Phase 4): setup-gbrain is carved — the
// SKILL.md.tmpl is a decision-tree skeleton (detect, path dispatch, verify,
// MCP registration, verdict) and the branch-exclusive install bodies live in
// setup-gbrain/sections/*.md.tmpl. Each pin below targets the file that OWNS
// the content: dispatch/verdict pins hit the skeleton, per-path init pins hit
// sections/brain-init.md.tmpl, the CLAUDE.md block pins hit
// sections/claude-md-persist.md.tmpl, and the token-security regressions run
// over the union so a marker can't silently vanish during a re-carve.
//
// Why a structural test instead of a full Agent SDK E2E:
//   - Side effects (claude.json mutation, MCP registration) are covered
//     by unit tests for gstack-gbrain-mcp-verify and gstack-artifacts-init.
//   - The structural prose is the source of regressions for AUQ pacing
//     (the failure mode the gstack repo has tracked since v1.26.x:
//     "wrote_findings_before_asking"). A grep-based regression on the
//     template prose is fast (<200ms), free, and catches the same drift
//     as the paid E2E without spending tokens.
//   - The full Agent SDK E2E remains the right tool for end-to-end
//     pacing eval; this is the gate-tier check that catches the failure
//     class deterministically.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_DIR = path.join(ROOT, 'setup-gbrain');
const SECTIONS_DIR = path.join(SKILL_DIR, 'sections');

// Skeleton template — always loaded; owns detect, path dispatch, Steps 5/5a/6/7/9/10.
const skeleton = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md.tmpl'), 'utf-8');
// Per-path init procedures (Paths 1/2a/2b/3/4 + Switch) — Step 4 body.
const brainInit = fs.readFileSync(path.join(SECTIONS_DIR, 'brain-init.md.tmpl'), 'utf-8');
// Step 8 CLAUDE.md persist body (both mode blocks + the gated guidance write).
const claudeMdPersist = fs.readFileSync(
  path.join(SECTIONS_DIR, 'claude-md-persist.md.tmpl'),
  'utf-8',
);
// Skeleton + every section template — total behavior, order-stable.
const union = [skeleton]
  .concat(
    fs
      .readdirSync(SECTIONS_DIR)
      .filter((f) => f.endsWith('.md.tmpl'))
      .sort()
      .map((f) => fs.readFileSync(path.join(SECTIONS_DIR, f), 'utf-8')),
  )
  .join('\n');

describe('setup-gbrain carve — dispatch stays in the skeleton', () => {
  test('the path-dispatch step (Step 2 picker) stays always-loaded', () => {
    expect(skeleton).toContain('## Step 2: Pick a path (AskUserQuestion)');
  });

  test('the skeleton routes to all four sections and renders the index', () => {
    expect(skeleton).toContain('{{SECTION_INDEX:setup-gbrain}}');
    for (const id of ['engine-remediation', 'brain-init', 'transcript-gate', 'claude-md-persist']) {
      expect(skeleton).toContain(`{{SECTION:${id}}}`);
    }
  });

  test('the carved bodies moved OUT of the skeleton (no leak-back)', () => {
    // Step 4 per-path init:
    expect(skeleton).not.toContain('### Path 1 (Supabase, existing URL)');
    expect(skeleton).not.toContain('read_secret_to_env GBRAIN_MCP_TOKEN');
    // Step 1.5 remediation AUQ:
    expect(skeleton).not.toContain("Your local gbrain engine isn't responding");
    // Step 7.5 ingest gate body:
    expect(skeleton).not.toContain('gstack-memory-ingest.ts --probe');
    // Step 8 block formats:
    expect(skeleton).not.toContain('Mode: remote-http');
  });
});

describe('setup-gbrain Path 4 (Remote MCP) — structural contract', () => {
  test('Step 2 lists Path 4 as one of the path options (skeleton)', () => {
    // "4 — Remote gbrain MCP" with em-dash (—, U+2014 — one codepoint).
    expect(skeleton).toMatch(/\*\*4 . Remote gbrain MCP/);
  });

  test('Step 4 has a Path 4 sub-section (brain-init section)', () => {
    expect(brainInit).toMatch(/### Path 4 \(Remote gbrain MCP/);
  });

  test('Step 4 collects the bearer via read_secret_to_env, never argv', () => {
    // The secret-read helper is the canonical token-capture pattern.
    // Without it, tokens land in shell history.
    expect(brainInit).toContain('read_secret_to_env GBRAIN_MCP_TOKEN');
  });

  test('Step 4c invokes gstack-gbrain-mcp-verify and STOPs on failure', () => {
    expect(brainInit).toContain('gstack-gbrain-mcp-verify');
    // The STOP rule is what prevents partial registration after auth fail.
    const path4Section = brainInit.split('### Path 4')[1] || '';
    expect(path4Section).toMatch(/STOP/);
  });

  test('Step 4d explicitly skips Steps 3, 4 (other paths), 5, 7.5 in remote mode', () => {
    expect(brainInit).toMatch(/4d.*[Ss]kip Steps? 3, 4.*5.*7\.5/s);
  });

  test('Step 5a has a Path 4 branch with claude mcp add --transport http (skeleton)', () => {
    expect(skeleton).toMatch(/Path 4 \(Remote MCP/);
    expect(skeleton).toMatch(/claude mcp add --scope user --transport http gbrain/);
    expect(skeleton).toContain('Authorization: Bearer $GBRAIN_MCP_TOKEN');
    // Token must be unset after registration so it doesn't linger in env.
    expect(skeleton).toMatch(/unset GBRAIN_MCP_TOKEN/);
  });

  test('Step 5a removes any prior gbrain registration before adding the new one', () => {
    // Otherwise local-stdio + remote-http coexist, which breaks routing.
    expect(skeleton).toMatch(/claude mcp remove gbrain/);
  });

  test('Step 7 calls gstack-artifacts-init with --url-form-supported flag (skeleton)', () => {
    expect(skeleton).toMatch(/gstack-artifacts-init.*--url-form-supported/);
  });

  test('Step 8 CLAUDE.md block branches on mode (claude-md-persist section)', () => {
    // The remote-http block has Mode: remote-http; local-stdio block has Engine:.
    expect(claudeMdPersist).toMatch(/### Path 4 \(Remote MCP\)/);
    expect(claudeMdPersist).toMatch(/Mode: remote-http/);
    expect(claudeMdPersist).toMatch(/Mode: local-stdio/);
  });

  test('Step 8 explicitly says the bearer is never written to CLAUDE.md', () => {
    // Token-leak regression guard. CLAUDE.md is committed in many projects.
    expect(claudeMdPersist).toMatch(/bearer token is \*\*never\*\* written to CLAUDE\.md/);
  });

  test('Step 9 smoke test on Path 4 prints a placeholder, never the real token', () => {
    // Don't paste the token into the curl example the user might share.
    expect(skeleton).toMatch(/<YOUR_TOKEN>/);
  });

  test('Step 10 verdict block has a remote-http variant separate from local-stdio', () => {
    expect(skeleton).toMatch(/### Path 4 \(Remote MCP\)/);
    expect(skeleton).toMatch(/mode: remote-http/);
    expect(skeleton).toMatch(/N\/A.*remote mode/);
  });

  test('idempotency: re-running with gbrain_mcp_mode=remote-http skips Step 2', () => {
    // Re-run path stays graceful; no double-registration.
    expect(skeleton).toMatch(/gbrain_mcp_mode=remote-http/);
  });

  test('Step 5 (local doctor) explicitly skips on Path 4 (skeleton)', () => {
    expect(skeleton).toMatch(/SKIP entirely on Path 4 \(Remote MCP\)/);
  });

  test('Step 7.5 (transcript ingest) explicitly skips on Path 4 (skeleton)', () => {
    // Transcript ingest needs local gbrain CLI which Path 4 doesn't install.
    // The skip notes are DISPATCH — they must stay in the always-loaded
    // skeleton (Steps 3, 5, and 7.5 each carry one).
    const matches = skeleton.match(/SKIP entirely on Path 4 \(Remote MCP\)/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('setup-gbrain Path 4 — token security regressions', () => {
  test('no template (skeleton or section) inlines a real-shaped bearer string', () => {
    // We never want a literal "gbrain_<hex>" token to appear in the
    // templates — placeholders only. This catches the failure mode where
    // someone copies a real token into a template by accident.
    const realTokenShape = /gbrain_[a-f0-9]{40,}/;
    expect(union).not.toMatch(realTokenShape);
  });

  test('Path 4 always uses env-var $GBRAIN_MCP_TOKEN, never inline strings', () => {
    // Find every reference to the bearer header in Path 4 (across the
    // skeleton AND sections) and verify it's either an env-var expansion
    // or an explicit placeholder. Allow:
    //   - $GBRAIN_MCP_TOKEN  (env-var expansion)
    //   - <bearer>, <YOUR_TOKEN>, <TOKEN>  (placeholder)
    //   - "..."  (rest-of-doc-text continuation; a doc note showing how
    //     `claude mcp add --header` shapes its argv).
    const path4Section = union.match(/### Path 4 \(Remote MCP[\s\S]*?(?=###|## )/g)?.join('') || '';
    const bearerLines = path4Section.match(/Bearer\s+\S+/g) || [];
    for (const line of bearerLines) {
      expect(line).toMatch(/Bearer (\$GBRAIN_MCP_TOKEN|<bearer>|<YOUR_TOKEN>|<TOKEN>|\.\.\."?)/);
    }
  });
});
