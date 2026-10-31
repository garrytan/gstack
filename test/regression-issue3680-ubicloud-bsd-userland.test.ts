/**
 * Regression tests for #3680 and #3679: scripts/ubicloud/ubi-runner.sh on the
 * BSD userland macOS ships.
 *
 *   #3680  pack built its archive with `tar --null -T - -c -C "$tmp" .git -zf -`.
 *          bsdtar stops reading options at the first operand (so -zf and - were
 *          file names) and resolves -T names after the -C (so the work-tree
 *          files were looked up in the temp dir): exit 1 and an archive holding
 *          only .git, after the VM was already created.
 *   #3679  usage's END block printed `o == me ? "  (you)" : ""` unparenthesized
 *          inside a printf list, a syntax error in the one-true-awk, so usage
 *          exited 2 and the vCPU quota preflight read no total and let every
 *          create through.
 *
 * Both need the real tools: macOS's /usr/bin/tar and /usr/bin/awk, or on Linux
 * `bsdtar` (libarchive-tools) and `original-awk`. Where a tool is missing its
 * cases are skipped, and the skip names the package. No network, no VM.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const RUNNER = join(ROOT, 'scripts/ubicloud/ubi-runner.sh');
const darwin = process.platform === 'darwin';
const bsdTar = darwin ? '/usr/bin/tar' : Bun.which('bsdtar');
const bwkAwk = darwin ? '/usr/bin/awk' : Bun.which('original-awk');

/** A directory to put first on PATH whose `tar` or `awk` is the BSD one. */
function bsdPath(root: string, tools: { tar?: string | null; awk?: string | null }) {
  const bin = join(root, 'bsd-bin');
  mkdirSync(bin, { recursive: true });
  if (tools.tar) symlinkSync(tools.tar, join(bin, 'tar'));
  if (tools.awk) symlinkSync(tools.awk, join(bin, 'awk'));
  return `${bin}:${process.env.PATH}`;
}

const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

describe(`ubi-runner pack under bsdtar (#3680)${bsdTar ? '' : ': skipped, no bsdtar (install libarchive-tools)'}`, () => {
  // Value: protects=pack writes a whole checkout under bsdtar (macOS's default tar), not an archive of .git alone; fails_when=pack passes tar options after an operand or resolves its -T list after a -C again; why_new=test/ubicloud-runner.test.ts runs pack only under GNU tar on Linux, so #3680 shipped green; seam=PATH (tar resolves to bsdtar); no_claim=the VM side's tar -xzf (GNU tar on Ubuntu, exercised by ubicloud-runner.test.ts)
  test.skipIf(!bsdTar)('pack ships tracked, staged, untracked, symlinked, spaced and option-like names, a linked worktree and an empty file list', () => {
    const d = mkdtempSync(join(tmpdir(), 'ubi-bsd-pack-'));
    try {
      const PATH = bsdPath(d, { tar: bsdTar });
      const sh = (cmd: string, cwd: string) => {
        const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, timeout: 30_000, env: { ...process.env, ...gitEnv, PATH } });
        expect(r.exitCode, `${cmd}\n${r.stderr.toString()}`).toBe(0);
        return r.stdout.toString();
      };
      expect(sh('tar --version', d)).toContain('bsdtar');
      const pack = (src: string, out: string) => sh(`bash ${JSON.stringify(RUNNER)} pack ${JSON.stringify(src)} > ${JSON.stringify(out)}`, d);
      const unpack = (tgz: string, dir: string) => { mkdirSync(join(d, dir)); sh(`tar -xzf ${JSON.stringify(tgz)} -C ${JSON.stringify(dir)}`, d); return join(d, dir); };
      const status = (cwd: string) => sh('git status --short', cwd).split('\n').filter(Boolean).sort();

      sh('git init -q plain && cd plain && echo a > a && echo b > gone && echo s > "with space" && ln -s a link && echo o > ./-C && echo o > ./--files-from=a && git add -A && git commit -qm one && rm gone && echo st > staged && git add staged && echo u > untracked && echo x > "untracked space"', d);
      pack('plain', 'plain.tgz');
      const listing = sh('tar -tzf plain.tgz', d).split('\n');
      expect(listing.some(l => l.endsWith('files.tar'))).toBe(false);
      const vm = unpack('plain.tgz', 'vm-plain');
      expect(status(vm)).toEqual(status(join(d, 'plain')));
      expect(status(vm)).toEqual([' D gone', '?? "untracked space"', '?? untracked', 'A  staged']);
      expect(readFileSync(join(vm, 'with space'), 'utf8')).toBe('s\n');
      expect(sh('readlink link', vm).trim()).toBe('a');
      expect(existsSync(join(vm, '-C')) && existsSync(join(vm, '--files-from=a'))).toBe(true);

      sh('git init -q main && cd main && echo a > a && git add a && git commit -qm one && git branch feat && git worktree add -q ../wt feat', d);
      sh('echo b > b && git add b && git commit -qm two && echo u > u && echo ignored > ig && echo ig > .gitignore', join(d, 'wt'));
      pack('wt', 'wt.tgz');
      const vmWt = unpack('wt.tgz', 'vm-wt');
      expect(existsSync(join(vmWt, 'ig'))).toBe(false);
      expect(sh('git rev-parse --abbrev-ref HEAD && git status --short && git log --oneline | wc -l', vmWt).replace(/\s+/g, ' ').trim()).toBe('feat ?? .gitignore ?? u 2');

      sh('git init -q empty && cd empty && echo a > a && git add a && git commit -qm one && rm a', d);
      pack('empty', 'empty.tgz');
      expect(status(unpack('empty.tgz', 'vm-empty'))).toEqual([' D a']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);
});

describe(`ubi-runner usage and the quota preflight under the one-true-awk (#3679)${bwkAwk ? '' : ': skipped, no one-true-awk (install original-awk)'}`, () => {
  /** Fake Ubicloud API: two VMs, a standard-4 owned by lane7 and a standard-16 another tool named; every call body goes to calls.log. */
  function fakeApi() {
    const root = mkdtempSync(join(tmpdir(), 'ubi-bsd-awk-'));
    const bin = join(root, 'bin'), log = join(root, 'calls.log');
    mkdirSync(bin); mkdirSync(join(root, 'state'));
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
body=$(cat); echo "$body" >> ${JSON.stringify(log)}
case "$body" in
  *'"list"'*) printf 'eu-central-h1 ubirun-lane7-1761900000-ab12-t3\\neu-north-h1 someone-elses-vm\\n' > "$out" ;;
  *lane7*'"show"'*) printf 'state: running\\nsize: standard-4\\n' > "$out" ;;
  *'"show"'*) printf 'state: running\\nsize: standard-16\\n' > "$out" ;;
  *) : > "$out" ;;
esac
printf 200
`);
    chmodSync(join(bin, 'curl'), 0o755);
    const PATH = bsdPath(root, { awk: bwkAwk });
    const env = { ...process.env, PATH: `${bin}:${PATH}`, UBICLOUD_API_KEY: 'offline', UBI_RUNNER_STATE: join(root, 'state'), UBI_VM_RECORD: join(root, 'vms.tsv'), UBI_OWNER: 'lane7', UBI_REAP: '0', UBI_POLL_SECONDS: '1' };
    const run = (args: string[], extra: Record<string, string> = {}) => Bun.spawnSync(['bash', RUNNER, ...args], { env: { ...env, ...extra }, timeout: 60_000 });
    return { root, run, env, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
  }

  // Value: protects=usage runs under macOS's awk and the vCPU preflight refuses over its ceiling there; fails_when=an awk program in the runner uses syntax the one-true-awk rejects, so usage dies and the preflight silently passes; why_new=the runner's awk ran only under mawk/gawk in CI, so #3679 shipped green; seam=PATH (awk resolves to the one-true-awk) and a fake curl; no_claim=real Ubicloud sizes and quota
  test.skipIf(!bwkAwk)('usage prints the per-owner table, and up refuses a create that would pass UBI_QUOTA_VCPUS', () => {
    const f = fakeApi();
    try {
      expect(Bun.spawnSync(['awk', '--version'], { env: f.env }).stdout.toString()).toContain('awk version');
      const usage = f.run(['usage']);
      expect(usage.stderr.toString()).toBe('');
      expect(usage.exitCode).toBe(0);
      expect(usage.stdout.toString()).toBe('OWNER           VMS  VCPUS\n(other)           1     16\nlane7             1      4  (you)\ntotal             2     20\n');
      const up = f.run(['up', '-s', 'standard-4'], { UBI_QUOTA_VCPUS: '16' });
      expect(up.exitCode).toBe(1);
      expect(up.stderr.toString()).toContain('it needs 4 vCPUs and the project\'s VMs already use 20 of 16');
      expect(up.stderr.toString()).toContain('create refused before any request: vCPU quota exhausted');
      expect(f.calls()).not.toContain('"create"');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);
});
