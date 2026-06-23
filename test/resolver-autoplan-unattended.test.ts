/**
 * Autoplan Unattended Mode (G1+G2) + Decision Confidence (G7) — gate-tier
 * assertions on the generated prose and resolver wiring.
 *
 * These are the load-bearing strings the feature depends on. They're prose the
 * agent obeys at runtime, so this can't test agent compliance — it asserts the
 * blocks are present, registered, and composed into the generated autoplan
 * SKILL.md. (Agent-compliance is the periodic E2E auto-mode test.)
 *
 * What this enforces:
 * - Unattended Mode parks the two hard gates instead of silently auto-accepting
 * - Security/feasibility-flagged challenges HALT, not proceed
 * - A resume path exists (/autoplan --resume + pending-queue artifact)
 * - Decision Confidence adds an escalation threshold for low-confidence taste calls
 * - Both resolvers are registered in RESOLVERS and wired into autoplan/SKILL.md
 * - No unescaped `${` interpolation leaked into the bash (template-literal hazard)
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateAutoplanUnattended } from '../scripts/resolvers/autoplan-unattended';
import { generateDecisionConfidence } from '../scripts/resolvers/confidence';
import { RESOLVERS } from '../scripts/resolvers/index';

function makeCtx(host: 'claude' | 'codex' = 'claude'): TemplateContext {
  return {
    skillName: 'autoplan',
    tmplPath: 'autoplan/SKILL.md.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: 3,
  };
}

describe('Autoplan Unattended Mode resolver (G1+G2)', () => {
  const out = generateAutoplanUnattended(makeCtx());

  test('parks the two hard gates instead of silently auto-accepting', () => {
    expect(out).toContain('## Unattended Mode');
    expect(out).toContain('PARK them instead of auto-accepting');
    expect(out).toContain('PENDING_PREMISE_REVIEW');
    expect(out).toContain('PENDING_CHALLENGE');
  });

  test('writes a durable pending-decisions queue artifact', () => {
    expect(out).toContain('autoplan-pending');
    expect(out).toMatch(/\.jsonl/);
    expect(out).toContain('"resolved":false');
  });

  test('HALTS on a security/feasibility-flagged challenge', () => {
    expect(out).toContain('"security_flag":true');
    expect(out).toContain('BLOCKED — security/feasibility challenge requires human review');
  });

  test('offers an async notify hook and a resume path', () => {
    expect(out).toContain('notify_webhook');
    expect(out).toContain('/autoplan --resume');
  });

  test('is a no-op when AskUserQuestion is available (interactive unchanged)', () => {
    expect(out).toMatch(/interactive run.*changes nothing|changes nothing.*interactive/);
  });

  test('no unescaped ${ interpolation leaked into the bash', () => {
    // The embedded bash uses $BRANCH/$SLUG/$HOME (no braces) precisely so the
    // TS template literal does not interpolate. A literal "${" in the output
    // would mean an interpolation hazard slipped through.
    expect(out).not.toContain('${');
  });
});

describe('Decision Confidence resolver (G7)', () => {
  const out = generateDecisionConfidence(makeCtx());

  test('adds a 1-10 score and an escalation threshold for taste calls', () => {
    expect(out).toContain('## Decision Confidence');
    expect(out).toContain('autoplan_escalate_below');
    expect(out).toMatch(/below the threshold/i);
    expect(out).toContain('escalated: confidence N/10 < threshold');
  });

  test('never downgrades a User Challenge or the two hard gates', () => {
    expect(out).toMatch(/never downgrades a User Challenge/);
    expect(out).toMatch(/never overrides the\s+two hard gates/);
  });
});

describe('resolver registration + template wiring', () => {
  test('both resolvers are registered in RESOLVERS', () => {
    expect(RESOLVERS.AUTOPLAN_UNATTENDED).toBeDefined();
    expect(RESOLVERS.DECISION_CONFIDENCE).toBeDefined();
  });

  test('generated autoplan/SKILL.md composes both blocks (token wired + regenerated)', () => {
    const skillMd = fs.readFileSync(
      path.join(import.meta.dir, '..', 'autoplan', 'SKILL.md'),
      'utf-8',
    );
    expect(skillMd).toContain('## Unattended Mode');
    expect(skillMd).toContain('## Decision Confidence');
    expect(skillMd).toContain('/autoplan --resume');
    // Audit-trail table gained the Confidence column
    expect(skillMd).toContain('| # | Phase | Decision | Classification | Confidence | Principle | Rationale | Rejected |');
  });
});
