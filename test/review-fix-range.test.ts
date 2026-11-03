/**
 * #3339: /ship Step 9 and /review may re-review only the fix range, but a fix-range pass
 * can never be the last review. The fix base comes from the review log (never
 * the working tree or the caller) and is the commit whose tree the fixing pass
 * started from, a narrowed row is never CURRENT and carries no
 * start_wtree/end_wtree for Step 11.5 to bind, and narrowed dispatches stay out
 * of specialist hit rates.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canReuseSharedLibsAdvisory, reviewFreshness, sharedLibsFingerprint } from '../lib/review-evidence';
import { gitIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const W = 'a'.repeat(40);

let root: string, repo: string, env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fix-range-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state') };
  delete env.GSTACK_HOME;
  gitIn(repo, 'init -q -b feature');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  gitIn(repo, 'add a.ts');
  gitIn(repo, 'commit -q -m init');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function bin(name: string, args: string[]) {
  const r = spawnSync(path.join(BIN, name), args, { cwd: repo, encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}
const head = () => gitIn(repo, 'rev-parse HEAD').trim();
const edit = (text: string) => fs.writeFileSync(path.join(repo, 'a.ts'), text);
const commit = () => gitIn(repo, 'commit -q -am fix');
const row = (fields: Record<string, unknown>) => JSON.stringify({ skill: 'review', via: 'ship', status: 'clean', issues_found: 0, critical: 0, informational: 0, ...fields });
const fixing = { status: 'issues_found', issues_found: 1, completed: true, converged: false };
const clean = { completed: true, converged: true };

// Step 9.4's order: start, review, apply fixes, log with the original token, then commit the fixes.
function pass(fields: Record<string, unknown>, start: string[] = ['--start', 'review'], fixes?: string, commitFixes = true) {
  const started = bin('gstack-review-log', start);
  expect(started.code).toBe(0);
  const [token, base] = started.out.split('\n');
  if (fixes) edit(fixes);
  expect(bin('gstack-review-log', [row(fields), '--finish', token!]).code).toBe(0);
  if (fixes && commitFixes) commit();
  return base;
}
function rows(): any[] {
  return bin('gstack-review-read', []).out.split('\n---CONFIG---')[0]!.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}
const narrowStart = () => bin('gstack-review-log', ['--start', 'review', '--fix-range']);

describe('fix-range start', () => {
  test('after a completed fixing pass it prints the token and the reviewed commit as FIX_BASE', () => {
    const reviewed = head();
    pass(fixing, undefined, 'export const a = 2;\n');
    expect(pass(clean, ['--start', 'review', '--fix-range'])).toBe(`FIX_BASE=${reviewed}`);
    expect(gitIn(repo, `diff --name-only ${reviewed}`).trim()).toBe('a.ts');
  });

  test('fixes still uncommitted at the repeat are inside the range', () => {
    const reviewed = head();
    pass(fixing, undefined, 'export const a = 2;\n', false);
    expect(pass(clean, ['--start', 'review', '--fix-range'])).toBe(`FIX_BASE=${reviewed}`);
    expect(gitIn(repo, `diff --name-only ${reviewed}`).trim()).toBe('a.ts');
  });

  test('chained fix-range passes take the latest fixing pass as base', () => {
    pass(fixing, undefined, 'export const a = 2;\n');
    const second = head();
    pass(fixing, ['--start', 'review', '--fix-range'], 'export const a = 3;\n');
    expect(pass(clean, ['--start', 'review', '--fix-range'])).toBe(`FIX_BASE=${second}`);
  });

  test.each([
    ['no earlier pass', () => {}, 'no earlier pass on this branch'],
    ['a clean latest pass', () => pass(clean), 'the latest pass made no fixes'],
    ['an incomplete latest pass (coverage restoration stays full)', () => pass({ ...fixing, status: 'unavailable', completed: false }, undefined, 'export const a = 2;\n'), 'the latest pass did not complete'],
    ['a Step 11 review after the latest pass', () => {
      pass(fixing, undefined, 'export const a = 2;\n');
      pass({ skill: 'adversarial-review', ...clean }, ['--start', 'adversarial-review']);
    }, 'a Step 11 review followed the latest pass'],
    ['a latest pass logged without a start capture', () => {
      edit('export const a = 2;\n');
      expect(bin('gstack-review-log', [row(fixing)]).code).toBe(0);
    }, 'the latest pass has no captured start'],
    ['a pass that started from uncommitted content (a reverted dirty hunk would fall outside the range)', () => {
      edit('export const a = 1; // dirty\n');
      pass(fixing, undefined, 'export const a = 1;\n', false);
    }, 'started from uncommitted content'],
    ['a pass that started with an untracked file', () => {
      fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
      pass(fixing, undefined, 'export const a = 2;\n');
    }, 'started from uncommitted content'],
    ['a base that is no longer an ancestor of HEAD', () => {
      edit('export const a = 2;\n');
      commit();
      pass(fixing, undefined, 'export const a = 3;\n');
      gitIn(repo, 'reset -q --hard HEAD~2');
      edit('export const a = 4;\n');
      commit();
    }, 'is not an ancestor of HEAD'],
  ])('refuses %s', (_, setup, reason) => {
    setup();
    const r = narrowStart();
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('fix-range refused: ');
    expect(r.err).toContain(reason);
    expect(r.err).toContain('run a full pass (gstack-review-log --start review)');
  });

  test('rejects an unknown start flag with usage', () => {
    expect(bin('gstack-review-log', ['--start', 'review', '--narrow']).code).toBe(2);
  });
});

describe('a fix-range pass is never the last review', () => {
  test('its row is fix-range scoped whatever the caller claims, unbindable at Step 11.5 and never CURRENT', () => {
    const reviewed = head();
    pass(fixing, undefined, 'export const a = 2;\n');
    pass({ ...clean, scope: 'full', fix_base: 'f'.repeat(40), review_binding: { state: 'verified', start_wtree: W, end_wtree: W }, wtree: W },
      ['--start', 'review', '--fix-range']);
    const last = rows().at(-1);
    expect(last.scope).toBe('fix-range');
    expect(last.fix_base).toBe(reviewed);
    expect(last.review_binding.state).toBe('fix-range');
    expect(last.review_binding.range_start_wtree).toBe(last.review_binding.range_end_wtree);
    expect(last.review_binding).not.toHaveProperty('start_wtree');
    expect(last.review_binding).not.toHaveProperty('end_wtree');
    expect(last).not.toHaveProperty('wtree');
    expect(last.review_freshness).toEqual({ status: 'UNVERIFIED', reason: 'fix-range pass; only a later full pass can clear review' });
    expect(narrowStart().err).toContain('the latest pass made no fixes');
    pass(clean);
    expect(rows().at(-1).review_freshness.status).toBe('CURRENT');
  });

  test('a fixing fix-range pass is not CURRENT either', () => {
    pass(fixing, undefined, 'export const a = 2;\n');
    pass(fixing, ['--start', 'review', '--fix-range'], 'export const a = 3;\n');
    const last = rows().at(-1);
    expect(last.scope).toBe('fix-range');
    expect(last.review_freshness.status).not.toBe('CURRENT');
  });

  test('a caller cannot narrow a full pass by claiming fix-range', () => {
    pass({ ...clean, scope: 'fix-range', fix_base: W });
    const last = rows().at(-1);
    expect(last).not.toHaveProperty('scope');
    expect(last).not.toHaveProperty('fix_base');
    expect(last.review_freshness.status).toBe('CURRENT');
  });

  test('a start token that still names a fix base stays narrowed even if its scope is rewritten', () => {
    pass(fixing, undefined, 'export const a = 2;\n');
    const [token] = narrowStart().out.split('\n');
    const slug = bin('gstack-slug', []).out.match(/^SLUG=(.+)$/m)![1]!;
    const file = path.join(root, 'state', 'projects', slug, '.review-starts', `${token}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), scope: 'full', fix_base: 'not-a-commit' }));
    expect(bin('gstack-review-log', [row(clean), '--finish', token!]).code).toBe(0);
    const last = rows().at(-1);
    expect(last.scope).toBe('fix-range');
    expect(last).not.toHaveProperty('fix_base');
    expect(last.review_freshness.status).toBe('UNVERIFIED');
  });

  test('freshness rejects a fix-range row even with a verified-looking binding', () => {
    const rec = { skill: 'review', scope: 'fix-range', status: 'clean', issues_found: 0, critical: 0, completed: true, converged: true, wtree: W,
      review_binding: { state: 'verified', start_wtree: W, end_wtree: W } };
    expect(reviewFreshness(rec, W)?.status).toBe('UNVERIFIED');
    expect(reviewFreshness({ ...rec, scope: undefined }, W)?.status).toBe('CURRENT');
  });

  test('shared-libs advisory reuse never trusts a fix-range row', () => {
    const finding = { severity: 'INFORMATIONAL', advisory: true, action: 'skipped', evidence_paths: ['a.ts'], helper_target: { path: 'b.ts', symbol: 'b' } };
    const prior = { ...finding, fingerprint: sharedLibsFingerprint(finding), snapshot_covered_paths: ['a.ts'] };
    const snapshot = { wtree: W, branch_id: 'd'.repeat(64), covered_paths: ['a.ts'] };
    const full = { skill: 'review', completed: true, converged: true, wtree: W, review_binding: { state: 'verified', start_wtree: W, end_wtree: W, branch_id: 'd'.repeat(64) } };
    expect(canReuseSharedLibsAdvisory(prior, finding, full, snapshot)).toBe(true);
    const narrowed = { ...full, scope: 'fix-range', review_binding: { state: 'fix-range', range_start_wtree: W, range_end_wtree: W, branch_id: 'd'.repeat(64) } };
    expect(canReuseSharedLibsAdvisory(prior, finding, narrowed, snapshot)).toBe(false);
  });
});

describe('gstack-specialist-stats', () => {
  test('fix-range passes do not count toward hit rates or gate candidacy', () => {
    const entry = (scope?: string) => JSON.stringify({ ...(scope ? { scope } : {}), specialists: { testing: { dispatched: true, findings: 0 } } });
    const slug = bin('gstack-slug', []).out.match(/^SLUG=(.+)$/m)![1]!;
    const dir = path.join(root, 'state', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feature-reviews.jsonl'), [...Array(9).fill(entry()), ...Array(5).fill(entry('fix-range'))].join('\n') + '\n');
    const out = bin('gstack-specialist-stats', []).out;
    expect(out).toContain('SPECIALIST_STATS: 9 reviews analyzed');
    expect(out).toContain('testing: 9/9 dispatched, 0 findings (0%)');
    expect(out).not.toContain('GATE_CANDIDATE');
  });
});

describe('ship Step 9 instructions', () => {
  // Harness lane E (issue row 1): the fix-range token's mandatory final full pass re-read the
  // whole tree and found new neighbours every time. /ship now reads only the range since the
  // previous pass (RANGE_BASE) under a full token, so the final record still binds the tree.
  const army = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf8').replace(/\s+/g, ' ');
  test('pass 2+ reads the range since the previous pass under a full token; the fix-range token is /review\'s alone', () => {
    expect(army).toContain('Every entry saves `PASS_HEAD=$(git rev-parse HEAD)`; from pass 2 on, `RANGE_BASE` is the previous pass\'s PASS_HEAD.');
    expect(army).toContain('`DIFF_BASE=<diff-base>`, the merge base on pass 1 and `RANGE_BASE` from pass 2 on.');
    expect(army).toContain('A reviewer never sees your shell\'s `RANGE_BASE`; a variable left in a prompt re-reads the whole branch.');
    expect(army).toContain('Every pass captures a full token (no `--fix-range`), so the record binds the whole tree even when reviewers read only the range.');
    expect(army).not.toContain('--start review --fix-range');
    expect(army).toContain('gstack-review-scope classify --base <base> --pass $PASS --range-base $RANGE_BASE');
    expect(army).toContain('A pass whose only findings were deferred or noted applied no edits and continues here: the loop converges below the floor.');
  });
});

describe('review Step 3 and Step 5.8 instructions', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'review/SKILL.md'), 'utf8');
  const step3 = skill.slice(skill.indexOf('## Step 3: Get the diff'), skill.indexOf('## Step 3.5:'));
  const step58 = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'), skill.indexOf('### Report the final review'));
  const flat3 = step3.replace(/\s+/g, ' '), flat58 = step58.replace(/\s+/g, ' ');

  test('the first pass starts full and only the pass after an edited pass narrows its DIFF_BASE, never Step 4.8 or other base uses', () => {
    expect(skill.indexOf('## Step 3.5:')).toBeGreaterThan(skill.indexOf('## Step 3: Get the diff'));
    expect(skill.indexOf('## Step 3: Get the diff')).toBeGreaterThanOrEqual(0);
    const block = step3.slice(step3.indexOf('```bash'), step3.indexOf('```', step3.indexOf('```bash') + 7));
    expect(block).toContain('gstack-review-log --start review\ngit diff "$DIFF_BASE"');
    expect(block).not.toContain('--fix-range');
    expect(flat3).toContain('After an edited pass, start the next with `--start review --fix-range`: it prints REVIEW_START, then `FIX_BASE=<sha>`. Wherever this pass sets DIFF_BASE outside Step 4.8, use FIX_BASE instead; Step 4.8 and every other `<base>` use stay full. On refusal, start a full pass.');
    expect(skill.match(/--fix-range/g)).toHaveLength(1);
  });

  test('an edited pass is logged before the repeat, kept out of Step 5.0, and a fix-range pass is never the final review', () => {
    const edited = flat58.indexOf("Edited: increment CYCLES once, then fill and save the record below with `converged:false`. Step 5.0 never treats this invocation's records as prior reviews.");
    const repeat = flat58.indexOf('Below 3, repeat Steps 3–5 with a new REVIEW_START.');
    const none = flat58.indexOf('No edits: after a full pass, fill the record below. A fix-range pass is never final: repeat Steps 3–5 with a full start.');
    expect(edited).toBeGreaterThan(-1);
    expect(repeat).toBeGreaterThan(edited);
    expect(none).toBeGreaterThan(repeat);
    expect(flat58).toContain("finish only this pass's own token");
  });
});

describe('review Step 3/5.8 order against the real logger', () => {
  // /review's order on every pass: core start, Step 4.8 attempt start and finish, fixes in the working tree, core finish; never a commit.
  const reviewRow = (fields: Record<string, unknown>) => JSON.stringify({ skill: 'review', status: 'clean', issues_found: 0, critical: 0, informational: 0, ...fields });
  function reviewPass(fields: Record<string, unknown>, start: string[], fixes?: string) {
    const started = bin('gstack-review-log', start);
    expect(started.code).toBe(0);
    const [token, base] = started.out.split('\n');
    // Step 4.8: each pass's adversarial attempt saves its row before any fix and before the core row.
    const attempt = bin('gstack-review-log', ['--start', 'adversarial-review']);
    expect(attempt.code).toBe(0);
    expect(bin('gstack-review-log', [JSON.stringify({ skill: 'adversarial-review', status: 'clean', source: 'claude', ...clean }), '--finish', attempt.out]).code).toBe(0);
    if (fixes) edit(fixes);
    expect(bin('gstack-review-log', [reviewRow(fields), '--finish', token!]).code).toBe(0);
    return base;
  }

  test('a committed first pass narrows the next repeat to the uncommitted fixes, then the chain returns to a full pass', () => {
    const reviewed = head();
    reviewPass(fixing, ['--start', 'review'], 'export const a = 2;\n');
    expect(reviewPass(fixing, ['--start', 'review', '--fix-range'], 'export const a = 3;\n')).toBe(`FIX_BASE=${reviewed}`);
    expect(gitIn(repo, `diff --name-only ${reviewed}`).trim()).toBe('a.ts');
    const third = narrowStart();
    expect(third.code).toBe(1);
    expect(third.err).toContain('started from uncommitted content');
    reviewPass(clean, ['--start', 'review']);
    const last = rows().at(-1)!;
    expect(last.scope).toBeUndefined();
    expect(reviewFreshness(last, last.wtree)?.status).toBe('CURRENT');
  }, 30_000);

  test('a zero-edit fix-range pass is never CURRENT even if it were logged, so the final record needs a full pass', () => {
    reviewPass(fixing, ['--start', 'review'], 'export const a = 2;\n');
    reviewPass(clean, ['--start', 'review', '--fix-range']);
    const narrowed = rows().at(-1)!;
    expect(narrowed.scope).toBe('fix-range');
    expect(reviewFreshness(narrowed, narrowed.review_binding.range_end_wtree)?.status).toBe('UNVERIFIED');
  }, 30_000);

  test('a first pass over uncommitted work cannot be narrowed', () => {
    edit('export const a = 1; // uncommitted\n');
    reviewPass(fixing, ['--start', 'review'], 'export const a = 2;\n');
    const r = narrowStart();
    expect(r.code).toBe(1);
    expect(r.err).toContain('started from uncommitted content');
  }, 30_000);
});
