/**
 * W2-A3 (fix wave 3): scripts/ubicloud/pregate-remote.sh, gstack's declared
 * remote_gate. Each case runs the real script in a fixture checkout whose
 * scripts/ubicloud/ubi-runner.sh is a stub that "creates" a local VM
 * directory, so the keyed path runs its real VM-side setup prelude, the real
 * test-free-shards.ts --files-from and the real bin/gstack-wtree, offline and
 * at no cost. Reports are judged through the exported parseRemoteReport /
 * remoteReportProblem, exactly as gstack-pregate --remote judges them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseConfig } from '../lib/pregate/config';
import { parseRemoteReport, remoteReportProblem } from '../lib/pregate/checks/lanes';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pregate-remote-gate-'));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const COPIED = ['scripts/ubicloud/pregate-remote.sh', 'bin/gstack-wtree', 'bin/gstack-path-spelling.sh',
  'scripts/test-free-shards.ts', 'scripts/test-strict-output.ts', 'scripts/lib/shard-engine.ts', 'scripts/lib/free-home-guard.ts',
  'scripts/lib/free-ci-health.ts', 'scripts/lib/windows-curation.ts', 'lib/state-root.ts', 'test/helpers/paid-test-set.ts',
  'test/helpers/touchfiles.ts', 'test/helpers/touchfiles-data.ts', 'test/helpers/test-selection.ts'];
const TESTS: Record<string, string> = {
  'test/alpha.test.ts': "import { expect, test } from 'bun:test';\ntest('alpha', () => { expect(1).toBe(1); });\n",
  'test/beta.test.ts': "import { expect, test } from 'bun:test';\ntest('beta', () => { expect(2).toBe(2); });\n",
  'test/fails.test.ts': "import { expect, test } from 'bun:test';\ntest('fails', () => { expect(1).toBe(2); });\n",
  'test/empty.test.ts': "import 'bun:test';\n",
  'test/mover.test.ts': "import { test } from 'bun:test';\nimport * as fs from 'node:fs';\nimport * as path from 'node:path';\ntest('moves the tree', () => { fs.writeFileSync(path.join(import.meta.dir, '..', 'moved.txt'), 'x'); });\n",
};

/** Stub of scripts/ubicloud/ubi-runner.sh (written into each fixture as that file). */
const UBI_RUNNER_STUB = `#!/usr/bin/env bash
# Stub of scripts/ubicloud/ubi-runner.sh for test/ubicloud-pregate-remote.test.ts:
# "run" copies the checkout (tracked + untracked-unignored + .git) into a local
# VM directory, runs setup and the command there, and prints ubi-runner's log
# lines. STUB_FAIL picks a failure: create, quota, quota-once, ssh. STUB_HANG
# sleeps before the command; TERM tears down as ubi-runner's trap does.
# Every teardown is appended to $STUB_CALLS.down.
set -uo pipefail
[ "$1" != owner ] || { echo stub; exit 0; }
[ "$1" = run ] || exit 2
shift
printf '%s\\n' "$*" >>"$STUB_CALLS"
src=. setup="" size="" name=unnamed envs=()
while [ $# -gt 0 ]; do
  case $1 in
    -s) size=$2; shift 2 ;;
    -n) name=$2; shift 2 ;;
    --src) src=$2; shift 2 ;;
    --setup) setup=$2; shift 2 ;;
    --env) envs+=("$2"); shift 2 ;;
    --pull) shift 2 ;;
    --) shift; break ;;
    *) echo "stub: unknown option $1" >&2; exit 2 ;;
  esac
done
cmd=$*
log() { echo "ubi-runner: $*" >&2; }
log "creating eu-central-h1/$name ($size)"
calls=$(wc -l <"$STUB_CALLS")
fail=\${STUB_FAIL:-}
if [ "$fail" = quota ] || { [ "$fail" = quota-once ] && [ "$calls" -eq 1 ]; }; then
  log "quota refused eu-central-h1/$name ($size): it needs 16 vCPUs and the project already uses 64 of 64"
  log "create failed: vCPU quota exhausted; wait for running VMs to finish, or use fewer or smaller VMs (ci:ubicloud --vms N)"
  log "gone: eu-central-h1/$name (never existed or already destroyed)"
  exit 1
fi
if [ "$fail" = create ]; then
  echo "Validation failed for following fields: size" >&2
  log "create failed"
  log "gone: eu-central-h1/$name (never existed or already destroyed)"
  exit 1
fi
log "ready: $name (192.0.2.1)"
trap 'log "destroyed eu-central-h1/$name"; echo "term $name" >>"$STUB_CALLS.down"; exit 130' TERM
vm=$STUB_VM_HOME
dest="$vm/work/$(basename "$src")"
rm -rf "$dest" && mkdir -p "$dest"
(cd "$src" && { git ls-files -z -co --exclude-standard; printf '.git\\0'; } | tar --null -T - -cf -) | tar -xf - -C "$dest"
[ -z "\${STUB_VM_EDIT:-}" ] || echo "// edited on the VM" >>"$dest/$STUB_VM_EDIT"
for e in \${envs[@]+"\${envs[@]}"}; do printf 'export %s\\n' "$e"; done >"$vm/.ubirun-env"
log "synced $src -> $name:$dest"
if [ -n "$setup" ]; then
  cp "$setup" "$vm/.ubirun-setup.sh"
  log "running setup $(basename "$setup")"
  if ! (cd "$dest" && HOME="$vm" bash -c '. ~/.ubirun-env && bash ~/.ubirun-setup.sh'); then
    log "setup failed"
    log "destroyed eu-central-h1/$name"
    exit 1
  fi
fi
[ -z "\${STUB_VM_LIST_ADD:-}" ] || echo "$STUB_VM_LIST_ADD" >>"$vm/.pregate-files.txt"
log "running on $name: $cmd"
if [ -n "\${STUB_HANG:-}" ]; then sleep "$STUB_HANG" & wait $!; fi
rc=0
if [ "$fail" = ssh ]; then
  rc=255
else
  (cd "$dest" && HOME="$vm" PATH="$STUB_BIN:$PATH" bash -c ". ~/.ubirun-env && $cmd") || rc=$?
fi
log "command exited $rc after 1s"
log "destroyed eu-central-h1/$name"
echo "exit $name" >>"$STUB_CALLS.down"
exit "$rc"
`;

interface Fixture { repo: string; vm: string; calls: string; bin: string; tree: string }

let counter = 0;
function fixture(): Fixture {
  const base = path.join(SCRATCH, String(++counter));
  const repo = path.join(base, 'gstack');
  const vm = path.join(base, 'vm');
  const bin = path.join(base, 'bin');
  for (const dir of [repo, vm, bin]) fs.mkdirSync(dir, { recursive: true });
  const put = (rel: string, body: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body, { mode });
  };
  for (const rel of COPIED) put(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'), fs.statSync(path.join(ROOT, rel)).mode & 0o777);
  for (const [rel, body] of Object.entries(TESTS)) put(rel, body);
  put('scripts/ubicloud/ubi-runner.sh', UBI_RUNNER_STUB, 0o755);
  put('scripts/ubicloud/setup-free-suite.sh', '#!/usr/bin/env bash\necho "setup-free-suite (stub)"\n[ -z "${STUB_SETUP_FAIL:-}" ] || exit 1\n[ -z "${STUB_SETUP_REBUILD:-}" ] || echo rebuilt >>dist/bundle.txt\n', 0o755);
  put('dist/bundle.txt', 'committed build output\n');
  put('.gitignore', '.context/\n');
  put('package.json', JSON.stringify({ scripts: { 'test:free': 'bun run scripts/test-free-shards.ts' } }) + '\n');
  fs.writeFileSync(path.join(bin, 'xvfb-run'), '#!/bin/sh\n[ "$1" = -a ] && shift\nexec "$@"\n', { mode: 0o755 });
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const tree = Bun.spawnSync(['bin/gstack-wtree'], { cwd: repo, timeout: 30_000 }).stdout.toString().trim();
  return { repo, vm, calls: path.join(base, 'calls.log'), bin, tree };
}

function gate(f: Fixture, files: string[] | null, env: Record<string, string | undefined> = {}) {
  const list = path.join(path.dirname(f.repo), 'files.txt');
  if (files) fs.writeFileSync(list, files.join('\n') + '\n');
  const base: Record<string, string | undefined> = { ...process.env, UBICLOUD_API_KEY: undefined, UBICLOUD_API_TOKEN: undefined, UBI_SIZE: undefined,
    GSTACK_FREE_JOBS: '2', GSTACK_FLAKE_LEDGER: path.join(path.dirname(f.repo), 'flakes.jsonl'), STUB_CALLS: f.calls, STUB_VM_HOME: f.vm, STUB_BIN: f.bin };
  if (files) Object.assign(base, { PREGATE_FILES_FILE: list, PREGATE_TREE: f.tree, PREGATE_SPEND_CAP_USD: '2' });
  const merged = Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const r = Bun.spawnSync(['bash', 'scripts/ubicloud/pregate-remote.sh'], { cwd: f.repo, env: merged, timeout: 90_000 });
  const out = r.stdout.toString() + r.stderr.toString();
  return { exit: r.exitCode, out, report: parseRemoteReport(out), calls: fs.existsSync(f.calls) ? fs.readFileSync(f.calls, 'utf8').trim().split('\n') : [] };
}
const KEY = { UBICLOUD_API_KEY: 'offline-stub' };

describe('pregate-remote.sh inputs and the local tree check', () => {
  test('run bare it exits 2 before any work, naming the pregate command', () => {
    const f = fixture();
    const r = gate(f, null, KEY);
    expect(r.exit).toBe(2);
    expect(r.out).toContain('pregate-remote: PREGATE_REMOTE_USAGE: PREGATE_FILES_FILE is not set; run: gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands');
    expect(r.out).toContain('see docs/pregate.md#remote-gate');
    expect(r.calls).toEqual([]);
    expect(fs.existsSync(path.join(f.repo, '.context'))).toBe(false);
  }, 60_000);

  test('a working tree that is not PREGATE_TREE exits 3 before any upload, with both prefixes and the rerun command', () => {
    const f = fixture();
    const r = gate(f, ['test/alpha.test.ts'], { ...KEY, PREGATE_TREE: 'f'.repeat(40) });
    expect(r.exit).toBe(3);
    expect(r.out).toContain(`PREGATE_REMOTE_TREE_MISMATCH: the working tree is ${f.tree.slice(0, 12)}, not the planned tree ffffffffffff`);
    expect(r.out).toContain('nothing uploaded, nothing spent');
    expect(r.out).toContain('rerun: gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands');
    expect(r.calls).toEqual([]);
    expect(r.report).toBeNull();
  }, 60_000);
});

describe('pregate-remote.sh keyed path (stub ubi-runner)', () => {
  test('a passing run prints the VM tree, the counts and billed spend; pregate clears it', () => {
    const f = fixture();
    const r = gate(f, ['test/alpha.test.ts', 'test/beta.test.ts'], KEY);
    expect(r.exit, r.out).toBe(0);
    expect(r.report).toEqual({ tree: f.tree, tests: 2, failed: 0, spent: '0.01' });
    expect(remoteReportProblem(r.report!, f.tree)).toBeNull();
    expect(r.out).toContain("2 files on one standard-16 VM; worst case $0.38 under the cap $2; the VM is told to stop after 2520s (the cap's 45 min wall minus 3 min for teardown)");
    expect(r.out).toMatch(/phases: create \d+s, setup \d+s, run \d+s, teardown \d+s; total \d+s \(target 600s\)/);
    expect(r.out.trim().split('\n').at(-1)).toMatch(/^PREGATE_REMOTE: /);
    expect(r.calls).toHaveLength(1);
    for (const arg of ['-s standard-16 ', '--env GSTACK_EXPECT_BINARIES=1', '--env GSTACK_FREE_RETRY_FLAKY=1', '--env GSTACK_FREE_JOBS=2', '-- bash ~/.pregate-run.sh']) expect(r.calls[0]).toContain(arg);
    expect(fs.readFileSync(path.join(f.vm, '.pregate-files.txt'), 'utf8')).toBe('test/alpha.test.ts\ntest/beta.test.ts\n');
  }, 90_000);

  test('setup rebuilding committed build output (as CI does) is printed; the reported tree stays the uploaded one', () => {
    const f = fixture();
    const r = gate(f, ['test/alpha.test.ts'], { ...KEY, STUB_SETUP_REBUILD: '1' });
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain('  setup rebuilt (committed build output, as the CI free lane rebuilds it): M\tdist/bundle.txt');
    expect(r.report).toEqual({ tree: f.tree, tests: 1, failed: 0, spent: '0.01' });
  }, 90_000);

  test('a failing test reports failed>0 and exits 1; a file with zero tests reports tests=0; neither clears', () => {
    const failing = gate(fixture(), ['test/alpha.test.ts', 'test/fails.test.ts'], KEY);
    expect(failing.exit, failing.out).toBe(1);
    expect(failing.report).toMatchObject({ tests: 2, failed: 1 });
    expect(remoteReportProblem(failing.report!, failing.report!.tree)).toBe('the remote gate reported 1 failed of 2');
    const empty = gate(fixture(), ['test/empty.test.ts'], KEY);
    expect(empty.report, empty.out).toMatchObject({ tests: 0, failed: 0 });
    expect(remoteReportProblem(empty.report!, empty.report!.tree)).toBe('the remote gate reported 0 tests');
  }, 90_000);

  test('the cap refuses before any VM is created, at the price of the size actually used', () => {
    const f = fixture();
    const low = gate(f, ['test/alpha.test.ts'], { ...KEY, PREGATE_SPEND_CAP_USD: '0.1' });
    expect(low.exit).toBe(5);
    expect(low.out).toContain('PREGATE_REMOTE_CAP_TOO_LOW: worst case $0.17 (20 min x $0.00831/min on standard-16) exceeds the spend cap $0.1');
    expect(low.out).toContain('nothing created, nothing spent');
    expect(low.out).toContain('rerun with --spend-cap 0.17 or more');
    const big = gate(f, ['test/alpha.test.ts'], { ...KEY, PREGATE_SPEND_CAP_USD: '0.5', UBI_SIZE: 'standard-60' });
    expect(big.exit).toBe(5);
    expect(big.out).toContain('worst case $0.63 (20 min x $0.03117/min on standard-60) exceeds the spend cap $0.5');
    const unpriced = gate(f, ['test/alpha.test.ts'], { ...KEY, UBI_SIZE: 'burstable-1' });
    expect(unpriced.exit).toBe(5);
    expect(unpriced.out).toContain('PREGATE_REMOTE_NO_PRICE: no price for UBI_SIZE=burstable-1');
    const noCap = gate(f, ['test/alpha.test.ts'], { ...KEY, PREGATE_SPEND_CAP_USD: '' });
    expect(noCap.exit).toBe(2);
    expect([low, big, unpriced, noCap].every(r => r.report === null)).toBe(true);
    expect(fs.existsSync(f.calls)).toBe(false);
  }, 90_000);

  test('create, setup and SSH failures exit 4 with the ubi-runner message, the VM, its teardown line, the log and spent=', () => {
    const create = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_FAIL: 'create' });
    expect(create.exit, create.out).toBe(4);
    expect(create.out).toContain('PREGATE_REMOTE_INFRA: infrastructure failure (ubi-runner exit 1): ubi-runner: create failed');
    expect(create.out).toMatch(/VM: eu-central-h1\/(ubirun-stub-\d+-[0-9a-f]{8}); ubi-runner: gone: eu-central-h1\/\1 \(never existed or already destroyed\)/);
    expect(create.out).toMatch(/VM (ubirun-stub-\d+-[0-9a-f]{8}); if this run is killed before its teardown line, destroy it with: bash scripts\/ubicloud\/ubi-runner\.sh down \1\n/);
    expect(create.out).toMatch(/log: \S+\/\.context\/pregate-remote\/\S+\/run\.log/);
    expect(create.out).toContain('spent=0.00 (0 billed min on standard-16)');
    const setup = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_SETUP_FAIL: '1' });
    expect(setup.exit, setup.out).toBe(4);
    expect(setup.out).toContain('ubi-runner: setup failed');
    expect(setup.out).toMatch(/; ubi-runner: destroyed eu-central-h1\/ubirun-stub-\d+-[0-9a-f]{8}/);
    expect(setup.out).toContain('spent=0.01 (1 billed min on standard-16)');
    const ssh = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_FAIL: 'ssh' });
    expect(ssh.exit, ssh.out).toBe(4);
    expect(ssh.out).toContain('infrastructure failure (ubi-runner exit 255): ubi-runner: command exited 255 after 1s');
    expect([create, setup, ssh].every(r => r.report === null)).toBe(true);
  }, 90_000);

  test('a quota refusal is retried once, then the run stops', () => {
    const once = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_FAIL: 'quota-once', PREGATE_REMOTE_QUOTA_WAIT_S: '0' });
    expect(once.exit, once.out).toBe(0);
    expect(once.out).toContain('vCPU quota refused the VM; one retry in 0 s');
    expect(once.calls).toHaveLength(2);
    const twice = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_FAIL: 'quota', PREGATE_REMOTE_QUOTA_WAIT_S: '0' });
    expect(twice.exit, twice.out).toBe(4);
    expect(twice.calls).toHaveLength(2);
    expect(twice.out).toContain('create failed: vCPU quota exhausted');
  }, 90_000);

  test('the VM refuses a tree that differs after unpack, a planned set that differs from the list, and a tree that moved during the run', () => {
    const edited = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_VM_EDIT: 'test/alpha.test.ts' });
    expect(edited.exit, edited.out).toBe(3);
    expect(edited.out).toContain('PREGATE_REMOTE_VM_TREE: the VM refused before running tests: PREGATE_VM_TREE_MISMATCH vm=');
    expect(edited.out).toContain('no tests ran; spent=0.01');
    const listed = gate(fixture(), ['test/alpha.test.ts'], { ...KEY, STUB_VM_LIST_ADD: 'test/beta.test.ts' });
    expect(listed.exit, listed.out).toBe(3);
    expect(listed.out).toContain('PREGATE_VM_PLAN_MISMATCH planned=');
    const moved = gate(fixture(), ['test/alpha.test.ts', 'test/mover.test.ts'], KEY);
    expect(moved.exit, moved.out).toBe(3);
    expect(moved.out).toContain("PREGATE_REMOTE_TREE_MOVED: the VM's tree moved during the run");
    expect(moved.out).toContain('  moved: A\tmoved.txt');
    expect([edited, listed, moved].every(r => r.report === null)).toBe(true);
  }, 90_000);

  test('killing the gate\'s process group (pregate\'s timeout) never cuts teardown short; TERM under an outer deadline tears the VM down; an edit to the script mid-run changes nothing', async () => {
    const run = (f: Fixture) => {
      const list = path.join(path.dirname(f.repo), 'files.txt');
      fs.writeFileSync(list, 'test/alpha.test.ts\n');
      return Bun.spawn(['bash', 'scripts/ubicloud/pregate-remote.sh'], { cwd: f.repo, detached: true, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, ...KEY, UBI_SIZE: '', GSTACK_FREE_JOBS: '2', STUB_CALLS: f.calls, STUB_VM_HOME: f.vm, STUB_BIN: f.bin, STUB_HANG: '4',
          PREGATE_FILES_FILE: list, PREGATE_TREE: f.tree, PREGATE_SPEND_CAP_USD: '2', PREGATE_TIMEOUT_S: '900' } as Record<string, string> });
    };
    const until = async (cond: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!cond()) { if (Date.now() > deadline) throw new Error('condition not met in time'); await Bun.sleep(50); }
    };
    const vmLog = (f: Fixture) => { try { return fs.readFileSync(fs.readdirSync(path.join(f.repo, '.context/pregate-remote')).map(d => path.join(f.repo, '.context/pregate-remote', d, 'run.log'))[0]!, 'utf8'); } catch { return ''; } };
    const killed = fixture();
    const a = run(killed);
    await until(() => vmLog(killed).includes('ubi-runner: running on'), 30_000);
    process.kill(-a.pid, 'SIGKILL');
    await a.exited;
    await until(() => fs.existsSync(killed.calls + '.down'), 30_000);
    expect(fs.readFileSync(killed.calls + '.down', 'utf8')).toMatch(/^exit ubirun-stub-\d+-[0-9a-f]{8}\n$/);
    const termed = fixture();
    const b = run(termed);
    await until(() => vmLog(termed).includes('ubi-runner: running on'), 30_000);
    process.kill(b.pid, 'SIGTERM');
    expect(await b.exited).toBe(130);
    expect(await new Response(b.stdout).text()).toContain('interrupted: ubi-runner is tearing the VM down on its own');
    await until(() => fs.existsSync(termed.calls + '.down'), 10_000);
    expect(fs.readFileSync(termed.calls + '.down', 'utf8')).toMatch(/^term ubirun-stub-\d+-[0-9a-f]{8}\n$/);
    const edited = fixture();
    const c = run(edited);
    await until(() => vmLog(edited).includes('ubi-runner: running on'), 30_000);
    const script = path.join(edited.repo, 'scripts/ubicloud/pregate-remote.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\n# an edit that shifts every byte offset\n' + fs.readFileSync(script, 'utf8').split('\n').slice(1).join('\n'));
    expect(await c.exited).toBe(0);
    expect((await new Response(c.stdout).text()).trim().split('\n').at(-1)).toMatch(new RegExp(`^PREGATE_REMOTE: tree=${edited.tree} tests=1 failed=0 spent=`));
  }, 90_000);

  test('an enclosing pregate deadline shorter than the wall sets when the VM is told to stop; one too short refuses before any VM', () => {
    const f = fixture();
    const viaEnv = gate(f, ['test/alpha.test.ts'], { ...KEY, PREGATE_TIMEOUT_S: '900' });
    expect(viaEnv.exit, viaEnv.out).toBe(0);
    expect(viaEnv.out).toMatch(/the VM is told to stop after (76[0-5])s \(PREGATE_TIMEOUT_S 900s minus 120 s teardown reserve and 15 s margin\)/);
    const short = gate(f, ['test/alpha.test.ts'], { ...KEY, PREGATE_TIMEOUT_S: '400' });
    expect(short.exit).toBe(5);
    expect(short.out).toMatch(/PREGATE_REMOTE_TIMEOUT_TOO_SHORT: PREGATE_TIMEOUT_S 400s leaves 26\ds for the VM after 120 s reserved for teardown and 15 s margin \(at least 300 s needed\)/);
    expect(short.out).toContain('nothing created, nothing spent');
    expect(fs.readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
    // Run under a process named gstack-pregate, the deadline is read from its --timeout (600 s when it passes none).
    const shim = path.join(path.dirname(f.repo), 'gstack-pregate');
    fs.writeFileSync(shim, '#!/usr/bin/env bash\nexec bash scripts/ubicloud/pregate-remote.sh\n', { mode: 0o755 });
    const run = (args: string[]) => {
      const r = Bun.spawnSync(['bash', '-c', '"$0" "$@"; exit $?', shim, ...args], { cwd: f.repo, timeout: 90_000, env: { ...process.env, ...KEY, UBI_SIZE: '', GSTACK_FREE_JOBS: '2',
        STUB_CALLS: f.calls, STUB_VM_HOME: f.vm, STUB_BIN: f.bin, PREGATE_FILES_FILE: path.join(path.dirname(f.repo), 'files.txt'), PREGATE_TREE: f.tree, PREGATE_SPEND_CAP_USD: '2' } as Record<string, string> });
      return r.stdout.toString() + r.stderr.toString();
    };
    expect(run(['--stage', 'tests', '--remote', '--timeout', '1200'])).toMatch(/told to stop after 106[0-5]s \(gstack-pregate --timeout 1200s minus/);
    expect(run(['--stage', 'tests', '--remote'])).toMatch(/told to stop after 46[0-5]s \(gstack-pregate --timeout 600s minus/);
  }, 120_000);

  test('the VM environment is bun run test:ubicloud\'s (scripts/ubicloud/test-free.sh), so the two cannot drift', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/ubicloud/pregate-remote.sh'), 'utf8');
    const wrapper = fs.readFileSync(path.join(ROOT, 'scripts/ubicloud/test-free.sh'), 'utf8');
    const flags = [...wrapper.matchAll(/--(?:env|pull) "?[^\s"]+(?: [^\s"]+)?/g)].map(m => m[0]).filter(flag => !flag.includes('GSTACK_FREE_JOBS'));
    expect(flags.length).toBeGreaterThanOrEqual(5);
    for (const flag of flags) expect(script).toContain(flag);
    expect(wrapper).toContain('--setup "$here/setup-free-suite.sh"');
    expect(script).toContain("'bash scripts/ubicloud/setup-free-suite.sh'");
    expect(wrapper).toContain('xvfb-run -a bun run test:free');
    expect(script).toContain("'xvfb-run -a bun run test:free --files-from ~/.pregate-files.txt'");
  });
});

describe('pregate-remote.sh keyless path', () => {
  test('without a key it runs the list locally in parallel shards and reports the tree it tested with spent=0', () => {
    const f = fixture();
    const r = gate(f, ['test/alpha.test.ts', 'test/beta.test.ts']);
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain('no UBICLOUD_API_KEY: running 2 files locally in parallel shards');
    expect(r.out).toMatch(/\nbackend=local \(\d+ cores; not the CI environment\)\nPREGATE_REMOTE: /);
    expect(r.report).toEqual({ tree: f.tree, tests: 2, failed: 0, spent: '0' });
    expect(remoteReportProblem(r.report!, f.tree)).toBeNull();
    expect(fs.existsSync(f.calls)).toBe(false);
  }, 90_000);

  test('a tree that moves during the local run fails without a report', () => {
    const r = gate(fixture(), ['test/alpha.test.ts', 'test/mover.test.ts']);
    expect(r.exit, r.out).toBe(3);
    expect(r.out).toContain('PREGATE_REMOTE_TREE_MOVED: the working tree moved during the run');
    expect(r.out).toContain('  moved: A\tmoved.txt');
    expect(r.report).toBeNull();
  }, 90_000);

  test('paid test files in the selection are named and left to the paid PR gate; a paid-only selection reports tests=0 and cannot clear', () => {
    const f = fixture();
    const paid = ['test/skill-e2e-a.test.ts', 'test/skill-e2e-b.test.ts', 'test/skill-llm-eval.test.ts', 'test/codex-e2e-x.test.ts', 'test/carve-section-loading-y.test.ts', 'test/skill-routing-e2e.test.ts'];
    const mixed = gate(f, ['test/alpha.test.ts', ...paid]);
    expect(mixed.exit, mixed.out).toBe(0);
    expect(mixed.out).toContain('6 paid test file(s) are covered by the paid PR gate, not the free tier: test/skill-e2e-a.test.ts, test/skill-e2e-b.test.ts, test/skill-llm-eval.test.ts, test/codex-e2e-x.test.ts, test/carve-section-loading-y.test.ts ...');
    expect(mixed.out).toContain('no UBICLOUD_API_KEY: running 1 files locally in parallel shards');
    expect(mixed.report).toEqual({ tree: f.tree, tests: 1, failed: 0, spent: '0' });
    const keyed = gate(f, ['test/beta.test.ts', 'test/skill-e2e-a.test.ts'], KEY);
    expect(keyed.exit, keyed.out).toBe(0);
    expect(fs.readFileSync(path.join(f.vm, '.pregate-files.txt'), 'utf8')).toBe('test/beta.test.ts\n');
    const only = gate(f, paid.slice(0, 2));
    expect(only.exit, only.out).toBe(0);
    expect(only.out).toContain('PREGATE_REMOTE_PAID_ONLY: every selected file is a paid test file');
    expect(only.report).toEqual({ tree: f.tree, tests: 0, failed: 0, spent: '0' });
    expect(remoteReportProblem(only.report!, f.tree)).toBe('the remote gate reported 0 tests');
  }, 90_000);

  test('a list test-free-shards rejects exits 1 without a report', () => {
    const r = gate(fixture(), ['test/alpha.test.ts', 'test/missing.test.ts']);
    expect(r.exit, r.out).toBe(1);
    expect(r.out).toContain('1 path(s) not in the free planned set: test/missing.test.ts');
    expect(r.out).toContain('PREGATE_REMOTE_NO_RESULT: test-free-shards exited 1 without a FILES-FROM RESULT line');
    expect(r.report).toBeNull();
  }, 90_000);
});

describe('.gstack/pregate.json declares the remote gate', () => {
  test('remote_gate is this script, and the config still validates', () => {
    const { config, errors } = parseConfig(fs.readFileSync(path.join(ROOT, '.gstack/pregate.json'), 'utf8'));
    expect(errors).toEqual([]);
    expect(config.remote_gate).toBe('bash scripts/ubicloud/pregate-remote.sh');
  });
});
