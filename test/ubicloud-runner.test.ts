/**
 * Static and offline pins for `bun run test:ubicloud` (scripts/ubicloud/).
 * The VM path needs a Ubicloud token and costs money, so it is exercised by
 * hand; these checks keep its environment from drifting away from the
 * required CI free lane it mirrors, and prove it fails before any network
 * call when the token is absent.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIR = join(ROOT, 'scripts/ubicloud');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
const workflow = Bun.YAML.parse(read('.github/workflows/free-tests.yml')) as { jobs: Record<string, { steps: Step[] }> };
const freeSuite = workflow.jobs['free-suite'].steps;

describe('ubicloud free-suite runner', () => {
  test('setup pins the same Bun version as the CI free-suite job', () => {
    const ciBun = freeSuite.find(step => step.uses?.startsWith('oven-sh/setup-bun'))?.with?.['bun-version'];
    expect(ciBun).toBeDefined();
    expect(read('scripts/ubicloud/setup-free-suite.sh')).toContain(`BUN_VERSION=${ciBun}\n`);
  });

  test('setup performs the CI job’s build steps', () => {
    const setup = read('scripts/ubicloud/setup-free-suite.sh');
    for (const command of ['bun install --frozen-lockfile', 'bun run gen:skill-docs --host all', 'bun run vendor:xterm',
      'bash browse/scripts/build-node-server.sh', 'bun run build:gates', 'bun run build:cso']) {
      expect(freeSuite.some(step => step.run?.includes(command))).toBe(true);
      expect(setup).toContain(command);
    }
    expect(setup).toContain('chrome-sandbox');
    expect(setup).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  });

  test('the wrapper runs the suite under Xvfb with the CI lane’s strictness knobs', () => {
    const ciEnv = freeSuite.find(step => step.run?.includes('bun run test:free'))?.env ?? {};
    const wrapper = read('scripts/ubicloud/test-free.sh');
    expect(ciEnv.GSTACK_EXPECT_BINARIES).toBe('1');
    expect(ciEnv.GSTACK_FREE_RETRY_FLAKY).toBe('1');
    expect(wrapper).toContain('--env GSTACK_EXPECT_BINARIES=1');
    expect(wrapper).toContain('--env GSTACK_FREE_RETRY_FLAKY=1');
    expect(wrapper).toContain('--env GSTACK_FLAKE_LEDGER=/tmp/gstack-free-test-flake-ledger.jsonl');
    expect(wrapper).toContain('--pull "/tmp/gstack-free-test-*:$logs"');
    expect(wrapper).toContain('--pull "work/$(basename "$root")/.context/free-test-logs:$logs"');
    expect(wrapper).toContain('xvfb-run -a bun run test:free');
    expect(JSON.parse(read('package.json')).scripts['test:ubicloud']).toBe('bash scripts/ubicloud/test-free.sh');
  });

  test('remote commands force umask 022 and teardown is trapped on exit', () => {
    const runner = read('scripts/ubicloud/ubi-runner.sh');
    expect(runner).toContain('"umask 022; $*"');
    // Armed before the create request and shielded from a second signal (record-before-create teardown, plan E2).
    expect(runner).toMatch(/trap 'trap "" INT TERM HUP QUIT; cmd_down "\$RUN_VM"[^']*' EXIT/);
    expect(runner.indexOf("trap 'trap \"\" INT TERM HUP QUIT; cmd_down \"$RUN_VM\"")).toBeLessThan(runner.indexOf('cmd_up "${up_args[@]}" >/dev/null'));
  });

  test('pull retrieves the retained free-test logs and skips a glob that matches nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ubi-pull-'));
    try {
      const remoteHome = join(root, 'remote'), bin = join(root, 'bin'), state = join(root, 'state'), local = join(root, 'local');
      mkdirSync(join(remoteHome, 'work/gstack/.context/free-test-logs'), { recursive: true });
      mkdirSync(join(remoteHome, 'tmp'), { recursive: true });
      writeFileSync(join(remoteHome, 'work/gstack/.context/free-test-logs/gstack-free-test-shard-11.log'), 'shard 11 log\n');
      mkdirSync(join(state, 'fake-vm'), { recursive: true });
      writeFileSync(join(state, 'fake-vm/env'), 'IP=192.0.2.1\n');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\ncd ${JSON.stringify(remoteHome)} && exec bash -c "\${@: -1}"\n`);
      chmodSync(join(bin, 'ssh'), 0o755);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: state };
      const pull = (from: string) => Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'pull', 'fake-vm', from, local], { env, timeout: 10_000 });
      const empty = pull(join(remoteHome, 'tmp/gstack-free-test-*'));
      expect(empty.exitCode).toBe(0);
      expect(empty.stderr.toString()).toContain('pull: nothing matches');
      const logs = pull('work/gstack/.context/free-test-logs');
      expect(logs.exitCode).toBe(0);
      expect(readFileSync(join(local, 'free-test-logs/gstack-free-test-shard-11.log'), 'utf8')).toBe('shard 11 log\n');
      expect(existsSync(join(local, 'gstack-free-test-*'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to start without UBICLOUD_API_KEY, before any network call', () => {
    const env = { ...process.env, UBICLOUD_API_URL: 'http://127.0.0.1:9' } as Record<string, string | undefined>;
    delete env.UBICLOUD_API_KEY;
    const result = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'list'], { env, timeout: 10_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('UBICLOUD_API_KEY is not set');
    expect(result.stdout.toString()).toBe('');
  });
});

describe('ubi-runner teardown is confirmed and never sweeps other runners by default', () => {
  /**
   * Fake Ubicloud API: `vm list` returns `listed`; `vm <loc>/<name> show` is 200
   * while the name is listed and 404 after a successful destroy; `destroy`
   * returns `destroy`. Every call body is appended to calls.log.
   */
  function fakeApi(mode: { destroy: number; listed: string; owner?: string }) {
    const root = mkdtempSync(join(tmpdir(), 'ubi-down-'));
    const bin = join(root, 'bin'), state = join(root, 'state'), log = join(root, 'calls.log'), record = join(root, 'vms.tsv');
    mkdirSync(bin); mkdirSync(join(state, 'vm-a'), { recursive: true });
    writeFileSync(join(state, 'vm-a/env'), 'NAME=vm-a\nLOCATION=eu-central-h1\nSIZE=standard-16\nIP=192.0.2.1\nCREATED=yes\nCREATE_AT=0\nCREATE_PID=1\n');
    writeFileSync(join(root, 'listed'), mode.listed);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
body=$(cat); echo "$body" >> ${JSON.stringify(log)}
listed=${JSON.stringify(join(root, 'listed'))}
name=$(printf '%s' "$body" | sed -n 's/.*"vm", *"[^/"]*\\/\\([^"]*\\)".*/\\1/p')
case "$body" in
  *destroy*) : > "$out"; if [ ${mode.destroy} = 200 ]; then grep -v " $name$" "$listed" > "$listed.tmp"; mv "$listed.tmp" "$listed"; fi; printf '%s' ${mode.destroy} ;;
  *'"list"'*) cat "$listed" > "$out"; printf 200 ;;
  *'"show"'*) if grep -q " $name$" "$listed"; then printf 'state: running\nsize: standard-16\nip4: 192.0.2.1\n' > "$out"; printf 200; else : > "$out"; printf 404; fi ;;
  *) : > "$out"; printf 200 ;;
esac
`);
    chmodSync(join(bin, 'curl'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: state, UBI_POLL_SECONDS: '1', UBI_VM_RECORD: record, UBI_OWNER: mode.owner ?? 'thrd1' };
    const run = (...args: string[]) => Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), ...args], { env, timeout: 90_000 });
    return { root, run, record, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
  }

  test('down fails when the destroy request fails', () => {
    const f = fakeApi({ destroy: 500, listed: 'eu-central-h1 vm-a\n' });
    try {
      const r = f.run('down', 'vm-a');
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain('FAILED to destroy eu-central-h1/vm-a');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('down succeeds only once the VM is no longer listed, and forgets its scratch record', () => {
    const f = fakeApi({ destroy: 200, listed: 'eu-central-h1 vm-a\neu-central-h1 other-vm\n' });
    try {
      writeFileSync(f.record, 'vm-a\teu-central-h1\tthrd1\t2026-10-10T00:00:00Z\t1\nubirun-other-1000000000-aa\teu-central-h1\tother\t2026-10-10T00:00:00Z\t2\n');
      const r = f.run('down', 'vm-a');
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).toContain('destroyed eu-central-h1/vm-a');
      expect(readFileSync(f.record, 'utf8')).toBe('ubirun-other-1000000000-aa\teu-central-h1\tother\t2026-10-10T00:00:00Z\t2\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('gc with no hours and no UBI_GC_HOURS lists and destroys nothing', () => {
    const f = fakeApi({ destroy: 200, listed: 'eu-central-h1 ubirun-1000000000-deadbeef\n' });
    try {
      expect(f.run('gc').exitCode).toBe(0);
      expect(f.calls()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('gc destroys only this owner’s stale VMs: another owner’s and untagged legacy names are never touched', () => {
    const listed = 'eu-central-h1 ubirun-thrd1-1000000000-aaaa\neu-central-h1 ubirun-other-1000000000-bbbb\neu-central-h1 ubirun-1000000000-cccc\neu-central-h1 ubirun-thrd1-9999999999-dddd\n';
    const f = fakeApi({ destroy: 200, listed });
    try {
      const r = f.run('gc', '1');
      expect(r.exitCode).toBe(0);
      const destroyed = f.calls().split('\n').filter(l => l.includes('destroy'));
      expect(destroyed).toHaveLength(1);
      expect(destroyed[0]).toContain('ubirun-thrd1-1000000000-aaaa');
      expect(f.calls()).not.toMatch(/destroy.*ubirun-other/);
      expect(f.calls()).not.toMatch(/destroy.*ubirun-1000000000-cccc/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('list --mine shows this owner’s VMs only; owner tags are lowercase letters and digits, 12 max, starting with a letter', () => {
    const f = fakeApi({ destroy: 200, listed: 'eu-central-h1 ubirun-thrd1-1000000000-aaaa\neu-north-h1 ubirun-other-1000000000-bbbb\neu-central-h1 ubirun-1000000000-cccc\n' });
    try {
      const mine = f.run('list', '--mine');
      expect(mine.exitCode).toBe(0);
      expect(mine.stdout.toString()).toBe('eu-central-h1  ubirun-thrd1-1000000000-aaaa\n');
      const owner = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'owner'], { env: { ...process.env, UBI_OWNER: '12-Capy_Thread-ABCDEFGH', UBI_RUNNER_STATE: f.root }, timeout: 10_000 });
      expect(owner.stdout.toString().trim()).toBe('u12capythrea');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('up records the VM in the scratch file before the create request is sent', () => {
    const runner = read('scripts/ubicloud/ubi-runner.sh');
    const create = runner.indexOf('cli "${args[@]}" >/dev/null 2>"$dir/create.err"');
    expect(create).toBeGreaterThan(0);
    expect(runner.indexOf('record_vm "$name" "$location"')).toBeLessThan(create);
    expect(runner).toContain('$HOME/.capy/work/ubi-runner/vms.tsv');
  });
});
