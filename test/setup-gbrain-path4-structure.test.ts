// setup-gbrain Path 4 structural lint.
//
// Verifies the SKILL.md.tmpl has the prose contract that Path 4 (Remote MCP)
// depends on: STOP gates after verify failures, never-write-token rules,
// mode-aware CLAUDE.md block, idempotent re-run path.
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
const TMPL = path.join(ROOT, 'setup-gbrain', 'SKILL.md.tmpl');

const tmpl = fs.readFileSync(TMPL, 'utf-8');

describe('setup-gbrain Path 4 (Remote MCP) — structural contract', () => {
  test('Step 2 lists Path 4 as one of the path options', () => {
    // "4 — Remote gbrain MCP" with em-dash (—, U+2014 — one codepoint).
    expect(tmpl).toMatch(/\*\*4 . Remote gbrain MCP/);
  });

  test('Step 4 has a Path 4 sub-section', () => {
    expect(tmpl).toMatch(/### Path 4 \(Remote gbrain MCP/);
  });

  test('Step 4 collects the bearer via read_secret_to_env, never argv', () => {
    // The secret-read helper is the canonical token-capture pattern.
    // Without it, tokens land in shell history.
    expect(tmpl).toContain('read_secret_to_env GBRAIN_MCP_TOKEN');
  });

  test('Step 4c invokes gstack-gbrain-mcp-verify and STOPs on failure', () => {
    expect(tmpl).toContain('gstack-gbrain-mcp-verify');
    // The STOP rule is what prevents partial registration after auth fail.
    const path4Section = tmpl.split('### Path 4')[1] || '';
    expect(path4Section).toMatch(/STOP/);
  });

  test('Step 4d explicitly skips Steps 3, 4 (other paths), 5, 7.5 in remote mode', () => {
    expect(tmpl).toMatch(/4d.*[Ss]kip Steps? 3, 4.*5.*7\.5/s);
  });

  test('Step 5a has a Path 4 branch with claude mcp add --transport http', () => {
    expect(tmpl).toMatch(/Path 4 \(Remote MCP/);
    expect(tmpl).toMatch(/claude mcp add --scope user --transport http gbrain/);
    expect(tmpl).toContain('Authorization: Bearer $GBRAIN_MCP_TOKEN');
    // Token must be unset after registration so it doesn't linger in env.
    expect(tmpl).toMatch(/unset GBRAIN_MCP_TOKEN/);
  });

  test('Step 5a removes any prior gbrain registration before adding the new one', () => {
    // Otherwise local-stdio + remote-http coexist, which breaks routing.
    expect(tmpl).toMatch(/claude mcp remove gbrain/);
  });

  test('Step 7 calls gstack-artifacts-init with --url-form-supported flag', () => {
    expect(tmpl).toMatch(/gstack-artifacts-init.*--url-form-supported/);
  });

  test('Step 8 CLAUDE.md block branches on mode', () => {
    // The remote-http block has Mode: remote-http; local-stdio block has Engine:.
    expect(tmpl).toMatch(/### Path 4 \(Remote MCP\)/);
    expect(tmpl).toMatch(/Mode: remote-http/);
    expect(tmpl).toMatch(/Mode: local-stdio/);
  });

  test('Step 8 explicitly says the bearer is never written to CLAUDE.md', () => {
    // Token-leak regression guard. CLAUDE.md is committed in many projects.
    expect(tmpl).toMatch(/bearer token is \*\*never\*\* written to CLAUDE\.md/);
  });

  test('Step 9 smoke test on Path 4 prints a placeholder, never the real token', () => {
    // Don't paste the token into the curl example the user might share.
    expect(tmpl).toMatch(/<YOUR_TOKEN>/);
  });

  test('Step 10 verdict block has a remote-http variant separate from local-stdio', () => {
    expect(tmpl).toMatch(/### Path 4 \(Remote MCP\)/);
    expect(tmpl).toMatch(/mode: remote-http/);
    expect(tmpl).toMatch(/N\/A.*remote mode/);
  });

  test('idempotency: re-running with gbrain_mcp_mode=remote-http skips Step 2', () => {
    // Re-run path stays graceful; no double-registration.
    expect(tmpl).toMatch(/gbrain_mcp_mode=remote-http/);
  });

  test('Step 5 (local doctor) explicitly skips on Path 4', () => {
    expect(tmpl).toMatch(/SKIP entirely on Path 4 \(Remote MCP\)/);
  });

  test('Step 7.5 (transcript ingest) explicitly skips on Path 4', () => {
    // Transcript ingest needs local gbrain CLI which Path 4 doesn't install.
    const matches = tmpl.match(/SKIP entirely on Path 4 \(Remote MCP\)/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('setup-gbrain Path 4 — token security regressions', () => {
  test('the template never inlines a real-shaped bearer string', () => {
    // We never want a literal "gbrain_<hex>" token to appear in the
    // template — placeholders only. This catches the failure mode where
    // someone copies a real token into the template by accident.
    const realTokenShape = /gbrain_[a-f0-9]{40,}/;
    expect(tmpl).not.toMatch(realTokenShape);
  });

  test('Path 4 always uses env-var $GBRAIN_MCP_TOKEN, never inline strings', () => {
    // Find every reference to the bearer header in Path 4 and verify it's
    // either an env-var expansion or an explicit placeholder. Allow:
    //   - $GBRAIN_MCP_TOKEN  (env-var expansion)
    //   - <bearer>, <YOUR_TOKEN>, <TOKEN>  (placeholder)
    //   - "..."  (rest-of-doc-text continuation; a doc note showing how
    //     `claude mcp add --header` shapes its argv).
    const path4Section = tmpl.match(/### Path 4 \(Remote MCP[\s\S]*?(?=###|## )/g)?.join('') || '';
    const bearerLines = path4Section.match(/Bearer\s+\S+/g) || [];
    for (const line of bearerLines) {
      expect(line).toMatch(/Bearer (\$GBRAIN_MCP_TOKEN|<bearer>|<YOUR_TOKEN>|<TOKEN>|\.\.\."?)/);
    }
  });
});
