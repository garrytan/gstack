/**
 * Lane D (GSTA-112, E6): a pregate failure the environment caused (a runner
 * binary missing from PATH, a network error before any test ran, a quota
 * refusal from the remote gate, a guard that cannot start) is classified and
 * reported apart from a failure the diff caused, under its own result code
 * `PREGATE_ENVIRONMENT` with a kind and the evidence, so a lane can waive by
 * cause instead of by test name (truther #617). A failing test whose log also
 * mentions a network error is still a diff failure: the runner's own summary
 * decides, never the log alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { planRuns } from '../lib/pregate/checks/lanes';
import { DEFAULT_CONFIG } from '../lib/pregate/config';
import { classifyCommandEnvironment, classifyEnvironment, commandBinary } from '../lib/pregate/environment';
import { verifyPregate } from '../lib/pregate/index';
import type { PregateContext } from '../lib/pregate/types';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (pregate: Record<string, unknown>, baseFiles?: Record<string, string>) => { const r = makeFixtureRepo({ pregate, baseFiles }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes,guards', ...args]);
const readOut = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
const check = (repo: FixtureRepo, id: string) => readOut(repo).checks.find((c: any) => c.id === id);
const UTIL_EDIT = { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' };

describe('classifyEnvironment', () => {
  // Value: protects=the classifier's vocabulary and its silence on ordinary failures; fails_when=a plain assertion failure or a
  //   non-zero exit with a test summary reads as environment, or exit 127 / ENOTFOUND / quota text does not; why_new=new module;
  //   seam=none; no_claim=completeness of the vocabulary
  test('names missing-binary, network, quota and disk, and stays null for an ordinary failure', () => {
    expect(classifyEnvironment('bash: line 1: vitest: command not found', 127)?.kind).toBe('missing-binary');
    expect(classifyEnvironment('', 127)).toEqual({ kind: 'missing-binary', evidence: 'exit 127: the shell found no such command', proof: 'launch' });
    expect(classifyEnvironment('write failed: Disk quota exceeded (EDQUOT)', 1)).toEqual({ kind: 'disk', evidence: 'write failed: Disk quota exceeded (EDQUOT)', proof: 'output' });
    expect(classifyEnvironment("'nope' is not recognized as an internal or external command", 1)?.kind).toBe('missing-binary');
    expect(classifyEnvironment('Error: getaddrinfo ENOTFOUND registry.example.invalid', 1)).toEqual({ kind: 'network', evidence: 'getaddrinfo ENOTFOUND registry.example.invalid', proof: 'output' });
    expect(classifyEnvironment('curl: (7) Failed to connect to host port 443: Connection refused', 7)?.kind).toBe('network');
    expect(classifyEnvironment('ubicloud: vcpu quota exceeded (528/512)', 1)?.kind).toBe('quota');
    expect(classifyEnvironment('HTTP 429 Too Many Requests', 1)?.kind).toBe('quota');
    expect(classifyEnvironment('ENOSPC: no space left on device, write', 1)?.kind).toBe('disk');
    expect(classifyEnvironment('AssertionError: expected 3 to be 4', 1)).toBeNull();
    expect(classifyEnvironment('✖ fetches the thing\n  ECONNREFUSED 127.0.0.1:3000\nℹ tests 1\nℹ fail 1', 1)?.kind).toBe('network');
  });

  // Value: protects=exit 127 (or "command not found" text) is the machine's only when the command's own binary is off PATH: a script
  //   the diff controls that exits 127 is the diff's; fails_when=a present runner exiting 127 reads as missing-binary; why_new=the veto
  //   is new (adversarial review); seam=none; no_claim=none
  test('a missing binary is the machine\'s only when the command\'s own binary is off PATH', () => {
    expect(commandBinary("(cd 'pkg' && UBI_OWNER=x node run.js a b)")).toBe('node');
    expect(commandBinary('FOO=1 BAR=2 bun test x')).toBe('bun');
    expect(commandBinary('')).toBeNull();
    const env = { PATH: process.env.PATH };
    expect(classifyCommandEnvironment('node scripts/x.js', '', 127, env)).toBeNull();
    expect(classifyCommandEnvironment('node scripts/x.js', 'bash: vitest: command not found', 127, env)).toBeNull();
    expect(classifyCommandEnvironment('gstack-fixture-runner-that-does-not-exist x', '', 127, env)).toMatchObject({ kind: 'missing-binary', proof: 'launch' });
    expect(classifyCommandEnvironment('node scripts/x.js', 'Error: getaddrinfo ENOTFOUND registry.example.invalid', 1, env)).toMatchObject({ kind: 'network', proof: 'output' });
  });
});

describe('environment failures are reported apart from diff failures', () => {
  // Value: protects=a runner whose binary is missing is PREGATE_ENVIRONMENT missing-binary (incomplete, cause environment) rather
  //   than a lane failure that reads as the diff's fault; fails_when=the lane is PREGATE_LANE_FAILED with no cause (the behaviour
  //   before this change); why_new=the code and cause are new; seam=none; no_claim=none
  test('a runner binary missing from PATH is PREGATE_ENVIRONMENT missing-binary, incomplete, cause environment', () => {
    const repo = fixture({ ...BASE_PREGATE, runner: 'gstack-fixture-runner-that-does-not-exist {files}' });
    commit(repo, UTIL_EDIT);
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_ENVIRONMENT)');
    expect(r.err).not.toContain('PREGATE_LANE_FAILED');
    const c = check(repo, 'lanes');
    expect([c.status, c.code, c.cause, c.environment.kind, c.environment.proof]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'missing-binary', 'launch']);
    expect(c.environment.evidence).toContain('gstack-fixture-runner-that-does-not-exist');
    expect(c.fix).toContain('the diff is not at fault');
    expect(r.out).toContain('environment: missing-binary');
    const verify = runBin(repo, 'gstack-pregate', ['verify']);
    expect(verify.status).toBe(EXIT.fail);
    expect(verify.err).toContain('(PREGATE_ENVIRONMENT)');
    expect(verify.err).toContain('blocked by the environment (missing-binary), not by the diff');
  });

  // Value: protects=a runner that dies on a network error before reporting any test is environment/network, while a test that
  //   failed and whose log also names a connection error stays a diff failure (its summary counted a failure); fails_when=either
  //   direction is misread; why_new=the summary-first rule is new; seam=none; no_claim=none
  test('a network error with no test summary is environment; a counted test failure beside a network line is still the diff', () => {
    const net = fixture({ ...BASE_PREGATE, runner: 'node scripts/net.js {files}' }, { 'scripts/net.js': "console.error('Error: getaddrinfo ENOTFOUND registry.example.invalid');\nprocess.exit(1);\n" });
    commit(net, UTIL_EDIT);
    pregate(net, []);
    const c = check(net, 'lanes');
    expect([c.status, c.code, c.cause, c.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'network']);
    const diff = fixture({ ...BASE_PREGATE, runner: 'node scripts/fail.js {files}' }, { 'scripts/fail.js': "console.log('✖ talks to the server\\n  Error: connect ECONNREFUSED 127.0.0.1:3000\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1');\nprocess.exit(1);\n" });
    commit(diff, UTIL_EDIT);
    const r = pregate(diff, []);
    expect(r.err).toContain('(PREGATE_LANE_FAILED)');
    const d = check(diff, 'lanes');
    expect([d.status, d.code, d.cause]).toEqual(['fail', 'PREGATE_LANE_FAILED', 'diff']);
    expect(d.environment).toBeUndefined();
  });

  // Value: protects=a test in the diff cannot clear itself: a runner whose binary is present but exits 127 is PREGATE_LANE_FAILED
  //   (diff), and a bun test that prints a network line and exits the process before the summary is at most an output-inferred
  //   environment cause whose fix and verify message ask for confirmation elsewhere, never "the diff is not at fault";
  //   fails_when=exit 127 from a present runner reads as missing-binary, or the spoof's fix clears the diff; why_new=the binary veto
  //   and the launch/output proof are new (adversarial review); seam=none; no_claim=a spoof with no summary cannot be told from a
  //   real network failure by the output alone, which is exactly what the proof records
  test('a present runner that exits 127 is the diff\'s; a test that exits with a network line is only an output-inferred cause', () => {
    const exit127 = fixture({ ...BASE_PREGATE, runner: 'node scripts/x.js {files}' }, { 'scripts/x.js': 'process.exit(127);\n' });
    commit(exit127, UTIL_EDIT);
    pregate(exit127, []);
    const c = check(exit127, 'lanes');
    expect([c.status, c.code, c.cause, c.environment]).toEqual(['fail', 'PREGATE_LANE_FAILED', 'diff', undefined]);
    if (!Bun.which('bun')) return;
    const spoof = fixture({ ...BASE_PREGATE, runner: 'bun test {files}' }, { 'test/util.test.js': "const { test } = require('bun:test');\nrequire('../lib/util.js');\ntest('spoof', () => { console.log('Received: fetch failed'); process.exit(1); });\n" });
    commit(spoof, UTIL_EDIT);
    pregate(spoof, []);
    const s = check(spoof, 'lanes');
    expect([s.status, s.code, s.environment.kind, s.environment.proof]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'network', 'output']);
    expect(s.fix).not.toContain('the diff is not at fault');
    expect(s.fix).toContain('confirm on another machine or with --remote');
    expect(s.lines.join('\n')).toContain('environment: network — Received: fetch failed (inferred from output)');
    const verify = runBin(spoof, 'gstack-pregate', ['verify']);
    expect(verify.err).toContain('lanes inferred from output alone');
  });

  // Value: protects=a remote gate is classified from its preamble only: quota text streamed from the tests past the first lines
  //   is not the environment; fails_when=a test name with "quota" waives the gate; why_new=new (adversarial review); seam=none; no_claim=none
  test('a remote gate whose test stream names a quota past the preamble is PREGATE_INCOMPLETE, not environment', () => {
    const repo = fixture({ ...BASE_PREGATE, remote_gate: 'node scripts/gate.js' }, { 'scripts/gate.js': "for (let i = 0; i < 60; i++) console.log('ok test ' + i);\nconsole.log('✗ billing > enforces quota per user');\nprocess.exit(1);\n" });
    commit(repo, UTIL_EDIT);
    pregate(repo, ['--remote', '--spend-cap', '1']);
    const c = check(repo, 'lanes');
    expect([c.status, c.code, c.environment]).toEqual(['incomplete', 'PREGATE_INCOMPLETE', undefined]);
  });

  // Value: protects=a remote gate refused by a quota (no PREGATE_REMOTE line) is environment/quota and the obligation stays
  //   uncleared; fails_when=it is a generic PREGATE_INCOMPLETE; why_new=new; seam=none; no_claim=none
  test('a remote gate that hit a quota is PREGATE_ENVIRONMENT quota and leaves the obligation uncleared', () => {
    const repo = fixture({ ...BASE_PREGATE, remote_gate: 'node scripts/gate.js' }, { 'scripts/gate.js': "console.error('ubicloud: vcpu quota exceeded (528/512)');\nprocess.exit(1);\n" });
    commit(repo, UTIL_EDIT);
    const r = pregate(repo, ['--remote', '--spend-cap', '1']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_ENVIRONMENT)');
    const c = check(repo, 'lanes');
    expect([c.status, c.cause, c.environment.kind]).toEqual(['incomplete', 'environment', 'quota']);
    expect(readOut(repo).requires_remote.find((o: any) => o.lane === 'pregate.json/remote_gate').receipt).toBeNull();
  });

  // Value: protects=guards classify the same way: a guard whose command is missing is environment, a guard that fails on its
  //   own terms is the diff; fails_when=a missing guard binary is PREGATE_GUARD_FAILED; why_new=new; seam=none; no_claim=none
  test('a guard whose binary is missing is environment; a guard that fails is the diff', () => {
    // The red guard's output names a rate limit and a refused connection: a guard that ran and said no is the diff's whatever it printed.
    const repo = fixture({ ...BASE_PREGATE, guards: [{ id: 'absent', when: ['lib/**'], command: 'gstack-fixture-guard-that-does-not-exist --check' }, { id: 'red', when: ['lib/**'], command: 'node -e "console.log(\'FAIL api > retries after a rate limit (ECONNREFUSED fixture)\'); process.exit(2)"', fix: 'fix it' }] });
    commit(repo, UTIL_EDIT);
    const r = pregate(repo, ['--only', 'guards']);
    expect(r.status).toBe(EXIT.fail);
    const g = check(repo, 'guards');
    expect([g.status, g.code, g.cause]).toEqual(['fail', 'PREGATE_GUARD_FAILED', 'diff']);
    expect(g.lines.join('\n')).toContain('environment: missing-binary');
    expect(g.lines.join('\n')).not.toContain('red environment:');
    // A guard whose own binary is present but whose script exits 127 (a package script naming a missing tool) is the diff's.
    const present = fixture({ ...BASE_PREGATE, guards: [{ id: 'script', when: ['lib/**'], command: 'node -e "process.exit(127)"', fix: 'fix it' }] });
    commit(present, UTIL_EDIT);
    pregate(present, ['--only', 'guards']);
    const p = check(present, 'guards');
    expect([p.status, p.code, p.cause, p.environment]).toEqual(['fail', 'PREGATE_GUARD_FAILED', 'diff', undefined]);
    const only = fixture({ ...BASE_PREGATE, guards: [{ id: 'absent', when: ['lib/**'], command: 'gstack-fixture-guard-that-does-not-exist --check' }] });
    commit(only, UTIL_EDIT);
    pregate(only, ['--only', 'guards']);
    const o = check(only, 'guards');
    expect([o.status, o.code, o.cause, o.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'missing-binary']);
  });
});

describe('a detected pytest runner needs pytest importable by python3', () => {
  const PY_TEST = { 'tests/test_alpha.py': 'import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1 + 1, 2)\n' };
  /** A directory holding only a `python3` whose `-c` probe exits `probeExit` (0: pytest importable, 1: not). */
  const python3Shim = (repo: FixtureRepo, probeExit: number): string => {
    const dir = path.join(repo.root, `py-${probeExit}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'python3'), `#!/bin/sh\n[ "$1" = "-c" ] && exit ${probeExit}\necho "unexpected: python3 $*"\nexit 3\n`, { mode: 0o755 });
    return dir;
  };
  const ctxFor = (repo: FixtureRepo, PATH: string) => ({ repoRoot: repo.work, config: DEFAULT_CONFIG, env: { PATH } }) as unknown as PregateContext;

  // Value: protects=a `.py` selection plans `python3 -m pytest` only when python3 can import pytest; otherwise the tool to install is
  //   named (`pytest`, or `python3` when it is off PATH) and the file is unclaimed; fails_when=the pytest branch plans the runner
  //   unchecked again (#3598); why_new=pnpm/cargo/dart had a pre-run check, pytest none; seam=none; no_claim=a real pytest install
  test('plans pytest when python3 imports it, else names pytest or python3 as missing', () => {
    const repo = makeFixtureRepo({ pregate: null, baseFiles: PY_TEST }); repos.push(repo);
    const files = ['tests/test_alpha.py'];
    expect(planRuns(ctxFor(repo, python3Shim(repo, 0)), files)).toEqual({ groups: [{ runner: 'python3 -m pytest {files}', cwd: '', files }], unclaimed: [], missing: [], noPubspec: [] });
    expect(planRuns(ctxFor(repo, python3Shim(repo, 1)), files)).toEqual({ groups: [], unclaimed: files, missing: ['pytest'], noPubspec: [] });
    expect(planRuns(ctxFor(repo, path.join(repo.root, 'empty-path')), files)).toEqual({ groups: [], unclaimed: files, missing: ['python3'], noPubspec: [] });
  });

  // Value: protects=the reported case end to end: a machine without pytest gets PREGATE_ENVIRONMENT missing-binary naming pytest and
  //   "the diff is not at fault", and the lane never runs; fails_when=it is PREGATE_LANE_FAILED with "fix the in-branch failure"
  //   (#3598); why_new=no pytest environment case existed; seam=none; no_claim=a real pytest install
  test('a machine without pytest is PREGATE_ENVIRONMENT naming pytest, never PREGATE_LANE_FAILED', () => {
    const repo = makeFixtureRepo({ pregate: null, baseFiles: PY_TEST }); repos.push(repo);
    commit(repo, { 'tests/test_alpha.py': `${PY_TEST['tests/test_alpha.py']}# touched\n` });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--only', 'lanes'], { PATH: `${python3Shim(repo, 1)}:${process.env.PATH ?? ''}` });
    expect(r.err).toContain('(PREGATE_ENVIRONMENT)');
    expect(r.err).not.toContain('PREGATE_LANE_FAILED');
    expect(r.out).not.toContain('unexpected: python3');
    const c = check(repo, 'lanes');
    expect([c.status, c.code, c.cause, c.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'missing-binary']);
    expect(c.environment.evidence).toContain('pytest');
    expect(c.fix).toContain('install pytest');
    expect(c.fix).toContain('the diff is not at fault');
  });
});

describe('Playwright without its browsers is the machine, not the diff', () => {
  const SPEC = { 'package.json': JSON.stringify({ name: 'fixture', devDependencies: { '@playwright/test': '^1.48.0' } }) + '\n', 'tests/e2e/home.spec.ts': "import { test } from '@playwright/test';\ntest('home', async ({ page }) => { await page.goto('/'); });\ntest('about', async ({ page }) => { await page.goto('/about'); });\n" };
  const NO_BROWSERS = ['Running 2 tests using 1 worker', '  x  1 tests/e2e/home.spec.ts:2:5 > home (12ms)', '  x  2 tests/e2e/home.spec.ts:3:5 > about (8ms)', '', '  1) tests/e2e/home.spec.ts:2:5 > home', "    Error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1169/chrome-linux/headless_shell", '    Looks like Playwright Test or Playwright was just installed or updated.', '    Please run the following command to download new browsers:', '        npx playwright install', '  2 failed', '    tests/e2e/home.spec.ts:2:5 > home', '    tests/e2e/home.spec.ts:3:5 > about'];
  const ASSERTION = ['Running 2 tests using 1 worker', '  1) tests/e2e/home.spec.ts:2:5 > home', '    Error: expect(received).toBe(expected)', '  1 failed', '    tests/e2e/home.spec.ts:2:5 > home', '  1 passed (2.0s)'];
  /** An `npx` first on PATH (and again through BASH_ENV, since the lane puts its Bun's directory first) that prints `lines` and exits 1. */
  const npxShim = (repo: FixtureRepo, lines: string[]) => {
    const dir = path.join(repo.root, 'npx-shim');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'out.txt'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'npx'), `#!/bin/sh\ncat '${path.join(dir, 'out.txt')}'\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'path.sh'), `PATH='${dir}':"$PATH"\n`);
    return { PATH: `${dir}:${process.env.PATH ?? ''}`, BASH_ENV: path.join(dir, 'path.sh') };
  };

  // Value: protects=a Playwright run whose every failure is a missing browser is PREGATE_ENVIRONMENT missing-binary naming
  //   `npx playwright install`, while an ordinary assertion failure stays the diff's; fails_when=the browsers case is PREGATE_LANE_FAILED
  //   "fix the in-branch failure" again (the #3598 misreading for Playwright); why_new=Playwright had no runner before #3629;
  //   seam=none; no_claim=a real Playwright install
  test('every test failing to launch its browser is PREGATE_ENVIRONMENT; an assertion failure is PREGATE_LANE_FAILED', () => {
    const repo = makeFixtureRepo({ pregate: null, baseFiles: SPEC }); repos.push(repo);
    commit(repo, { 'tests/e2e/home.spec.ts': `${SPEC['tests/e2e/home.spec.ts']}// touched\n` });
    const args = ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--only', 'lanes'];
    const r = runBin(repo, 'gstack-pregate', args, npxShim(repo, NO_BROWSERS));
    expect(r.err).toContain('(PREGATE_ENVIRONMENT)');
    const c = check(repo, 'lanes');
    expect([c.status, c.code, c.cause, c.environment.kind]).toEqual(['incomplete', 'PREGATE_ENVIRONMENT', 'environment', 'missing-binary']);
    expect(c.environment.evidence).toContain('Playwright browsers not installed (npx playwright install)');
    expect(c.lines.join('\n')).toContain('playwright test --reporter=list');
    runBin(repo, 'gstack-pregate', args, npxShim(repo, ASSERTION));
    const d = check(repo, 'lanes');
    expect([d.status, d.code]).toEqual(['fail', 'PREGATE_LANE_FAILED']);
    expect(d.detail).toContain('1 failed of 2 ran');
  });
});

describe('verify: a mixed incomplete record stays PREGATE_INCOMPLETE and names the environment-blocked check', () => {
  test('one environment-caused check beside a plain incomplete one is not promoted to PREGATE_ENVIRONMENT', () => {
    const file: any = { schema_version: 1, tree: 'T', checks: [
      { id: 'lanes', status: 'incomplete', cause: 'environment', environment: { kind: 'network', evidence: 'ENOTFOUND x' } },
      { id: 'guards', status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED' },
    ] };
    const v = verifyPregate('/nonexistent', file, { tree: 'T' } as any);
    expect(v.code).toBe('PREGATE_INCOMPLETE');
    expect(v.message).toContain('(blocked by the environment: lanes network)');
    const all: any = { ...file, checks: [file.checks[0]] };
    expect(verifyPregate('/nonexistent', all, { tree: 'T' } as any).code).toBe('PREGATE_ENVIRONMENT');
  });
});
