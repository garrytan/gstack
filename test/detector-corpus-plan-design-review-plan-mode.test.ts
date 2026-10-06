import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { OFFICE_HOURS_BUN_GRACE_MS, runRecordedOfficeHoursAttempt } from './helpers/office-hours-attempt';
import { resolveEvalModel } from '../lib/eval-model';

// Replays stored census captures of plan-design-review-plan-mode through the
// case's real validate callback. The detector lives inline in the paid suite,
// so this evaluates its registration (the plan-design-sdk-fixture pattern)
// and replaces only the model run: the captured final message and saved plan.

const ROOT = path.resolve(import.meta.dir, '..');
const CASE = 'plan-design-review-plan-mode';
const DIR = path.join(ROOT, 'test/fixtures/detector-corpora', CASE);
const source = fs.readFileSync(path.join(ROOT, 'test/skill-e2e-design.test.ts'), 'utf8');

interface CorpusInput { exit_reason: string; output: string; plan_after: string | null }
interface CorpusEntry {
  schema: string; case: string; detector: string; series_identity: string;
  source: { run: string; sha: string; lane: string; artifact: string; path: string };
  census_outcome: 'passed' | 'failed'; census_error: string;
  expected: 'pass' | 'refuse'; justification: string; derived?: string; input: CorpusInput;
}

const files = fs.readdirSync(DIR).filter(name => name.endsWith('.json') && name !== 'inventory.json').sort();
const entries = files.map(name => ({ name, entry: JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as CorpusEntry }));

async function replay(input: CorpusInput) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detector-corpus-pdr-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const rows: Array<{ passed: boolean; exit_reason?: string; error?: string }> = [];
  const callbacks: Array<() => Promise<void>> = [];
  let workDir = '';
  const args = {
    ROOT, fs, path, os: { tmpdir: () => scratch }, expect,
    CAPTURE_MS, CAPTURE_LONG_MS, OFFICE_HOURS_BUN_GRACE_MS, resolveEvalModel, runId: 'detector-corpus',
    evalCollector: { addTest: (row: (typeof rows)[number]) => { rows.push(row); } },
    runRecordedOfficeHoursAttempt, logCost: () => {}, recordE2E: () => {},
    describeIfSelected: (_title: string, names: string[], fn: () => void) => { if (names.includes(CASE)) fn(); },
    testConcurrentIfSelected: (name: string, fn: () => Promise<void>) => { if (name === CASE) callbacks.push(fn); },
    spawnSync: (bin: string, argv: string[], opts: { cwd: string; timeout?: number }) =>
      spawnSync(bin, argv, { ...opts, env, timeout: opts.timeout ?? 5000 }),
    runSkillTest: async (opts: { workingDirectory: string }) => {
      workDir = opts.workingDirectory;
      expect(path.dirname(workDir)).toBe(scratch);
      if (input.plan_after !== null) fs.writeFileSync(path.join(workDir, 'plan.md'), input.plan_after);
      return { output: input.output, exitReason: input.exit_reason, duration: 1, toolCalls: [], browseErrors: [],
        transcript: [], model: 'detector-corpus-replay',
        costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 0 } };
    },
  };
  const start = source.indexOf("describeIfSelected('Plan Design Review E2E'");
  const end = source.indexOf("describeIfSelected('Design Review E2E'", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  let error: unknown;
  try {
    new Function(...Object.keys(args), new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end)))(...Object.values(args));
    expect(callbacks).toHaveLength(1);
    try { await callbacks[0]!(); } catch (caught) { error = caught; }
    expect(workDir).not.toBe('');
    expect(fs.existsSync(workDir)).toBe(false);
    expect(rows).toHaveLength(1);
    return { row: rows[0]!, error };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

describe(`${CASE} detector corpus`, () => {
  test('inventory accounts for every entry and every census in scope', () => {
    const inventory = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory.json'), 'utf8')) as Array<{
      run: string; lane: string; outcome: string; series_identity: string; artifact: string;
      available: boolean; entry: string | null; reason?: string }>;
    for (const row of inventory) {
      if (row.entry) expect(files).toContain(row.entry);
      else expect(row.reason).toBeTruthy();
    }
    for (const { name, entry } of entries) {
      const row = inventory.find(r => r.run === entry.source.run);
      expect(row, name).toBeDefined();
      expect(entry.census_outcome).toBe(row!.outcome as CorpusEntry['census_outcome']);
      expect(entry.series_identity).toBe(row!.series_identity);
      if (!entry.derived) expect(row!.entry).toBe(name);
    }
    expect(entries.some(e => e.entry.expected === 'pass')).toBe(true);
    expect(entries.some(e => e.entry.expected === 'refuse')).toBe(true);
  });

  test.each(entries.map(e => [e.name, e.entry] as const))('%s', async (name, entry) => {
    expect(entry.schema).toBe('gstack-detector-corpus/v1');
    expect(entry.case).toBe(CASE);
    expect(entry.source.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.justification).toBeTruthy();
    expect(fs.statSync(path.join(DIR, name)).size).toBeLessThanOrEqual(64 * 1024);
    const { row, error } = await replay(entry.input);
    expect(row.exit_reason).toBe(entry.input.exit_reason);
    if (entry.expected === 'pass') {
      expect(error).toBeUndefined();
      expect(row.passed).toBe(true);
    } else {
      expect(row.passed).toBe(false);
      expect(String(error)).toContain('expect(received)');
    }
  });
});
