import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// Execute the actual paid registration and fixture; replace only the provider.
function exercise(options: { missingRead?: string; exitReason?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-carve-fixture-'));
  const script = path.join(dir, 'capture.test.ts');
  const facts = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CARVE_GUARDS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/carve-guards.ts'))};
import { resolveEvalModel } from ${JSON.stringify(path.join(ROOT, 'lib/eval-model.ts'))};
const input = ${JSON.stringify(options)};
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ called: true }));
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: opts.workingDirectory, encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    expect(git('rev-parse', '--verify', 'main')).not.toBe(git('rev-parse', 'HEAD'));
    expect(git('branch', '--show-current')).toBe('invoice-access-refactor');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('diff', '--name-only', 'main...HEAD')).toBe('src/invoice-access.ts');
    expect(git('ls-tree', '-r', '--name-only', 'main')).toContain('codex/sections/consult-mode.md');
    expect(git('diff', 'main...HEAD', '--', 'codex')).toBe('');
    const baselinePath = ${JSON.stringify(path.join(dir, 'baseline.ts'))};
    fs.writeFileSync(baselinePath, git('show', 'main:src/invoice-access.ts'));
    const baseline = await import(baselinePath);
    const current = await import(path.join(opts.workingDirectory, 'src/invoice-access.ts'));
    const invoice = { ownerId: 'owner' };
    expect(baseline.canReadInvoice('owner', invoice)).toBe(true);
    expect(current.canReadInvoice('owner', invoice)).toBe(true);
    expect(baseline.canReadInvoice('another-account', invoice)).toBe(false);
    expect(current.canReadInvoice('another-account', invoice)).toBe(true);
    expect(current.canReadInvoice('', invoice)).toBe(false);
    expect(opts.prompt).toContain(CARVE_GUARDS.codex.scenario);
    expect(opts.prompt).toContain('with the Read tool BEFORE');
    expect(opts).toMatchObject({ maxTurns: 25, timeout: 480000, model: resolveEvalModel('capture') });
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent']);
    const output = '# Review report\\n' + 'Reviewed the invoice ownership regression and completed the consult follow-up. '.repeat(4);
    fs.writeFileSync(path.join(opts.workingDirectory, 'REPORT.md'), output);
    return { exitReason: input.exitReason ?? 'success', output, transcript: [],
      toolCalls: CARVE_GUARDS.codex.requiredReads.filter(section => section !== input.missingRead).map(section => ({
        tool: 'Read', input: { file_path: path.join(opts.workingDirectory, 'codex/sections', section) },
      })),
    };
  },
}));
const { registerCarveSectionCase } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/carve-section-case.ts'))});
registerCarveSectionCase('codex');
`);
  try {
    const result = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeout: 10_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(fs.existsSync(facts), output).toBe(true);
    expect(JSON.parse(fs.readFileSync(facts, 'utf8'))).toEqual({ called: true });
    expect(result.signalCode ?? null).toBeNull();
    return { code: result.exitCode, output };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Codex carve reviews a real source-only feature diff against its baseline', () => {
  const result = exercise();
  expect(result.code, result.output).toBe(0);
}, 20_000);

test.each(['review-mode.md', 'consult-mode.md'])('Codex carve still requires a native Read of %s', section => {
  const result = exercise({ missingRead: section });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('"missing"');
}, 20_000);

test('Codex carve rejects a timed-out run even when its report is complete', () => {
  const result = exercise({ exitReason: 'timeout' });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('"reportProduced": false');
}, 20_000);
