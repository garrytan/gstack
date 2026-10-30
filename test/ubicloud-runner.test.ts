/**
 * Static and offline pins for `bun run test:ubicloud` (scripts/ubicloud/).
 * The VM path needs a Ubicloud token and costs money, so it is exercised by
 * hand; these checks keep its environment from drifting away from the
 * required CI free lane it mirrors, and prove it fails before any network
 * call when the token is absent.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

  test('up reaps expired TTL VMs of any owner first, names its own VM with -t<hours>, and the quota preflight refuses before any create request', () => {
    const listed = 'eu-central-h1 ubirun-other-1000000000-bbbb-t1\neu-central-h1 ubirun-peer-9999999999-cccc\n';
    const f = fakeApi({ destroy: 200, listed });
    try {
      const r = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'up'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: 'thrd1', UBI_QUOTA_VCPUS: '31' }, timeout: 90_000 });
      expect(r.exitCode).toBe(1);
      const err = r.stderr.toString();
      expect(err).toMatch(/reaping expired eu-central-h1\/ubirun-other-1000000000-bbbb-t1 \(owner other; its TTL ended \d+ min ago\)/);
      expect(err).toMatch(/quota preflight refused eu-central-h1\/ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 \(standard-16\): it needs 16 vCPUs and the project's VMs already use 16 of 31/);
      expect(err).toContain('create refused before any request: vCPU quota exhausted');
      const destroyed = f.calls().split('\n').filter(l => l.includes('destroy'));
      expect(destroyed).toHaveLength(1);
      expect(destroyed[0]).toContain('ubirun-other-1000000000-bbbb-t1');
      expect(f.calls()).not.toContain('"create"');
      expect(existsSync(f.record)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('UBI_REAP=0 skips the reap and UBI_TTL_HOURS sets the name\'s TTL; reap destroys expired TTLs and this owner\'s old TTL-less names, never unexpired, recent, another owner\'s TTL-less, untagged or foreign ones', () => {
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
      expect(destroyed).toEqual(['ubirun-other-1000000000-bbbb-t1', 'ubirun-thrd1-1000000000-aaaa']);
      expect(f.run('reap').stderr.toString()).toContain('reap: no expired VMs');
      // Value: protects=UBI_LEGACY_HOURS sets reap's bound for TTL-less ubirun names (a 3h-old name is spared at 4h, reaped at 2h); fails_when=reap ignores UBI_LEGACY_HOURS and keeps a fixed bound; why_new=only the default bound and the validation are tested; seam=none; no_claim=real Ubicloud list and destroy (fake curl)
      const lowered = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'reap'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: 'thrd1', UBI_LEGACY_HOURS: '2' }, timeout: 90_000 });
      expect(lowered.exitCode).toBe(0);
      expect(lowered.stderr.toString()).toMatch(/reaping TTL-less eu-central-h1\/ubirun-thrd1-\d{10}-eeee \(owner thrd1; 3h old, legacy sweep at 2h\)/);
      expect(f.calls()).toMatch(/ubirun-thrd1-\d{10}-eeee[^\n]*destroy/);
      // Value: protects=the legacy sweep never destroys another lane's or an untagged TTL-less VM (GST-324: 22 gbra240 eval VMs lost); fails_when=the sweep matches any owner again; why_new=the cross-owner sweep destroyed a paid eval; seam=none; no_claim=real Ubicloud list and destroy (fake curl)
      expect(f.calls()).not.toMatch(/(team-db|dddd|gggg|cccc)[^\n]*destroy/);
      const ownerless = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'reap'], { env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(f.root, 'state'), UBI_POLL_SECONDS: '1', UBI_VM_RECORD: f.record, UBI_OWNER: '', UBI_LEGACY_HOURS: '1' }, timeout: 90_000 });
      expect(ownerless.exitCode).toBe(0);
      expect(ownerless.stderr.toString()).not.toContain('reaping TTL-less');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

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

  test('up records the VM in the scratch file before the create request is sent', () => {
    const runner = read('scripts/ubicloud/ubi-runner.sh');
    const create = runner.indexOf('cli "${args[@]}" >/dev/null 2>"$dir/create.err"');
    expect(create).toBeGreaterThan(0);
    expect(runner.indexOf('record_vm "$name" "$location"')).toBeLessThan(create);
    expect(runner).toContain('$HOME/.capy/work/ubi-runner/vms.tsv');
  });
});

describe('ubi-runner run, verify and quota against a fake API and a fake ssh', () => {
  /**
   * Fake Ubicloud API that can create: create adds the name to the listed file
   * (or answers the quota refusal in refuse with HTTP 400), show is running at
   * 192.0.2.1 while listed, destroy unlists. The fake ssh records every remote
   * command in ssh.log and plays the role the command asks for: it stores
   * ~/.ubirun-env and ~/.ubirun-setup.sh under the fixture root, drains tar
   * uploads, runs the setup phase per setup-mode (ok or hang) and echoes the
   * command phase. No network, no VM.
   */
  function fakeVm(opts: { listed?: string; refuse?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ubi-run-'));
    const bin = join(root, 'bin'), state = join(root, 'state'), log = join(root, 'calls.log'), sshLog = join(root, 'ssh.log'), record = join(root, 'vms.tsv');
    mkdirSync(bin); mkdirSync(state, { recursive: true });
    writeFileSync(join(root, 'listed'), opts.listed ?? '');
    writeFileSync(join(root, 'setup-mode'), 'ok');
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\n' +
      'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n' +
      'body=$(cat); echo "$body" >> ' + JSON.stringify(log) + '\n' +
      'listed=' + JSON.stringify(join(root, 'listed')) + '\n' +
      'loc=$(printf \'%s\' "$body" | sed -n \'s/.*"vm", *"\\([^/"]*\\)\\/[^"]*".*/\\1/p\')\n' +
      'name=$(printf \'%s\' "$body" | sed -n \'s/.*"vm", *"[^/"]*\\/\\([^"]*\\)".*/\\1/p\')\n' +
      'case "$body" in\n' +
      '  *\'"create"\'*) if [ -n ' + JSON.stringify(opts.refuse ?? '') + ' ]; then printf \'%s\' ' + JSON.stringify(opts.refuse ?? '') + ' > "$out"; printf 400; else echo "$loc $name" >> "$listed"; : > "$out"; printf 200; fi ;;\n' +
      '  *destroy*) : > "$out"; if [ -f "$listed.destroy-fails" ]; then printf 500; else grep -v " $name$" "$listed" > "$listed.tmp"; mv "$listed.tmp" "$listed"; printf 200; fi ;;\n' +
      '  *\'"list"\'*) if [ -f "$listed.list-fails" ]; then echo down > "$out"; printf 503; else cat "$listed" > "$out"; printf 200; fi ;;\n' +
      '  *\'"show"\'*) [ -z "${FAKE_SHOW_DELAY:-}" ] || sleep "$FAKE_SHOW_DELAY"; if grep -q " $name$" "$listed"; then printf \'state: running\\nsize: standard-16\\nip4: 192.0.2.1\\n\' > "$out"; printf 200; else : > "$out"; printf 404; fi ;;\n' +
      '  *) : > "$out"; printf 200 ;;\n' +
      'esac\n');
    writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\n' +
      'root=' + JSON.stringify(root) + '\n' +
      'cmd=${*: -1}\n' +
      'printf \'%s\\n\' "$cmd" >> "$root/ssh.log"\n' +
      'case "$cmd" in\n' +
      '  *pkill*) echo "$cmd" >> "$root/cancel.log" ;;\n' +
      '  *captured*) cat > "$root/captured" ;;\n' +
      '  *"cat > ~/.ubirun-env"*) cat > "$root/ubirun-env" ;;\n' +
      '  *"cat > ~/.ubirun-setup.sh"*) cat > "$root/ubirun-setup.sh" ;;\n' +
      '  *"tar -xzf -"*) cat > /dev/null ;;\n' +
      '  *"tar -czf -"*) base=${cmd##* }; tar -czf - -C "$root/remote-fs" "$base" ;;\n' +
      '  *"bash -l ~/.ubirun-setup.sh"*) echo "setup start"; if [ "$(cat "$root/setup-mode")" = hang ]; then sleep 20; fi; echo "setup done" ;;\n' +
      '  *"bash -lc "*) if [ -f "$root/command-mode" ]; then bash -c "$(cat "$root/command-mode")"; else echo "ran: $cmd"; fi ;;\n' +
      '  *) : ;;\n' +
      'esac\n');
    chmodSync(join(bin, 'curl'), 0o755); chmodSync(join(bin, 'ssh'), 0o755);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: state, UBI_POLL_SECONDS: '1', UBI_VM_RECORD: record, UBI_OWNER: 'thrd1', UBI_HEARTBEAT: '0' };
    const run = (args: string[], extra: Record<string, string> = {}, stdin?: string) =>
      Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), ...args], { env: { ...env, ...extra }, stdin: stdin === undefined ? undefined : Buffer.from(stdin), timeout: 90_000 });
    return {
      root, state, record, run,
      calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
      ssh: () => (existsSync(sshLog) ? readFileSync(sshLog, 'utf8') : ''),
      listed: () => readFileSync(join(root, 'listed'), 'utf8'),
    };
  }

  const src = (f: { root: string }, cfg: unknown) => {
    const dir = join(f.root, 'repo');
    mkdirSync(join(dir, '.gstack'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/boot.sh'), 'echo boot\n');
    writeFileSync(join(dir, '.gstack/ubicloud.json'), JSON.stringify(cfg));
    return dir;
  };

  const run = (f: ReturnType<typeof fakeVm>, args: string[], extra: Record<string, string> = {}, stdin?: string) => f.run(args, extra, stdin);

  test('run: a hung setup is killed by the watchdog, exits 124, never reaches the command, and the VM is destroyed', () => {
    const f = fakeVm();
    try {
      writeFileSync(join(f.root, 'setup-mode'), 'hang');
      const setup = join(f.root, 'setup.sh'); writeFileSync(setup, 'echo hi\n');
      const r = run(f, ['run', '--src', f.root, '--setup', setup, '--', 'make test'], { UBI_IDLE_TIMEOUT: '2' });
      const err = r.stderr.toString();
      expect(r.exitCode, err).toBe(124);
      expect(err).toMatch(/watchdog: setup printed nothing for \d+s \(UBI_IDLE_TIMEOUT=2\)/);
      expect(err).toContain('setup failed (exit 124)');
      expect(f.ssh()).not.toContain('bash -lc');
      expect(readFileSync(join(f.root, 'cancel.log'), 'utf8')).toMatch(/cat ~\/\.ubirun-setup-\d+\.sid/);
      expect(f.ssh()).toMatch(/setsid -w bash -c 'printf %s \$\$ >~\/\.ubirun-setup-\d+\.sid; cd work\/[^ ]+ && \. ~\/\.ubirun-env && bash -l ~\/\.ubirun-setup\.sh'; else bash -c '[^']*'; fi$/m);
      expect(readFileSync(join(f.root, 'cancel.log'), 'utf8')).toMatch(/rm -f ~\/\.ubirun-setup-\d+\.sid; \[ -z "\$sid" \] \|\| \{ pkill -TERM -s "\$sid"; sleep 2; pkill -KILL -s "\$sid"; \}/);
      expect(f.calls()).toContain('destroy');
      expect(err).toMatch(/destroyed eu-central-h1\/ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3/);
      expect(f.listed()).toBe('');
      expect(readFileSync(f.record, 'utf8')).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('run: UBI_RUN_TIMEOUT kills a command that keeps printing, with exit 124 and its reason', () => {
    const f = fakeVm();
    try {
      writeFileSync(join(f.root, 'command-mode'), 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "tick $i"; sleep 1; done');
      const r = run(f, ['run', '--src', f.root, '--', 'make test'], { UBI_RUN_TIMEOUT: '3' });
      expect(r.exitCode).toBe(124);
      expect(r.stderr.toString()).toMatch(/watchdog: command ran \d+s \(UBI_RUN_TIMEOUT=3\); killing it/);
      expect(r.stderr.toString()).toContain('command exited 124 after');
      expect(f.calls()).toContain('destroy');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('run: ends with UBICLOUD: left=0 for its own VM; a same-owner sibling is counted as information and does not fail the run', () => {
    const f = fakeVm({ listed: 'eu-central-h1 ubirun-thrd1-9999999999-sib1-t3\n' });
    try {
      const leftFile = join(f.root, 'left');
      const r = f.run(['run', '--src', f.root, '--', 'true'], { UBI_REAP: '0', UBI_LEFT_FILE: leftFile });
      const err = r.stderr.toString();
      expect(r.exitCode, err).toBe(0);
      expect(err).toMatch(/UBICLOUD: left=0 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=1\n/);
      expect(f.listed()).toBe('eu-central-h1 ubirun-thrd1-9999999999-sib1-t3\n');
      // Value: protects=UBI_LEFT_FILE carries the same leftover line pregate-remote.sh parses, apart from the command's output; fails_when=the file is not written or its format drifts from pregate-remote.sh's parser; why_new=the pregate stub hand-copies the format; seam=none; no_claim=real VM teardown (fake API and ssh)
      expect(readFileSync(leftFile, 'utf8')).toMatch(/^UBICLOUD: left=0 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=1\n$/);
      const parser = read('scripts/ubicloud/pregate-remote.sh').match(/left=\$\(sed -n '([^']+)' "\$log\.left"/)![1];
      expect(Bun.spawnSync(['sed', '-n', parser, leftFile], { timeout: 30_000 }).stdout.toString()).toBe('0\n');
      // Value: protects=run --keep reports its live VM as UBICLOUD: left=1 ... kept=1 and never a clean left=0; fails_when=the kept line is dropped or --keep still prints the teardown line; why_new=no test runs run --keep; seam=none; no_claim=real VM lifetime (fake API and ssh)
      const kept = f.run(['run', '--src', f.root, '--keep', '--', 'true'], { UBI_REAP: '0' });
      const keptErr = kept.stderr.toString();
      expect(kept.exitCode, keptErr).toBe(0);
      expect(keptErr).toMatch(/UBICLOUD: left=1 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 kept=1\n/);
      expect(keptErr).not.toContain('left=0');
      expect(f.listed()).toMatch(/ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3\n/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test('run: a passing command whose teardown fails exits 1 with UBICLOUD: left=1 and the down command; an unreadable VM list fails closed', () => {
    const f = fakeVm();
    try {
      writeFileSync(join(f.root, 'listed.destroy-fails'), '');
      const leaked = f.run(['run', '--src', f.root, '--', 'true'], { UBI_REAP: '0', UBI_DOWN_TIMEOUT: '3' });
      const err = leaked.stderr.toString();
      expect(leaked.exitCode, err).toBe(1);
      expect(err).toMatch(/UBICLOUD: left=1 owner=thrd1 vm=(ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3) others=0\n[^]*VM cleanup not confirmed for \1 \(left=1\); destroy it with: \S+ down \1/);
      expect(f.listed()).toContain('ubirun-thrd1-');
      // Value: protects=a failing command whose VM also leaks keeps its own exit status, not 1; fails_when=run_teardown exits 1 whenever left is not 0; why_new=the leak case above only runs a passing command; seam=none; no_claim=real destroy failure modes (fake API returns 500)
      writeFileSync(join(f.root, 'command-mode'), 'exit 7');
      const failedLeak = f.run(['run', '--src', f.root, '--', 'false'], { UBI_REAP: '0', UBI_DOWN_TIMEOUT: '3' });
      expect(failedLeak.exitCode, failedLeak.stderr.toString()).toBe(7);
      expect(failedLeak.stderr.toString()).toMatch(/UBICLOUD: left=1 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=1\n/);
      const blind = fakeVm();
      try {
        writeFileSync(join(blind.root, 'bin/curl.real'), readFileSync(join(blind.root, 'bin/curl')));
        chmodSync(join(blind.root, 'bin/curl.real'), 0o755);
        writeFileSync(join(blind.root, 'bin/curl'), '#!/usr/bin/env bash\nif [ -f ' + JSON.stringify(join(blind.root, 'armed')) + ' ]; then touch ' + JSON.stringify(join(blind.root, 'listed.list-fails')) + '; fi\nexec ' + JSON.stringify(join(blind.root, 'bin/curl.real')) + ' "$@"\n');
        chmodSync(join(blind.root, 'bin/curl'), 0o755);
        writeFileSync(join(blind.root, 'command-mode'), 'touch ' + JSON.stringify(join(blind.root, 'armed')));
        const r = blind.run(['run', '--src', blind.root, '--', 'true'], { UBI_REAP: '0' });
        expect(r.exitCode, r.stderr.toString()).toBe(1);
        expect(r.stderr.toString()).toMatch(/UBICLOUD: left=unknown owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=unknown\n/);
      } finally { rmSync(blind.root, { recursive: true, force: true }); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('run: the fake ssh dispatches on the remote command, so a checkout whose name holds -O still syncs and runs (GSTA-139)', () => {
    const f = fakeVm();
    try {
      const checkout = join(f.root, 'ubi-run-O1x2y3');
      mkdirSync(checkout);
      const r = run(f, ['run', '--src', checkout, '--', 'make test']);
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      expect(r.stdout.toString()).toContain('ran: ');
      expect(f.ssh()).toContain('tar -xzf - -C work/ubi-run-O1x2y3');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('run: --pass forwards a named local variable only; UBICLOUD_* and non-names are refused before any API call', () => {
    const f = fakeVm();
    try {
      const ok = run(f, ['run', '--src', f.root, '--pass', 'UBI_TEST_TOKEN', '--env', 'CI=1', '--', 'make test'], { UBI_TEST_TOKEN: 'sekret value' });
      expect(ok.exitCode).toBe(0);
      expect(ok.stderr.toString()).toContain('command exited 0 after');
      const envFile = readFileSync(join(f.root, 'ubirun-env'), 'utf8');
      expect(envFile).toContain('export UBI_TEST_TOKEN=sekret\\ value');
      expect(envFile).toContain('export CI=1');
      expect(envFile).not.toContain('UBICLOUD');
      expect(ok.stdout.toString() + ok.stderr.toString()).not.toContain('sekret');
      for (const bad of ['UBICLOUD_API_KEY', 'UBICLOUD_API_TOKEN', 'X;Y', 'HOME/..']) {
        const before = f.calls();
        const r = run(f, ['run', '--src', f.root, '--pass', bad, '--', 'true']);
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toMatch(bad.startsWith('UBICLOUD_') ? /never forwards its own Ubicloud credentials/ : /not a variable name/);
        expect(f.calls()).toBe(before);
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('ssh NAME COMMAND hands the caller’s stdin to the remote command', () => {
    const f = fakeVm({ listed: 'eu-central-h1 vm-a\n' });
    try {
      mkdirSync(join(f.state, 'vm-a'), { recursive: true });
      writeFileSync(join(f.state, 'vm-a/env'), 'NAME=vm-a\nLOCATION=eu-central-h1\nSIZE=standard-16\nIP=192.0.2.1\nCREATED=yes\nCREATE_AT=0\nCREATE_PID=1\n');
      const r = run(f, ['ssh', 'vm-a', 'cat > captured'], { UBI_IDLE_TIMEOUT: '0' }, 'payload line\n');
      expect(r.exitCode).toBe(0);
      expect(readFileSync(join(f.root, 'captured'), 'utf8')).toBe('payload line\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test('verify forwards a configured pass name only when the command line grants it, and never UBICLOUD_*', () => {
    const f = fakeVm();
    try {
      const dir = src(f, { setup: 'scripts/boot.sh', command: 'make verify', pass: ['UBI_TEST_TOKEN'] });
      const refused = run(f, ['verify', '--src', dir], { UBI_TEST_TOKEN: 'x' });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain('asks to forward local UBI_TEST_TOKEN; grant each on this command line with --pass NAME, or every name it lists with --trust-config');
      expect(f.calls()).toBe('');
      const granted = run(f, ['verify', '--src', dir, '--pass', 'UBI_TEST_TOKEN'], { UBI_TEST_TOKEN: 'granted value' });
      expect(granted.exitCode).toBe(0);
      expect(readFileSync(join(f.root, 'ubirun-env'), 'utf8')).toContain('export UBI_TEST_TOKEN=granted\\ value');
      expect(f.ssh()).toContain('bash -lc make\\ verify');
      rmSync(join(f.root, 'ubirun-env'));
      const trusted = run(f, ['verify', '--src', dir, '--trust-config'], { UBI_TEST_TOKEN: 'trusted value' });
      expect(trusted.exitCode).toBe(0);
      expect(readFileSync(join(f.root, 'ubirun-env'), 'utf8')).toContain('export UBI_TEST_TOKEN=trusted\\ value');
      rmSync(join(f.root, 'ubirun-env'));
      const asValue = run(f, ['verify', '--src', dir, '--dest', '--trust-config', '--keep', '--dest', 'work/safe'], { UBI_TEST_TOKEN: 'x' });
      expect(asValue.exitCode).toBe(1);
      expect(asValue.stderr.toString()).toContain('asks to forward local UBI_TEST_TOKEN');
      expect(existsSync(join(f.root, 'ubirun-env'))).toBe(false);
      expect(run(f, ['verify', '--src', dir, '--pass']).stderr.toString()).toContain('verify: --pass needs a value');
      expect(run(f, ['verify', '--src', dir, '--bogus']).stderr.toString()).toContain('verify: unknown option --bogus');
      writeFileSync(join(dir, '.gstack/ubicloud.json'), JSON.stringify({ command: 'make verify', pass: ['UBICLOUD_API_KEY'] }));
      const before = f.calls();
      const key = run(f, ['verify', '--src', dir, '--trust-config']);
      expect(key.exitCode).toBe(1);
      expect(key.stderr.toString()).toContain('never forwards its own Ubicloud credentials');
      expect(f.calls()).toBe(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('verify keeps a configured setup script and pull destination inside --src: absolute, ~ and .. paths are refused before any API call', () => {
    const f = fakeVm();
    try {
      const dir = src(f, {});
      const outside = join(f.root, 'outside.sh'); writeFileSync(outside, 'echo outside\n');
      const cases: Array<[unknown, RegExp]> = [
        [{ setup: outside, command: 'x' }, /setup '[^']*outside\.sh' must be a relative path inside the checkout/],
        [{ setup: '../outside.sh', command: 'x' }, /setup '\.\.\/outside\.sh' must be a relative path inside the checkout/],
        [{ setup: 'scripts/../../outside.sh', command: 'x' }, /must be a relative path inside the checkout/],
        [{ setup: '~/outside.sh', command: 'x' }, /must be a relative path inside the checkout/],
        [{ command: 'x', pull: ['work/logs:/etc/cron.d'] }, /pull destination '\/etc\/cron\.d' must be a relative path inside the checkout/],
        [{ command: 'x', pull: ['work/logs:../stolen'] }, /pull destination '\.\.\/stolen' must be a relative path inside the checkout/],
        [{ command: 'x', pull: ['no-colon'] }, /pull entry 'no-colon' must be REMOTE_GLOB:LOCAL_DIR/],
      ];
      for (const [cfg, want] of cases) {
        writeFileSync(join(dir, '.gstack/ubicloud.json'), JSON.stringify(cfg));
        const r = run(f, ['verify', '--src', dir]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toMatch(want);
      }
      expect(f.calls()).toBe('');
      writeFileSync(join(dir, '.gstack/ubicloud.json'), JSON.stringify({ setup: 'scripts/boot.sh', command: 'make verify', pull: ['work/repo/logs:.context/ubicloud'] }));
      const ok = run(f, ['verify', '--src', dir]);
      expect(ok.exitCode).toBe(0);
      expect(readFileSync(join(f.root, 'ubirun-setup.sh'), 'utf8')).toBe('echo boot\n');
      expect(f.ssh()).toContain('ls -d -- logs');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('verify rechecks every pull destination at pull time: a symlink an earlier pull planted cannot redirect a later pull outside --src', () => {
    const f = fakeVm();
    try {
      const dir = src(f, { command: 'make verify', pull: ['work/repo/escape:.', 'work/repo/artifacts:escape/new/sub'] });
      const victim = join(f.root, 'victim'); mkdirSync(victim);
      mkdirSync(join(f.root, 'remote-fs/artifacts'), { recursive: true });
      writeFileSync(join(f.root, 'remote-fs/artifacts/authorized_keys'), 'ssh-ed25519 AAAA attacker\n');
      symlinkSync(victim, join(f.root, 'remote-fs/escape'));
      const r = run(f, ['verify', '--src', dir]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toMatch(/pull refused: .*\/repo\/escape\/new\/sub resolves outside .*\/repo/);
      expect(lstatSync(join(dir, 'escape')).isSymbolicLink()).toBe(true);
      expect(readdirSync(victim)).toEqual([]);
      expect(f.calls()).toContain('destroy');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('quota: a refusal caches the maximum, the cache drives the preflight for a day and is dropped after; UBI_QUOTA_WAIT waits before refusing', () => {
    const refuse = fakeVm({ refuse: 'Validation failed for following fields: Requested vCPU count: 16, currently used vCPU count: 32, maximum allowed vCPU count: 32' });
    try {
      const r = run(refuse, ['up']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain('create failed: vCPU quota exhausted');
      expect(readFileSync(join(refuse.state, 'quota-max'), 'utf8').trim()).toBe('32');
      expect(refuse.listed()).toBe('');
    } finally { rmSync(refuse.root, { recursive: true, force: true }); }

    const f = fakeVm({ listed: 'eu-central-h1 ubirun-peer-9999999999-cccc\n' });
    try {
      writeFileSync(join(f.state, 'quota-max'), '31\n');
      const cached = run(f, ['up']);
      expect(cached.exitCode).toBe(1);
      expect(cached.stderr.toString()).toMatch(/already use 16 of 31 \(ceiling from the last refusal, cached in .*quota-max;/);
      expect(f.calls()).not.toContain('"create"');

      const started = Date.now();
      const waited = run(f, ['up'], { UBI_QUOTA_WAIT: '3' });
      expect(waited.exitCode).toBe(1);
      expect(waited.stderr.toString()).toMatch(/quota: 16 of 31 vCPUs in use and 16 needed; waiting up to 3s more for room/);
      expect(waited.stderr.toString()).toContain('create refused before any request: vCPU quota exhausted');
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
      expect(f.calls()).not.toContain('"create"');

      utimesSync(join(f.state, 'quota-max'), new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000));
      const stale = run(f, ['up']);
      expect(stale.exitCode).toBe(0);
      expect(stale.stderr.toString()).not.toContain('quota preflight refused');
      expect(f.calls()).toContain('"create"');
      expect(existsSync(join(f.state, 'quota-max'))).toBe(false);
      const name = stale.stdout.toString().trim();
      expect(name).toMatch(/^ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3$/);
      expect(run(f, ['down', name]).exitCode).toBe(0);
      expect(f.listed()).toBe('eu-central-h1 ubirun-peer-9999999999-cccc\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  // Value: protects=the quota wait budget counts seconds slept, not usage reads: a slow usage read keeps the printed budget, a wait above 30 s counts down in 30 s steps, and the wait releases when room appears; fails_when=the budget goes back to a wall-clock deadline taken before the first usage read (the first log line shrinks to 1s), the step cap or the decrement is lost, or room found mid-wait still refuses; why_new=the WAIT=3 case above passes under both the old deadline and the new countdown because its fake usage read is instant and it never sees a second step; seam=none (the fixture's bin/ is already first on PATH, so sleep and curl are stubbed there); no_claim=real elapsed time of the long wait (the 70 s case stubs sleep)
  test('quota wait: a slow usage read does not shave the printed budget; a long wait counts down in 30s steps and releases when room appears', () => {
    const slow = fakeVm({ listed: 'eu-central-h1 ubirun-peer-9999999999-cccc\n' });
    try {
      writeFileSync(join(slow.state, 'quota-max'), '31\n');
      const r = run(slow, ['up'], { UBI_QUOTA_WAIT: '2', FAKE_SHOW_DELAY: '1.2' });
      const err = r.stderr.toString();
      expect(r.exitCode, err).toBe(1);
      expect(err).toMatch(/quota: 16 of 31 vCPUs in use and 16 needed; waiting up to 2s more for room/);
      expect(err).toContain('create refused before any request: vCPU quota exhausted');
      expect(slow.calls()).not.toContain('"create"');
    } finally { rmSync(slow.root, { recursive: true, force: true }); }

    const f = fakeVm({ listed: 'eu-central-h1 ubirun-peer-9999999999-cccc\n' });
    try {
      writeFileSync(join(f.state, 'quota-max'), '31\n');
      const sleepLog = join(f.root, 'sleep.log');
      writeFileSync(join(f.root, 'bin/sleep'), '#!/usr/bin/env bash\necho "$1" >> ' + JSON.stringify(sleepLog) + '\n[ "$(wc -l < ' + JSON.stringify(sleepLog) + ')" -ne 2 ] || : > ' + JSON.stringify(join(f.root, 'listed')) + '\n');
      chmodSync(join(f.root, 'bin/sleep'), 0o755);
      const r = run(f, ['up'], { UBI_QUOTA_WAIT: '70' });
      const err = r.stderr.toString();
      expect(r.exitCode, err).toBe(0);
      expect(err).toMatch(/waiting up to 70s more for room/);
      expect(err).toMatch(/waiting up to 40s more for room/);
      expect(err).not.toContain('quota preflight refused');
      expect(readFileSync(sleepLog, 'utf8').split('\n').slice(0, 2)).toEqual(['30', '30']);
      expect(f.calls()).toContain('"create"');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('reap reports a failed list and a failed destroy as failures; UBI_TTL_HOURS rejects leading zeros and more than three digits', () => {
    const f = fakeVm({ listed: 'eu-central-h1 ubirun-other-1000000000-bbbb-t1\n' });
    try {
      writeFileSync(join(f.root, 'bin/curl'), '#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\nbody=$(cat)\ncase "$body" in\n  *\'"list"\'*) echo "eu-central-h1 ubirun-other-1000000000-bbbb-t1" > "$out"; printf 200 ;;\n  *\'"show"\'*) printf \'state: running\\nsize: standard-16\\nip4: 192.0.2.1\\n\' > "$out"; printf 200 ;;\n  *) echo "boom" > "$out"; printf 500 ;;\nesac\n');
      const destroyFails = run(f, ['reap']);
      expect(destroyFails.exitCode).toBe(1);
      expect(destroyFails.stderr.toString()).toContain('failed to reap eu-central-h1/ubirun-other-1000000000-bbbb-t1');
      expect(destroyFails.stderr.toString()).toContain('reap: 1 of 1 expired VMs could not be destroyed');
      writeFileSync(join(f.root, 'bin/curl'), '#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\ncat >/dev/null; echo "down" > "$out"; printf 503\n');
      const listFails = run(f, ['reap']);
      expect(listFails.exitCode).toBe(1);
      expect(listFails.stderr.toString()).toContain("reap: could not list the project's VMs; nothing destroyed");
      for (const ttl of ['0', '08', '1000', 'abc']) {
        const r = run(f, ['up'], { UBI_TTL_HOURS: ttl });
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain('UBI_TTL_HOURS must be a whole number of hours from 1 to 999');
      }
      // Value: protects=an old UBI_TTL_HOURS=0 or bad UBI_LEGACY_HOURS never blocks commands that create nothing (down, list, owner); fails_when=the TTL checks move back to startup; why_new=the checks were global and blocked cleanup; seam=none; no_claim=real down against the API (owner stands in for every read-only command)
      expect(run(f, ['owner'], { UBI_TTL_HOURS: '0', UBI_LEGACY_HOURS: '0' }).exitCode).toBe(0);
      for (const legacy of ['0', '04', 'x']) {
        const r = run(f, ['reap'], { UBI_LEGACY_HOURS: legacy });
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain('UBI_LEGACY_HOURS must be a whole number of hours from 1 to 9999');
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});
