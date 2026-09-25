import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT = path.resolve(import.meta.dir, '..');
const marker = 'SYNTHETIC_RENDER_VALUE_DO_NOT_DISPLAY';
let rendered: string;

beforeAll(() => {
  rendered = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-deploy-render-'));
  const result = spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', rendered], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  expect(result.status, result.stderr).toBe(0);
});

afterAll(() => { fs.rmSync(rendered, { recursive: true, force: true }); });

describe('Render API key presence check', () => {
  for (const file of ['setup-deploy/SKILL.md.tmpl', 'setup-deploy/SKILL.md', '.agents/skills/gstack-setup-deploy/SKILL.md']) {
    for (const [state, value] of [['unset', undefined], ['empty', ''], ['present', marker]] as const) {
      test(`${file}: ${state} reports only presence`, () => {
        const source = fs.readFileSync(path.join(file.startsWith('.agents/') ? rendered : ROOT, file), 'utf8');
        const section = source.slice(source.indexOf('#### Render\n'), source.indexOf('#### Vercel\n'));
        expect(section).toContain('Render API key');
        const command = section.match(/```bash\n([\s\S]*?)\n```/)?.[1]
          ?? section.match(/Check for Render API key: `([^`]+)`/)?.[1];
        expect(command).toBeTruthy();
        const env = { ...process.env };
        delete env.RENDER_API_KEY;
        if (value !== undefined) env.RENDER_API_KEY = value;
        const result = spawnSync('bash', ['-eu', '-c', command!], { env, encoding: 'utf8', timeout: 5_000 });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe(`RENDER_API_KEY: ${value ? 'set' : 'not set'}\n`);
        expect(result.stdout + result.stderr).not.toContain(marker.slice(0, 4));
      });
    }
  }
});

describe('Render behavioral fixture free controls', () => {
  test.each(['native', 'fabricated', 'leaking'])('%s tool evidence exercises the behavioral assertions', (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-fixture-control-'));
    const script = path.join(dir, 'capture.test.ts');
    fs.writeFileSync(script, `
import { mock, describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPTURE_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/eval-budgets.ts'))};
import { DEFAULT_SHARD_TIMEOUT_MS } from ${JSON.stringify(path.join(ROOT, 'scripts/test-paid-shards.ts'))};
expect(3 * (CAPTURE_MS - 30_000) * 2 + 60_000).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-helpers.ts'))}, () => ({
  ROOT: ${JSON.stringify(ROOT)}, runId: 'free-render-control',
  describeIfSelected: (name, ids, fn) => describe(name, fn),
  testConcurrentIfSelected: (name, fn, timeout) => {
    expect(timeout).toBe(CAPTURE_MS - 30_000);
    test(name, fn, timeout);
  }, createEvalCollector: () => null,
  finalizeEvalCollector: async () => {}, recordE2E: () => {},
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    expect(opts.tools).toEqual(['Bash', 'Read']);
    expect(opts.timeout).toBe(CAPTURE_MS - 60_000);
    expect(opts.prompt).not.toContain(${JSON.stringify(marker)});
    const source = fs.readFileSync(path.join(opts.workingDirectory, 'RENDER.md'), 'utf8');
    const canonical = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'setup-deploy/SKILL.md'))}, 'utf8');
    expect(source).toBe(canonical.slice(canonical.indexOf('#### Render\\n'), canonical.indexOf('#### Vercel\\n')));
    const command = source.match(/\x60\x60\x60bash\\n([\\s\\S]*?)\\n\x60\x60\x60/)[1];
    const env = { ...process.env, ...opts.env };
    delete env.RENDER_API_KEY;
    if ('RENDER_API_KEY' in opts.env) env.RENDER_API_KEY = opts.env.RENDER_API_KEY;
    const result = spawnSync('bash', ['-eu', '-c', command], { env, encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(0);
    const expected = opts.testName.endsWith('-present') ? 'set' : 'not set';
    expect(result.stdout).toBe('RENDER_API_KEY: ' + expected + '\\n');
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'observed.jsonl'))}, JSON.stringify({ name: opts.testName, state: expected }) + '\\n');
    return {
      exitReason: 'success', output: ${JSON.stringify(mode)} === 'leaking' ? 'SYNT' : result.stdout,
      transcript: [], toolCalls: ${JSON.stringify(mode)} === 'fabricated' ? [] : [{ tool: 'Bash', input: { command }, output: result.stdout }],
    };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-setup-deploy-render.test.ts'))});
`);
    try {
      const result = spawnSync(process.execPath, ['test', script], {
        cwd: ROOT, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_HERMETIC: '1', TMPDIR: dir, TMP: dir, TEMP: dir },
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(mode === 'native' ? 0 : 1);
      const observed = fs.readFileSync(path.join(dir, 'observed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(observed.map(row => row.state)).toEqual(['not set', 'not set', 'set']);
      expect(fs.readdirSync(dir).sort()).toEqual(['capture.test.ts', 'observed.jsonl']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
