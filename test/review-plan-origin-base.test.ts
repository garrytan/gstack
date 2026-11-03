/**
 * gstack-review-plan and gstack-gate-diff diff against origin/<base> (GST-883): with a local <base> that lags
 * origin/<base>, review-plan handed the raw name to gstack-gate-diff, which merged against the stale local ref and
 * scanned upstream commits the branch only inherited, so a code diff planned as gate class at full depth.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PLAN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const GATE_DIFF = path.join(import.meta.dir, '..', 'bin', 'gstack-gate-diff');
const FIXTURES = path.join(import.meta.dir, 'fixtures', 'gate-diff');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-origin-')));
  dirs.push(root);
  const work = path.join(root, 'work');
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n');
  const sh = (cwd: string, c: string) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git work 2>/dev/null');
  sh(work, `git apply '${FIXTURES}/rh1-skip.base.patch' && git add -A && git commit -qm base && git push -q origin main`);
  sh(root, `git clone -q origin.git other && cd other && git apply '${FIXTURES}/rh1-skip.patch' && git commit -qam upstream && git push -q origin main`);
  sh(work, "git fetch -q origin && git checkout -qb feat origin/main && echo 'export const v = 1;' > src/v.ts && git add -A && git commit -qm feat");
  return { work, env, sh };
}

const planOf = (work: string, env: NodeJS.ProcessEnv) => {
  const r = spawnSync(PLAN, ['--base', 'main', '--json'], { cwd: work, env, encoding: 'utf8', timeout: 180_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const p = JSON.parse(r.stdout) as { class: string; depth: string; gate_scan: unknown };
  return { class: p.class, depth: p.depth, gate_scan: p.gate_scan };
};
const gateDiff = (work: string, env: NodeJS.ProcessEnv, base: string) => {
  const r = spawnSync(GATE_DIFF, [base], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return { tagged: /tagged=\{([^}]*)\}/.exec(r.stdout)?.[1], candidate: /candidate=(\S+)/.exec(r.stdout)?.[1], stderr: r.stderr };
};

describe('review-plan and gate-diff read the origin merge base (GST-883)', () => {
  // Value: protects=a stale local <base> never turns inherited upstream commits into gate hunks that force full depth;
  //   fails_when=gstack-gate-diff merges against the local <base> while origin/<base> is ahead, or review-plan hands it a base the plan's own diff did not use;
  //   why_new=GEVA-117 paid ~15-20M tokens of full-depth readers for a gate hunk already on origin/main; seam=bin/gstack-review-plan, bin/gstack-gate-diff;
  //   no_claim=which gate rules fire
  test('local main behind origin/main plans the same class, depth and gate-tagged count as a fresh main', () => {
    const { work, env, sh } = fixture();
    expect(sh(work, 'git merge-base main HEAD')).not.toBe(sh(work, 'git merge-base origin/main HEAD'));
    const stale = { plan: planOf(work, env), tags: gateDiff(work, env, 'main').tagged };
    sh(work, 'git branch -f main origin/main');
    const fresh = { plan: planOf(work, env), tags: gateDiff(work, env, 'main').tagged };
    expect(fresh).toEqual({ plan: { class: 'code', depth: 'light', gate_scan: expect.anything() }, tags: '' });
    expect(stale).toEqual(fresh);
  }, 240_000);

  // Value: protects=a tag cannot stand in for the base branch, so it cannot move the merge base to HEAD and hide committed edits;
  //   fails_when=resolveBase or collectLive read `origin/main` or `main` by short name while a tag of that name exists;
  //   why_new=outside-voice finding on the whole diff (shadow tag reproduced); seam=bin/gstack-review-plan, bin/gstack-gate-diff
  for (const [tag, branch] of [['origin/main', 'refs/remotes/origin/main'], ['main', 'refs/heads/main']] as const) {
    test(`a tag named ${tag} at HEAD does not shadow ${branch}`, () => {
      const { work, env, sh } = fixture();
      if (branch === 'refs/heads/main') sh(work, 'git remote remove origin');
      const before = { plan: planOf(work, env), candidate: gateDiff(work, env, 'main').candidate };
      sh(work, `git tag '${tag}' HEAD`);
      const after = { plan: planOf(work, env), candidate: gateDiff(work, env, 'main').candidate };
      expect(after).toEqual(before);
      expect(after.candidate?.startsWith(sh(work, `git merge-base ${branch} HEAD`).slice(0, 12))).toBe(true);
    }, 240_000);
  }

  // Value: protects=without a remote-tracking twin the local base still works and the fallback is named on stderr;
  //   fails_when=the origin preference turns a remote-less branch into no_base, or falls back silently; why_new=the fallback is new; seam=bin/gstack-gate-diff
  test('no origin/<base>: gate-diff falls back to the local ref and says so', () => {
    const { work, env, sh } = fixture();
    sh(work, 'git branch trunk origin/main');
    const r = gateDiff(work, env, 'trunk');
    expect(r.tagged).toBe('');
    expect(r.stderr).toContain('gstack-gate-diff: no remote-tracking branch for trunk; base is the local trunk, which may lag its remote');
  }, 240_000);

  // Value: protects=the fallback note names why the local ref stands, and a remote-less repository stays quiet;
  //   fails_when=an unrelated origin/<base> is reported as missing, or a repository with no remote prints a lag note; why_new=review finding on the fallback; seam=bin/gstack-gate-diff
  test('an unrelated origin/<base> is named in the note; no remote at all uses the local base quietly', () => {
    const { work, env, sh } = fixture();
    sh(work, 'git branch -f main origin/main && git update-ref refs/remotes/origin/main "$(git commit-tree "HEAD^{tree}" -m orphan)"');
    expect(gateDiff(work, env, 'main').stderr).toContain('gstack-gate-diff: origin/main shares no history with HEAD; base is the local main, which may lag its remote');
    sh(work, 'git remote remove origin');
    const none = gateDiff(work, env, 'main');
    expect(none.tagged).toBe('');
    expect(none.stderr).not.toContain('base is');
  }, 240_000);
});
