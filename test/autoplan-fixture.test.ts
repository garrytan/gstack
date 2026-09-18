/** Free lifecycle controls for the current native Autoplan paid caller. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTOPLAN_CHAIN_BUDGET } from './helpers/eval-budgets';

const ROOT = path.resolve(import.meta.dir, '..');

// Exercise the actual current paid caller, replacing only the native/provider
// boundaries. Permission epoch semantics are covered by the native recorder
// regressions; these controls preserve its full-chain budget and cleanup.
test.each(['progress', 'deadline', 'late-completion'] as const)('autoplan native caller preserves full-chain progress and the deadline: %s', mode => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-caller-'));
  const factsPath = path.join(dir, 'facts.json');
  try {
    const child = spawnSync(process.execPath, ['test', path.join(ROOT, 'test/fixtures/autoplan-caller.fixture.test.ts')], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_TIER: '',
        AUTOPLAN_CALLER_SCENARIO: mode, AUTOPLAN_CALLER_FACTS: factsPath,
        TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(mode === 'progress' ? 0 : 1);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts.inputs).toEqual(['/autoplan\r']);
    expect(facts.closed).toBe(true);
    expect(facts.approvalStartedAt).toBe(facts.startedAt);
    if (mode === 'progress') {
      expect(facts.elapsedMs).toBe(900001);
      expect(facts.elapsedMs).toBeLessThan(AUTOPLAN_CHAIN_BUDGET.workMs);
    } else {
      expect(child.stderr).toContain('outcome=timeout');
      expect(facts.elapsedMs).toBe(AUTOPLAN_CHAIN_BUDGET.workMs);
    }
    expect(fs.readdirSync(dir).filter(name => name.startsWith('gstack-autoplan-chain-'))).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

test.each(['entry-omission', 'entry-valid', 'entry-late', 'entry-equal', 'entry-foreign',
  'entry-child', 'entry-error', 'entry-missing-ack', 'entry-alias', 'entry-foreign-alias', 'entry-foreign-report'] as const)
('actual chain caller preserves the phase entry boundary: %s', mode => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-entry-caller-')));
  const factsPath = path.join(dir, 'facts.json');
  try {
    const child = spawnSync(process.execPath, ['test', path.join(ROOT, 'test/fixtures/autoplan-caller.fixture.test.ts')], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_TIER: '',
        AUTOPLAN_CALLER_SCENARIO: mode, AUTOPLAN_CALLER_FACTS: factsPath, TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    const violation = ['entry-omission', 'entry-late', 'entry-foreign-report'].includes(mode);
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(violation ? 1 : 0);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts.inputs).toEqual(['/autoplan\r']);
    expect(facts.closed).toBe(true);
    expect(facts.elapsedMs).toBe(15000);
    expect(facts.elapsedMs).toBeLessThan(AUTOPLAN_CHAIN_BUDGET.workMs);
    const terminal = facts.captured.at(-1);
    if (violation) {
      expect(child.stderr).toContain('outcome=premature_phase_entry');
      expect(terminal.state).toBe('premature_phase_entry');
      expect(terminal.prematurePhaseEntry).toMatchObject({ phase: 'design', requiredPhase: 1,
        readToolUseId: 'toolu_01XvX1QbuKqv1xWjpdHsFLnj' });
    } else {
      // No early abort is not an added ordering/coverage claim (notably equality).
      // The existing independent completion assertions still run in the caller.
      expect(terminal.state).toBe('chain_complete');
      expect(terminal.prematurePhaseEntry).toBeNull();
    }
    expect(fs.readdirSync(dir).filter(name => name.startsWith('gstack-autoplan-chain-'))).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
