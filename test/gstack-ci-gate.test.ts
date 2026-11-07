/**
 * lib/ci-gate.ts — the /land-and-deploy merge gate (#2995).
 *
 * Fixtures under test/fixtures/ci-gate/ are real `gh pr checks --json` output
 * (gh 2.101.0 against garrytan/gstack PRs); the remaining cases are synthetic
 * responses in the same shape. gh exits 0 with --json even when checks are red
 * or pending, so the verdict must come from `bucket`, never the exit status.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciGateMain, evaluateChecks, parseCiGateArgs, runCiGate, type CiGateOptions, type GhResult, type GhRunner } from '../lib/ci-gate';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const fixture = (name: string): { required: GhResult; all: GhResult } =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'ci-gate', `${name}.json`), 'utf8'));
const ok = (rows: unknown): GhResult => ({ status: 0, stdout: JSON.stringify(rows), stderr: '' });
const err = (stderr: string, status = 1): GhResult => ({ status, stdout: '', stderr: `${stderr}\n` });
const row = (name: string, bucket?: string) => ({ name, state: 'X', link: `https://ci.example/${encodeURIComponent(name)}`, ...(bucket === undefined ? {} : { bucket }) });
const NONE = err("no checks reported on the 'feature' branch");
const NONE_REQUIRED = err("no required checks reported on the 'feature' branch");

interface Script { heads?: string[]; required?: GhResult[]; all?: GhResult[]; api?: GhResult }
function fakeGh(script: Script): GhRunner & { calls: string[][] } {
  const queues = { head: script.heads ?? [HEAD], required: script.required ?? [], all: script.all ?? [] };
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]);
  const calls: string[][] = [];
  const gh = ((args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') return script.api ?? err('gh: Not Found (HTTP 404)');
    if (args[1] === 'view') return { status: 0, stdout: `${next(queues.head)}\n`, stderr: '' };
    if (args[1] === 'merge') throw new Error('the gate must never merge');
    return next(args.includes('--required') ? queues.required : queues.all);
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}
const options = (extra: Partial<CiGateOptions> = {}): CiGateOptions => ({
  repo: 'owner/project', pr: '42', expectHead: HEAD, excludes: [], waitSeconds: 0, intervalSeconds: 30, registrationWaitSeconds: 0, ...extra,
});
const noSleep = async () => {};
const gate = (script: Script, extra: Partial<CiGateOptions> = {}) => runCiGate(options(extra), fakeGh(script), noSleep);
const checkLines = (lines: string[]) => lines.filter(line => line.startsWith('CHECK\t'));

describe('verdicts on recorded gh output', () => {
  test('protected repo, required and all checks green or skipped → PASS', async () => {
    const { required, all } = fixture('protected-pass');
    expect(JSON.parse(all.stdout).some((c: { bucket: string }) => c.bucket === 'skipping')).toBe(true);
    const result = await gate({ required: [required], all: [all] });
    expect(result.verdict).toBe('PASS');
    expect(checkLines(result.lines)).toEqual([]);
  });

  test('required check red → FAIL naming it as required', async () => {
    const { required, all } = fixture('protected-required-red');
    const result = await gate({ required: [required], all: [all] });
    expect(result.verdict).toBe('FAIL');
    expect(checkLines(result.lines)).toContainEqual(expect.stringMatching(/^CHECK\tfree-tests\tfail\trequired=y\thttps:/));
    expect(checkLines(result.lines).filter(line => line.includes('required=n')).length).toBeGreaterThan(0);
  });

  test('required green but non-required red → FAIL (strict all-checks default)', async () => {
    const { required, all } = fixture('protected-nonrequired-red');
    expect(required.status).toBe(0);
    const result = await gate({ required: [required], all: [all] });
    expect(result.verdict).toBe('FAIL');
    expect(checkLines(result.lines).map(line => line.split('\t').slice(1, 4))).toEqual([
      ['eval-slices (5)', 'fail', 'required=n'],
      ['slices-report', 'fail', 'required=n'],
    ]);
  });

  test('no CI on the head at all → NO_CHECKS with SHA and workflow presence', async () => {
    const { required, all } = fixture('no-checks');
    const result = await gate({ required: [required], all: [all], api: ok(2) });
    expect(result.verdict).toBe('NO_CHECKS');
    expect(result.sha).toBe(HEAD);
    expect(result.lines).toContain('NOTE .github/workflows exists at this head');
    expect(result.lines.some(line => line.includes(`no CI ran on ${HEAD}`))).toBe(true);
    const absent = await gate({ required: [required], all: [all] });
    expect(absent.lines).toContain('NOTE .github/workflows does not exist at this head');
  });
});

describe('verdicts on synthetic gh output', () => {
  test('unprotected repo: none required, all green → PASS; one red → FAIL (#2995)', async () => {
    expect((await gate({ required: [NONE_REQUIRED], all: [ok([row('build', 'pass')])] })).verdict).toBe('PASS');
    const red = await gate({ required: [NONE_REQUIRED], all: [ok([row('build', 'pass'), row('test', 'fail')])] });
    expect(red.verdict).toBe('FAIL');
    expect(red.lines).toContain('NOTE no required checks configured; gating on all checks');
  });

  test('unprotected repo with a pending check → PENDING, never a pass', async () => {
    const result = await gate({ required: [NONE_REQUIRED], all: [ok([row('build', 'pass'), row('test', 'pending')])] });
    expect(result.verdict).toBe('PENDING');
    expect(checkLines(result.lines)).toEqual([`CHECK\ttest\tpending\trequired=n\thttps://ci.example/test`]);
  });

  test('403 protection metadata → gate on all checks with required=?', async () => {
    const forbidden = err('GraphQL: Resource not accessible by integration (HTTP 403)');
    const result = await gate({ required: [forbidden], all: [ok([row('build', 'pass'), row('lint', 'fail')])] });
    expect(result.verdict).toBe('FAIL');
    expect(checkLines(result.lines)).toEqual([`CHECK\tlint\tfail\trequired=?\thttps://ci.example/lint`]);
    expect(result.lines.some(line => line.startsWith('NOTE required-check metadata unavailable') && line.includes('HTTP 403'))).toBe(true);
    expect((await gate({ required: [forbidden], all: [ok([row('build', 'pass')])] })).verdict).toBe('PASS');
  });

  test('pass buckets are a whitelist; cancel and unknown buckets fail', async () => {
    for (const bucket of ['pass', 'skipping', 'neutral']) {
      expect((await gate({ required: [NONE_REQUIRED], all: [ok([row('x', bucket)])] })).verdict).toBe('PASS');
    }
    for (const bucket of ['cancel', 'fail', 'stale', 'action_required', '']) {
      expect((await gate({ required: [NONE_REQUIRED], all: [ok([row('x', bucket)])] })).verdict).toBe('FAIL');
    }
  });

  test('fail outranks pending', async () => {
    expect((await gate({ required: [NONE_REQUIRED], all: [ok([row('a', 'pending'), row('b', 'cancel')])] })).verdict).toBe('FAIL');
  });

  test('missing bucket (old gh), malformed JSON, auth failure and unknown errors → ERROR', async () => {
    const cases: GhResult[] = [
      ok([{ name: 'build', state: 'SUCCESS', link: '' }]),
      { status: 0, stdout: 'not json', stderr: '' },
      ok({ name: 'build', bucket: 'pass' }),
      ok([{ bucket: 'pass' }]),
      err('HTTP 401: Bad credentials (https://api.github.com/graphql)'),
      err('unknown flag: --json'),
      err('no commit found on the pull request'),
      { status: null, stdout: '', stderr: '', error: 'gh is not installed or not on PATH' },
    ];
    for (const all of cases) {
      const result = await gate({ required: [NONE_REQUIRED], all: [all] });
      expect(result.verdict).toBe('ERROR');
      expect(result.lines.some(line => line.startsWith('CAUSE '))).toBe(true);
      expect(result.lines.some(line => line.includes('gh auth status') && line.includes('2.50.0'))).toBe(true);
    }
    const auth = await gate({ required: [NONE_REQUIRED], all: [err('HTTP 401: Bad credentials')] });
    expect(auth.lines).toContain('STDERR HTTP 401: Bad credentials');
  });

  test('a nonzero exit that still carries valid JSON is judged by its buckets', async () => {
    const legacy = { status: 8, stdout: JSON.stringify([row('build', 'pending')]), stderr: '' };
    expect((await gate({ required: [NONE_REQUIRED], all: [legacy] })).verdict).toBe('PENDING');
  });

  test('worst observation wins when the two reads disagree', () => {
    const result = evaluateChecks(ok([row('build', 'pending')]), ok([row('build', 'pass')]), []);
    expect(result.verdict).toBe('PENDING');
    expect(result.verdict !== 'ERROR' && result.lines[0]).toBe('CHECK\tbuild\tpending\trequired=y\thttps://ci.example/build');
  });

  test('checks that register between the two reads have unknown required status', () => {
    const result = evaluateChecks(NONE, ok([row('build', 'fail')]), ['build']);
    expect(result.verdict).toBe('FAIL');
    expect(result.verdict !== 'ERROR' && result.lines[0]).toContain('required=?');
  });
});

describe('head binding', () => {
  test('a head other than --expect-head is ERROR before any check is read', async () => {
    const gh = fakeGh({ heads: [OTHER], required: [NONE_REQUIRED], all: [ok([row('b', 'pass')])] });
    const result = await runCiGate(options(), gh, noSleep);
    expect(result.verdict).toBe('ERROR');
    expect(result.sha).toBe(HEAD);
    expect(result.lines).toContain(`HEAD ${OTHER}`);
    expect(gh.calls.some(args => args[1] === 'checks')).toBe(false);
  });

  test('a head that moves while checks are read is ERROR even when checks pass', async () => {
    const result = await gate({ heads: [HEAD, OTHER], required: [NONE_REQUIRED], all: [ok([row('b', 'pass')])] });
    expect(result.verdict).toBe('ERROR');
    expect(result.lines).toContain('CAUSE the PR head moved while checks were being read');
  });

  test('checks are read with and without --required, for the pinned PR and repo', async () => {
    const gh = fakeGh({ required: [NONE_REQUIRED], all: [ok([row('b', 'pass')])] });
    await runCiGate(options(), gh, noSleep);
    expect(gh.calls).toEqual([
      ['pr', 'view', '42', '--repo', 'owner/project', '--json', 'headRefOid', '--jq', '.headRefOid'],
      ['pr', 'checks', '42', '--repo', 'owner/project', '--required', '--json', 'name,state,bucket,link'],
      ['pr', 'checks', '42', '--repo', 'owner/project', '--json', 'name,state,bucket,link'],
      ['pr', 'view', '42', '--repo', 'owner/project', '--json', 'headRefOid', '--jq', '.headRefOid'],
    ]);
  });
});

describe('per-head, per-check overrides', () => {
  const nonRequiredRed = { required: [ok([row('build', 'pass')])], all: [ok([row('build', 'pass'), row('lint', 'fail'), row('e2e', 'pending')])] };

  test('excluding every named non-required failure for this head → PASS, still listed', async () => {
    const result = await gate(nonRequiredRed, { excludes: ['lint', 'e2e'], overrideHead: HEAD });
    expect(result.verdict).toBe('PASS');
    expect(checkLines(result.lines).every(line => line.endsWith('\texcluded'))).toBe(true);
    expect((await gate(nonRequiredRed, { excludes: ['lint'], overrideHead: HEAD })).verdict).toBe('PENDING');
  });

  test('overrides approved for another head, or without a head, are ERROR', async () => {
    for (const overrideHead of [OTHER, undefined]) {
      const result = await gate(nonRequiredRed, { excludes: ['lint', 'e2e'], overrideHead });
      expect(result.verdict).toBe('ERROR');
      expect(result.lines[0]).toBe('CAUSE check overrides were not approved for this head');
    }
  });

  test('required and unknown-required checks can never be excluded', async () => {
    const requiredRed = await gate({ required: [ok([row('build', 'fail')])], all: [ok([row('build', 'fail')])] }, { excludes: ['build'], overrideHead: HEAD });
    expect(requiredRed.verdict).toBe('FAIL');
    expect(checkLines(requiredRed.lines)[0]).toEndWith('\toverride-refused');
    const unknown = await gate({ required: [err('HTTP 403')], all: [ok([row('lint', 'fail')])] }, { excludes: ['lint'], overrideHead: HEAD });
    expect(unknown.verdict).toBe('FAIL');
  });

  test('an override naming no existing check is reported, not silently applied', async () => {
    const result = await gate(nonRequiredRed, { excludes: ['lint', 'e2e', 'ghost'], overrideHead: HEAD });
    expect(result.lines).toContain('NOTE override for unknown check "ghost" ignored');
  });
});

describe('polling', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  test('delayed registration: zero checks re-polled until checks appear', async () => {
    const c = clock();
    const gh = fakeGh({ required: [NONE, NONE, NONE_REQUIRED], all: [NONE, NONE, ok([row('build', 'pending')])] });
    const result = await runCiGate(options({ registrationWaitSeconds: 120 }), gh, c.sleep, c.now, () => 0);
    expect(result.verdict).toBe('PENDING');
    expect(c.now()).toBe(120_000);
  });

  test('registration wait is bounded at 60s, then NO_CHECKS', async () => {
    const c = clock();
    const result = await runCiGate(options({ registrationWaitSeconds: 60 }), fakeGh({ required: [NONE], all: [NONE] }), c.sleep, c.now, () => 0);
    expect(result.verdict).toBe('NO_CHECKS');
    expect(c.now()).toBe(60_000);
  });

  test('registration wait re-polls once even when the first read takes time', async () => {
    const c = clock();
    const base = fakeGh({ required: [NONE, NONE_REQUIRED], all: [NONE, ok([row('build', 'pending')])] });
    const gh: GhRunner = args => { c.sleep(500); return base(args); };
    const result = await runCiGate(options({ registrationWaitSeconds: 60 }), gh, c.sleep, c.now, () => 0);
    expect(result.verdict).toBe('PENDING');
  });

  test('--wait polls PENDING until a final verdict', async () => {
    const c = clock();
    const all = [ok([row('t', 'pending')]), ok([row('t', 'pending')]), ok([row('t', 'pass')])];
    const result = await runCiGate(options({ waitSeconds: 240 }), fakeGh({ required: [NONE_REQUIRED], all }), c.sleep, c.now, () => 0);
    expect(result.verdict).toBe('PASS');
    expect(c.now()).toBe(120_000);
  });

  test('--wait timeout reports PENDING and names the still-pending checks', async () => {
    const c = clock();
    const all = [ok([row('build', 'pass'), row('deploy-preview', 'pending')])];
    const result = await runCiGate(options({ waitSeconds: 240 }), fakeGh({ required: [NONE_REQUIRED], all }), c.sleep, c.now, () => 0);
    expect(result.verdict).toBe('PENDING');
    expect(checkLines(result.lines)).toEqual(['CHECK\tdeploy-preview\tpending\trequired=n\thttps://ci.example/deploy-preview']);
    expect(result.lines.some(line => line.startsWith('NOTE still pending after waiting 240s'))).toBe(true);
  });

  test('a failure during the wait stops immediately (fail fast)', async () => {
    const c = clock();
    const all = [ok([row('t', 'pending')]), ok([row('t', 'fail'), row('u', 'pending')])];
    const result = await runCiGate(options({ waitSeconds: 240 }), fakeGh({ required: [NONE_REQUIRED], all }), c.sleep, c.now, () => 0);
    expect(result.verdict).toBe('FAIL');
    expect(c.now()).toBe(60_000);
  });
});

describe('CLI contract', () => {
  const run = async (argv: string[], gh: GhRunner = fakeGh({ required: [NONE_REQUIRED], all: [ok([row('b', 'pass')])] })) => {
    let out = '';
    const code = await ciGateMain(argv, gh, text => { out += text; });
    return { code, out };
  };
  const base = ['--repo', 'owner/project', '--pr', '42', '--expect-head', HEAD, '--registration-wait', '0'];

  test('VERDICT is the first line and exit codes are 0/1/2/3/4', async () => {
    const cases: Array<[Script, string, number]> = [
      [{ required: [NONE_REQUIRED], all: [ok([row('b', 'pass')])] }, 'PASS', 0],
      [{ required: [NONE_REQUIRED], all: [ok([row('b', 'fail')])] }, 'FAIL', 1],
      [{ required: [NONE_REQUIRED], all: [ok([row('b', 'pending')])] }, 'PENDING', 2],
      [{ required: [NONE], all: [NONE] }, 'NO_CHECKS', 3],
      [{ required: [NONE_REQUIRED], all: [err('HTTP 502')] }, 'ERROR', 4],
    ];
    for (const [script, verdict, code] of cases) {
      const result = await run(base, fakeGh(script));
      expect(result.out.split('\n')[0]).toBe(`VERDICT ${verdict} ${HEAD}`);
      expect(result.code).toBe(code);
    }
  });

  test('--help documents the verdicts and exit codes', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Exit codes: 0 PASS, 1 FAIL, 2 PENDING, 3 NO_CHECKS, 4 ERROR.');
    expect(result.out).toContain('--expect-head');
  });

  test('bad arguments are ERROR, never a pass', async () => {
    for (const argv of [[], ['--repo', 'x', '--pr', '1', '--expect-head', HEAD], [...base, '--interval', '0'], [...base, '--bogus'], [...base.slice(0, 4), '--expect-head', 'abc']]) {
      const result = await run(argv);
      expect(result.code).toBe(4);
      expect(result.out).toStartWith('VERDICT ERROR ');
    }
    expect(parseCiGateArgs([...base, '--exclude', 'a b', '--override-head', HEAD])).toMatchObject({ excludes: ['a b'], overrideHead: HEAD });
  });
});
