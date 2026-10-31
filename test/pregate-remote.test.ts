/**
 * Lane C4 (GBRA-95): on a machine under 8 cores, a remote test gate the base
 * branch declares (`remote_gate`) or a remote `test_backend` records the
 * local test tier as a requires-remote obligation with the exact command,
 * instead of running thousands of files locally. `--remote` runs the
 * declared gate now under a spend cap; the obligation clears only on the
 * gate's `PREGATE_REMOTE: tree=<tested tree> tests=<n> failed=0` line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const GATE = 'node scripts/remote-gate.js';
/** A fake remote gate: reports the tree it was handed (or GATE_TREE), GATE_TESTS / GATE_FAILED, and records its env. */
const GATE_SCRIPT = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('../gate-env.json', JSON.stringify({ tree: process.env.PREGATE_TREE, cap: process.env.PREGATE_SPEND_CAP_USD, timeout: process.env.PREGATE_TIMEOUT_S, files: fs.readFileSync(process.env.PREGATE_FILES_FILE, 'utf8') }));",
  "if (process.env.GATE_QUIET_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.GATE_QUIET_MS));",
  "if (process.env.GATE_SILENT) process.exit(0);",
  "const spent = process.env.GATE_SPENT ? ` spent=${process.env.GATE_SPENT}` : '';",
  "console.log(`PREGATE_REMOTE: tree=${process.env.GATE_TREE || process.env.PREGATE_TREE} tests=${process.env.GATE_TESTS ?? 3} failed=${process.env.GATE_FAILED ?? 0}${spent}`);",
].join('\n') + '\n';

function gated(pregate: Record<string, unknown> = { ...BASE_PREGATE, remote_gate: GATE }): FixtureRepo {
  const repo = makeFixtureRepo({ pregate });
  repos.push(repo);
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'scripts/remote-gate.js': GATE_SCRIPT }, 'remote gate');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--ff-only', 'main');
  commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
  return repo;
}

async function lanesOn(repo: FixtureRepo, o: { cores: number; testBackend: string }) {
  const lines: string[] = [];
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: l => lines.push(l), ...o });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'tests' });
  return { file, lanes: file.checks.find(c => c.id === 'lanes')!, lines };
}

describe('small machines record the test tier for the remote gate (C4)', () => {
  test('under 8 cores a declared remote_gate becomes a requires-remote obligation naming the command; nothing runs locally', async () => {
    const repo = gated();
    const { file, lanes, lines } = await lanesOn(repo, { cores: 4, testBackend: 'local' });
    expect(lanes.status).toBe('requires-remote');
    expect(lanes.detail).toContain('recorded as requires-remote pregate.json/remote_gate (4 cores, under 8)');
    expect(file.requires_remote).toEqual([expect.objectContaining({ lane: 'pregate.json/remote_gate', platform: 'remote', command: GATE, tests: ['test/util.test.js'], receipt: null })]);
    expect(file.verdict).toBe('requires-remote (1 uncleared)');
    expect(fs.existsSync(path.join(repo.root, 'gate-env.json'))).toBe(false);
    expect(lines.some(l => l.startsWith('PREGATE_TEST:'))).toBe(false);
    expect(lines.at(-1)).toMatch(/^PREGATE: tests requires-remote \(1 uncleared\) in /);
  });

  test('a remote test_backend without remote_gate names gstack\'s Ubicloud runner with the selection; 8 cores or more, or local with no gate, runs locally', async () => {
    const backend = gated(BASE_PREGATE);
    const viaBackend = await lanesOn(backend, { cores: 4, testBackend: 'ubicloud' });
    expect(viaBackend.lanes.status).toBe('requires-remote');
    const obligation = viaBackend.file.requires_remote![0]!;
    expect(obligation.lane).toBe('test_backend/ubicloud');
    expect(obligation.command).toMatch(/scripts\/ubicloud\/ubi-runner\.sh run --src '.*\/work' -- 'node --test '\\''test\/util\.test\.js'\\'''$/);
    expect((await lanesOn(backend, { cores: 4, testBackend: 'local' })).lanes.status).toBe('pass');
    expect((await lanesOn(gated(), { cores: 16, testBackend: 'local' })).lanes.status).toBe('pass');
  });

  test('`clear` on the remote_gate obligation needs the gate\'s PREGATE_REMOTE receipt for the tested tree; a run URL or a bad receipt leaves it uncleared', async () => {
    const repo = gated();
    const fileAt = path.join(repo.work, '.gstack/tmp/pregate.json');
    const { file } = await lanesOn(repo, { cores: 4, testBackend: 'local' });
    fs.mkdirSync(path.dirname(fileAt), { recursive: true });
    fs.writeFileSync(fileAt, JSON.stringify(file));
    const clear = (args: string[]) => runBin(repo, 'gstack-pregate', ['clear', '--remote', 'pregate.json/remote_gate', ...args]);
    const receiptOf = (line: string) => { const f = path.join(repo.root, `receipt-${Math.random().toString(36).slice(2)}.log`); fs.writeFileSync(f, `gate log\n${line}\n`); return f; };
    const url = clear(['--run-url', 'https://ci.example/run/1']);
    expect(url.status).toBe(EXIT.usage);
    expect(url.err).toContain('clears only with --receipt <file>');
    for (const [line, why] of [
      [`PREGATE_REMOTE: tree=${'deadbeef'.repeat(8)} tests=3 failed=0`, 'the remote gate tested tree deadbeefdead'],
      [`PREGATE_REMOTE: tree=${file.tree} tests=0 failed=0`, 'the remote gate reported 0 tests'],
      [`PREGATE_REMOTE: tree=${file.tree} tests=3 failed=1`, 'the remote gate reported 1 failed of 3'],
      ['all green, trust me', 'has no PREGATE_REMOTE: line'],
    ] as const) {
      const r = clear(['--receipt', receiptOf(line)]);
      expect(r.status).toBe(EXIT.fail);
      expect(r.err).toContain(why);
      expect(r.err).toContain('(PREGATE_RECEIPT_INVALID; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#pregate-receipt-invalid)');
      expect(JSON.parse(fs.readFileSync(fileAt, 'utf8')).requires_remote[0].receipt).toBeNull();
    }
    const ok = clear(['--receipt', receiptOf(`PREGATE_REMOTE: tree=${file.tree} tests=3 failed=0`)]);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(new RegExp(`^PREGATE_CLEARED: pregate\\.json/remote_gate receipt=remote-gate tree=${file.tree.slice(0, 12)} tests=3 receipt=\\S+ sha256=[0-9a-f]{12} verdict=requires-remote cleared$`, 'm'));
    expect(ok.out).not.toContain('attested');
  });

  test('`clear` on a test_backend obligation records the run URL as attested, not validated, and says so', async () => {
    const repo = gated(BASE_PREGATE);
    const fileAt = path.join(repo.work, '.gstack/tmp/pregate.json');
    const { file, lanes } = await lanesOn(repo, { cores: 4, testBackend: 'ubicloud' });
    expect(lanes.detail).toContain('gstack-pregate clear --remote test_backend/ubicloud --run-url <url>');
    fs.mkdirSync(path.dirname(fileAt), { recursive: true });
    fs.writeFileSync(fileAt, JSON.stringify(file));
    expect(runBin(repo, 'gstack-pregate', ['clear', '--remote', 'test_backend/ubicloud', '--receipt', fileAt]).status).toBe(EXIT.usage);
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', 'test_backend/ubicloud', '--run-url', 'https://ci.example/run/7']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('PREGATE_CLEARED: test_backend/ubicloud receipt=attested:https://ci.example/run/7 verdict=requires-remote cleared (attested, not validated: test_backend/ubicloud has no machine-checkable receipt)');
    expect(JSON.parse(fs.readFileSync(fileAt, 'utf8')).requires_remote[0].receipt).toBe('attested:https://ci.example/run/7');
  });

  test('config: stall_timeout_s and remote_gate are typed', async () => {
    const { validateConfig } = await import('../lib/pregate/config');
    const codes = (c: unknown) => validateConfig(c).map(e => `${e.code}:${e.path}`);
    expect(codes({ stall_timeout_s: 0, remote_gate: GATE })).toEqual([]);
    expect(codes({ stall_timeout_s: -1 })).toEqual(['PREGATE_CONFIG_INVALID:stall_timeout_s']);
    expect(codes({ stall_timeout_s: 1.5 })).toEqual(['PREGATE_CONFIG_INVALID:stall_timeout_s']);
    expect(codes({ remote_gate: 'a\nb' })).toEqual(['PREGATE_CONFIG_INVALID:remote_gate']);
  });
});

describe('gstack-pregate --remote (C-c)', () => {
  const remote = (repo: FixtureRepo, args: string[], env: Record<string, string> = {}) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'tests', ...args], env);
  const lanes = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'lanes');
  const pregateFile = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));

  test('needs --allow-repo-commands and a spend cap', () => {
    const repo = gated();
    expect(remote(repo, ['--remote', '--spend-cap', '5']).status).toBe(EXIT.refused);
    const noCap = remote(repo, ['--remote', '--allow-repo-commands']);
    expect(noCap.status).toBe(EXIT.usage);
    expect(noCap.err).toContain('pass --spend-cap <usd> (or set GSTACK_SPEND_CAP_USD)');
    expect(remote(repo, ['--spend-cap', '5', '--allow-repo-commands']).status).toBe(EXIT.usage);
    expect(fs.existsSync(path.join(repo.root, 'gate-env.json'))).toBe(false);
  });

  test('a gate reporting the tested tree, tests > 0 and failed = 0 clears the obligation and reports its spend', () => {
    const repo = gated();
    const r = remote(repo, ['--remote', '--allow-repo-commands'], { GSTACK_SPEND_CAP_USD: '4', GATE_SPENT: '0.37' });
    expect(r.status).toBe(EXIT.ok);
    const file = pregateFile(repo);
    expect(file.verdict).toBe('requires-remote cleared');
    expect(file.requires_remote[0]).toMatchObject({ lane: 'pregate.json/remote_gate', receipt: `remote-gate tree=${file.tree.slice(0, 12)} tests=3` });
    expect(lanes(repo).detail).toContain('spend: spent $0.37, reserved $0, unknown $0 (cap $4)');
    expect(r.err).toContain('PREGATE_REMOTE_SPEND: spent $0.37, reserved $0, unknown $0 (cap $4)');
    const env = JSON.parse(fs.readFileSync(path.join(repo.root, 'gate-env.json'), 'utf8'));
    expect(env).toEqual({ tree: file.tree, cap: '4', timeout: '600', files: 'test/util.test.js\n' });
    expect(runBin(repo, 'gstack-pregate', ['verify']).status).toBe(EXIT.ok);
  });

  // Value: protects=a head policy that only adds lanes can clear the remote obligation on a small machine, with the base copy's gate and the
  //   policy's timeout_s as the gate's deadline (PREGATE_TIMEOUT_S); a head policy that changes the gate is refused (GST-419, GST-420);
  //   fails_when=--remote refuses head mode, the gate deadline ignores timeout_s or --timeout, or a head remote_gate runs; why_new=head mode
  //   could never clear on under-8-core crew machines; seam=fake gate; no_claim=the Ubicloud VM
  test('under --policy-from head the base gate runs with the head lanes and the timeout_s deadline; a head policy that changes the gate is refused', () => {
    const policy = { ...BASE_PREGATE, remote_gate: GATE, timeout_s: 900 };
    const repo = gated(policy);
    const lane = { ...BASE_PREGATE.dependencies, 'lib/orphan.js': ['test/util.test.js'] };
    commit(repo, { 'lib/orphan.js': 'exports.lonely = () => 2;\n', '.gstack/pregate.json': JSON.stringify({ ...policy, dependencies: lane }) + '\n' });
    const env = () => JSON.parse(fs.readFileSync(path.join(repo.root, 'gate-env.json'), 'utf8'));
    expect(remote(repo, ['--remote', '--allow-repo-commands', '--policy-from', 'head', '--spend-cap', '2']).status).toBe(EXIT.ok);
    expect(env().timeout).toBe('900');
    expect(env().files).toContain('test/util.test.js');
    expect(remote(repo, ['--remote', '--allow-repo-commands', '--policy-from', 'head', '--spend-cap', '2', '--timeout', '1200']).status).toBe(EXIT.ok);
    expect(env().timeout).toBe('1200');
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...policy, remote_gate: 'node scripts/other-gate.js', dependencies: lane }) + '\n' });
    const changed = remote(repo, ['--remote', '--allow-repo-commands', '--policy-from', 'head', '--spend-cap', '2']);
    expect(changed.status).toBe(EXIT.refused);
    expect(changed.err).toContain('remote_gate differs from the trusted policy');
  }, 60_000);

  // Value: protects=a bootstrap head policy (no base copy, no user-owned file) cannot run its own remote_gate to clear its obligation;
  //   fails_when=--remote under head runs a branch-authored gate and verify passes with no test run; why_new=--remote now runs under
  //   head once the additive check passes, and a bootstrap has nothing to check against; seam=fake gate; no_claim=none
  test('--remote under --policy-from head with no trusted policy is refused before any gate runs', () => {
    const repo = makeFixtureRepo({ pregate: null });
    repos.push(repo);
    commit(repo, { 'scripts/remote-gate.js': GATE_SCRIPT, '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, remote_gate: GATE }) + '\n', 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const r = remote(repo, ['--remote', '--allow-repo-commands', '--policy-from', 'head', '--spend-cap', '2'], { GSTACK_PROJECT_SLUG: 'remote-bootstrap' });
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('the head file is a bootstrap and its remote_gate cannot clear its own obligation');
    expect(fs.existsSync(path.join(repo.root, 'gate-env.json'))).toBe(false);
  }, 60_000);

  // Value: protects=a remote gate that waits quietly on CI is bounded by its deadline (--timeout, else timeout_s), not killed by the
  //   test-output stall timer; a gate past its deadline still stays uncleared (GST-431); fails_when=the stall timer kills a quiet gate
  //   inside its deadline, or a gate past --timeout clears; why_new=a CI-waiting gate died at 300 s on qm (CAPY-1); seam=fake gate;
  //   no_claim=the Ubicloud VM
  test('a gate that is quiet past the stall timeout but inside its deadline clears; past --timeout it stays uncleared', () => {
    const repo = gated();
    const quiet = remote(repo, ['--remote', '--allow-repo-commands', '--spend-cap', '2', '--stall-timeout', '1', '--timeout', '60'], { GATE_QUIET_MS: '2500' });
    expect(quiet.status).toBe(EXIT.ok);
    expect(pregateFile(repo).verdict).toBe('requires-remote cleared');
    const late = remote(repo, ['--remote', '--allow-repo-commands', '--spend-cap', '2', '--timeout', '2'], { GATE_QUIET_MS: '8000' });
    expect(late.status).toBe(EXIT.fail);
    expect(lanes(repo)).toMatchObject({ status: 'incomplete', code: 'PREGATE_INCOMPLETE' });
    expect(lanes(repo).detail).toContain('the remote gate did not finish (timed out after 2 s, --timeout)');
    expect(pregateFile(repo).requires_remote[0].receipt).toBeNull();
  }, 60_000);

  test('a wrong tree, zero tests, a failure, a missing line or a non-zero exit leaves the obligation uncleared and the check incomplete; unreported spend counts at the cap', () => {
    const repo = gated();
    const cases: Array<[Record<string, string>, string]> = [
      [{ GATE_TREE: 'deadbeef'.repeat(8) }, 'the remote gate tested tree deadbeefdead'],
      [{ GATE_TESTS: '0' }, 'the remote gate reported 0 tests'],
      [{ GATE_FAILED: '1' }, 'the remote gate reported 1 failed of 3'],
      [{ GATE_SILENT: '1' }, 'the remote gate exited 0 without a PREGATE_REMOTE: line'],
    ];
    for (const [env, why] of cases) {
      const r = remote(repo, ['--remote', '--allow-repo-commands', '--spend-cap', '2'], env);
      expect(r.status).toBe(EXIT.fail);
      const row = lanes(repo);
      expect(row.status).toBe('incomplete');
      expect(row.detail).toContain(why);
      expect(row.detail).toContain('requires-remote pregate.json/remote_gate stays uncleared');
      expect(pregateFile(repo).requires_remote[0].receipt).toBeNull();
    }
    expect(lanes(repo).lines).toContain('spend: spent $0, reserved $0, unknown $2 (no spent= reported; counted at the cap) (cap $2)');
    const backendOnly = gated(BASE_PREGATE);
    expect(remote(backendOnly, ['--remote', '--allow-repo-commands', '--spend-cap', '2']).status).toBe(EXIT.fail);
    expect(lanes(backendOnly).detail).toContain('--remote runs only a declared remote gate');
  });
});
