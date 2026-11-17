/**
 * #4424: on Linux a local lane with thousands of unit files never started. runOnce put every file of a run group into
 * one command string and supervise started it as `bash -c <string>`; Linux caps one execve argument at MAX_ARG_STRLEN
 * (128 KiB), so posix_spawn returned E2BIG, and the launch failure read as a missing binary ("install the named tool").
 * The fixture selects 700 test files with 200-character names (about 150 KB of quoted paths) and a runner that reports
 * one test per file argument, so the lane's count proves every file reached a runner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { argBudget, argChunks } from '../lib/pregate/checks/lanes';
import { buildContext } from '../lib/pregate/context';
import { classifyEnvironment } from '../lib/pregate/environment';
import { runPregate } from '../lib/pregate/index';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const FILES = 700;
const name = (i: number, tag = 'x') => `test/big/${tag.padEnd(186, 'x')}${String(i).padStart(4, '0')}.test.js`;
const RUNNER = [
  'const files = process.argv.slice(2);',
  "const failed = files.filter(f => f.includes('fail')).length;",
  "console.log(`ℹ tests ${files.length}\\nℹ pass ${files.length - failed}\\nℹ fail ${failed}`);",
  'process.exit(failed ? 1 : 0);',
].join('\n');

async function pregateOver(tests: string[], machine: { cores: number; testBackend: string }) {
  const repo = makeFixtureRepo({
    pregate: { ...BASE_PREGATE, runner: 'node scripts/count.js {files}', dependencies: { ...BASE_PREGATE.dependencies, 'src/big/**': tests } },
    baseFiles: Object.fromEntries([...tests.map(t => [t, "require('node:test');\n"]), ['src/big/.keep', ''], ['scripts/count.js', `${RUNNER}\n`]]),
  });
  repos.push(repo);
  commit(repo, { 'src/big/f.js': 'exports.n = 1;\n' }, 'touch the big tree');
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, ...machine });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  return runPregate(loaded.ctx, { stage: 'tests', only: ['lanes'] });
}
const lanesOver = async (tests: string[]) => (await pregateOver(tests, { cores: 64, testBackend: 'local' })).checks.find(c => c.id === 'lanes')!;

describe.skipIf(process.platform === 'win32')('a local lane whose file list is over the per-argument limit', () => {
  // Value: protects=a unit group whose quoted file list is over Linux's 128 KiB per-argument cap still launches and every file
  //   is counted; fails_when=the whole list goes into one `bash -c` argument (E2BIG on Linux: PREGATE_ENVIRONMENT, nothing ran);
  //   why_new=#4424, gbrain's 5,567 unit files on gstack 1.99.5.0; seam=runPregate --only lanes on a fixture repo with a
  //   counting runner; no_claim=macOS has no per-argument cap, so there the old code passed too
  test('every file runs and is counted, and a failure in the last chunk still fails the lane', async () => {
    const tests = Array.from({ length: FILES }, (_, i) => name(i));
    expect(tests.map(t => `'${t}'`).join(' ').length).toBeGreaterThan(128 * 1024);
    const green = await lanesOver(tests);
    expect(green.detail).not.toContain('E2BIG');
    expect(green).toMatchObject({ status: 'pass', detail: `${FILES} tests ran in ${FILES} file(s), exit 0` });

    const red = await lanesOver([...tests.slice(0, -1), name(FILES - 1, 'zfail')]);
    expect(red).toMatchObject({ status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `local lane exited 1 (1 failed of ${FILES} ran; ${FILES} files; pipefail)` });
  }, 120_000);
});

describe.skipIf(process.platform === 'win32')('the test backend command for a file list over the per-argument limit', () => {
  // Value: protects=on a small machine with a remote test_backend, the printed command passes the selected files in a setup
  //   script, so it stays short and, run the way ubi-runner runs it on the VM (setup, then bash -c <command>), every file reaches
  //   the runner; fails_when=the files go back into the command, which reaches the VM as one argument (E2BIG on Linux);
  //   why_new=the remote-gate half of #4424; seam=runPregate --only lanes, the setup file, bash; no_claim=ubi-runner's transport
  test('the files travel in the setup script, the command stays short, and running both reaches every file', async () => {
    const tests = Array.from({ length: FILES }, (_, i) => name(i));
    const quoted = tests.map(t => `'${t}'`).join(' ');
    expect(quoted.length).toBeGreaterThan(128 * 1024);
    if (process.platform === 'linux') expect((spawnSync('bash', ['-c', `true ${quoted}`], { timeout: 30_000 }).error as NodeJS.ErrnoException | undefined)?.code).toBe('E2BIG');
    const file = await pregateOver(tests, { cores: 4, testBackend: 'ubicloud' });
    expect(file.checks.find(c => c.id === 'lanes')!.status).toBe('requires-remote');
    const command = file.requires_remote!.find(o => o.lane === 'test_backend/ubicloud')!.command!;
    expect(command.length).toBeLessThan(2048);
    const argv = spawnSync('bash', ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', '_', command], { encoding: 'utf8', timeout: 30_000 }).stdout.split('\0').slice(0, -1);
    expect(argv.slice(1, 3)).toEqual(['run', '--src']);
    expect(argv[4]).toBe('--setup');
    expect(argv[6]).toBe('--');
    const setup = fs.readFileSync(argv[5]!, 'utf8');
    expect(setup.split('\n').filter(l => l.startsWith('test/big/'))).toEqual(tests);
    const vm = repos.at(-1)!;
    const env = { ...process.env, HOME: fs.mkdtempSync(path.join(vm.root, 'vm-home-')) };
    expect(spawnSync('bash', [argv[5]!], { cwd: vm.work, env, timeout: 30_000 }).status).toBe(0);
    const ran = spawnSync('bash', ['-c', argv[7]!], { cwd: vm.work, env, encoding: 'utf8', timeout: 60_000 });
    expect(ran.stdout).toContain(`ℹ tests ${FILES}\n`);
    expect(ran.status).toBe(0);
  }, 120_000);
});

describe('argChunks and argBudget', () => {
  // Value: protects=the split keeps order, drops nothing and keeps each chunk's quoted text under the budget, with an oversized
  //   argument alone in its chunk, and the budget stays under Linux's per-argument cap and shrinks with the environment;
  //   fails_when=a chunk passes the budget, a file is lost or reordered, or the budget ignores the cap; why_new=#4424; seam=none
  test('splits in order under the byte budget, which stays under the argument limits', () => {
    const args = ['a'.repeat(10), 'b'.repeat(10), "c'd".repeat(4), 'e'.repeat(40), 'f'];
    const chunks = argChunks(args, 30);
    expect(chunks).toEqual([[args[0], args[1]], [args[2]], [args[3]], [args[4]]]);
    expect(argChunks([], 30)).toEqual([]);
    expect(argChunks(args, 1_000)).toEqual([args]);
    const linux = argBudget('bun test {files}', {}, 'linux');
    expect(linux).toBeLessThan(128 * 1024);
    expect(argBudget('bun test {files}', { BIG: 'x'.repeat(900 * 1024) }, 'linux')).toBeLessThan(1024 * 1024 - 64 * 1024 - 900 * 1024);
    expect(argBudget('bun test {files}', {}, 'win32')).toBeLessThan(32 * 1024);
  });
});

describe('E2BIG is its own cause', () => {
  // Value: protects=an argument list over the system limit is named as such, never as a missing tool; fails_when=E2BIG
  //   classifies as missing-binary or as nothing (the launch path then defaulted to missing-binary); why_new=#4424's
  //   misleading "install the named tool"; seam=none
  test('classifies E2BIG and "argument list too long" as arg-limit', () => {
    expect(classifyEnvironment("E2BIG: argument list too long, posix_spawn 'bash'", null)).toEqual({ kind: 'arg-limit', evidence: "E2BIG: argument list too long, posix_spawn 'bash'", proof: 'output' });
    expect(classifyEnvironment('bash: /usr/bin/node: Argument list too long', 126)?.kind).toBe('arg-limit');
  });
});
