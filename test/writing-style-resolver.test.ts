/**
 * Writing Style preamble section — gate-tier assertions on generated prose.
 *
 * These tests assert the V1 Writing Style section is properly composed into
 * tier-≥2 preamble output, in both Claude and Codex host outputs. Since the
 * block itself is prose the agent obeys at runtime, we can't test the agent's
 * compliance here — that's the periodic LLM-judge E2E test (to-be-added).
 *
 * What this test enforces:
 * - Writing Style section header present in tier-≥2 generated preamble
 * - Compact semantic contract present (gloss, outcome, impact, override)
 * - Jargon list inlined (sample terms appear)
 * - Terse-mode gate condition text present
 * - Codex output uses $GSTACK_BIN, not ~/.claude/... (host-aware paths)
 * - Tier-1 preamble does NOT include Writing Style section
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generatePreamble } from '../scripts/resolvers/preamble';

// Token-reduction Phase 1: the EXPLAIN_LEVEL config read + echo moved from the
// inline preamble bash into bin/gstack-skill-start; the render keeps the
// interpretation prose that acts on the echoed key.
const SKILL_START_SCRIPT = fs.readFileSync(
  path.join(import.meta.dir, '..', 'bin', 'gstack-skill-start'),
  'utf-8',
);

function makeCtx(host: 'claude' | 'codex', tier: 1 | 2 | 3 | 4): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: tier,
  };
}

describe('Writing Style preamble section', () => {
  test('tier 2+ Claude preamble includes Writing Style header', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toContain('## Writing Style');
  });

  test('EXPLAIN_LEVEL is echoed by gstack-skill-start and read by tier 2+ prose', () => {
    // The bash echo lives in the script the preamble fence invokes...
    expect(SKILL_START_SCRIPT).toContain('_EXPLAIN_LEVEL=$(');
    expect(SKILL_START_SCRIPT).toContain('echo "EXPLAIN_LEVEL: $_EXPLAIN_LEVEL"');
    // ...and the tier-2+ render references the echoed key.
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toContain('EXPLAIN_LEVEL:');
  });

  test('tier 2+ preamble includes the compact writing-style contract', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toMatch(/gloss.*first use|first-use.*gloss/i);
    expect(out).toMatch(/outcome/i);
    expect(out).toMatch(/user impact|user.*experience|what.*user.*sees/i);
    expect(out).toMatch(/terse|no explanations|user-turn override|current message/i);
  });

  test('tier 2+ preamble references jargon list by path (v1.45.0.0 T3 — pointer, not inline)', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    // T3 dedup: the 80-term jargon list lives in scripts/jargon-list.json.
    // The Writing Style section points at the file rather than inlining it,
    // saving ~70 KB across the corpus. Agents Read the JSON on first
    // jargon term encountered per session.
    expect(out).toContain('jargon-list.json');
    expect(out).toContain('Curated jargon list');
    // Negative check: the literal term lines should NOT be inlined any more.
    expect(out).not.toMatch(/^- idempotent$/m);
    expect(out).not.toMatch(/^- race condition$/m);
  });

  test('tier 2+ preamble includes terse-mode gate condition', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toContain('EXPLAIN_LEVEL: terse');
    expect(out).toMatch(/skip.*terse|Terse mode.*skip/is);
  });

  test('Codex tier-2 preamble uses host-aware path (no .claude/)', () => {
    const out = generatePreamble(makeCtx('codex', 2));
    // The config read moved into gstack-skill-start, which resolves its bin
    // dir $0-relative ($_BIN) — host-neutral by construction.
    const explainLine = SKILL_START_SCRIPT.split('\n').find(l => l.includes('_EXPLAIN_LEVEL='));
    expect(explainLine).toBeDefined();
    expect(explainLine).not.toMatch(/~\/\.claude\//);
    expect(explainLine).toContain('$_BIN/');
    // The Codex render's fence must reach the script via the host path, not
    // a Claude-specific one.
    const fenceLine = out.split('\n').find(l => l.includes('_SS='));
    expect(fenceLine).toBeDefined();
    expect(fenceLine).not.toMatch(/~\/\.claude\//);
    expect(fenceLine).toContain('$GSTACK_BIN');
  });

  test('tier 1 preamble does NOT include Writing Style section', () => {
    const out = generatePreamble(makeCtx('claude', 1));
    expect(out).not.toContain('## Writing Style');
  });

  test('tier 2+ preamble composition note references AskUserQuestion Format', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    // The Writing Style section should explicitly compose with the existing Format section
    expect(out).toContain('AskUserQuestion Format');
  });

  test('migration prompt lives in gstack-skill-start (marker-gated emit)', () => {
    // Token-reduction Phase 2: the one-time V0→V1 migration prompt left the
    // rendered preamble; bin/gstack-skill-start computes the gate from the
    // marker files and emits it as a GSTACK_INSTRUCTION block, with the ack
    // (clear pending + set prompted) carried INSIDE the block for the model
    // to run after the interaction. The prompt text itself is pinned by
    // test/onboarding-moved-literals.test.ts (tombstone).
    expect(SKILL_START_SCRIPT).toContain(
      'if [ -f "$_GH/.writing-style-prompt-pending" ] && [ ! -f "$_GH/.writing-style-prompted" ]',
    );
    expect(SKILL_START_SCRIPT).toContain('_emit_block writing-style-migration');
    expect(SKILL_START_SCRIPT).toContain(
      'rm -f "$_GH/.writing-style-prompt-pending" && touch "$_GH/.writing-style-prompted"',
    );
  });
});
