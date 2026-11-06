import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseReviewTargeted, plainDocsSince, targetedClassesSince } from '../lib/ship-receipt-depth';

const BIN = path.join(import.meta.dir, '..', 'bin');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const MONEY_CODE = 'export const spendCapUsd = 25;\nexport function charge(amountUsd: number) { if (amountUsd > spendCapUsd) throw new Error("over cap"); return amountUsd; }\n';

/** A branch whose reviewed head adds money code (the targeted reader read it), as on harness-evals #225 at 563f858. */
function reviewed(baseFiles: Record<string, string> = {}, branchFiles: Record<string, string> = { 'src/billing.ts': MONEY_CODE }): { dir: string; env: NodeJS.ProcessEnv; git: (...a: string[]) => string; commit: (files: Record<string, string>, msg: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-delta-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-delta-state-'));
  dirs.push(dir, state);
  const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_MIRROR: '0' };
  delete env.GSTACK_APPROVALS_DIR;
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
    git('add', '.'); git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  commit({ 'README.md': '# x\n', ...baseFiles }, 'base');
  git('checkout', '-qb', 'feat');
  commit(branchFiles, 'money');
  return { dir, env, git, commit };
}
const plan = (r: { dir: string; env: NodeJS.ProcessEnv }, args: string[]) => spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: r.env });
const patchOf = (r: { dir: string; env: NodeJS.ProcessEnv }) => JSON.parse(plan(r, ['--json']).stdout).targeted.targeted_patch_id as string;
const dispatches = (stdout: string) => stdout.split('\n').filter(l => l.startsWith('DISPATCH: '));
/** The loop finished clean: pass 1, a clean fix-check, nothing open. */
const done = (rangeBase: string, ran: string) => ['--pass', '1', '--last', 'fix-check', '--fixed-below', '--range-base', rangeBase, '--targeted-ran', ran];

describe('GST-1598: a post-review docs delta that trips a targeted claim gets one targeted-only reader', () => {
  // Value: protects=the #225 shape has an exit: when the loop is done and the only change since the targeted read is a docs file
  //   with a money claim, the plan dispatches exactly one targeted reader for the head's classes, prints the delta's range_base,
  //   and once that reader's id is passed back the plan is done with no reader; the receipt binds a record read at HEAD and refuses
  //   the one read before the claim; fails_when=the plan prints NEXT: done with no dispatch (harness-evals #225), dispatches any
  //   other reader, or keeps dispatching after the read; seam=bin/gstack-review-plan, parseReviewTargeted with the receipt's own
  //   carry predicates; no_claim=what the reader finds
  test('the #225 shape: one targeted reader on the money claim, then the receipt binds its record', () => {
    const r = reviewed();
    const read = r.git('rev-parse', 'HEAD');
    const readPatch = patchOf(r);
    expect(dispatches(plan(r, ['--pass', '1', '--last', 'fix-check', '--fixed-below', '--targeted-ran', readPatch]).stdout)).toEqual([]);
    const head = r.commit({ 'changelog.d/eval-cost.md': '- Each PR eval run now costs about $4.20 instead of $11.\n' }, 'changelog');
    const p = plan(r, done(read, readPatch));
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain('NEXT: targeted');
    expect(dispatches(p.stdout)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
    expect(p.stdout).toContain(`TARGETED_DELTA: range_base=${read} paths=changelog.d/eval-cost.md classes=money`);
    const j = JSON.parse(plan(r, [...done(read, readPatch), '--json']).stdout);
    expect([j.next.step, j.dispatches.map((d: any) => d.role), j.targeted_delta.range_base]).toEqual(['targeted', ['targeted'], read]);
    const headPatch = patchOf(r);
    const after = plan(r, done(read, headPatch));
    expect(after.stdout).toContain('NEXT: done');
    expect(dispatches(after.stdout)).toEqual([]);
    const record = (at: string) => ({ classes: ['money'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head: at });
    const productOf = (c: string) => spawnSync('git', ['patch-id', '--verbatim'], { input: spawnSync('git', ['diff', 'main', c], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout, cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.split(' ')[0];
    const bind = (at: string) => parseReviewTargeted(record(at), productOf(head)!, productOf, from => targetedClassesSince(r.dir, from, head, 'main'), from => plainDocsSince(r.dir, from, head, 'main'));
    expect(bind(read).ok).toBe(false);
    expect(bind(head)).toMatchObject({ ok: true, targeted: { classes: ['money'], status: 'done' } });
  });

  // Value: protects=a code change after the loop keeps today's route (the review loop, not a targeted-only read);
  //   fails_when=the targeted-only step admits a code delta; seam=bin/gstack-review-plan; no_claim=how finish routes it
  test('a code delta after the read keeps today\'s behavior: no targeted-only reader', () => {
    const r = reviewed();
    const read = r.git('rev-parse', 'HEAD');
    const readPatch = patchOf(r);
    r.commit({ 'src/billing.ts': MONEY_CODE.replace('25', '50'), 'changelog.d/eval-cost.md': '- Cap raised to $50.\n' }, 'code');
    const p = plan(r, done(read, readPatch));
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain('NEXT: done');
    expect(dispatches(p.stdout)).toEqual([]);
    expect(p.stdout).toContain('SKIP: targeted-only read (the change since range_base');
  });

  // Value: protects=a plain docs change still carries the record, so no reader is spent on it (GST-1195), and the range_base must be
  //   the commit the targeted reader read; fails_when=the plan dispatches on plain docs or on a range_base whose patch the passed
  //   --targeted-ran does not name; seam=bin/gstack-review-plan; no_claim=receipt carry itself (parseReviewTargeted's tests)
  test('plain docs, or a range_base the targeted read did not read, dispatch nothing', () => {
    const r = reviewed();
    const read = r.git('rev-parse', 'HEAD');
    const readPatch = patchOf(r);
    r.commit({ 'docs/howto.md': '# How to\nRun the setup script first.\n' }, 'plain docs');
    expect(dispatches(plan(r, done(read, readPatch)).stdout)).toEqual([]);
    const plainHead = r.git('rev-parse', 'HEAD');
    r.commit({ 'changelog.d/eval-cost.md': '- Each PR eval run now costs about $4.20.\n' }, 'claim');
    const wrong = plan(r, done(plainHead, readPatch));
    expect(dispatches(wrong.stdout)).toEqual([]);
    expect(wrong.stdout).toContain('SKIP: targeted-only read (--targeted-ran');
  });

  // Value: protects=a main merge that only edits lines next to a reviewed branch hunk (comparePath's `context`) is no branch change,
  //   so the docs claim after it still plans the targeted-only read; fails_when=the delta counts a context-only path as changed and
  //   keeps NEXT: done with a not-docs-only skip (the GST-1598 dead end after a base merge); seam=bin/gstack-review-plan;
  //   no_claim=a base merge that edits the reviewed lines themselves
  test('a base merge that only moves context next to a branch hunk still plans the targeted-only read', () => {
    const billing = (cap: string, note: string) => ['// billing', '// rates', `// ${note}`, '', `export const spendCapUsd = ${cap};`, 'export function charge(amountUsd: number) { if (amountUsd > spendCapUsd) throw new Error("over cap"); return amountUsd; }', ''].join('\n');
    const r = reviewed({ 'src/billing.ts': billing('25', 'old note') }, { 'src/billing.ts': billing('30', 'old note') });
    const read = r.git('rev-parse', 'HEAD');
    const readPatch = patchOf(r);
    r.git('checkout', '-q', 'main');
    r.commit({ 'src/billing.ts': billing('25', 'new note') }, 'base comment');
    r.git('checkout', '-q', 'feat');
    r.git('merge', '-q', '--no-edit', 'main');
    r.commit({ 'changelog.d/eval-cost.md': '- The spend cap is now $30.\n' }, 'claim');
    const p = plan(r, done(read, readPatch));
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain('NEXT: targeted');
    expect(p.stdout).toContain(`TARGETED_DELTA: range_base=${read} paths=changelog.d/eval-cost.md classes=money`);
  });

  // Value: protects=a grant is not what opens this read, and a grant the approval record does not hold still refuses before any plan;
  //   fails_when=a fabricated --grant prints a plan; seam=bin/gstack-review-plan's grant check; no_claim=who may grant
  test('a fabricated grant refuses', () => {
    const r = reviewed();
    const read = r.git('rev-parse', 'HEAD');
    const readPatch = patchOf(r);
    const head = r.commit({ 'changelog.d/eval-cost.md': '- Each PR eval run now costs about $4.20.\n' }, 'changelog');
    const p = plan(r, [...done(read, readPatch), '--grant', 'a-000000000000']);
    expect([p.status, p.stdout]).toEqual([3, '']);
    expect(p.stderr).toContain('--grant a-000000000000');
    expect(p.stderr).toContain('review_loop_grant');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  // Value: protects=--force targeted no longer dispatches zero readers in silence: targeted is not a specialist, so the flag refuses and
  //   names the route; fails_when=--force targeted exits 0; seam=bin/gstack-review-plan; no_claim=other --force names
  test('--force targeted refuses and names the route', () => {
    const r = reviewed();
    const p = plan(r, ['--force', 'targeted']);
    expect(p.status).toBe(2);
    expect(p.stderr).toContain('--range-base');
    expect(p.stderr).toContain('--targeted-ran');
  });

  // Value: protects=the pass command builds the targeted-only manifest (the brief renders only inside a pass manifest when an exclusion
  //   is active): one targeted reader in the voices stage on the merge base, the TARGETED_DELTA line in its plan lines, and its voices
  //   stage renders the brief on HEAD; fails_when=pass prints PASS: none for NEXT: targeted, or the stage renders on another base;
  //   seam=gstack-review-dispatch pass and stage; no_claim=the reader's reply
  test('gstack-review-dispatch pass builds a manifest with the one targeted reader', () => {
    const r = reviewed();
    const read = r.git('rev-parse', 'HEAD');
    const readPatch = patchOf(r);
    r.commit({ 'changelog.d/eval-cost.md': '- Each PR eval run now costs about $4.20.\n' }, 'changelog');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-delta-out-'));
    dirs.push(out);
    const p = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['pass', '--base', 'main', '--out', out, '--pass', 'td1', '--', '--gate-tagged', '0', ...done(read, readPatch)], { cwd: r.dir, encoding: 'utf8', timeout: 120_000, env: r.env });
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toMatch(/MANIFEST: file=\S+ pass=td1 readers=1 first=0 specialists=0 red-team=0 voices=1/);
    const file = p.stdout.match(/MANIFEST: file=(\S+)/)![1]!;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mergeBase = r.git('merge-base', 'main', 'HEAD');
    expect([m.next, m.readers.map((x: any) => [x.role, x.stage, x.classes, x.diff_base])]).toEqual(['targeted', [['targeted', 'voices', ['money'], mergeBase]]]);
    expect(m.plan_lines.filter((l: string) => l.startsWith('TARGETED_DELTA: '))).toEqual([`TARGETED_DELTA: range_base=${read} paths=changelog.d/eval-cost.md classes=money`]);
    const stage = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['stage', '--manifest', file, '--stage', 'voices'], { cwd: r.dir, encoding: 'utf8', timeout: 120_000, env: r.env });
    expect(stage.status, stage.stderr).toBe(0);
    const rendered = fs.readFileSync(m.ledger, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'rendered');
    expect(rendered.map(e => [e.reader, e.diff_base, e.head, e.classes])).toEqual([['targeted', mergeBase, r.git('rev-parse', 'HEAD'), ['money']]]);
  });
});
