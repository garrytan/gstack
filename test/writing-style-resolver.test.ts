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
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generatePreamble } from '../scripts/resolvers/preamble';

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

  test('tier 2+ preamble includes EXPLAIN_LEVEL echo in bash', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toContain('_EXPLAIN_LEVEL');
    expect(out).toContain('EXPLAIN_LEVEL:');
  });

  test('tier 2+ preamble includes the compact writing-style contract', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toMatch(/gloss.*first use|first-use.*gloss/i);
    expect(out).toMatch(/outcome/i);
    expect(out).toMatch(/user impact|user.*experience|what.*user.*sees/i);
    expect(out).toMatch(/terse|no explanations|user-turn override|current message/i);
  });

  test('tier 2+ preamble inlines jargon list', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    // Spot-check a few terms from scripts/jargon-list.json
    expect(out).toContain('idempotent');
    expect(out).toContain('race condition');
  });

  test('tier 2+ preamble includes terse-mode gate condition', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toContain('EXPLAIN_LEVEL: terse');
    expect(out).toMatch(/skip.*terse|Terse mode.*skip/is);
  });

  test('Codex tier-2 preamble uses host-aware path (no .claude/)', () => {
    const out = generatePreamble(makeCtx('codex', 2));
    // The Writing Style section shouldn't reference a Claude-specific bin path.
    // Specifically check the EXPLAIN_LEVEL bash line.
    const explainLine = out.split('\n').find(l => l.includes('_EXPLAIN_LEVEL='));
    expect(explainLine).toBeDefined();
    expect(explainLine).not.toMatch(/~\/\.claude\//);
    // Codex uses $GSTACK_BIN
    expect(explainLine).toContain('$GSTACK_BIN');
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

  test('tier 2+ preamble migration-prompt block appears', () => {
    const out = generatePreamble(makeCtx('claude', 2));
    expect(out).toContain('WRITING_STYLE_PENDING');
    expect(out).toMatch(/writing-style-prompt-pending/);
  });
});
