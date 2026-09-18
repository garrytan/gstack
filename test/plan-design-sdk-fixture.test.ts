import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { OFFICE_HOURS_BUN_GRACE_MS, runRecordedOfficeHoursAttempt } from './helpers/office-hours-attempt';
import { resolveEvalModel } from '../lib/eval-model';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, 'test/skill-e2e-design.test.ts'), 'utf8');
const id = 'plan-design-review-plan-mode';

// Same source-evaluation pattern as plan-tune-cathedral-fixture.test.ts: run
// the real suite registration and selected callback, without importing paid
// initialization. All filesystem mutations stay in this standalone fixture.
async function exercise(mode: 'success' | 'max-turns' | 'first-timeout' | 'second-timeout' | 'saved-timeout' | 'empty-summary' | 'write-failure' | 'unchanged-seed' | 'no-additions' | 'short-plan' | 'api-error' | 'plan-read-failure' | 'attempt-deadline') {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-design-free-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const callbacks: Array<{ name: string; fn: () => Promise<void>; timeout: number }> = [];
  const declared: string[] = [], dirs: string[] = [], rows: Array<{ passed: boolean; exit_reason?: string; error?: string; cost_usd?: number }> = [];
  const recordBudgets: number[] = [];
  let launched = false, sdkSignal: AbortSignal | undefined;
  let inputVerified = false, saved = '', resultError: unknown;
  const owned = (p: string) => {
    const full = path.resolve(p);
    expect(full.startsWith(scratch + path.sep)).toBe(true);
    let existing = full;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const resolved = fs.realpathSync(existing);
    expect(resolved === scratch || resolved.startsWith(scratch + path.sep)).toBe(true);
  };
  const localFs = { ...fs,
    mkdtempSync(prefix: string) { owned(prefix); const p = fs.mkdtempSync(prefix); dirs.push(p); return p; },
    mkdirSync(p: string, opts?: any) { owned(p); return fs.mkdirSync(p, opts); },
    writeFileSync(p: string, data: any, opts?: any) { owned(p); return fs.writeFileSync(p, data, opts); },
    readFileSync(p: any, opts?: any) {
      if (mode === 'plan-read-failure' && launched && p === path.join(dirs[0]!, 'plan.md')) throw new Error('controlled plan read failure');
      return fs.readFileSync(p, opts);
    },
    copyFileSync(a: string, b: string) { owned(b); fs.copyFileSync(a, b); },
    cpSync(a: string, b: string, opts: any) { owned(b); fs.cpSync(a, b, opts); },
    rmSync(p: string, opts: any) { owned(p); fs.rmSync(p, opts); },
  };
  const args = {
    ROOT, fs: localFs, path, os: { tmpdir: () => scratch }, expect,
    CAPTURE_MS, CAPTURE_LONG_MS, OFFICE_HOURS_BUN_GRACE_MS, resolveEvalModel, runId: 'free-legacy-design',
    evalCollector: { addTest(entry: any) {
      expect(dirs.every(dir => !fs.existsSync(dir))).toBe(true);
      rows.push(entry);
    } },
    runRecordedOfficeHoursAttempt: (options: Parameters<typeof runRecordedOfficeHoursAttempt>[0]) => {
      expect(options.name).toBe('/plan-design-review plan-mode');
      expect(options.suite).toBe('Plan Design Review E2E');
      expect(options.model).toBe(process.env.EVALS_MODEL ?? resolveEvalModel('capture'));
      recordBudgets.push(options.budgetMs!);
      expect(options.budgetMs).toBe(CAPTURE_LONG_MS - OFFICE_HOURS_BUN_GRACE_MS);
      // Shorten only this synthetic cooperative deadline, never production options.
      return runRecordedOfficeHoursAttempt(mode === 'attempt-deadline' ? { ...options, budgetMs: 100 } : options);
    },
    logCost: () => {}, recordE2E: (_collector: unknown, name: string, _suite: string, _result: unknown, extra: { passed: boolean }) => {
      expect(name).toBe('/plan-design-review plan-mode'); rows.push(extra);
    },
    describeIfSelected: (_title: string, names: string[], fn: () => void) => { if (names.includes(id)) fn(); },
    testConcurrentIfSelected: (name: string, fn: () => Promise<void>, timeout: number) => {
      declared.push(name); if (name === id) callbacks.push({ name, fn, timeout });
    },
    spawnSync: (bin: string, argv: string[], opts: any) => {
      expect(bin).toBe('git'); owned(opts.cwd);
      const result = spawnSync(bin, argv, { ...opts, env });
      expect(result.status, result.stderr?.toString()).toBe(0); return result;
    },
    runSkillTest: async (opts: any) => {
      owned(opts.workingDirectory);
      const plan = path.join(opts.workingDirectory, 'plan.md');
      const initial = fs.readFileSync(plan, 'utf8');
      expect(initial).toContain('hero section at the top with a gradient background');
      expect(initial).toContain('WebSocket for real-time activity updates');
      expect(fs.readFileSync(path.join(opts.workingDirectory, 'plan-design-review/SKILL.md'), 'utf8'))
        .toBe(fs.readFileSync(path.join(ROOT, 'plan-design-review/SKILL.md'), 'utf8'));
      expect(fs.readFileSync(path.join(opts.workingDirectory, 'plan-design-review/sections/review-sections.md'), 'utf8'))
        .toBe(fs.readFileSync(path.join(ROOT, 'plan-design-review/sections/review-sections.md'), 'utf8'));
      expect(rows).toEqual([]);
      expect(opts.publicStreamDiagnostics).toBe(true);
      expect(opts.signal).toBeInstanceOf(AbortSignal); sdkSignal = opts.signal;
      expect(opts.signal.aborted).toBe(false);
      // Bind the complete actual compact-delivery prompt, not selected snippets.
      expect(new Bun.CryptoHasher('sha256').update(opts.prompt).digest('hex'))
        .toBe('2fa957ab9d56850a1629a845d6fe0ee5a1cb7c0843ab6555b621971d270604cb');
      expect(opts.testName).toBe(id); expect(opts.maxTurns).toBe(15); expect(opts.timeout).toBe(CAPTURE_MS);
      for (const key of ['model', 'tools', 'allowedTools', 'appendSystemPrompt', 'env']) expect(opts).not.toHaveProperty(key);
      expect(opts.prompt).toContain('Review the plan in ./plan.md');
      expect(opts.prompt).toContain('Review all 7 design passes');
      expect(opts.prompt).toContain('0-10 and explain what would make it a 10');
      expect(opts.prompt).toContain('preserve the unresolved-decisions pass');
      expect(opts.prompt).toContain('interaction state table, empty states, responsive behavior');
      expect(opts.prompt).toContain('full required review report');
      expect(opts.prompt).toContain('Write before publishing a completed walkthrough');
      expect(opts.prompt).toContain('Read plan.md back to verify the saved changes');
      expect(opts.prompt).toContain('Then return a brief, concrete summary');
      expect(opts.prompt).toContain('execute every required pass and lazy-section Read');
      expect(opts.prompt).toContain('Retain all required report fields, design decisions, diagrams, ratings, and explanations');
      expect(opts.prompt).toContain('use the canonical tables and decision IDs');
      expect(opts.prompt).toContain('Specify each design requirement once');
      expect(opts.prompt).toContain('instead of repeating that specification');
      expect(opts.prompt).toContain('concise score rationales and 10/10 explanations');
      const ordered = ['Read every lazy section', 'Review all 7 design passes',
        'EDIT plan.md', 'Keep the saved review compact',
        'Persist that complete plan and review with Write', 'Read plan.md back',
        'Then return a brief, concrete summary'].map(text => opts.prompt.indexOf(text));
      expect(ordered.every(index => index >= 0)).toBe(true);
      expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
      expect(opts.prompt).toContain('Do NOT try to browse any URLs');
      inputVerified = true; launched = true;
      if (mode === 'attempt-deadline') return await new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      });
      // Captured public attempts at d306: both ended by announcing the still
      // pending write. The terminal result/output were absent; timeout retains
      // its real failure meaning, regardless of that unpersisted walkthrough.
      const timedOut = mode === 'first-timeout' || mode === 'second-timeout' || mode === 'saved-timeout';
      if ((!timedOut || mode === 'saved-timeout') && mode !== 'unchanged-seed') {
        if (mode === 'write-failure') throw new Error('controlled plan write failure');
        const reviewed = mode === 'no-additions' ? initial + '\nReviewed prose remains unspecified.\n'
          : mode === 'short-plan' ? 'Interaction state: empty, loading and error.'
          : initial + '\n## Accepted design changes\nInformation architecture: headline then activity.\n' +
          'Interaction state table: loading, empty, error and success. Responsive and accessibility decisions recorded.\n';
        fs.writeFileSync(plan, reviewed); saved = fs.readFileSync(plan, 'utf8');
      }
      return { output: timedOut ? '' : mode === 'empty-summary' ? 'Done.' : 'Saved the information architecture and interaction state decisions in plan.md.',
        exitReason: timedOut ? 'timeout' : mode === 'max-turns' ? 'error_max_turns' : mode === 'api-error' ? 'error_api' : 'success',
        duration: timedOut ? (mode === 'first-timeout' ? 300039 : 300032) : 1,
        toolCalls: [], browseErrors: [], transcript: [], model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
        costEstimate: { inputChars: opts.prompt.length, outputChars: 80, estimatedTokens: 20, estimatedCost: 0.12, turnsUsed: 1 },
      };
    },
  };
  const start = source.indexOf("describeIfSelected('Plan Design Review E2E'");
  const end = source.indexOf("describeIfSelected('Design Review E2E'", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const suite = source.slice(start, end);
  try {
    new Function(...Object.keys(args), new Bun.Transpiler({ loader: 'ts' }).transformSync(suite))(...Object.values(args));
    expect(declared).toEqual([id, 'plan-design-review-no-ui-scope']);
    expect(callbacks).toHaveLength(1); expect(callbacks[0]!.timeout).toBe(CAPTURE_LONG_MS);
    try { await callbacks[0]!.fn(); } catch (error) { resultError = error; }
    expect(inputVerified).toBe(true); expect(dirs).toHaveLength(1);
    expect(dirs.every(dir => !fs.existsSync(dir))).toBe(true);
    expect(recordBudgets).toEqual([CAPTURE_LONG_MS - OFFICE_HOURS_BUN_GRACE_MS]);
    expect(sdkSignal?.aborted).toBe(true);
    return { resultError, rows, saved };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

test.each(['success', 'max-turns'] as const)('legacy Design registration preserves the complete prompt and existing %s outcome', async mode => {
  const result = await exercise(mode);
  expect(result.resultError).toBeUndefined(); expect(result.rows.map(row => row.passed)).toEqual([true]);
  expect(result.saved).toContain('Interaction state table');
});

test.each(['first-timeout', 'second-timeout'] as const)('legacy Design keeps captured %s failure without plan-write credit', async mode => {
  const result = await exercise(mode);
  expect(result.resultError).toBeDefined(); expect(result.rows.map(row => row.passed)).toEqual([false]);
  expect(result.saved).toBe('');
});

test('legacy Design still requires substantive output after a saved plan', async () => {
  const result = await exercise('empty-summary');
  expect(result.resultError).toBeDefined(); expect(result.rows.map(row => row.passed)).toEqual([false]);
});

test('legacy Design cleans the fixture when its write fails', async () => {
  const result = await exercise('write-failure');
  expect(String(result.resultError)).toContain('controlled plan write failure'); expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: 'harness_error', cost_usd: 0 });
  expect(result.rows[0]!.error).toContain('controlled plan write failure');
});


test.each(['unchanged-seed', 'no-additions', 'short-plan'] as const)('legacy Design records a failed edit assertion exactly once: %s', async mode => {
  const result = await exercise(mode);
  expect(result.resultError).toBeDefined(); expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: 'success', cost_usd: 0.12 });
});

test('legacy Design preserves returned API failure even after a valid saved plan', async () => {
  const result = await exercise('api-error');
  expect(result.resultError).toBeDefined(); expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: 'error_api', cost_usd: 0.12 });
});

test('legacy Design records a validation read exception exactly once after cleanup', async () => {
  const result = await exercise('plan-read-failure');
  expect(String(result.resultError)).toContain('controlled plan read failure');
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: 'success', cost_usd: 0.12 });
  expect(result.rows[0]!.error).toContain('controlled plan read failure');
});

test('legacy Design aggregate deadline cancels its owned runner and records one failed attempt inside the unchanged outer cap', async () => {
  const result = await exercise('attempt-deadline');
  expect(String(result.resultError)).toContain('attempt exceeded 100ms');
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: 'timeout', cost_usd: 0 });
  expect(result.rows[0]!.error).toContain('cost and usage unavailable');
});

test('legacy Design rejects timeout after the complete saved plan, without granting terminal success', async () => {
  const result = await exercise('saved-timeout');
  expect(result.saved).toContain('Interaction state table');
  expect(result.resultError).toBeDefined();
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
});
