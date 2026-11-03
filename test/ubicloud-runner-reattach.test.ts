/**
 * ubi-runner detached phases, reattach, signals and the run key (GSTA-158 P3), against the fake Ubicloud API and fake ssh in
 * test/helpers/ubi-runner-fake-vm.ts. Split from test/ubicloud-runner.test.ts (GSTA-151).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, fakeVm, src, run, until, vmDirs, phaseStarted, creates, killSession, gitSrc } from './helpers/ubi-runner-fake-vm';

describe('ubi-runner run, verify and quota against a fake API and a fake ssh', () => {
  test('run: a SIGKILLed runner leaves its VM; the same command reattaches, skips the finished setup and reports the command\'s exit', async () => {
    const f = fakeVm();
    try {
      const repo = gitSrc(f);
      const setup = join(f.root, 'setup.sh'); writeFileSync(setup, 'echo setup >> ~/setup-count\n');
      writeFileSync(join(f.root, 'make-test.sh'), 'echo begin; sleep 4; echo end; exit 3\n');
      const args = ['run', '--src', repo, '--setup', setup, '--', 'make test'];
      const a = f.spawn(args);
      await until(() => vmDirs(f).some(d => existsSync(join(f.state, d, 'command.out')) && readFileSync(join(f.state, d, 'command.out'), 'utf8').includes('begin')), 30_000);
      process.kill(a.pid, 'SIGKILL');
      await a.exited;
      const name = vmDirs(f)[0]!;
      expect(f.listed()).toContain(name);
      const b = f.run(args);
      const err = b.stderr.toString();
      expect(b.exitCode, err).toBe(3);
      expect(err).toMatch(new RegExp('ubi-runner: reattached to ' + name + ' created_at=\\d{10} key=[0-9a-f]{12}\n'));
      expect(b.stdout.toString().split('\n').filter(l => l === 'begin' || l === 'end')).toEqual(['begin', 'end']);
      expect(err).toMatch(/command exited 3 after \d+s/);
      expect(creates(f)).toBe(1);
      expect(readFileSync(join(f.vm, 'setup-count'), 'utf8')).toBe('setup\n');
      expect(f.listed()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('run: a second live runner of the same command refuses with UBI_ATTACH_BUSY and creates nothing', async () => {
    const f = fakeVm();
    try {
      const repo = gitSrc(f);
      writeFileSync(join(f.root, 'make-test.sh'), 'sleep 4; echo done\n');
      const args = ['run', '--src', repo, '--', 'make test'];
      const a = f.spawn(args);
      await until(() => phaseStarted(f, 'command'), 30_000);
      const b = f.run(args);
      expect(b.exitCode).toBe(1);
      expect(b.stderr.toString()).toMatch(new RegExp('UBI_ATTACH_BUSY: vm=' + vmDirs(f)[0] + ' key=[0-9a-f]{12}: runner pid ' + a.pid + ' '));
      expect(await a.exited).toBe(0);
      expect(await new Response(a.stdout).text()).toContain('done');
      expect(creates(f)).toBe(1);
      expect(f.listed()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('run: HUP once the command is live detaches (UBI_DETACHED, exit 129, VM kept, no pass value on disk); a rerun reattaches and finishes', async () => {
    const f = fakeVm();
    try {
      const repo = gitSrc(f);
      writeFileSync(join(f.root, 'make-test.sh'), 'sleep 3; echo finished\n');
      const args = ['run', '--src', repo, '--pass', 'UBI_TEST_TOKEN', '--', 'make test'];
      const a = f.spawn(args, { UBI_TEST_TOKEN: 'hup-secret-value' });
      await until(() => phaseStarted(f, 'command'), 30_000);
      await Bun.sleep(500);
      process.kill(a.pid, 'SIGHUP');
      expect(await a.exited).toBe(129);
      const name = vmDirs(f)[0]!;
      const err = await new Response(a.stderr).text();
      expect(err).toMatch(new RegExp('UBI_DETACHED: vm=' + name + ' key=[0-9a-f]{12} reattach: rerun the same command'));
      expect(f.listed()).toContain(name);
      expect(f.calls()).not.toContain('destroy');
      for (const file of readdirSync(join(f.state, name))) {
        const p = join(f.state, name, file);
        if (lstatSync(p).isFile()) expect(readFileSync(p, 'utf8')).not.toContain('hup-secret-value');
      }
      const b = f.run(args, { UBI_TEST_TOKEN: 'hup-secret-value' });
      expect(b.exitCode, b.stderr.toString()).toBe(0);
      expect(b.stderr.toString()).toContain('reattached to ' + name);
      expect(b.stdout.toString()).toContain('finished');
      expect(creates(f)).toBe(1);
      expect(f.listed()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('run: INT and TERM during a live command still tear the VM down', async () => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      const f = fakeVm();
      try {
        const repo = gitSrc(f);
        writeFileSync(join(f.root, 'make-test.sh'), 'sleep 3\n');
        const a = f.spawn(['run', '--src', repo, '--', 'make test']);
        await until(() => phaseStarted(f, 'command'), 30_000);
        await Bun.sleep(500);
        process.kill(a.pid, sig);
        expect(await a.exited).toBe(130);
        expect(await new Response(a.stderr).text()).toMatch(/destroyed eu-central-h1\/ubirun-thrd1-/);
        expect(f.listed()).toBe('');
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  }, 90_000);

  test('run: a remote session gone without an exit status exits 125 with UBI_ATTACH_LOST and the VM name', async () => {
    const f = fakeVm();
    try {
      const repo = gitSrc(f);
      writeFileSync(join(f.root, 'make-test.sh'), 'sleep 30\n');
      const args = ['run', '--src', repo, '--', 'make test'];
      const a = f.spawn(args);
      await until(() => existsSync(join(f.vm, '.ubirun-command.pid')) && readFileSync(join(f.vm, '.ubirun-command.pid'), 'utf8').trim() !== '', 30_000);
      process.kill(a.pid, 'SIGKILL');
      await a.exited;
      await killSession(f, 'command');
      const name = vmDirs(f)[0]!;
      const b = f.run(args);
      expect(b.exitCode).toBe(125);
      expect(b.stderr.toString()).toContain('UBI_ATTACH_LOST: vm=' + name + ' phase=command');
      expect(f.listed()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);

  test('run: the run key covers tree, command, setup content, env, pass value, image, origin/HEAD and the runner itself; a pass value never appears in it', () => {
    const f = fakeVm();
    try {
      const repo = gitSrc(f);
      const setup = join(f.root, 'setup.sh'); writeFileSync(setup, 'echo one\n');
      const runner = join(f.root, 'runner-copy.sh'); writeFileSync(runner, readFileSync(join(DIR, 'ubi-runner.sh'), 'utf8'));
      const key = (opts: { args?: string[]; env?: Record<string, string>; cmd?: string; script?: string } = {}) => {
        const r = Bun.spawnSync(['bash', opts.script ?? join(DIR, 'ubi-runner.sh'), 'run', '--probe', '--src', repo, '--setup', setup, '--env', 'MODE=a', '--pass', 'UBI_TEST_TOKEN', ...(opts.args ?? []), '--', opts.cmd ?? 'make test'],
          { env: { ...process.env, PATH: join(f.root, 'bin') + ':' + process.env.PATH, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: f.state, UBI_OWNER: 'thrd1', UBI_TEST_TOKEN: 'v1', ...(opts.env ?? {}) }, timeout: 30_000 });
        const out = r.stdout.toString() + r.stderr.toString();
        expect(out).not.toContain('v1');
        const m = /^UBI_ATTACH_INFO: none key=([0-9a-f]{12})$/m.exec(out);
        if (!m) throw new Error(out);
        return m[1]!;
      };
      const base = key();
      expect(key()).toBe(base);
      const variants: Record<string, string> = {};
      variants.command = key({ cmd: 'make check' });
      variants.env = key({ args: ['--env', 'MODE=b'] });
      variants.pass = key({ env: { UBI_TEST_TOKEN: 'v2' } });
      variants.image = key({ args: ['-b', 'ubuntu-jammy'] });
      variants.size = key({ args: ['-s', 'standard-8'] });
      writeFileSync(runner, readFileSync(runner, 'utf8') + '# edited\n');
      variants.runner = key({ script: runner });
      writeFileSync(setup, 'echo two\n');
      variants.setup = key();
      writeFileSync(setup, 'echo one\n');
      expect(key()).toBe(base);
      Bun.spawnSync(['git', 'update-ref', 'refs/remotes/origin/HEAD', 'HEAD'], { cwd: repo, timeout: 10_000 });
      variants.base = key();
      writeFileSync(join(repo, 'new-file.txt'), 'untracked source\n');
      variants.tree = key();
      for (const [what, k] of Object.entries(variants)) expect({ what, same: k === base }).toEqual({ what, same: false });
      expect(new Set(Object.values(variants)).size).toBe(Object.keys(variants).length);
      expect(f.calls()).not.toContain('"create"');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);
});
