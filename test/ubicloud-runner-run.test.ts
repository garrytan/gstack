/**
 * ubi-runner run: watchdog, timeouts, teardown accounting, ssh dispatch and --pass, against the fake Ubicloud API and fake ssh in
 * test/helpers/ubi-runner-fake-vm.ts. Split from test/ubicloud-runner.test.ts (GSTA-151).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, fakeVm, src, run } from './helpers/ubi-runner-fake-vm';

describe('ubi-runner run, verify and quota against a fake API and a fake ssh', () => {
  test('run: a hung setup is killed by the watchdog, exits 124, never reaches the command, and the VM is destroyed', () => {
    const f = fakeVm();
    try {
      const setup = join(f.root, 'setup.sh'); writeFileSync(setup, 'echo "setup start"; sleep 20\n');
      const r = run(f, ['run', '--src', f.src, '--setup', setup, '--', 'make test'], { UBI_IDLE_TIMEOUT: '2' });
      const err = r.stderr.toString();
      expect(r.exitCode, err).toBe(124);
      expect(err).toMatch(/watchdog: setup printed nothing for \d+s \(UBI_IDLE_TIMEOUT=2\)/);
      expect(err).toContain('setup failed (exit 124)');
      expect(f.ssh()).not.toContain('bash -lc');
      expect(err).toContain('setup start');
      // The setup runs detached in its own session: its leader's pid, both streams and the exit status are files on the VM.
      expect(f.ssh()).toMatch(/setsid -f bash -c 'echo \$\$ >~\/\.ubirun-setup\.pid\.tmp && mv ~\/\.ubirun-setup\.pid\.tmp ~\/\.ubirun-setup\.pid; \( cd work\/[^ ]+ && \. ~\/\.ubirun-env && bash -l ~\/\.ubirun-setup\.sh \) >~\/\.ubirun-setup\.out 2>~\/\.ubirun-setup\.err <\/dev\/null; echo \$\? >~\/\.ubirun-setup\.exit\.tmp && mv ~\/\.ubirun-setup\.exit\.tmp ~\/\.ubirun-setup\.exit' <\/dev\/null/m);
      expect(readFileSync(join(f.root, 'cancel.log'), 'utf8')).toMatch(/sid=\$\(cat ~\/\.ubirun-setup\.pid 2>\/dev\/null\); rm -f ~\/\.ubirun-setup\.pid; \[ -z "\$sid" \] \|\| \{ pkill -TERM -s "\$sid"; sleep 2; pkill -KILL -s "\$sid"; \}/);
      expect(existsSync(join(f.vm, '.ubirun-setup.exit'))).toBe(false);
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
      const r = run(f, ['run', '--src', f.src, '--', 'make test'], { UBI_RUN_TIMEOUT: '3' });
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
      const r = f.run(['run', '--src', f.src, '--', 'true'], { UBI_REAP: '0', UBI_LEFT_FILE: leftFile });
      const err = r.stderr.toString();
      expect(r.exitCode, err).toBe(0);
      expect(err).toMatch(/UBICLOUD: left=0 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=1\n/);
      expect(err).toMatch(/carries a 3h TTL \(this owner's next up or reap destroys it once it expires\); if this process dies first: /);
      expect(f.listed()).toBe('eu-central-h1 ubirun-thrd1-9999999999-sib1-t3\n');
      // Value: protects=UBI_LEFT_FILE carries the same leftover line pregate-remote.sh parses, apart from the command's output; fails_when=the file is not written or its format drifts from pregate-remote.sh's parser; why_new=the pregate stub hand-copies the format; seam=none; no_claim=real VM teardown (fake API and ssh)
      expect(readFileSync(leftFile, 'utf8')).toMatch(/^UBICLOUD: left=0 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=1\n$/);
      const parser = read('scripts/ubicloud/pregate-remote.sh').match(/left=\$\(sed -n '([^']+)' "\$log\.left"/)![1];
      expect(Bun.spawnSync(['sed', '-n', parser, leftFile], { timeout: 30_000 }).stdout.toString()).toBe('0\n');
      // Value: protects=run --keep reports its live VM as UBICLOUD: left=1 ... kept=1 and never a clean left=0; fails_when=the kept line is dropped or --keep still prints the teardown line; why_new=no test runs run --keep; seam=none; no_claim=real VM lifetime (fake API and ssh)
      const kept = f.run(['run', '--src', f.src, '--keep', '--', 'true'], { UBI_REAP: '0' });
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
      const leaked = f.run(['run', '--src', f.src, '--', 'true'], { UBI_REAP: '0', UBI_DOWN_TIMEOUT: '3' });
      const err = leaked.stderr.toString();
      expect(leaked.exitCode, err).toBe(1);
      expect(err).toMatch(/UBICLOUD: left=1 owner=thrd1 vm=(ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3) others=0\n[^]*VM cleanup not confirmed for \1 \(left=1\); destroy it with: \S+ down \1/);
      expect(f.listed()).toContain('ubirun-thrd1-');
      // Value: protects=a failing command whose VM also leaks keeps its own exit status, not 1; fails_when=run_teardown exits 1 whenever left is not 0; why_new=the leak case above only runs a passing command; seam=none; no_claim=real destroy failure modes (fake API returns 500)
      writeFileSync(join(f.root, 'command-mode'), 'exit 7');
      const failedLeak = f.run(['run', '--src', f.src, '--', 'make test'], { UBI_REAP: '0', UBI_DOWN_TIMEOUT: '3' });
      expect(failedLeak.exitCode, failedLeak.stderr.toString()).toBe(7);
      expect(failedLeak.stderr.toString()).toMatch(/UBICLOUD: left=1 owner=thrd1 vm=ubirun-thrd1-\d{10}-[0-9a-f]{8}-t3 others=1\n/);
      const blind = fakeVm();
      try {
        writeFileSync(join(blind.root, 'bin/curl.real'), readFileSync(join(blind.root, 'bin/curl')));
        chmodSync(join(blind.root, 'bin/curl.real'), 0o755);
        writeFileSync(join(blind.root, 'bin/curl'), '#!/usr/bin/env bash\nif [ -f ' + JSON.stringify(join(blind.root, 'armed')) + ' ]; then touch ' + JSON.stringify(join(blind.root, 'listed.list-fails')) + '; fi\nexec ' + JSON.stringify(join(blind.root, 'bin/curl.real')) + ' "$@"\n');
        chmodSync(join(blind.root, 'bin/curl'), 0o755);
        writeFileSync(join(blind.root, 'command-mode'), 'touch ' + JSON.stringify(join(blind.root, 'armed')));
        const r = blind.run(['run', '--src', blind.src, '--', 'make test'], { UBI_REAP: '0' });
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
      const ok = run(f, ['run', '--src', f.src, '--pass', 'UBI_TEST_TOKEN', '--env', 'CI=1', '--', 'make test'], { UBI_TEST_TOKEN: 'sekret value' });
      expect(ok.exitCode).toBe(0);
      expect(ok.stderr.toString()).toContain('command exited 0 after');
      const envFile = readFileSync(join(f.root, 'ubirun-env'), 'utf8');
      expect(envFile).toContain('export UBI_TEST_TOKEN=sekret\\ value');
      expect(envFile).toContain('export CI=1');
      expect(envFile).not.toContain('UBICLOUD');
      expect(ok.stdout.toString() + ok.stderr.toString()).not.toContain('sekret');
      for (const bad of ['UBICLOUD_API_KEY', 'UBICLOUD_API_TOKEN', 'X;Y', 'HOME/..']) {
        const before = f.calls();
        const r = run(f, ['run', '--src', f.src, '--pass', bad, '--', 'true']);
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
});
