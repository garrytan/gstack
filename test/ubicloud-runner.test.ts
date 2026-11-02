/**
 * Static and offline pins for `bun run test:ubicloud` (scripts/ubicloud/).
 * The VM path needs a Ubicloud token and costs money, so it is exercised by
 * hand; these checks keep its environment from drifting away from the
 * required CI free lane it mirrors, and prove it fails before any network
 * call when the token is absent.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(runner).toContain(`trap 'run_teardown "$?"' EXIT`);
    expect(runner.indexOf(`trap 'run_teardown "$?"' EXIT`)).toBeLessThan(runner.indexOf('cmd_up "${up_args[@]}" >/dev/null'));
    const teardown = runner.slice(runner.indexOf('run_teardown() {'), runner.indexOf('\n}\n', runner.indexOf('run_teardown() {')));
    expect(teardown.indexOf('trap "" INT TERM HUP QUIT')).toBeLessThan(teardown.indexOf('cmd_down "$RUN_VM"'));
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

  test('up and run accept only the storage sizes Ubicloud offers, before any API call; UBI_ALLOWED_STORAGE widens the list', () => {
    const root = mkdtempSync(join(tmpdir(), 'ubi-storage-'));
    try {
      const bin = join(root, 'bin'), log = join(root, 'curl.log');
      mkdirSync(bin);
      writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho "curl $*" >> ${JSON.stringify(log)}\necho 000\n`);
      chmodSync(join(bin, 'curl'), 0o755);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(root, 'state'), UBI_VM_RECORD: join(root, 'vms.tsv'), UBI_OWNER: 't' };
      const ubi = (args: string[], extra: Record<string, string> = {}) => Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), ...args], { env: { ...env, ...extra }, timeout: 10_000 });
      for (const args of [['up', '-S', '100'], ['run', '--storage', '1000', '--', 'true'], ['up', '-S', '']]) {
        const r = ubi(args);
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain('(allowed: 320 640; set UBI_ALLOWED_STORAGE when Ubicloud adds sizes)');
      }
      expect(existsSync(log)).toBe(false);
      for (const [size, extra] of [['320', {}], ['1280', { UBI_ALLOWED_STORAGE: '320 640 1280' }]] as const) {
        const accepted = ubi(['run', '-S', size, '--bogus'], extra);
        expect(accepted.stderr.toString()).toContain('run: unknown option --bogus');
      }
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test('up reaps this owner\'s expired TTL VMs first and leaves another owner\'s, names its own VM with -t<hours>, and the quota preflight refuses before any create request', () => {
    const listed = 'eu-central-h1 ubirun-thrd1-1000000000-hhhh-t1\neu-central-h1 ubirun-peer-9999999999-cccc\n';
    const f = fakeApi({ destroy: 200, listed });
    try {
      const r = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'up'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: 'thrd1', UBI_QUOTA_VCPUS: '31' }, timeout: 90_000 });
      expect(r.exitCode).toBe(1);
      const err = r.stderr.toString();
      expect(err).toMatch(/reaping expired eu-central-h1\/ubirun-thrd1-1000000000-hhhh-t1 \(owner thrd1; its TTL ended \d+ min ago\)/);
      expect(err).toMatch(/quota preflight refused eu-central-h1\/ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 \(standard-16\): it needs 16 vCPUs and the project's VMs already use 16 of 31/);
      expect(err).toContain('create refused before any request: vCPU quota exhausted');
      const destroyed = f.calls().split('\n').filter(l => l.includes('destroy'));
      expect(destroyed).toHaveLength(1);
      expect(destroyed[0]).toContain('ubirun-thrd1-1000000000-hhhh-t1');
      expect(f.calls()).not.toContain('"create"');
      expect(existsSync(f.record)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('UBI_REAP=0 skips the reap and UBI_TTL_HOURS sets the name\'s TTL; reap destroys this owner\'s expired TTLs and old TTL-less names, never unexpired, recent, another owner\'s expired or TTL-less, untagged or foreign ones', () => {
    const now = Math.floor(Date.now() / 1000);
    const listed = `eu-central-h1 ubirun-other-1000000000-bbbb-t1\neu-central-h1 ubirun-thrd1-9999999999-dddd-t1\neu-central-h1 ubirun-thrd1-1000000000-aaaa\neu-central-h1 ubirun-1000000000-cccc\neu-central-h1 ubirun-thrd1-${now - 3 * 3600}-eeee\neu-central-h1 ubirun-gbra240-1000000000-gggg\neu-central-h1 team-db-1000000000-ffff\n`;
    const f = fakeApi({ destroy: 200, listed });
    try {
      const up = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'up'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: 'thrd1', UBI_QUOTA_VCPUS: '112', UBI_REAP: '0', UBI_TTL_HOURS: '7' }, timeout: 90_000 });
      expect(up.exitCode).toBe(1);
      expect(up.stderr.toString()).toMatch(/quota preflight refused eu-central-h1\/ubirun-thrd1-\d{10}-[0-9a-f]{8}-t7 \(standard-16\): it needs 16 vCPUs and the project's VMs already use 112 of 112/);
      expect(f.calls()).not.toContain('destroy');
      const reap = f.run('reap');
      expect(reap.exitCode).toBe(0);
      expect(reap.stderr.toString()).toMatch(/reaping TTL-less eu-central-h1\/ubirun-thrd1-1000000000-aaaa \(owner thrd1; \d+h old, legacy sweep at 4h\)/);
      const destroyed = f.calls().split('\n').filter(l => l.includes('destroy')).map(l => l.match(/ubirun-[a-z0-9-]+|team-db-[a-z0-9-]+/)?.[0]).sort();
      expect(destroyed).toEqual(['ubirun-thrd1-1000000000-aaaa']);
      expect(reap.stderr.toString()).toContain('reap: left 1 expired VMs of other owners; only their owners reap them');
      expect(f.run('reap').stderr.toString()).toContain('reap: no expired VMs');
      // Value: protects=UBI_LEGACY_HOURS sets reap's bound for TTL-less ubirun names (a 3h-old name is spared at 4h, reaped at 2h); fails_when=reap ignores UBI_LEGACY_HOURS and keeps a fixed bound; why_new=only the default bound and the validation are tested; seam=none; no_claim=real Ubicloud list and destroy (fake curl)
      const lowered = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'reap'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: 'thrd1', UBI_LEGACY_HOURS: '2' }, timeout: 90_000 });
      expect(lowered.exitCode).toBe(0);
      expect(lowered.stderr.toString()).toMatch(/reaping TTL-less eu-central-h1\/ubirun-thrd1-\d{10}-eeee \(owner thrd1; 3h old, legacy sweep at 2h\)/);
      expect(f.calls()).toMatch(/ubirun-thrd1-\d{10}-eeee[^\n]*destroy/);
      // Value: protects=the legacy sweep never destroys another lane's or an untagged TTL-less VM (GST-324: 22 gbra240 eval VMs lost); fails_when=the sweep matches any owner again; why_new=the cross-owner sweep destroyed a paid eval; seam=none; no_claim=real Ubicloud list and destroy (fake curl)
      expect(f.calls()).not.toMatch(/(team-db|dddd|gggg|cccc|bbbb)[^\n]*destroy/);
      const ownerless = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'reap'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: '', UBI_LEGACY_HOURS: '1' }, timeout: 90_000 });
      expect(ownerless.exitCode).toBe(0);
      expect(ownerless.stderr.toString()).not.toContain('reaping TTL-less');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  // Value: protects=reap and every up destroy only the caller's own VMs, never another owner's, even one whose TTL ran out (the 2026-10-30 owner-scoped-deletes rule; GST-324 lost 22 of gbrain's eval VMs to a cross-owner sweep); fails_when=reap judges another owner's VM by its TTL again; why_new=the old cases asserted the cross-owner TTL reap this rule forbids; seam=none; no_claim=real Ubicloud list and destroy (fake curl)
  test('reap and up destroy only the caller\'s own expired VMs: another owner\'s and an untagged expired VM survive (GST-573)', () => {
    const listed = 'eu-central-h1 ubirun-other-1000000000-bbbb-t1\neu-central-h1 ubirun-1000000000-cccc-t1\neu-central-h1 ubirun-thrd1-1000000000-hhhh-t1\n';
    const f = fakeApi({ destroy: 200, listed });
    try {
      const reap = f.run('reap');
      expect(reap.exitCode).toBe(0);
      expect(reap.stderr.toString()).toMatch(/reaping expired eu-central-h1\/ubirun-thrd1-1000000000-hhhh-t1 \(owner thrd1; its TTL ended \d+ min ago\)/);
      expect(reap.stderr.toString()).toContain('reap: left 2 expired VMs of other owners; only their owners reap them');
      const destroyed = f.calls().split('\n').filter(l => l.includes('destroy'));
      expect(destroyed).toHaveLength(1);
      expect(destroyed[0]).toContain('ubirun-thrd1-1000000000-hhhh-t1');
      const up = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'up'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: 'thrd1', UBI_QUOTA_VCPUS: '1' }, timeout: 90_000 });
      expect(up.stderr.toString()).toContain('create refused before any request');
      expect(up.stderr.toString()).toContain('reap: left 2 expired VMs of other owners; only their owners reap them');
      expect(up.stderr.toString()).not.toMatch(/reaping[^\n]*(ubirun-other|ubirun-1000000000-cccc)/);
      expect(f.calls().split('\n').filter(l => l.includes('destroy'))).toHaveLength(1);
      for (const name of ['ubirun-other-1000000000-bbbb-t1', 'ubirun-1000000000-cccc-t1']) expect(readFileSync(join(f.root, 'listed'), 'utf8')).toContain(name);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  // Value: protects=a project with no VMs (Ubicloud answers vm list with a bare newline) reads as empty everywhere vm_rows feeds; fails_when=a blank list row becomes a VM named "-" again and reap dies on it or usage asks to show it; why_new=every fake list in this file had at least one VM, so #3678 shipped green; seam=none; no_claim=the real API's empty-body shape (taken from #3678's reading of ubi_cli.rb)
  test('an empty project (vm list answers a bare or blank line) has no VMs: reap destroys nothing and exits 0, usage prints total 0 0, list --mine prints nothing (#3678)', () => {
    for (const listed of ['\n', '  \n']) {
      const f = fakeApi({ destroy: 200, listed });
      try {
        const reap = f.run('reap');
        expect(reap.stderr.toString()).toContain('reap: no expired VMs');
        expect(reap.stderr.toString()).not.toContain('invalid VM name');
        expect(reap.exitCode).toBe(0);
        const usage = f.run('usage');
        expect(usage.exitCode).toBe(0);
        expect(usage.stdout.toString()).toBe('OWNER           VMS  VCPUS\ntotal             0      0\n');
        expect(f.run('list', '--mine').stdout.toString()).toBe('');
        expect(f.calls()).not.toContain('destroy');
        expect(f.calls()).not.toContain('"show"');
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  test('up and run refuse without UBI_OWNER before any API call; list, usage, reap and down still work without it', () => {
    const f = fakeApi({ destroy: 200, listed: 'eu-central-h1 vm-a\n', owner: '' });
    try {
      for (const args of [['up'], ['run', '--', 'true']]) {
        const r = f.run(...args);
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain('UBI_OWNER is not set: every VM must carry its owner; export UBI_OWNER=<your thread or session code>');
        expect(r.stderr.toString()).toContain('(UBI_OWNER_REQUIRED)');
      }
      expect(f.calls()).toBe('');
      for (const args of [['list'], ['usage'], ['reap']]) expect(f.run(...args).exitCode).toBe(0);
      expect(f.run('down', 'vm-a').exitCode).toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('the watchdog kills a silent remote command with exit 124 and the last output, and the heartbeat reports progress', () => {
    const f = fakeApi({ destroy: 200, listed: 'eu-central-h1 vm-a\n' });
    try {
      const ssh = join(f.root, 'bin/ssh');
      writeFileSync(ssh, '#!/usr/bin/env bash\ncase "${*: -1}" in *pkill*) echo "$*" >> ' + JSON.stringify(join(f.root, 'cancel.log')) + '; exit 0 ;; esac\necho "line one"; echo "warn one" >&2; sleep 15\n');
      chmodSync(ssh, 0o755);
      const env = { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_OWNER: 'thrd1' };
      const hung = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'ssh', 'vm-a', 'sleep 15'], { env: { ...env, UBI_IDLE_TIMEOUT: '2' }, timeout: 60_000 });
      expect(hung.exitCode).toBe(124);
      expect(hung.stdout.toString()).toBe('line one\n');
      const err = hung.stderr.toString();
      expect(err).toContain('warn one');
      expect(err).toMatch(/watchdog: ssh printed nothing for \d+s \(UBI_IDLE_TIMEOUT=2\); killing it. Last output:/);
      expect(err.indexOf('line one')).toBeGreaterThan(err.indexOf('Last output:'));
      expect(readFileSync(join(f.root, 'state/vm-a/ssh.log'), 'utf8')).toContain('line one');
      expect(readFileSync(join(f.root, 'cancel.log'), 'utf8')).toMatch(/sid=\$\(cat ~\/\.ubirun-ssh-\d+\.sid .*pkill -TERM -s/);
      writeFileSync(ssh, '#!/usr/bin/env bash\nfor i in 1 2 3 4 5 6; do echo "tick $i"; sleep 0.5; done\n');
      const beating = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'ssh', 'vm-a', 'true'], { env: { ...env, UBI_IDLE_TIMEOUT: '0', UBI_HEARTBEAT: '1' }, timeout: 60_000 });
      expect(beating.exitCode).toBe(0);
      expect(beating.stdout.toString()).toContain('tick 6');
      expect(beating.stderr.toString()).toMatch(/heartbeat: ssh \d+s elapsed, last output \d+s ago/);
      expect(f.calls()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test('verify runs only a committed .gstack/ubicloud.json and resolves its setup script against --src, before any API call', () => {
    const f = fakeApi({ destroy: 200, listed: '' });
    try {
      const src = join(f.root, 'repo');
      mkdirSync(join(src, '.gstack'), { recursive: true });
      const missing = f.run('verify', '--src', src);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain(`verify: no ${src}/.gstack/ubicloud.json; commit one`);
      writeFileSync(join(src, '.gstack/ubicloud.json'), JSON.stringify({ setup: 'scripts/boot.sh' }));
      const noCommand = f.run('verify', '--src', src);
      expect(noCommand.exitCode).toBe(1);
      expect(noCommand.stderr.toString()).toContain('names no command and none was given after --');
      writeFileSync(join(src, '.gstack/ubicloud.json'), JSON.stringify({ setup: 'scripts/boot.sh', command: 'make verify', size: 'standard-8' }));
      const noSetup = f.run('verify', '--src', src);
      expect(noSetup.exitCode).toBe(1);
      expect(noSetup.stderr.toString()).toContain(`setup script not found: ${src}/scripts/boot.sh`);
      writeFileSync(join(src, '.gstack/ubicloud.json'), '{');
      expect(f.run('verify', '--src', src).stderr.toString()).toContain('is not valid JSON');
      expect(f.calls()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('bin/gstack-ubi is a thin entry point: it execs the runner beside it and forwards every argument', () => {
    const wrapper = read('bin/gstack-ubi');
    expect(wrapper).toContain('exec bash "$here/../scripts/ubicloud/ubi-runner.sh" "$@"');
    const help = Bun.spawnSync(['bash', join(ROOT, 'bin/gstack-ubi'), 'help'], { env: { ...process.env, UBI_RUNNER_STATE: mkdtempSync(join(tmpdir(), 'ubi-help-')) }, timeout: 10_000 });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('usage: ubi-runner.sh <command> [args]');
    const owner = Bun.spawnSync(['bash', join(ROOT, 'bin/gstack-ubi'), 'owner'], { env: { ...process.env, UBI_OWNER: 'lane7', UBI_RUNNER_STATE: mkdtempSync(join(tmpdir(), 'ubi-owner-')) }, timeout: 10_000 });
    expect(owner.stdout.toString().trim()).toBe('lane7');
  });

test('pack ships a linked worktree with a self-contained .git on the checked-out branch, carrying its index', () => {
    const d = mkdtempSync(join(tmpdir(), 'ubi-pack-'));
    try {
      const sh = (cmd: string, cwd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); expect(r.exitCode).toBe(0); return r.stdout.toString(); };
      sh('git init -q main && cd main && echo a > a && git add a && git commit -qm one && git branch feat && git worktree add -q ../wt feat', d);
      sh('echo b > b && git add b && git commit -qm two && echo u > u && echo ignored > ig && echo ig > .gitignore', join(d, 'wt'));
      expect(readFileSync(join(d, 'wt/.git'), 'utf8')).toStartWith('gitdir:');
      sh(`bash ${JSON.stringify(join(DIR, 'ubi-runner.sh'))} pack . > ../pack.tgz && mkdir ../vm && tar -xzf ../pack.tgz -C ../vm`, join(d, 'wt'));
      expect(existsSync(join(d, 'vm/.git/HEAD'))).toBe(true);
      expect(lstatSync(join(d, 'vm/.git')).isDirectory()).toBe(true);
      expect(existsSync(join(d, 'vm/ig'))).toBe(false);
      expect(sh('git rev-parse --abbrev-ref HEAD && git status --short && git log --oneline | wc -l', join(d, 'vm')).replace(/\s+/g, ' ').trim()).toBe('feat ?? .gitignore ?? u 2');
      const wtree = (cwd: string) => sh(`bash ${JSON.stringify(join(ROOT, 'bin/gstack-wtree'))}`, cwd).trim();
      expect(wtree(join(d, 'vm'))).toBe(wtree(join(d, 'wt')));
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);

  test('pack snapshots a plain checkout without reading its live .git: remotes resolve, a detached HEAD gets a branch, and git running beside it cannot fail the tar', () => {
    const d = mkdtempSync(join(tmpdir(), 'ubi-pack-live-'));
    try {
      const sh = (cmd: string, cwd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, timeout: 60_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); expect(r.exitCode, r.stderr.toString()).toBe(0); return r.stdout.toString(); };
      sh('git init -q --bare origin.git && git clone -q origin.git src 2>/dev/null && cd src && echo a > a && git add a && git commit -qm one && git push -q origin HEAD:main && echo b > b && git add b && git commit -qm two && git push -q origin HEAD:main && git checkout -q --detach && echo c > c && echo s > staged && git add staged && echo i > inta && git add -N inta', d);
      const src = join(d, 'src');
      const pack = `bash ${JSON.stringify(join(DIR, 'ubi-runner.sh'))} pack .`;
      // Twenty seconds of index.lock, worktree and ref churn in the checkout while pack runs three times.
      const churn = Bun.spawn(['bash', '-c', 'end=$((SECONDS+20)); while [ $SECONDS -lt $end ]; do git update-index -q --refresh; git worktree add -q ../wt HEAD >/dev/null 2>&1; git worktree remove --force ../wt >/dev/null 2>&1; git update-ref refs/heads/churn HEAD; git update-ref -d refs/heads/churn; done'], { cwd: src, stdout: 'ignore', stderr: 'ignore' });
      try {
        for (const i of [1, 2, 3]) sh(`${pack} > ../pack-${i}.tgz`, src);
      } finally { churn.kill(); }
      sh('mkdir vm && tar -xzf pack-3.tgz -C vm', d);
      const vm = join(d, 'vm');
      expect(lstatSync(join(vm, '.git')).isDirectory()).toBe(true);
      const head = sh('git rev-parse HEAD', src).trim();
      expect(sh('git rev-parse HEAD && git rev-parse --abbrev-ref HEAD && git rev-parse origin/main && git config --get remote.origin.url && git status --short', vm).split('\n').filter(Boolean))
        .toEqual([head, `detached-${head.slice(0, 12)}`, head, join(d, 'origin.git'), ' A inta', 'A  staged', '?? c']);
      // The staged blob and the intent-to-add entry's empty blob are behind no ref; the snapshot carries them, so the VM can read and write-tree them.
      expect(sh('git fsck --no-progress 2>&1; git diff --cached --name-only', vm).trim()).toBe('staged');
      const wtree = (cwd: string) => sh(`bash ${JSON.stringify(join(ROOT, 'bin/gstack-wtree'))}`, cwd).trim();
      expect(wtree(vm)).toBe(wtree(src));
      // The snapshot carries no hook path or other local config from the source checkout.
      expect(sh('git config --local --list', vm)).not.toContain('hooksPath');
      // A failed pack leaves no object copy behind in TMPDIR, and a branch's upstream rides along with its remote.
      sh('mkdir ../tmpd && git checkout -q -b topic && git branch -q --set-upstream-to=origin/main topic', src);
      const broken = Bun.spawnSync(['bash', '-c', `rm -f .git/index && TMPDIR=../tmpd ${pack} > ../pack-broken.tgz; echo rc=$?; ls ../tmpd`], { cwd: src, timeout: 60_000 });
      expect(broken.stderr.toString()).toContain('.git/index');
      expect(broken.stdout.toString().trim()).toBe('rc=1');
      // A gitlink in the index (a submodule commit this object store lacks) is not packed, and a valueless
      // remote key (`[remote "origin"] mirror`) replays as true.
      sh('git reset -q && git update-index --add --cacheinfo 160000,1111111111111111111111111111111111111111,sub && printf \'[remote "origin"]\\n\\tmirror\\n\' >> .git/config', src);
      sh('mkdir vm2 && ' + pack.replace('pack .', 'pack src') + ' | tar -xzf - -C vm2', d);
      expect(sh('git rev-parse --abbrev-ref @{u} && git config --bool --get remote.origin.mirror && git ls-files -s sub | cut -c1-6', join(d, 'vm2')).split('\n').filter(Boolean)).toEqual(['origin/main', 'true', '160000']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 90_000);

  // Value: protects=pack never lets macOS tar add AppleDouble ._* entries (files with extended attributes), which the VM's tree check would count as untracked files and fail the run with UBI_VM_TREE_MISMATCH; fails_when=a tar call in pack runs without COPYFILE_DISABLE=1; why_new=only Apple's tar reads the variable, so no Linux run can see the ._* entries themselves; seam=PATH (a tar shim records its environment, then runs the real tar); no_claim=Apple tar's metadata behavior itself (checked by hand on a Mac)
  test('pack runs every tar with COPYFILE_DISABLE=1, for a checkout and for a plain directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'ubi-pack-copyfile-'));
    try {
      const realTar = Bun.which('tar');
      expect(realTar).toBeTruthy();
      mkdirSync(join(d, 'bin'));
      writeFileSync(join(d, 'bin/tar'), `#!/usr/bin/env bash\necho "COPYFILE_DISABLE=${'$'}{COPYFILE_DISABLE:-unset}" >> ${JSON.stringify(join(d, 'tar.log'))}\nexec ${JSON.stringify(realTar)} "$@"\n`);
      chmodSync(join(d, 'bin/tar'), 0o755);
      const env = { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const sh = (cmd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd: d, env, timeout: 30_000 }); expect(r.exitCode, r.stderr.toString()).toBe(0); };
      sh(`git init -q repo && cd repo && echo a > a && git add a && git commit -qm one && bash ${JSON.stringify(join(DIR, 'ubi-runner.sh'))} pack . > ../repo.tgz`);
      sh(`mkdir plain && echo p > plain/p && bash ${JSON.stringify(join(DIR, 'ubi-runner.sh'))} pack plain > plain.tgz`);
      const lines = readFileSync(join(d, 'tar.log'), 'utf8').trim().split('\n');
      expect(lines.length).toBe(3);
      expect(lines.every(l => l === 'COPYFILE_DISABLE=1')).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('up records the VM in the scratch file before the create request is sent', () => {
    const runner = read('scripts/ubicloud/ubi-runner.sh');
    const create = runner.indexOf('cli "${args[@]}" >/dev/null 2>"$dir/create.err"');
    expect(create).toBeGreaterThan(0);
    expect(runner.indexOf('record_vm "$name" "$location"')).toBeLessThan(create);
    expect(runner).toContain('$HOME/.capy/work/ubi-runner/vms.tsv');
  });
});
