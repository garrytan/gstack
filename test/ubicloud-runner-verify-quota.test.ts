/**
 * ubi-runner verify pass names and pull containment, quota cache and wait, reap, against the fake Ubicloud API and fake ssh in
 * test/helpers/ubi-runner-fake-vm.ts. Split from test/ubicloud-runner.test.ts (GSTA-151).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, fakeVm, src, run } from './helpers/ubi-runner-fake-vm';

describe('ubi-runner run, verify and quota against a fake API and a fake ssh', () => {
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

  // Value: protects=the first up on a fresh project reaches its create with the default reap on; fails_when=the reap before up dies on an empty list again (#3678); why_new=no up case ran against a project with no VMs; seam=none; no_claim=real create and boot (fake API and ssh)
  test('up on an empty project reaps nothing, creates its VM and comes up (#3678)', () => {
    const f = fakeVm({ listed: '\n' });
    try {
      const up = run(f, ['up']);
      expect(up.stderr.toString()).toContain('reap: no expired VMs');
      expect(up.exitCode).toBe(0);
      expect(f.calls()).toContain('"create"');
      expect(f.calls()).not.toContain('destroy');
      const name = up.stdout.toString().trim();
      expect(name).toMatch(/^ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3$/);
      expect(run(f, ['down', name]).exitCode).toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  // Value: protects=usage never reports a partial or empty count as the project's real usage, and the quota preflight says when it cannot read usage instead of passing silently; fails_when=a failed vm list or vm show prints a total again (the empty-project fix's `|| true` did that) or the preflight drops its log line; why_new=only successful reads were tested, and #3679 showed an unreadable usage switching the preflight off without a word; seam=none; no_claim=the real API's failure bodies
  test('usage exits 1 without a total when the VM list or a size read fails, skips a VM destroyed since the list, and the quota preflight logs an unreadable usage and leaves the call to the API', () => {
    const f = fakeVm({ listed: 'eu-central-h1 ubirun-peer-9999999999-cccc\n' });
    const listed = join(f.root, 'listed');
    try {
      writeFileSync(`${listed}.list-fails`, '');
      const noList = run(f, ['usage']);
      expect(noList.exitCode).toBe(1);
      expect(noList.stdout.toString()).not.toContain('total');
      expect(noList.stderr.toString()).toContain("usage: could not list the project's VMs");
      const up = run(f, ['up'], { UBI_REAP: '0', UBI_QUOTA_VCPUS: '16' });
      expect(up.stderr.toString()).toContain("quota preflight: could not read the project's vCPU usage; the API's own answer decides");
      expect(f.calls()).toContain('"create"');
      // With a wait budget, an unreadable usage is retried until the budget is spent, as a full project is.
      const waited = run(f, ['up'], { UBI_REAP: '0', UBI_QUOTA_VCPUS: '16', UBI_QUOTA_WAIT: '2' });
      expect(waited.stderr.toString()).toContain("quota: could not read the project's vCPU usage; retrying, up to 2s more");
      expect(waited.stderr.toString()).toContain("quota preflight: could not read the project's vCPU usage; the API's own answer decides");
      const waitedName = waited.stdout.toString().trim();
      rmSync(`${listed}.list-fails`);
      for (const name of [up.stdout.toString().trim(), waitedName]) {
        expect(name).toMatch(/^ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3$/);
        expect(run(f, ['down', name]).exitCode).toBe(0);
      }

      writeFileSync(`${listed}.show-fails`, '');
      const noShow = run(f, ['usage']);
      expect(noShow.exitCode).toBe(1);
      expect(noShow.stdout.toString()).not.toContain('total');
      expect(noShow.stderr.toString()).toContain('usage: could not read the size of 1 of 1 VMs');
      rmSync(`${listed}.show-fails`);

      // A VM destroyed between the list and its size read (show answers 404) is gone, not unread.
      writeFileSync(`${listed}.ghost`, 'eu-central-h1 ubirun-gone-9999999999-dddd-t3\n');
      const ghost = run(f, ['usage']);
      expect(ghost.exitCode).toBe(0);
      expect(ghost.stdout.toString()).toBe('OWNER           VMS  VCPUS\npeer              1     16\ntotal             1     16\n');
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
