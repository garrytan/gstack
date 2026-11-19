/**
 * GST-3187: a round-2 /ship on gbrain#9799 planned `done` with nothing reviewed. Its plan flags were
 * `--pass 1 --last full --touched-gate`: the full-pass loop counted a fix only from --fixed-blocking or --fixed-below, so a
 * fix that touched a gate-class path read as "the step applied no edits". The same pass also showed gstack-review-dispatch
 * reading its own flags out of the plan flags after `--`. These cases pin the exact round-2 call shape the Capy pass
 * program builds (`pass --base <b> --out <dir> --pass <id> -- <plan flags>`) and the refusal that stops a plan from
 * printing done over unreviewed commits.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FULL_PASS_CAP, nextStep } from '../lib/review-depth';

const DISPATCH = path.join(import.meta.dir, '..', 'bin', 'gstack-review-dispatch');
const PLAN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'round2-plan-')));
  dirs.push(root);
  const work = path.join(root, 'work');
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  git(root, 'init', '-q', '--bare', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'work');
  const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true }); fs.writeFileSync(path.join(work, p), text); };
  const commit = (files: Record<string, string>, msg: string) => { for (const [p, t] of Object.entries(files)) write(p, t); git(work, 'add', '-A'); git(work, 'commit', '-qm', msg); return git(work, 'rev-parse', 'HEAD'); };
  commit({ 'src/a.ts': Array.from({ length: 40 }, (_, i) => `export const a${i} = ${i};\n`).join('') }, 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-qb', 'feat');
  const pass1 = commit({ '.github/workflows/ci.yml': 'on: push\n', 'src/b.ts': 'export const b = 2;\n' }, 'feat');
  const run = (bin: string, args: string[]) => spawnSync(bin, args, { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
  const pass = (out: string, planFlags: string[], own = ['--pass', 'e2e1-p2']) => run(DISPATCH, ['pass', '--base', 'main', '--out', path.join(root, out), ...own, '--', ...planFlags]);
  return { root, work, commit, pass1, pass, run };
}
const line = (out: string, prefix: string) => out.split('\n').find(l => l.startsWith(prefix)) ?? '';

describe('GST-3187: the round-2 plan flags reach the planner and a gate-class fix is reviewed', () => {
  // Value: protects=the exact round-2 pass the Capy program runs on a gate-class PR plans a full pass with readers;
  //   fails_when=it prints PASS: none next=done (gbrain#9799: "the step applied no edits" after a fix that touched a gate path);
  //   why_new=GST-3187; seam=gstack-review-dispatch pass on a real repo; no_claim=what the readers find
  test('pass --pass <id> -- --pass 1 --last full --touched-gate plans a full pass on the range, with readers', () => {
    const f = fixture();
    const r = f.pass('p2', ['--pass', '1', '--last', 'full', '--touched-gate']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(line(r.stdout, 'REVIEW_PLAN: ')).toMatch(/^REVIEW_PLAN: class=gate pass=2 next=full /);
    expect(r.stdout).toContain('NEXT: full (a fix touched a gate-class path: full pass on the range)');
    expect(r.stdout).not.toContain('PASS: none');
    expect(line(r.stdout, 'MANIFEST: ')).toMatch(/ pass=e2e1-p2 readers=[1-9]/);
  }, 180_000);

  // Value: protects=the round-2 shape /ship's Step 9 writes (with --range-base at the reviewed head) after a real gate-class fix
  //   commit plans a review; fails_when=a fix range the planner itself measured as touching a gate path still plans done;
  //   seam=gstack-review-dispatch pass; no_claim=the range's runtime line count
  test('the same shape with --range-base over a committed gate-class fix plans the full pass', () => {
    const f = fixture();
    f.commit({ '.github/workflows/ci.yml': 'on: [push, pull_request]\n' }, 'fix: the workflow trigger');
    const r = f.pass('p2', ['--pass', '1', '--last', 'full', '--touched-gate', '--range-base', f.pass1]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^NEXT: full /m);
    expect(line(r.stdout, 'MANIFEST: ')).toMatch(/ readers=[1-9]/);
  }, 180_000);

  // Value: protects=dispatch reads its own flags only before `--`: the plan's --pass is never taken as the pass id, and the
  //   plan's flags reach gstack-review-plan unchanged; fails_when=a pass with no --pass of its own runs as pass "1" (it did on
  //   main), or a plan flag after -- switches dispatch into --audit-only; seam=gstack-review-dispatch pass; no_claim=render's tail
  test('dispatch never takes its own flags from the plan flags after --', () => {
    const f = fixture();
    const missing = f.pass('p2', ['--pass', '1', '--last', 'full', '--fixed-blocking'], []);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('needs --base <ref>, --out <dir> and --pass <id>');
    expect(fs.existsSync(path.join(f.root, 'p2', 'pass-manifest.json'))).toBe(false);
    const audit = f.pass('p3', ['--audit-only', '--pass', '1', '--last', 'full', '--fixed-blocking']);
    expect(audit.status, audit.stdout + audit.stderr).toBe(0);
    expect(audit.stdout).not.toContain('PASS: audit-only');
    expect(line(audit.stdout, 'REVIEW_PLAN: ')).toMatch(/ pass=2 next=full /);
    expect(line(audit.stdout, 'MANIFEST: ')).toMatch(/ pass=e2e1-p2 readers=[1-9]/);
  }, 180_000);
});

describe('GST-3187: a plan that would ship unreviewed commits refuses instead of printing done', () => {
  // Value: protects=after a full pass, commits since --range-base with no fix flag fail closed with review_required_no_readers
  //   (exit 3 from the plan, no manifest from dispatch); fails_when=the plan prints NEXT: done "the step applied no edits" over
  //   a runtime commit nobody reviewed; seam=gstack-review-plan and gstack-review-dispatch pass; no_claim=which flag was right
  test('a runtime commit since --range-base with no fix flag refuses with review_required_no_readers', () => {
    const f = fixture();
    f.commit({ 'src/b.ts': 'export const b = 3;\n' }, 'fix: b');
    const flags = ['--pass', '1', '--last', 'full', '--range-base', f.pass1];
    const plan = f.run(PLAN, ['--base', 'main', ...flags]);
    expect(plan.status).toBe(3);
    expect(plan.stderr).toContain('gstack-review-plan: not run (commits after the reviewed head would ship with no reviewer');
    expect(plan.stderr.trimEnd().endsWith('(review_required_no_readers)')).toBe(true);
    expect(plan.stdout).not.toContain('NEXT: done');
    expect(f.run(PLAN, ['--base', 'main', ...flags, '--json']).status).toBe(3);
    const pass = f.pass('p2', flags);
    expect(pass.status).not.toBe(0);
    expect(pass.stderr).toContain('(review_required_no_readers)');
    expect(fs.existsSync(path.join(f.root, 'p2', 'pass-manifest.json'))).toBe(false);
  }, 180_000);

  // Value: protects=--targeted-ran exempts the refusal only when the targeted read covers HEAD or carries the change, never by
  //   being present; fails_when=a stale or foreign --targeted-ran turns a runtime commit nobody reviewed into NEXT: done;
  //   seam=gstack-review-plan; no_claim=the docs-carry path, which review-plan-targeted-delta.test.ts covers
  test('a --targeted-ran that does not cover the runtime commit still refuses', () => {
    const f = fixture();
    f.commit({ 'src/b.ts': 'export const b = 3;\n' }, 'fix: b');
    const plan = f.run(PLAN, ['--base', 'main', '--pass', '1', '--last', 'full', '--range-base', f.pass1, '--targeted-ran', 'deadbeef']);
    expect(plan.status, plan.stdout + plan.stderr).toBe(3);
    expect(plan.stderr.trimEnd().endsWith('(review_required_no_readers)')).toBe(true);
    expect(plan.stdout).not.toContain('NEXT: done');
  }, 180_000);

  // Value: protects=the refusal fires only on unreviewed commits: no commit since the reviewed head is still done, and a flagged
  //   below-floor fix still plans its fix-check; fails_when=the guard refuses a clean pass 1 or a flagged fix;
  //   seam=gstack-review-plan; no_claim=the fix-check's verdict
  test('no commit since the reviewed head is done, and a flagged fix plans its review', () => {
    const f = fixture();
    const clean = f.run(PLAN, ['--base', 'main', '--pass', '1', '--last', 'full', '--range-base', f.pass1]);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('NEXT: done (the step applied no edits)');
    f.commit({ 'src/b.ts': 'export const b = 3;\n' }, 'fix: b');
    const flagged = f.run(PLAN, ['--base', 'main', '--pass', '1', '--last', 'full', '--fixed-below', '--range-base', f.pass1]);
    expect(flagged.status, flagged.stderr).toBe(0);
    expect(flagged.stdout).not.toMatch(/^NEXT: done /m);
  }, 180_000);
});

describe('GST-3187: nextStep counts a gate-class fix as an edit', () => {
  // Value: protects=--touched-gate alone after a full pass plans the full pass on the range, and at the cap it stops for the
  //   owner; fails_when=loopStep's fix test ignores touchedGate (it returned done "the step applied no edits");
  //   seam=nextStep; no_claim=the gate-class voices' ordering, which GST-967's cases cover
  test('--touched-gate with no other fix flag is a fix', () => {
    expect(nextStep({ fullPasses: 1, last: 'full', touchedGate: true })).toMatchObject({ step: 'full', reason: 'a fix touched a gate-class path: full pass on the range' });
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', touchedGate: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: 1, last: 'full' })).toMatchObject({ step: 'done', reason: 'the step applied no edits' });
  });
});
