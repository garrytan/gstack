/**
 * ubi-runner verify tiers and their checkpoints (GSTA-158 P3), against the fake Ubicloud API and fake ssh in
 * test/helpers/ubi-runner-fake-vm.ts. Split from test/ubicloud-runner.test.ts (GSTA-151).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIR, fakeVm, src, run, until, vmDirs, creates, killSession, gitSrc, TIERS, bootCounts, verifyLine } from './helpers/ubi-runner-fake-vm';

describe('ubi-runner run, verify and quota against a fake API and a fake ssh', () => {
  test('verify tiers: config refuses command with tiers, bad and duplicate tier names, before any API call', () => {
    const f = fakeVm();
    try {
      const cases: Array<[unknown, RegExp]> = [
        [{ command: 'make', tiers: [{ name: 'a', command: 'x' }] }, /UBI_CONFIG_TIERS_AND_COMMAND/],
        [{ tiers: [{ name: 'Unit', command: 'x' }] }, /UBI_CONFIG_TIER_NAME: tier name 'Unit' must match/],
        [{ tiers: [{ name: '-x', command: 'x' }] }, /UBI_CONFIG_TIER_NAME: tier name '-x'/],
        [{ tiers: [{ name: 'a'.repeat(33), command: 'x' }] }, /UBI_CONFIG_TIER_NAME/],
        [{ tiers: [{ name: 'a.b', command: 'x' }] }, /UBI_CONFIG_TIER_NAME/],
        [{ tiers: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }, /UBI_CONFIG_TIER_NAME: tier name 'a' appears twice/],
        [{ tiers: [{ name: 'a' }] }, /UBI_CONFIG_TIER_NAME: tier 'a' needs a command/],
        [{ tiers: [] }, /UBI_CONFIG_TIER_NAME: tiers must be a non-empty list/],
      ];
      for (const [cfg, want] of cases) {
        const dir = src(f, cfg);
        const r = run(f, ['verify', '--src', dir]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toMatch(want);
      }
      expect(f.calls()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  test('verify tiers: a run killed during tier 3 with its VM gone resumes on a new VM: setup reruns, t1 and t2 are reused, t3 reruns', async () => {
    const f = fakeVm();
    try {
      const dir = gitSrc(f, TIERS);
      bootCounts(f, dir);
      Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'boot'], { cwd: dir, timeout: 10_000 });
      writeFileSync(join(f.root, 'make-t3.sh'), 'touch ' + JSON.stringify(join(f.root, 't3-started')) + '; sleep 30\n');
      const a = f.spawn(['verify', '--src', dir]);
      await until(() => existsSync(join(f.root, 't3-started')), 60_000);
      process.kill(a.pid, 'SIGKILL');
      await a.exited;
      await killSession(f, 'tier-t3');
      const first = vmDirs(f)[0]!;
      writeFileSync(join(f.root, 'listed'), '');
      writeFileSync(join(f.root, 'make-t3.sh'), 'echo t3 ok\n');
      const b = f.run(['verify', '--src', dir]);
      const err = b.stderr.toString(), out = b.stdout.toString();
      expect(b.exitCode, err).toBe(0);
      expect(err).toMatch(/UBI_VERIFY_RESUME: tier=t1 reuse t1\.\d{10}\.\d+\.json \(\d+s\)\n/);
      expect(err).toMatch(/UBI_VERIFY_RESUME: tier=t2 reuse t2\.\d{10}\.\d+\.json \(\d+s\)\n/);
      expect(err).toMatch(/UBI_VERIFY_RESUME: tier=t3 run: interrupted \(only a start record, t3\.\d{10}\.\d+\.json\)\n/);
      expect(err).toContain('run record for ' + first + ': the VM is gone; starting a new one');
      expect(err).not.toContain('reattached to');
      expect(creates(f)).toBe(2);
      expect(readFileSync(join(f.vm, 'setup-count'), 'utf8')).toBe('boot\nboot\n');
      expect(out).not.toContain('ran: make t1');
      expect(out).toContain('t3 ok');
      expect(verifyLine(out)).toMatch(/^UBI_VERIFY: tree=[0-9a-f]{12} key=[0-9a-f]{12} tiers=3 passed=3 reused=t1,t2 failed=none prior_failures=none saved_s=\d+$/);
      expect(f.listed()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 120_000);

  test('verify tiers: a fail record blocks a rerun until --rerun-failed (then prior_failures); passes are reused unless stale, tampered, --no-resume or the tree changed', () => {
    const f = fakeVm();
    try {
      const dir = gitSrc(f, TIERS);
      writeFileSync(join(f.root, 'make-t2.sh'), 'echo t2 broke; exit 7\n');
      const first = run(f, ['verify', '--src', dir]);
      expect(first.exitCode, first.stderr.toString()).toBe(7);
      expect(first.stdout.toString()).not.toContain('ran: make t3');
      expect(verifyLine(first.stdout.toString())).toMatch(/ tiers=3 passed=1 reused=none failed=t2 prior_failures=none saved_s=0$/);
      expect(creates(f)).toBe(1);

      const blocked = run(f, ['verify', '--src', dir]);
      expect(blocked.exitCode).toBe(7);
      expect(blocked.stderr.toString()).toMatch(/UBI_VERIFY_RESUME: tier=t2 fail t2\.\d{10}\.\d+\.json \(\d+s, exit 7\): not rerun without --rerun-failed/);
      expect(verifyLine(blocked.stdout.toString())).toMatch(/ failed=t2 prior_failures=none /);
      expect(creates(f)).toBe(1);

      writeFileSync(join(f.root, 'make-t2.sh'), 'echo t2 fixed\n');
      const rerun = run(f, ['verify', '--src', dir, '--rerun-failed']);
      expect(rerun.exitCode, rerun.stderr.toString()).toBe(0);
      expect(rerun.stderr.toString()).toMatch(/UBI_VERIFY_RESUME: tier=t1 reuse /);
      expect(rerun.stderr.toString()).toMatch(/UBI_VERIFY_RESUME: tier=t2 run: prior fail t2\.\d{10}\.\d+\.json \(exit 7; --rerun-failed\)/);
      expect(verifyLine(rerun.stdout.toString())).toMatch(/ tiers=3 passed=3 reused=t1 failed=none prior_failures=t2:7 saved_s=\d+$/);
      expect(creates(f)).toBe(2);

      const all = run(f, ['verify', '--src', dir]);
      expect(all.exitCode).toBe(0);
      expect(verifyLine(all.stdout.toString())).toMatch(/ passed=3 reused=t1,t2,t3 failed=none prior_failures=none saved_s=\d+$/);
      expect(all.stderr.toString()).toContain('every tier passed under this key; no VM needed');
      expect(creates(f)).toBe(2);

      const probe = (args: string[] = [], extra: Record<string, string> = {}) => run(f, ['verify', '--src', dir, '--probe', ...args], extra).stderr.toString();
      expect(probe(['--no-resume'])).toMatch(/tier=t1 run: --no-resume\n[^]*tier=t2 run: --no-resume\n[^]*tier=t3 run: --no-resume\n/);
      expect(probe([], { UBI_CHECKPOINT_MAX_AGE: '0' })).toMatch(/tier=t1 run: pass t1\.\d{10}\.\d+\.json is \d+s old \(UBI_CHECKPOINT_MAX_AGE=0\)/);
      const keyDir = join(f.checkpoints, readdirSync(f.checkpoints)[0]!);
      const t1Log = readdirSync(keyDir).filter(n => n.startsWith('t1.') && n.endsWith('.log')).sort().at(-1)!;
      writeFileSync(join(keyDir, t1Log), 'tampered\n');
      const tampered = probe();
      expect(tampered).toMatch(/tier=t1 run: pass t1\.\d{10}\.\d+\.json: its log does not re-hash/);
      expect(tampered).toMatch(/tier=t2 reuse /);
      writeFileSync(join(dir, 'new-source.ts'), 'export {}\n');
      const moved = probe();
      for (const t of ['t1', 't2', 't3']) expect(moved).toContain('UBI_VERIFY_RESUME: tier=' + t + ' run: no record');
      expect(creates(f)).toBe(2);
      // Records are write-once JSON; every one carries its generation.
      const gens = readdirSync(keyDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(keyDir, n), 'utf8')).generation as number).sort((x, y) => x - y);
      expect(gens).toEqual(gens.map((_, i) => i + 1));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 120_000);

  test('verify tiers: a reattach whose VM TTL no longer covers the run left plus UBI_REATTACH_MARGIN starts a fresh VM, destroys the old one and reuses the passed tiers', async () => {
    const f = fakeVm();
    try {
      const dir = gitSrc(f, TIERS);
      bootCounts(f, dir);
      Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'boot'], { cwd: dir, timeout: 10_000 });
      writeFileSync(join(f.root, 'make-t3.sh'), 'touch ' + JSON.stringify(join(f.root, 't3-started')) + '; sleep 30\n');
      const env = { UBI_REAP: '0', UBI_TTL_HOURS: '1' };
      const a = f.spawn(['verify', '--src', dir], env);
      await until(() => existsSync(join(f.root, 't3-started')), 60_000);
      process.kill(a.pid, 'SIGKILL');
      await a.exited;
      const first = vmDirs(f)[0]!;
      expect(first).toMatch(/-t1$/);
      const probe = (extra: Record<string, string>) => run(f, ['verify', '--src', dir, '--probe'], { ...env, ...extra }).stdout.toString();
      expect(probe({})).toMatch(new RegExp('UBI_ATTACH_INFO: vm=' + first + ' created_at=\\d{10} '));
      // A 1 h TTL leaves about 3600 s: t3's 1200 s run timeout plus a 2700 s margin does not fit.
      const short = { UBI_RUN_TIMEOUT: '1200', UBI_REATTACH_MARGIN: '2700' };
      expect(probe(short)).toMatch(new RegExp('UBI_ATTACH_INFO: none key=[0-9a-f]{12} ttl_short vm=' + first + ' ttl_left=\\d+s needs=\\d+s \\(run still to do \\d+s \\+ UBI_REATTACH_MARGIN=2700s\\)'));
      expect(creates(f)).toBe(1);
      writeFileSync(join(f.root, 'make-t3.sh'), 'echo t3 ok\n');
      const b = run(f, ['verify', '--src', dir], { ...env, ...short });
      const err = b.stderr.toString();
      expect(b.exitCode, err).toBe(0);
      expect(err).toMatch(new RegExp('UBI_REATTACH_TTL_SHORT: vm=' + first + ' key=[0-9a-f]{12} ttl_left=\\d+s needs=\\d+s \\(run still to do \\d+s \\+ UBI_REATTACH_MARGIN=2700s\\): starting a fresh VM \\(tier checkpoints carry over\\) and destroying ' + first));
      expect(err).not.toContain('reattached to');
      expect(err).toMatch(/UBI_VERIFY_RESUME: tier=t1 reuse /);
      expect(err).toMatch(/UBI_VERIFY_RESUME: tier=t2 reuse /);
      expect(verifyLine(b.stdout.toString())).toMatch(/ tiers=3 passed=3 reused=t1,t2 failed=none /);
      expect(creates(f)).toBe(2);
      expect(f.listed()).toBe('');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 120_000);

  test('verify tiers: a writer whose start record is no longer the newest publishes nothing (stale writer)', () => {
    const py = /\nCKPT_PY='\n([^']*)'\n/.exec(readFileSync(join(DIR, 'ubi-runner.sh'), 'utf8'))![1]!;
    const root = mkdtempSync(join(tmpdir(), 'ubi-ckpt-'));
    try {
      const d = join(root, 'key');
      const log = join(root, 'tier.log'); writeFileSync(log, 'ok\n');
      const publish = (status: string, startgen: string, pid: string) => Bun.spawnSync(['python3', '-c', py, 'publish', d, 't1', status, 'vm', '100', '200', '0', status === 'start' ? '' : log, startgen, 'k', 'tree', pid], { timeout: 30_000 });
      expect(publish('start', '0', '1').stdout.toString().trim()).toBe('1');
      expect(publish('start', '0', '2').stdout.toString().trim()).toBe('2');
      const stale = publish('pass', '1', '1');
      expect(stale.exitCode).toBe(2);
      expect(stale.stderr.toString()).toContain('stale writer: its start record is generation 1, the newest for t1 is 2');
      expect(readdirSync(d).filter(n => n.endsWith('.json')).length).toBe(2);
      expect(publish('pass', '2', '2').stdout.toString().trim()).toBe('3');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('verify tiers: a tier that edits the source gets no pass record (UBI_VERIFY_TREE_MOVED) and reruns next time', () => {
    const f = fakeVm();
    try {
      const dir = gitSrc(f, { tiers: [{ name: 'mover', command: 'make mover' }, { name: 'clean', command: 'make clean' }] });
      writeFileSync(join(f.root, 'make-mover.sh'), 'echo edited > moved.txt\n');
      const r = run(f, ['verify', '--src', dir]);
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      expect(r.stderr.toString()).toMatch(/UBI_VERIFY_TREE_MOVED: tier=mover before=[0-9a-f]{12} after=[0-9a-f]{12}: a tier must leave the source tree as it found it; no pass record/);
      expect(verifyLine(r.stdout.toString())).toMatch(/ tiers=2 passed=2 reused=none failed=none /);
      const next = run(f, ['verify', '--src', dir, '--probe']).stderr.toString();
      expect(next).toMatch(/tier=mover run: interrupted \(only a start record/);
      expect(next).toMatch(/tier=clean reuse /);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 90_000);
});
