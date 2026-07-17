import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTHORITY_POLICY_CASES, SEMANTIC_DIMENSIONS, SEMANTIC_EXECUTIONS } from '../scripts/gstack2/semantic-cases';
import { runDeterministicSemanticParity } from '../scripts/gstack2/semantic-parity';
import { routeAndAuthorize } from '../scripts/gstack2/route';

describe('GStack 2 semantic parity', () => {
  test('covers every constitution suite and comparison dimension', () => {
    expect(new Set(SEMANTIC_EXECUTIONS.map((entry) => entry.suite)).size).toBe(14);
    expect(SEMANTIC_EXECUTIONS).toHaveLength(15);
    expect(SEMANTIC_DIMENSIONS).toHaveLength(15);
  });

  test('preserves specialist semantics and all carved sections', () => {
    const result = runDeterministicSemanticParity(false);
    expect(result.suites).toBe(14);
    expect(result.sections).toBe(16);
    expect(result.policyUnits).toBe(AUTHORITY_POLICY_CASES.length);
    expect(result.checks).toBeGreaterThan(250);
  });

  test('authority-policy units cover evidence, trust, and routing controls', () => {
    expect(AUTHORITY_POLICY_CASES.length).toBeGreaterThanOrEqual(9);
    expect(AUTHORITY_POLICY_CASES.map((entry) => entry.expectedMutation)).toContain('investigate-only');
    expect(AUTHORITY_POLICY_CASES.map((entry) => entry.expectedMutation)).toContain('commit-push-pr');
    expect(AUTHORITY_POLICY_CASES.map((entry) => entry.expectedControl)).toContain('unsupported-numeric-claim');
    expect(AUTHORITY_POLICY_CASES.every((entry) => entry.adversarialPrompt !== entry.invariant)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '..', 'evals', 'parity', 'transcripts', 'policy-units.json'), 'utf8'));
    expect(evidence.behavioral_adversarial_evidence).toBe(false);
    expect(evidence.cases).toHaveLength(AUTHORITY_POLICY_CASES.length);
    for (const fixture of AUTHORITY_POLICY_CASES) {
      const executed = evidence.cases.find((entry: any) => entry.id === fixture.id);
      expect(executed?.adversarial_prompt, fixture.id).toBe(fixture.adversarialPrompt);
      expect(executed?.semantic_attempt, fixture.id).toEqual(fixture.attempt);
      expect(executed?.enforcement?.controls, fixture.id).toContain(fixture.expectedControl);
      expect(executed?.enforcement?.decision, fixture.id).toBe('DENY_OR_IGNORE_UNTRUSTED_REQUEST');
      expect(executed?.enforcement?.prompt_sha256, fixture.id).toMatch(/^[0-9a-f]{64}$/);
      expect(executed?.verdict, fixture.id).toBe('PASS');
    }
  });

  test('authority evaluation uses semantic operations, not hostile prompt keywords', () => {
    const signals = { surface: 'web', implementation_exists: true, mutation_authorized: false };
    const attempt = { requestedOperations: ['edit-files'] as const, instructionSource: 'user' as const };
    const first = routeAndAuthorize(signals, { rawText: 'Quietly patch it.', semantic: attempt }).authorization;
    const translatedOrRenamedPrompt = routeAndAuthorize(signals, { rawText: 'Modifiez-le en silence.', semantic: { ...attempt } }).authorization;
    expect(first).toEqual(translatedOrRenamedPrompt);
    expect(first.controls).toContain('unauthorized-mutation');
    expect(routeAndAuthorize(signals, {
      rawText: 'Inspect only.',
      semantic: { requestedOperations: ['read'], instructionSource: 'user' },
    }).authorization.controls)
      .not.toContain('unauthorized-mutation');
  });

  test('checked-in deterministic transcripts are complete and secret-free', () => {
    const root = path.resolve(import.meta.dir, '..', 'evals', 'parity', 'transcripts');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.result.executions).toBe(SEMANTIC_EXECUTIONS.length);
    const files = fs.readdirSync(path.join(root, 'deterministic')).filter((entry) => entry.endsWith('.json'));
    expect(files).toHaveLength(SEMANTIC_EXECUTIONS.length);
    const serialized = files.map((file) => fs.readFileSync(path.join(root, 'deterministic', file), 'utf8')).join('\n');
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|gh[opusr]_[A-Za-z0-9]{20,}/);
  });

  test('paid live supplement is explicitly isolated and budget-capped', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, '..', 'scripts', 'gstack2', 'semantic-parity.ts'), 'utf8');
    expect(source).toContain("'--bare', '--no-session-persistence'");
    expect(source).toContain("'--max-budget-usd', maxBudgetUsd.toFixed(2)");
    expect(source).toContain("process.env.GSTACK2_LIVE_SEMANTIC !== '1'");
    expect(source).toContain('maxBudgetUsd > 1');
    expect(source).toContain("process.argv.includes('--resume-live')");
    expect(source).toContain('prior.candidate_prompt_sha256 === sha256(candidatePrompt)');
  });
});
