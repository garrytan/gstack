import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Step 1 item 3's commands from the /review template, run in order, with `<base>` bound. */
function stepOneBlock(base: string): string {
  const body = fs.readFileSync(path.join(ROOT, 'review/SKILL.md.tmpl'), 'utf8');
  const item = body.slice(body.indexOf('3. Run `git fetch origin <base>'), body.indexOf('{{SCOPE_DRIFT}}'));
  const commands = [...item.matchAll(/`(git fetch [^`]+|DIFF_BASE=[^`]+)`/g)].map(m => m[1]!);
  if (commands.length !== 2) throw new Error('Step 1 item 3 commands moved');
  return commands.join('\n').replaceAll('<base>', base);
}

function clone() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-base-refresh-')));
  roots.push(root);
  const upstream = path.join(root, 'upstream');
  git(root, 'init', '-q', '-b', 'main', upstream);
  git(upstream, 'config', 'user.email', 't@t'); git(upstream, 'config', 'user.name', 't'); git(upstream, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(upstream, 'app.ts'), 'export const a = 1;\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'base');
  const repo = path.join(root, 'repo');
  git(root, 'clone', '-q', upstream, repo);
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 2;\n');
  git(repo, 'commit', '-qam', 'change');
  return { root, repo };
}

const run = (cwd: string, script: string) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', timeout: 20_000 });

describe('/review Step 1 base refresh', () => {
  test('a failed fetch reports stale base coverage and still finds the diff', () => {
    // E4: under Codex's read-only .git, `git fetch && merge-base && diff --stat` stopped at the fetch,
    // so the empty output read as "Nothing to review".
    const { repo } = clone();
    git(repo, 'remote', 'set-url', 'origin', path.join(repo, 'no-such-remote'));
    const result = run(repo, stepOneBlock('main'));
    const rev = git(repo, 'rev-parse', '--short', 'origin/main');
    expect(result.stdout).toContain(`BASE_REFRESH: stale ${rev}`);
    expect(result.stdout).toMatch(/app\.ts \| 2 \+-/);
  });

  test('a working fetch reports fresh coverage and the same diff', () => {
    const { repo } = clone();
    const result = run(repo, stepOneBlock('main'));
    expect(result.stdout).toContain('BASE_REFRESH: fresh');
    expect(result.stdout).toMatch(/app\.ts \| 2 \+-/);
  });

  test('the review reports stale coverage instead of stopping', () => {
    const body = fs.readFileSync(path.join(ROOT, 'review/SKILL.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
    expect(body).toContain('`stale` is not an empty diff: continue; report `Base coverage: stale at <revision>`.');
    expect(body).not.toContain('git fetch origin <base> --quiet && DIFF_BASE=');
  });
});
