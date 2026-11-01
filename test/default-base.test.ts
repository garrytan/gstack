/**
 * GST-774: a Capy machine checked out at a PR branch has refs/remotes/origin/HEAD naming that branch and
 * no local main. The default base must not be the checked-out branch (lib/default-base.ts, the GST-511
 * rule), and every base-relative step refuses a base that is HEAD or already contains it while the
 * branch has commits its real base lacks (BASE_CONTAINS_HEAD) instead of reporting no changes. The
 * control is a normal clone on the same feature branch with origin/HEAD naming main and a local main.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baseContainsHead, defaultBaseBranch } from '../lib/default-base';
import { buildContext } from '../lib/pregate/context';
import { runScriptSync } from '../lib/script-invocation';
import { extractReceipt } from '../lib/ship-receipt';
import { bindShippedReceipt } from '../lib/ship-receipt-depth';
import { resolveBaseBranch } from '../lib/ship-policy';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = (name: string) => path.join(ROOT, 'bin', name);
const big = Array.from({ length: 80 }, (_, i) => `exports.f${i} = () => ${i};`).join('\n') + '\n';

interface Fx { root: string; origin: string; clone: string; control: string; noMain: string; home: string; failGh: string; releaseGh: string; env: Record<string, string> }
let fx: Fx;

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = fx.env) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
function bin(name: string, args: string[], cwd: string, extra: Record<string, string> = {}) {
  const r = runScriptSync(BIN(name), args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...fx.env, ...extra } });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const stub = (dir: string, body: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return dir; };

beforeAll(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gst774-')));
  expect(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).status).not.toBe(0);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = fixture\n\temail = fixture@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const failGh = stub(path.join(root, 'gh-fail'), 'exit 1');
  const releaseGh = stub(path.join(root, 'gh-release'), 'echo release');
  const env = { HOME: home, GSTACK_STATE_ROOT: home, GSTACK_HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', PATH: `${failGh}${path.delimiter}${process.env.PATH}` };
  fx = { root, origin: path.join(root, 'origin.git'), clone: path.join(root, 'clone'), control: path.join(root, 'control'), noMain: path.join(root, 'nomain'), home, failGh, releaseGh, env };
  const seed = path.join(root, 'seed');
  run('git', ['init', '-q', '--bare', '-b', 'main', fx.origin], root);
  run('git', ['init', '-q', '-b', 'main', seed], root);
  fs.mkdirSync(path.join(seed, 'lib'));
  fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(seed, 'lib', 'app.js'), 'exports.app = () => 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  expect(git(seed, 'log', '-1', '--format=%an <%ae>')).toBe('fixture <fixture@test>');
  git(seed, 'remote', 'add', 'origin', fx.origin);
  git(seed, 'push', '-q', 'origin', 'main', 'main:release');
  git(seed, 'checkout', '-q', '-b', 'pr-branch');
  fs.writeFileSync(path.join(seed, 'lib', 'big.js'), big);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'pr change');
  git(seed, 'push', '-q', 'origin', 'pr-branch');

  run('git', ['clone', '-q', '--branch', 'pr-branch', fx.origin, fx.clone], root);
  git(fx.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/pr-branch');
  run('git', ['clone', '-q', fx.origin, fx.control], root);
  git(fx.control, 'checkout', '-q', '-b', 'pr-branch', 'origin/pr-branch');

  const nomainOrigin = path.join(root, 'nomain.git');
  run('git', ['clone', '-q', '--bare', fx.origin, nomainOrigin], root);
  git(nomainOrigin, 'branch', '-m', 'main', 'trunk');
  git(nomainOrigin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  run('git', ['clone', '-q', '--branch', 'pr-branch', nomainOrigin, fx.noMain], root);
  git(fx.noMain, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/pr-branch');
});
afterAll(() => { if (fx) fs.rmSync(fx.root, { recursive: true, force: true }); });

describe('the fixture is the reported checkout', () => {
  // Value: protects=every case below reads the GST-774 shape, outside any checkout and with its own state root; fails_when=the
  //   clone has a local main or origin/HEAD names main, or state resolves into the operator's root; seam=none
  test('the clone is on the PR branch, origin/HEAD names it, there is no local main, and state resolves into the fixture', () => {
    expect(git(fx.clone, 'symbolic-ref', '--short', 'HEAD')).toBe('pr-branch');
    expect(git(fx.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/pr-branch');
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { cwd: fx.clone, timeout: 10_000 }).status).not.toBe(0);
    expect(git(fx.clone, 'rev-parse', 'origin/main')).toBe(git(fx.control, 'rev-parse', 'main'));
    expect(git(fx.control, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
    expect(git(fx.clone, 'rev-parse', '--show-toplevel')).toBe(fx.clone);
    expect(bin('gstack-paths', ['--get', 'GSTACK_STATE_ROOT'], fx.clone).out.trim()).toBe(fx.home);
    const slug = bin('gstack-slug', ['--get', 'SLUG'], fx.clone);
    expect(slug.status).toBe(0);
    expect(slug.out.trim()).not.toBe('');
  });
});

describe('resolveBaseBranch skips an origin/HEAD that names the checked-out branch', () => {
  // Value: protects=ship-queue, pregate and the receipt writer default to the PR's real base, never the branch itself; fails_when=
  //   origin/HEAD naming the PR branch is taken as the base; seam=lib/default-base.ts
  test('origin/main on the bug checkout, the PR base when gh names one, explicit --base as given; the control is unchanged', () => {
    withEnv(fx.env, () => {
      expect(resolveBaseBranch(fx.clone)).toBe('main');
      expect(resolveBaseBranch(fx.clone, 'pr-branch')).toBe('pr-branch');
      expect(resolveBaseBranch(fx.control)).toBe('main');
      git(fx.control, 'checkout', '-q', 'main');
      try { expect(resolveBaseBranch(fx.control)).toBe('main'); } finally { git(fx.control, 'checkout', '-q', 'pr-branch'); }
    });
    withEnv({ ...fx.env, PATH: `${fx.releaseGh}${path.delimiter}${process.env.PATH}` }, () => expect(resolveBaseBranch(fx.clone)).toBe('release'));
  });
});

describe('the review depth ship-queue ready binds', () => {
  // Value: protects=a READY on the bug checkout never binds a light depth for an 80-line diff; fails_when=the queue compares the
  //   PR head with itself and reports required=light runtime_lines=0; seam=bindShippedReceipt
  test('origin/<PR branch> refuses BASE_CONTAINS_HEAD; the resolved default base binds standard; the control binds the same', () => {
    const body = path.join(fx.root, 'body.md');
    const w = bin('gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], fx.clone);
    expect(w.status, w.err).toBe(0);
    const text = fs.readFileSync(body, 'utf8');
    expect(extractReceipt(text).receipt!.review_depth).toMatchObject({ depth: 'standard', runtime_lines: 80 });
    const head = git(fx.clone, 'rev-parse', 'HEAD');
    withEnv(fx.env, () => {
      const self = bindShippedReceipt(fx.clone, 'origin/pr-branch', text, '7', [head]);
      expect(self.ok).toBe(false);
      if (self.ok) return;
      expect(self.code as string).toBe('BASE_CONTAINS_HEAD');
      expect(self.message).toContain(head.slice(0, 12));
      const real = bindShippedReceipt(fx.clone, `origin/${resolveBaseBranch(fx.clone)}`, text, '7', [head]);
      expect(real.ok && real.depthLine).toContain('receipt=standard required=standard runtime_lines=80 class=code');
      const control = bindShippedReceipt(fx.control, `origin/${resolveBaseBranch(fx.control)}`, text, '7', [head]);
      expect(control.ok && control.depthLine).toContain('receipt=standard required=standard runtime_lines=80 class=code');
    });
  }, 120_000);
});

describe('gstack-review-plan', () => {
  // Value: protects=/ship's review plan never plans light for a diff it compared with itself; fails_when=--base <PR branch> plans
  //   REVIEW_DEPTH light runtime_lines=0; seam=bin/gstack-review-plan
  test('--base <PR branch> refuses; --base main plans the same depth on the bug checkout and the control; main itself plans an empty diff', () => {
    const self = bin('gstack-review-plan', ['--base', 'pr-branch'], fx.clone);
    expect(self.status).toBe(1);
    expect(self.err).toContain('(BASE_CONTAINS_HEAD)');
    const depth = (out: string) => /^REVIEW_DEPTH: .*$/m.exec(out)?.[0];
    const real = bin('gstack-review-plan', ['--base', 'main'], fx.clone);
    expect(real.status, real.err).toBe(0);
    expect(depth(real.out)).toContain('REVIEW_DEPTH: standard runtime_lines=80');
    const control = bin('gstack-review-plan', ['--base', 'main'], fx.control);
    expect(depth(control.out)).toBe(depth(real.out));
    git(fx.control, 'checkout', '-q', 'main');
    try {
      const onMain = bin('gstack-review-plan', ['--base', 'main'], fx.control);
      expect(onMain.status, onMain.err).toBe(0);
      expect(depth(onMain.out)).toContain('runtime_lines=0');
    } finally { git(fx.control, 'checkout', '-q', 'pr-branch'); }
  }, 120_000);
});

describe('the pregate base and the sealed policy base', () => {
  // Value: protects=the pregate selects the PR's files and reads the base branch's policy, never the PR branch's; fails_when=the
  //   default base is the PR branch, so 0 files are touched and the policy is the PR's own; seam=buildContext, cmdSealed
  const load = (cwd: string, base: string) => buildContext({ repoRoot: cwd, base, policyFrom: 'base', allowRepoCommands: false, cores: 64, testBackend: 'local', env: { ...process.env, ...fx.env }, progress: () => {} });
  test('the default base is main with the PR file touched; an explicit PR-branch base refuses; the control and main itself are unchanged', () => {
    withEnv(fx.env, () => {
      const bug = load(fx.clone, resolveBaseBranch(fx.clone));
      expect('ctx' in bug && { base: bug.ctx.base, touched: bug.ctx.touched.map(t => t.path) }).toEqual({ base: 'main', touched: ['lib/big.js'] });
      const self = load(fx.clone, 'pr-branch');
      expect('refused' in self && (self.refused.code as string)).toBe('BASE_CONTAINS_HEAD');
      const control = load(fx.control, resolveBaseBranch(fx.control));
      expect('ctx' in control && { base: control.ctx.base, touched: control.ctx.touched.map(t => t.path) }).toEqual({ base: 'main', touched: ['lib/big.js'] });
      git(fx.control, 'checkout', '-q', 'main');
      try {
        const onMain = load(fx.control, resolveBaseBranch(fx.control));
        expect('ctx' in onMain && onMain.ctx.touched).toEqual([]);
      } finally { git(fx.control, 'checkout', '-q', 'pr-branch'); }
    });
  }, 120_000);

  test('sealed reads the policy from origin/main by default and refuses an explicit PR-branch base', () => {
    const bug = bin('gstack-pregate', ['sealed'], fx.clone);
    expect(bug.status, bug.err).toBe(0);
    expect(bug.out).toContain('policy=no sealed key on refs/remotes/origin/main or HEAD');
    const self = bin('gstack-pregate', ['sealed', '--base', 'pr-branch'], fx.clone);
    expect(self.status).not.toBe(0);
    expect(self.err).toContain('(BASE_CONTAINS_HEAD)');
    const control = bin('gstack-pregate', ['sealed'], fx.control);
    expect(control.out).toBe(bug.out);
  }, 120_000);
});

describe('gstack-gate-diff and gstack-diff-scope defaults', () => {
  // Value: protects=the gate scan and the scope flags read the PR's diff on the bug checkout; fails_when=the default base is the
  //   PR branch, so the scan lists nothing and every scope flag is false with exit 0; seam=lib/gate-diff/git.ts, bin/gstack-diff-scope
  test('gate-diff: the default diffs against origin/main like the control; the PR branch refuses; no resolvable default fails closed', () => {
    const summary = (out: string) => /^GATE_SUMMARY: .*$/m.exec(out)?.[0];
    const bug = bin('gstack-gate-diff', [], fx.clone);
    expect(bug.status, bug.out + bug.err).toBe(0);
    const control = bin('gstack-gate-diff', [], fx.control);
    expect(control.status, control.out + control.err).toBe(0);
    expect(summary(bug.out)).toBe(summary(control.out));
    expect(summary(bug.out)).toContain('unmatched=1');
    const self = bin('gstack-gate-diff', ['pr-branch'], fx.clone);
    expect(self.status).toBe(2);
    expect(self.out).toStartWith('GATE_ERROR=base_contains_head ref=pr-branch');
    const none = bin('gstack-gate-diff', [], fx.noMain);
    expect(none.status).toBe(2);
    expect(none.out).toStartWith('GATE_ERROR=no_base ref=origin/HEAD target=origin/pr-branch');
  }, 120_000);

  test('diff-scope: the default reads the PR file like the control; the PR branch refuses; main and a fresh branch keep today\'s output', () => {
    const bug = bin('gstack-diff-scope', [], fx.clone);
    expect(bug.status, bug.out + bug.err).toBe(0);
    expect(bug.out).toContain('SCOPE_BACKEND=true');
    const control = bin('gstack-diff-scope', [], fx.control);
    expect(control.out).toBe(bug.out);
    const self = bin('gstack-diff-scope', ['pr-branch'], fx.clone);
    expect(self.status).toBe(2);
    expect(self.out).toContain('SCOPE_ERROR=base_contains_head');
    const none = bin('gstack-diff-scope', [], fx.noMain);
    expect(none.status).toBe(2);
    expect(none.out).toContain('SCOPE_ERROR=no_base');
    git(fx.control, 'checkout', '-q', 'main');
    try {
      const onMain = bin('gstack-diff-scope', [], fx.control);
      expect(onMain.status).toBe(0);
      expect(onMain.out).not.toContain('=true');
      git(fx.control, 'checkout', '-q', '-b', 'fresh');
      fs.writeFileSync(path.join(fx.control, 'lib', 'app.js'), 'exports.app = () => 2;\n');
      const fresh = bin('gstack-diff-scope', ['main'], fx.control);
      expect(fresh.status, fresh.out).toBe(0);
      expect(fresh.out).toContain('SCOPE_BACKEND=true');
    } finally { git(fx.control, 'checkout', '-q', '--', 'lib/app.js'); git(fx.control, 'checkout', '-q', 'pr-branch'); }
  }, 120_000);
});

describe('the docs-audit base', () => {
  // Value: protects=/ship's documentation audit selects the PR's files; fails_when=the snapshot's base is the PR head, so it
  //   selects nothing and every later freshness check passes; seam=bin/gstack-docs-candidate snapshot
  test('snapshot refuses a base that is HEAD; the merge base with origin/main selects the PR file like the control', () => {
    const snap = (cwd: string, base: string, name: string) => bin('gstack-docs-candidate', ['snapshot', '--out', path.join(fx.root, `${name}.json`), '--audit-id', name, '--mode', 'read-only', '--base', base], cwd);
    const self = snap(fx.clone, git(fx.clone, 'rev-parse', 'origin/pr-branch'), 'self');
    expect(self.status).not.toBe(0);
    expect(self.err).toContain('(BASE_CONTAINS_HEAD)');
    const real = snap(fx.clone, git(fx.clone, 'merge-base', 'origin/main', 'HEAD'), 'real');
    expect(real.status, real.err).toBe(0);
    expect(real.out).toContain('committed: "lib/big.js"');
    const control = snap(fx.control, git(fx.control, 'merge-base', 'origin/main', 'HEAD'), 'control');
    expect(control.out.split('\n').slice(2).join('\n')).toBe(real.out.split('\n').slice(2).join('\n'));
  }, 120_000);
});

describe('baseContainsHead keeps today\'s result where the branch is not compared with itself', () => {
  // Value: protects=the guard refuses only a self-comparison and never the base branch, a detached checkout or a fresh branch;
  //   fails_when=the refusal fires on main, on a CI-style detached HEAD or on a branch with only uncommitted work; seam=lib/default-base.ts
  test('null on main, detached at the PR head and on a fresh branch; a PR head the base contains refuses; no default resolves past a skipped origin/HEAD', () => {
    withEnv(fx.env, () => {
      const head = git(fx.clone, 'rev-parse', 'HEAD');
      expect(baseContainsHead(fx.clone, 'origin/pr-branch')).toContain('on pr-branch, whose commits origin/main lacks; the real base is main');
      expect(baseContainsHead(fx.clone, 'origin/main')).toBeNull();
      expect(baseContainsHead(fx.clone, 'origin/pr-branch', head)).toContain(`the head ${head.slice(0, 12)}`);
      expect(baseContainsHead(fx.clone, 'origin/main', head)).toBeNull();
      git(fx.clone, 'checkout', '-q', '--detach', head);
      try { expect(baseContainsHead(fx.clone, 'origin/pr-branch')).toBeNull(); } finally { git(fx.clone, 'checkout', '-q', 'pr-branch'); }
      git(fx.control, 'checkout', '-q', 'main');
      try {
        expect(baseContainsHead(fx.control, 'origin/main')).toBeNull();
        git(fx.control, 'checkout', '-q', '-b', 'fresh-2');
        expect(baseContainsHead(fx.control, 'origin/main')).toBeNull();
        expect(bin('gstack-review-plan', ['--base', 'main'], fx.control).status).toBe(0);
      } finally { git(fx.control, 'checkout', '-q', 'pr-branch'); }
      expect(defaultBaseBranch(fx.noMain)).toEqual({ branch: null, skipped: { remote: 'origin', branch: 'pr-branch' } });
      expect(defaultBaseBranch(fx.control)).toEqual({ branch: 'main', remote: 'origin' });
    });
  }, 120_000);
});
