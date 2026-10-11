/**
 * Fixture repo for the C-stamp tests (gstack-ship-policy, gstack-restamp,
 * gstack-tree-receipt, gstack-ship-receipt): a bare origin plus a working
 * clone with a 4-digit VERSION, a package.json and lockfile, a CHANGELOG, a
 * `release:restamp` script that regenerates `generated/digest.md` from
 * VERSION, docs with `since:` / `vX` / `(was X)` mentions, and a committed
 * `.gstack/ship-policy.json`. Everything lives under os.tmpdir(), outside
 * any checkout, with its own hermetic git identity.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitArgvIn } from './scratch-repo';
import { mergeChangelogs } from '../../lib/changelog-check';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const BIN = (name: string) => path.join(ROOT, 'bin', name);

export interface FixtureRepo { root: string; work: string; origin: string; home: string; git: (...args: string[]) => string; env: Record<string, string> }

export const BASE_POLICY = {
  $schema: 'https://github.com/garrytan/gstack/docs/ship-policy.md#schema-v1',
  bump: 'patch',
  queue_mode: 'stamp-at-merge',
  release_tool: 'node gen.js',
  release_outputs: ['generated/**'],
  stamp_paths: ['docs/**/*.md'],
  changelog: 'CHANGELOG.md',
  history: 'squash-ok',
  stamp_sensitive_gates: ['digest'],
};

export function makeFixtureRepo(opts: { policy?: Record<string, unknown> | null; version?: string; prefix?: string } = {}): FixtureRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? 'gstack-restamp-fx-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const env = { GSTACK_HOME: home, GSTACK_STATE_DIR: home, HOME: home, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]): string => {
    const r = gitArgvIn(work, args, 30_000, { ...process.env, ...env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString()}`);
    return r.stdout?.toString().trim() ?? '';
  };
  spawnSync('git', ['init', '-q', '--bare', origin], { timeout: 30_000, env: { ...process.env, ...env } });
  git('init', '-q', '-b', 'main');
  const version = opts.version ?? '1.2.3.0';
  const npm = version.split('.').slice(0, 3).join('.');
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'generated'), { recursive: true });
  fs.mkdirSync(path.join(work, '.gstack'), { recursive: true });
  fs.writeFileSync(path.join(work, 'VERSION'), version + '\n');
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'fixture', version: npm, scripts: { 'release:restamp': 'node gen.js' }, dependencies: { 'left-pad': '1.2.3' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: npm, lockfileVersion: 3, packages: { '': { name: 'fixture', version: npm, dependencies: { 'left-pad': '1.2.3' } }, 'node_modules/left-pad': { version: '1.2.3' } } }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'gen.js'), "const fs=require('fs');const v=fs.readFileSync('VERSION','utf8').trim();fs.writeFileSync('generated/digest.md',`# digest v${v}\\nbody\\n`);\n");
  fs.writeFileSync(path.join(work, 'generated', 'digest.md'), `# digest v${version}\nbody\n`);
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-10-01\n\n- base release\n\n## [1.2.2.0] - 2026-09-01\n\n- older\n`);
  fs.writeFileSync(path.join(work, 'docs', 'notes.md'), `Previous release v${version}.\nleft-pad pinned at 1.2.3 (was 1.2.2)\n`);
  if (opts.policy !== null) fs.writeFileSync(path.join(work, '.gstack', 'ship-policy.json'), JSON.stringify(opts.policy ?? BASE_POLICY, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', `base ${version}`);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  return { root, work, origin, home, git, env };
}

/** A PR branch from origin/main with an `[Unreleased]` CHANGELOG entry and a doc mentioning the version it expects. */
export function makePr(repo: FixtureRepo, branch: string, opts: { expects?: string; file?: string; changelog?: boolean } = {}): string {
  repo.git('checkout', '-q', 'origin/main', '-b', branch);
  const file = opts.file ?? `${branch}.txt`;
  fs.writeFileSync(path.join(repo.work, file), `${branch}\n`);
  if (opts.changelog !== false) {
    const cl = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), cl.replace('# Changelog\n', `# Changelog\n\n## [Unreleased]\n\n- ${branch} change\n`));
  }
  if (opts.expects) fs.writeFileSync(path.join(repo.work, 'docs', `${branch}.md`), `since: ${opts.expects}\nRequires v${opts.expects} or later.\n`);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `feat ${branch}`);
  return repo.git('rev-parse', 'HEAD');
}

export function runBin(repo: FixtureRepo, name: string, args: string[], extraEnv: Record<string, string> = {}, cwd = repo.work) {
  const r = spawnSync(BIN(name), args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...repo.env, ...extraEnv } });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function restamp(repo: FixtureRepo, args: string[], extraEnv: Record<string, string> = {}) {
  return runBin(repo, 'gstack-restamp', ['--base', 'main', '--allow-repo-commands', ...args], extraEnv);
}

export function readFile(repo: FixtureRepo, rel: string): string {
  return fs.readFileSync(path.join(repo.work, rel), 'utf8');
}

/** Merge a branch into origin/main with a merge commit (the coordinator's merge) and return the new main head. */
export function mergeToMain(repo: FixtureRepo, branch: string): string {
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-ff', '--no-edit', branch);
  repo.git('push', '-q', 'origin', 'main');
  return repo.git('rev-parse', 'HEAD');
}

/**
 * Integrate origin/main into the checked-out branch the way /ship does at its
 * turn: a plain merge, with a CHANGELOG conflict resolved by lib/changelog-check
 * (the branch's Unreleased entries above main's released sections) and a version
 * file conflict taken from main. Any other conflict throws.
 */
export function mergeMain(repo: FixtureRepo): string {
  const r = gitArgvIn(repo.work, ['merge', '--no-ff', '--no-edit', '-q', 'origin/main'], 30_000, { ...process.env, ...repo.env });
  if (r.status !== 0) {
    const conflicts = repo.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    for (const c of conflicts) {
      if (c === 'CHANGELOG.md') {
        const merged = mergeChangelogs(repo.git('show', `:2:${c}`) + '\n', repo.git('show', `:3:${c}`) + '\n');
        if (merged === null) throw new Error(`fixture merge: CHANGELOG conflict is not a heading move`);
        fs.writeFileSync(path.join(repo.work, c), merged);
      } else if (/^(VERSION|package(-lock)?\.json)$/.test(c)) repo.git('checkout', '--theirs', '--', c);
      else throw new Error(`fixture merge: unexpected conflict in ${c}`);
    }
    repo.git('add', '--', ...conflicts);
    repo.git('commit', '-q', '--no-edit');
  }
  return repo.git('rev-parse', 'HEAD');
}

export function cleanup(repo: FixtureRepo): void {
  fs.rmSync(repo.root, { recursive: true, force: true });
}

/**
 * A `gh` on PATH that answers `gh pr view <n> --json ...` from a map of PR
 * number → JSON object and `gh pr list` with a fixed array, so queue-order
 * and PREDECESSOR MOVED checks run without the network.
 */
export function ghShim(repo: FixtureRepo, prs: Record<string, unknown>, list: unknown[] = []): { PATH: string } {
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prs.json'), JSON.stringify({ prs, list }));
  const script = [
    '#!/bin/sh',
    `DATA="${path.join(dir, 'prs.json')}"`,
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  node -e "const d=require(process.argv[1]);const p=d.prs[process.argv[2]];if(!p){console.error(\'no such pr\');process.exit(1)}console.log(JSON.stringify(p))" "$DATA" "$3"',
    '  exit $?',
    'fi',
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then node -e "console.log(JSON.stringify(require(process.argv[1]).list))" "$DATA"; exit $?; fi',
    'echo "gh shim: unsupported $*" >&2; exit 1',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

/** Record one evidence lane on the current HEAD of `cwd` and export a bundle for it. */
export function recordAndBundle(repo: FixtureRepo, cwd: string, lanes: Array<{ label: string; command: string }>, out: string, extraEnv: Record<string, string> = {}): string {
  for (const lane of lanes) {
    const r = runBin(repo, 'gstack-evidence', ['run', '--label', lane.label, '--', lane.command], extraEnv, cwd);
    if (r.status !== 0) throw new Error(`lane ${lane.label} failed: ${r.err}`);
  }
  const args = ['bundle', '--out', out, '--base', 'main', '--require', lanes.map(l => l.label).join(',')];
  for (const lane of lanes) args.push('--label', lane.label);
  const b = runBin(repo, 'gstack-evidence', args, extraEnv, cwd);
  if (b.status !== 0) throw new Error(`bundle failed: ${b.err} ${b.out}`);
  return b.out;
}
