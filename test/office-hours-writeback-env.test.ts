/** Free end-to-end fixture wiring: real session runner, owned fake provider/gbrain only. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SUITE = path.join(ROOT, 'test/skill-e2e-office-hours-brain-writeback.test.ts');

async function probeWritebackEnvironment(option: 'env' | 'extraEnv') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hours-env-'));
  const driverBin = path.join(dir, 'bin');
  const operatorHome = path.join(dir, 'operator-home');
  const receipt = path.join(dir, 'child-receipt.json');
  const sentinel = path.join(dir, 'operator-gbrain-called');
  for (const p of [driverBin, operatorHome]) fs.mkdirSync(p, { recursive: true });
  const driver = path.join(dir, 'provider.ts');
  fs.writeFileSync(driver, `
import * as fs from 'node:fs';
import * as path from 'node:path';
const cwd = process.cwd();
const home = path.join(cwd, '.fixture-home');
const state = path.join(home, '.gstack');
const resolved = Bun.which('gbrain');
const facts = {
  fakeFirstOnPath: process.env.PATH?.split(path.delimiter)[0] === path.join(cwd, 'bin'),
  fakeResolves: resolved === path.join(cwd, 'bin/gbrain'),
  homeOwned: process.env.HOME === home,
  gbrainHomeOwned: process.env.GBRAIN_HOME === home,
  stateOwned: process.env.GSTACK_HOME === state,
  stateSeeded: fs.existsSync(path.join(state, '.activated')) && fs.readFileSync(path.join(state, 'config.yaml'), 'utf8').includes('artifacts_sync_mode_prompted: true'),
};
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(facts));
// Never execute a fallback gbrain. Even the intentionally broken option case
// only observes our sentinel resolution and exits before invoking anything.
if (!Object.values(facts).every(Boolean)) process.exit(42);
const prompt = await Bun.stdin.text();
if (!prompt.includes('SAVE_RESULTS template literally') || !prompt.includes('pixel-fund')) process.exit(43);
fs.writeFileSync(path.join(state, 'child-state-write'), 'owned');
fs.mkdirSync(path.join(home, '.gbrain'), { recursive: true });
fs.writeFileSync(path.join(home, '.gbrain', 'child-state-write'), 'owned');
const version = Bun.spawn(['gbrain', '--version'], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
const [versionOut, versionErr, versionCode] = await Promise.all([new Response(version.stdout).text(), new Response(version.stderr).text(), version.exited]);
if (versionCode || versionErr || versionOut.trim() !== 'gbrain test-0.41.0') process.exit(44);
const payload = '---\\ntitle: Pixel fund\\ntags: [fixture]\\n---\\n' + 'Design detail. '.repeat(25);
const put = Bun.spawn(['gbrain', 'put', 'office-hours/pixel-fund', '--content', payload], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
const [putOut, putErr, putCode] = await Promise.all([new Response(put.stdout).text(), new Response(put.stderr).text(), put.exited]);
if (putCode || putOut || putErr) process.exit(45);
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ ...facts, fakeVersionMatches: true, fakePutSucceeded: true,
  stateWriteOwned: fs.readFileSync(path.join(state, 'child-state-write'), 'utf8') === 'owned',
  gbrainStateWriteOwned: fs.readFileSync(path.join(home, '.gbrain', 'child-state-write'), 'utf8') === 'owned',
}));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, result: 'free writeback fixture' }));
`);
  // POSIX executable shims (#!/bin/bash); no provider or operator gbrain can run.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(driverBin, 'claude'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(driver)}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(driverBin, 'gbrain'), `#!/bin/bash\nprintf forbidden > ${quote(sentinel)}\nexit 91\n`, { mode: 0o755 });
  const suiteSource = fs.readFileSync(SUITE, 'utf8');
  // Each case imports the actual suite, including its original prompt and
  // payload assertions. The negative case restores only the original typo.
  expect(suiteSource).toContain('env: childEnv,');
  let selectedSource = option === 'env' ? suiteSource : suiteSource.replace('env: childEnv,', 'extraEnv: childEnv,');
  selectedSource = selectedSource.replace(/from '(\.\/helpers\/[^']+)'/g,
    (_match, spec: string) => `from ${JSON.stringify(path.resolve(ROOT, 'test', spec))}`);
  const suiteCopy = path.join(dir, 'writeback-suite.ts');
  fs.writeFileSync(suiteCopy, selectedSource);
  const entry = path.join(dir, 'writeback-env.test.ts');
  fs.writeFileSync(entry, `
import { mock, describe, test } from 'bun:test';
const root = ${JSON.stringify(ROOT)};
mock.module(root + '/test/helpers/e2e-helpers.ts', () => ({
  ROOT: root, runId: undefined, evalsEnabled: false,
  describeIfSelected: (name, _ids, body) => describe(name, body),
  testConcurrentIfSelected: (name, body, timeout) => test(name, body, timeout),
  logCost: () => {}, recordE2E: () => {}, finalizeEvalCollector: async () => {},
}));
// Do not mock session-runner: its actual env option and subprocess behavior
// are precisely the regression boundary. Only E2E selection/recording is local.
await import(${JSON.stringify(suiteCopy)});
`);
  try {
    const proc = Bun.spawn([process.execPath, 'test', entry], {
      cwd: ROOT,
      env: {
        ...process.env, EVALS: '', EVALS_HERMETIC: '1',
        HOME: operatorHome, GBRAIN_HOME: operatorHome, GSTACK_HOME: path.join(operatorHome, '.gstack'),
        PATH: [driverBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.join(operatorHome, '.gbrain'))).toBe(false);
    expect(fs.existsSync(path.join(operatorHome, '.gstack'))).toBe(false);
    return { code, output: stdout + stderr, facts: JSON.parse(fs.readFileSync(receipt, 'utf8')) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('office-hours writeback child environment', () => {
  test('owned fake PATH and seeded state reach the real runner child; original writeback assertions pass', async () => {
    const { code, output, facts } = await probeWritebackEnvironment('env');
    expect(code, output).toBe(0);
    expect(output).toContain('1 pass');
    expect(Object.values(facts).every(Boolean)).toBe(true);
    expect(facts.fakePutSucceeded).toBe(true);
  }, 30_000);

  test('restoring extraEnv fails before any fallback gbrain executes', async () => {
    const { code, output, facts } = await probeWritebackEnvironment('extraEnv');
    expect(code).toBe(1);
    expect(output).toContain('exit_code_42');
    expect(facts.fakeResolves).toBe(false);
    expect(facts.fakeFirstOnPath).toBe(false);
    expect(facts.homeOwned).toBe(false);
    expect(facts.gbrainHomeOwned).toBe(false);
    expect(facts.stateOwned).toBe(false);
  }, 30_000);
});
