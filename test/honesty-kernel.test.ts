/**
 * The preamble's Claims Need Evidence kernel (docs/designs/HONEST_WORK_GATE_INTEGRITY.md W4).
 *
 * Pins where the kernel renders (tiers 2–4, default and terse; never tier 1),
 * its byte budget, and the machine-read markers each bullet carries; never the
 * sentences (docs/test-value-bar.md). The behavior claim is carried by the
 * selected prompt evals, not here.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generatePreamble } from '../scripts/resolvers/preamble';
import {
  EVIDENCE_KERNEL_BULLETS, EVIDENCE_KERNEL_HEADING, KERNEL_MAX_BYTES, generateEvidenceDirective,
} from '../scripts/resolvers/preamble/generate-evidence-directive';
import { generateCompletionStatus } from '../scripts/resolvers/preamble/generate-completion-status';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { between, expectMentions, expectTokens } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const ctx = (tier: number, explainLevel?: 'default' | 'terse'): TemplateContext => ({
  skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude, preambleTier: tier, explainLevel,
} as TemplateContext);

describe('Claims Need Evidence kernel', () => {
  test('renders five bullets within the byte budget, with the reuse pointer and the stderr rule', () => {
    const rendered = generateEvidenceDirective();
    expect(rendered.startsWith(`${EVIDENCE_KERNEL_HEADING}\n`)).toBe(true);
    const bullets = rendered.split('\n').filter(line => line.startsWith('- '));
    expect(bullets).toHaveLength(5);
    expect(EVIDENCE_KERNEL_BULLETS).toHaveLength(5);
    expect(Buffer.byteLength(bullets.join('\n'), 'utf8')).toBeLessThanOrEqual(KERNEL_MAX_BYTES);
    expectTokens(rendered, ['Reuse rules: Step 16', 'stderr', '"done, unverified"'], 'kernel');
    expectMentions(rendered, [
      ['limitation', 'verbatim error'],
      ['execution', 'command', 'fingerprint'],
      ['mock', 'live check'],
      ['disclose', 'failure', 'conclusion'],
      ['null result', 'success'],
    ], 'kernel');
    expect(rendered).not.toContain('Claimed Limitations Need Evidence');
  });

  test('composes for tiers 2–4 in default and terse builds, never for tier 1', () => {
    for (const tier of [2, 3, 4]) {
      for (const level of ['default', 'terse'] as const) {
        const out = generatePreamble(ctx(tier, level));
        expect(out, `tier ${tier} ${level} lacks the kernel`).toContain(generateEvidenceDirective());
        expect(out.indexOf(EVIDENCE_KERNEL_HEADING)).toBeLessThan(out.indexOf('## Completion Status Protocol'));
      }
    }
    for (const level of ['default', 'terse'] as const) {
      expect(generatePreamble(ctx(1, level))).not.toContain(EVIDENCE_KERNEL_HEADING);
    }
  });

  test('the DONE line binds evidence to the final consumed inputs and names reuse (every tier)', () => {
    const status = between(generateCompletionStatus(ctx(1)), '## Completion Status Protocol', '## Operational Self-Improvement');
    const done = status.split('\n').find(line => line.startsWith('- **DONE**'))!;
    expectTokens(done, ['**DONE**', 'final consumed inputs', 'reuse'], 'DONE line');
    expect(done).not.toBe('- **DONE** — completed with evidence.');
    for (const tier of [1, 2, 3, 4]) expect(generatePreamble(ctx(tier))).toContain(done);
  });

  test('generated SKILL.md files carry the kernel at tier 2+ and the old heading nowhere', () => {
    const skills = fs.readdirSync(ROOT).filter(dir => fs.existsSync(path.join(ROOT, dir, 'SKILL.md.tmpl')) && fs.existsSync(path.join(ROOT, dir, 'SKILL.md')));
    expect(skills.length).toBeGreaterThan(20);
    for (const skill of skills) {
      const tier = Number(/preamble-tier:\s*(\d)/.exec(fs.readFileSync(path.join(ROOT, skill, 'SKILL.md.tmpl'), 'utf8'))?.[1]);
      const rendered = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf8');
      expect(rendered, `${skill} still carries the retired heading`).not.toContain('Claimed Limitations Need Evidence');
      if (tier >= 2) expect(rendered, `${skill} (tier ${tier}) lacks the kernel; run bun run gen:skill-docs`).toContain(EVIDENCE_KERNEL_HEADING);
    }
  });
});
