import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { installFakeImpeccable, DETECT_SAMPLE } from './helpers/fake-impeccable';
import { sliceBetween } from './helpers/skill-fixture';
import { recordE2E } from './helpers/e2e-helpers';
import { resolveEvalModel } from '../lib/eval-model';
import captured from './fixtures/design-detector-source-public.json';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, 'test/skill-e2e-design.test.ts'), 'utf8');
const id = 'design-review-detector-shim';

type Mode = 'captured' | 'literal' | 'other-variable' | 'wrong-base' | 'no-scan' | 'wrong-files'
  | 'extra-file' | 'no-probe' | 'no-report' | 'no-finding' | 'no-rule' | 'npx' | 'browser'
  | 'timeout' | 'browse-error' | 'runner-throw' | 'report-read-throw'
  | 'quoted-path' | 'relative-path' | 'symlink-path' | 'claimed-probe' | 'wrong-probe-host' | 'wrong-probe-cwd';

async function exercise(modes: Mode[], retention?: 'directory' | 'run-id' | 'both' | 'write-error') {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-free-')));
  const home = path.join(scratch, 'home');
  const bin = path.join(scratch, 'bin');
  const artifactRoot = path.join(scratch, 'eval-artifacts');
  if (retention === 'write-error') fs.writeFileSync(artifactRoot, 'blocked');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home,
    GSTACK_HOME: path.join(home, '.gstack'), TMPDIR: scratch,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    EVALS_RUN_ID: retention === 'run-id' || retention === 'both' ? 'same-run/../probe' : '',
    GSTACK_EVAL_DIR: retention && retention !== 'run-id' ? artifactRoot : '' };
  const callbacks: Array<{ name: string; fn: () => Promise<void>; timeout: number }> = [];
  const before: Array<() => void> = [], after: Array<() => void> = [];
  const rows: any[] = [], errors: unknown[] = [], outputs: string[] = [];
  const retained: Array<{ file: string; text: string; calls: any[] }> = [], notices: string[] = [];
  let attempt = 0, repo = '';
  const controlledError = new Error('controlled detector fixture failure');
  const owned = (p: string) => {
    expect(path.resolve(p).startsWith(scratch + path.sep)).toBe(true);
    let existing = p;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const real = fs.realpathSync(existing);
    expect(real === scratch || real.startsWith(scratch + path.sep)).toBe(true);
  };
  const localFs = { ...fs,
    mkdtempSync(prefix: string) { owned(prefix); return fs.mkdtempSync(prefix); },
    mkdirSync(p: string, opts: any) { owned(p); return fs.mkdirSync(p, opts); },
    chmodSync(p: string, mode: number) { owned(p); fs.chmodSync(p, mode); },
    writeFileSync(p: string, data: any, opts?: any) { owned(p); fs.writeFileSync(p, data, opts); },
    rmSync(p: string, opts: any) { owned(p); fs.rmSync(p, opts); },
    readFileSync(p: any, opts?: any) {
      if (p === path.join(repo, 'detector-output.md')) expect(rows).toHaveLength(attempt);
      if (modes[attempt] === 'report-read-throw' && p === path.join(repo, 'detector-output.md')) throw controlledError;
      return fs.readFileSync(p, opts);
    },
  };
  const args = {
    ROOT, fs: localFs, os: { tmpdir: () => scratch }, path, expect, CAPTURE_MS, CAPTURE_LONG_MS,
    process: { ...process, env: { ...process.env, ...env } }, resolveEvalModel,
    getProjectEvalDir: () => artifactRoot,
    console: { ...console, log: (...args: any[]) => notices.push(args.join(' ')), error: (...args: any[]) => notices.push(args.join(' ')) },
    DETECT_SAMPLE, sliceBetween, runId: 'free-detector-replay', logCost: () => {}, recordE2E,
    evalCollector: { addTest(row: any) {
      expect(fs.readdirSync(scratch).some(name => name.startsWith('detector-source-evidence-'))).toBe(false);
      rows.push(row);
    } },
    installFakeImpeccable(prefix: string) {
      const result = installFakeImpeccable(path.join(path.relative(os.tmpdir(), scratch), prefix));
      owned(result.dir); return result;
    },
    beforeAll: (fn: () => void) => before.push(fn), afterAll: (fn: () => void) => after.push(fn),
    describeIfSelected: (_title: string, names: string[], fn: () => void) => { if (names.includes(id)) fn(); },
    testConcurrentIfSelected: (name: string, fn: () => Promise<void>, timeout: number) => callbacks.push({ name, fn, timeout }),
    spawnSync: (cmd: string, argv: string[], opts: any) => {
      owned(opts.cwd);
      const result = spawnSync(cmd, argv, { ...opts, env });
      expect(result.status, result.stderr?.toString()).toBe(0); return result;
    },
    runSkillTest: async (opts: any) => {
      const mode = modes[attempt];
      repo = opts.workingDirectory; owned(repo);
      expect(opts.testName).toBe(id); expect(opts.maxTurns).toBe(15); expect(opts.timeout).toBe(CAPTURE_MS);
      expect(opts.runId).toBe('free-detector-replay'); expect(opts).not.toHaveProperty('model');
      expect(opts.prompt.replaceAll(repo, '<repo>')).toBe(`You are in a git repo on branch feature/landing with changes against main (the base branch).
Read design-review-detector.md: it is the Setup "Design detector" block and "Phase 0: mechanical scan" from /design-review.
This is a diff-aware run with no URL, so it is SOURCE mode. Run the probe, then the Phase 0 source-mode scan with base main, exactly as written (use --host claude).
Do not run any browser step, do not fix anything, do not run npx.
Then write <repo>/detector-output.md: one FINDING-NNN row per rule in the DETECT_TOP block, each tagged with its [rule-id] and the printed impact, plus the first line the probe printed.`);
      expect(rows).toHaveLength(attempt);
      if (mode === 'runner-throw') throw controlledError;
      const toolCalls: any[] = [];
      const run = (command: string) => {
        const result = spawnSync('bash', ['-c', command], { cwd: repo, env: { ...env, ...opts.env }, encoding: 'utf8', timeout: 15_000 });
        expect(result.status, result.stderr).toBe(0);
        const output = result.stdout + result.stderr;
        toolCalls.push({ tool: 'Bash', input: { command }, output });
        outputs.push(output);
      };
      let wrapper = `${ROOT}/bin/gstack-design-detect.ts`;
      if (mode === 'relative-path') wrapper = path.relative(repo, wrapper);
      if (mode === 'symlink-path') {
        const alias = path.join(bin, 'detector-alias.ts');
        owned(alias); fs.symlinkSync(wrapper, alias); wrapper = alias;
      }
      if (mode === 'quoted-path') wrapper = `'${wrapper}'`;
      const probe = `${mode === 'wrong-probe-cwd' ? 'cd ..; ' : ''}bun --no-env-file run ${wrapper}${mode === 'quoted-path' ? '   ' : ' '}probe --host ${mode === 'wrong-probe-host' ? 'codex' : 'claude'}`;
      if (mode === 'claimed-probe') toolCalls.push({ tool: 'Bash', input: { command: probe }, output: 'IMPECCABLE_READY' });
      else if (mode !== 'no-probe') run(probe);
      let command = captured.scan.replaceAll('/workspace/gstack', ROOT);
      command = command.replace(`${ROOT}/bin/gstack-design-detect.ts`, wrapper);
      if (mode !== 'captured' && mode !== 'other-variable') command = command.replace('"$_BASE"', 'main');
      if (mode === 'other-variable') command = command.replaceAll('_BASE', 'REVIEW_REF');
      if (mode === 'wrong-base') {
        run('git branch other main');
        command = command.replace('scan --changed main', 'scan --changed other');
      }
      if (mode === 'wrong-files') command = command.replace('scan --changed main', 'scan index.html');
      if (mode === 'extra-file') {
        owned(path.join(repo, 'extra.css')); fs.writeFileSync(path.join(repo, 'extra.css'), 'body {}');
      }
      if (mode !== 'no-scan') run(command);
      else toolCalls.push({ tool: 'Bash', input: { command }, output: 'DETECT_TOP total=6 rules=4\nDETECT_SUMMARY: total=6\nDETECT_EXIT: 2' });
      if (mode === 'npx') toolCalls.push({ tool: 'Bash', input: { command: 'npx impeccable detect .' }, output: '' });
      if (mode === 'browser') toolCalls.push({ tool: 'Bash', input: { command: '$B goto http://localhost' }, output: '' });
      if (mode !== 'no-report') {
        let report = captured.report;
        if (mode === 'no-finding') report = report.replaceAll('FINDING-001', 'ROW-001');
        if (mode === 'no-rule') report = report.replaceAll('[ai-color-palette]', '[other-rule]');
        owned(path.join(repo, 'detector-output.md')); fs.writeFileSync(path.join(repo, 'detector-output.md'), report);
      }
      return { exitReason: mode === 'timeout' ? 'timeout' : 'success', output: 'Captured public report saved.',
        toolCalls, transcript: [{ type: 'public-replay' }], browseErrors: mode === 'browse-error' ? ['browser failed'] : [],
        duration: 42513, model: 'claude-fable-5-1', costEstimate: { estimatedCost: 0.2, turnsUsed: 5, estimatedTokens: 93719 } };
    },
  };
  const start = source.indexOf('function detectorSkillText(');
  const end = source.indexOf("describeIfSelected('Design HTML slop gate E2E'", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  try {
    new Function(...Object.keys(args), new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end)))(...Object.values(args));
    expect(callbacks.map(c => c.name)).toEqual([id, 'design-review-detector-shim-dom']);
    expect(callbacks[0]!.timeout).toBe(CAPTURE_MS);
    for (const fn of before) fn();
    for (; attempt < modes.length; attempt++) {
      let failure: unknown;
      try { await callbacks[0]!.fn(); } catch (error) { failure = error; }
      errors.push(failure);
    }
    for (const fn of after.splice(0)) fn();
    expect(fs.existsSync(repo)).toBe(false);
    expect(fs.readdirSync(scratch).some(name => name.startsWith('detector-source-evidence-'))).toBe(false);
    if (retention && retention !== 'write-error') {
      const walk = (dir: string) => {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          else {
            expect(entry.name).toBe('calls.jsonl');
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            const text = fs.readFileSync(file, 'utf8');
            retained.push({ file, text, calls: text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] });
          }
        }
      };
      walk(artifactRoot);
    } else if (!retention) expect(fs.existsSync(artifactRoot)).toBe(false);
    return { rows, errors, outputs, controlledError, retained, notices };
  } finally {
    for (const fn of after) fn();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test.each(['captured', 'literal', 'other-variable'] as const)('source detector callback accepts executed main scope: %s', async mode => {
  const result = await exercise([mode]);
  expect(result.outputs.join('\n')).toContain('DETECT_TOP total=6 rules=4');
  expect(result.outputs.join('\n')).toContain('DETECT_EXIT: 2');
  expect(result.errors).toEqual([undefined]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: true, exit_reason: 'success', cost_usd: 0.2,
    duration_ms: 42513, turns_used: 5, tokens_used: 93719, model: 'claude-fable-5-1', transcript: [{ type: 'public-replay' }] });
});

test.each(['wrong-base', 'no-scan', 'wrong-files', 'extra-file', 'no-probe', 'no-report', 'no-finding', 'no-rule', 'npx', 'browser', 'timeout', 'browse-error'] as const)(
  'source detector callback rejects and records invalid evidence once: %s', async mode => {
    const result = await exercise([mode]);
    expect(result.errors[0]).toBeDefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: mode === 'timeout' ? 'timeout' : 'success', cost_usd: 0.2 });
    expect(result.rows[0].error).toBe((result.errors[0] as Error).message);
  },
);

test.each(['runner-throw', 'report-read-throw'] as const)('source detector callback records and rethrows original exception: %s', async mode => {
  const result = await exercise([mode]);
  expect(result.errors[0]).toBe(result.controlledError);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ passed: false, exit_reason: mode === 'runner-throw' ? 'harness_error' : 'success' });
  expect(result.rows[0].error).toContain(result.controlledError.message);
});

test('source detector retry cannot reuse prior scan evidence or report', async () => {
  const result = await exercise(['literal', 'no-scan', 'no-report', 'captured']);
  expect(result.errors.map(Boolean)).toEqual([false, true, true, false]);
  expect(result.rows.map(row => row.passed)).toEqual([true, false, false, true]);
});

test.each(['quoted-path', 'relative-path', 'symlink-path'] as const)('source detector callback identifies executed canonical wrapper: %s', async mode => {
  const result = await exercise([mode]);
  expect(result.errors).toEqual([undefined]);
  expect(result.rows.map(row => row.passed)).toEqual([true]);
});

test.each(['claimed-probe', 'wrong-probe-host', 'wrong-probe-cwd'] as const)('source detector callback requires an executed valid probe: %s', async mode => {
  const result = await exercise([mode]);
  expect(result.errors[0]).toBeDefined();
  expect(result.rows.map(row => row.passed)).toEqual([false]);
});

test.each(['directory', 'run-id', 'both'] as const)('source detector receipts survive fixture cleanup privately with %s retention', async retention => {
  const result = await exercise(['wrong-base', 'claimed-probe', 'captured'], retention);
  expect(result.errors.map(Boolean)).toEqual([true, true, false]);
  expect(result.rows.map(row => row.passed)).toEqual([false, false, true]);
  expect(result.retained).toHaveLength(3);
  expect(new Set(result.retained.map(entry => path.dirname(entry.file))).size).toBe(3);
  const calls = result.retained.map(entry => entry.calls);
  expect(calls.filter(attempt => attempt.some(call => call.argv.includes('other')))).toHaveLength(1);
  expect(calls.filter(attempt => !attempt.some(call => call.argv[0] === 'probe'))).toHaveLength(1);
  expect(calls.filter(attempt => attempt.some(call => call.argv[0] === 'probe') && attempt.some(call => call.argv.includes('main')))).toHaveLength(1);
  for (const attempt of calls) {
    const scan = attempt.find(call => call.argv[0] === 'scan');
    expect(scan.exit).toBe(2);
    expect(scan.engine[0].argv.slice(0, 2)).toEqual(['detect', '--json']);
    expect(scan.engine[0].argv.slice(2).map((p: string) => path.basename(p))).toEqual(['index.html', 'styles.css']);
  }
  expect(result.notices.filter(note => note.includes('Detector artifacts:'))).toHaveLength(3);
});

test.each(['directory', 'write-error'] as const)('source detector preserves its original exception with %s retention', async retention => {
  const result = await exercise(['report-read-throw'], retention);
  expect(result.errors[0]).toBe(result.controlledError);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].passed).toBe(false);
  expect(result.rows[0].error).toContain(result.controlledError.message);
  if (retention === 'directory') expect(result.retained).toHaveLength(1);
  else expect(result.notices.some(note => note.includes('Detector artifact write failed:'))).toBe(true);
});
