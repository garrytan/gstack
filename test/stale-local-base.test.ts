/**
 * A bare --base <branch> reads origin's tracking branch, not a stale local branch (GST-1036). Capy clones and linked
 * worktrees never move the local base branch, so `--base main` there merged against an old local main: review and ship
 * bins then counted upstream commits the branch only inherited (a docs diff planned at gate depth, banned terms and
 * prose findings in lines the branch never wrote). Every such bin resolves the base through resolveBase
 * (lib/gate-diff/git.ts) and names the ref it used.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BANNED_TERMS_SCHEMA } from '../lib/banned-terms';
import { resolveCommit } from '../lib/pr-shots';

const BIN = path.join(import.meta.dir, '..', 'bin');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-base-')));
  dirs.push(root);
  const work = path.join(root, 'work');
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n');
  const sh = (cwd: string, c: string) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git work 2>/dev/null');
  fs.mkdirSync(path.join(work, '.gstack'));
  fs.writeFileSync(path.join(work, '.gstack', 'banned-terms.json'), JSON.stringify({ $schema: BANNED_TERMS_SCHEMA, terms: ['frobnicate'] }) + '\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# t\n');
  sh(work, 'git add -A && git commit -qm base && git push -q origin main');
  sh(root, "git clone -q origin.git other && cd other && mkdir docs && printf 'Upstream notes frobnicate the parser.\\n\\nShowcasing vibrant features.\\n' > docs/up.md && git add -A && git commit -qm upstream && git push -q origin main");
  sh(work, "git fetch -q origin && git checkout -qb feat origin/main && mkdir src && echo 'export const v = 1;' > src/v.ts && git add -A && git commit -qm feat");
  const origin = sh(work, 'git rev-parse refs/remotes/origin/main');
  expect(sh(work, 'git rev-parse refs/heads/main')).not.toBe(origin);
  const run = (bin: string, args: string[]) => { const r = spawnSync(path.join(BIN, bin), args, { cwd: work, env, encoding: 'utf8', timeout: 180_000 }); return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }; };
  return { root, work, sh, run, origin };
}

const NOTE = 'local main is behind origin/main; base is origin/main';

describe('a bare --base reads origin/<base> over a stale local branch (GST-1036)', () => {
  // Value: protects=review-plan names the base ref its plan was computed against, so a stale-base plan shows in its output;
  //   fails_when=review-plan prints no REVIEW_BASE line, or names the local main while origin/main is ahead, or re-qualifies origin/main;
  //   why_new=GST-1036 (#3882 planned a docs diff at full depth against local main 319ef500); seam=bin/gstack-review-plan, lib/review-collect.ts collectLive
  test('gstack-review-plan prints the ref it used and why', () => {
    const { run, origin } = fixture();
    const bare = run('gstack-review-plan', ['--base', 'main']);
    expect(bare.status, bare.out + bare.err).toBe(0);
    expect(bare.out).toContain(`REVIEW_BASE: origin/main ${origin.slice(0, 12)}\n`);
    expect(bare.err).toContain(`gstack-review-plan: ${NOTE}`);
    const json = run('gstack-review-plan', ['--base', 'main', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ paths: ['src/v.ts'], base: { ref: 'origin/main', sha: origin, local: 'behind' } });
    const qualified = run('gstack-review-plan', ['--base', 'origin/main']);
    expect(qualified.out).toContain(`REVIEW_BASE: origin/main ${origin.slice(0, 12)}\n`);
    expect(qualified.err).not.toContain('base is');
  }, 240_000);

  // Value: protects=banned-terms scans only the lines the branch adds; fails_when=it merges against the stale local main and reports a term an upstream commit added;
  //   why_new=GST-1036 sibling bin (/review passes a bare <base>); seam=bin/gstack-banned-terms
  test('gstack-banned-terms check ignores inherited upstream lines', () => {
    const { run } = fixture();
    for (const base of ['main', 'origin/main']) {
      const r = run('gstack-banned-terms', ['check', '--base', base]);
      expect(r.status, r.out + r.err).toBe(0);
      expect(r.out).toContain('BANNED_TERMS: ok');
      expect(r.err).toContain(`gstack-banned-terms: ${NOTE}`);
    }
  }, 120_000);

  // Value: protects=without a remote-tracking twin the local base still stands, so the origin preference never hides lines;
  //   fails_when=the fix drops the local fallback; why_new=negative control for GST-1036; seam=bin/gstack-banned-terms
  test('no origin: gstack-banned-terms keeps the local main and reports what the branch carries over it', () => {
    const { sh, work, run } = fixture();
    sh(work, 'git remote remove origin');
    const r = run('gstack-banned-terms', ['check', '--base', 'main']);
    expect(r.status, r.out + r.err).toBe(1);
    expect(r.out).toContain('frobnicate');
    expect(r.err).not.toContain('base is');
  }, 120_000);

  // Value: protects=prose-lint --base lints only the lines the branch adds; fails_when=a bare base merges against the stale local main;
  //   why_new=GST-1036 sibling bin; seam=lib/prose-lint.ts addedOnly
  test('gstack-prose-lint --base main skips a file only upstream changed; origin/main is read as given', () => {
    const { run } = fixture();
    for (const base of ['main', 'origin/main']) {
      const r = run('gstack-prose-lint', ['docs/up.md', '--base', base, '--gate']);
      expect(r.status, r.out + r.err).toBe(0);
      expect(r.out).not.toContain('PROSE:');
    }
  }, 120_000);

  // Value: protects=the docs-audit snapshot selects only the branch's files; fails_when=--base main resolves to the stale local main and selects upstream docs;
  //   why_new=GST-1036 sibling bin; seam=bin/gstack-docs-candidate
  test('gstack-docs-candidate snapshot --base main records origin/main and selects only the branch', () => {
    const { root, run, origin } = fixture();
    const r = run('gstack-docs-candidate', ['snapshot', '--out', path.join(root, 'c.json'), '--audit-id', 'a1', '--mode', 'read-only', '--base', 'main']);
    expect(r.status, r.out + r.err).toBe(0);
    expect(r.out).toContain(`base=${origin} `);
    expect(r.out).toContain('committed: "src/v.ts"\n');
    expect(r.err).toContain(`gstack-docs-candidate: ${NOTE}`);
  }, 120_000);

  // Value: protects=the PR screenshot's before side is origin's base, not a stale local copy; fails_when=resolveCommit reads refs/heads/main first;
  //   why_new=GST-1036 sibling bin; seam=lib/pr-shots.ts resolveCommit
  test('gstack-pr-shots --base main reads origin/main; a sha resolves as given', () => {
    const { work, sh, origin } = fixture();
    expect(resolveCommit(work, 'main')).toBe(origin);
    const local = sh(work, 'git rev-parse refs/heads/main');
    expect(resolveCommit(work, local)).toBe(local);
  }, 120_000);
});
