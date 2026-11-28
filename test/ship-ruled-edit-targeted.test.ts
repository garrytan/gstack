/**
 * HARN-1 (harness-evals #638, #646, #632, #644, #490; GSTA-876 on gstack #4853): past R51's two rounds, the lane's Captain rules a
 * small edit after the read-only final review in (`gstack-approvals rule --finding edit:<path>`). The plan then still stopped
 * ("a fix followed the read-only final review"), because the fix range held the release stamps Step 12 wrote, which nobody rules,
 * and the receipt refused the targeted record read before the edit, so the only exit was another whole read-only full review.
 * Now stamps carry without a ruling, a ruled range with no targeted class in it carries the record (and the receipt names the
 * rulings that carried it), and a ruled range that does touch a targeted class plans exactly one targeted reader.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ledgerPass, summarizeReviewLoop } from '../lib/review-scope';
import { parseReviewTargeted, plainDocsSince, ruledChangeSince, targetedClassesSince } from '../lib/ship-receipt-depth';
import { spawnSync } from '../lib/spawn-sync';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(120_000);
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; while (repos.length) cleanup(repos.pop()!); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const MONEY_CODE = 'export const spendCapUsd = 25;\nexport function charge(amountUsd: number) { if (amountUsd > spendCapUsd) throw new Error("over cap"); return amountUsd; }\n';
const UTIL = 'export const label = (s: string) => s.trim();\n';
const ENV = { GSTACK_APPROVALS_MIRROR: '0' };
const run = (repo: FixtureRepo, name: string, args: string[]) => { const r = runBin(repo, name, args, ENV); return { status: r.status, stdout: r.out, stderr: r.err }; };

/** A money-class PR whose final review (and its targeted reader) read `passHead`, then Step 12's stamps, then one more edit. */
function shipped(edit: Record<string, string>) {
  const repo = makeFixtureRepo({ policy: BASE_POLICY });
  repos.push(repo);
  const write = (files: Record<string, string>, msg: string) => {
    for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo.work, p)), { recursive: true }); fs.writeFileSync(path.join(repo.work, p), text); }
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
    return repo.git('rev-parse', 'HEAD');
  };
  const log = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8');
  repo.git('checkout', '-q', '-b', 'feat');
  const passHead = write({ 'src/billing.ts': MONEY_CODE, 'src/util.ts': UTIL, 'CHANGELOG.md': log.replace('## [1.2.3.0]', '## [Unreleased]\n\n- charge() caps spend\n\n## [1.2.3.0]') }, 'feat');
  write({ VERSION: '1.2.4.0\n', 'CHANGELOG.md': log.replace('## [1.2.3.0]', '## [1.2.4.0] - 2026-11-27\n\n- charge() caps spend\n\n## [1.2.3.0]') }, 'release stamps');
  const head = write(edit, 'edit after the read-only final review');
  return { repo, passHead, head };
}
const rule = (repo: FixtureRepo, file: string, head: string) => run(repo, 'gstack-approvals', ['rule', '--finding', `edit:${file}`, '--head', head, '--reason', 'a one-line edit after the final review ships as a disclosed note', '--words', 'ship it with the note', '--by', 'GStack Minder (GSTA-36)']);
const plan = (repo: FixtureRepo, args: string[]) => run(repo, 'gstack-review-plan', ['--base', 'main', '--post-review', '--pass', '3', '--last', 'full', '--adversarial-ran', ...args]);
const patchAt = (repo: FixtureRepo, rev: string) => {
  repo.git('checkout', '-q', rev);
  try { return JSON.parse(run(repo, 'gstack-review-plan', ['--base', 'main', '--json']).stdout).targeted.targeted_patch_id as string; } finally { repo.git('checkout', '-q', 'feat'); }
};
const next = (stdout: string) => stdout.split('\n').find(l => l.startsWith('NEXT: ')) ?? '';
const dispatches = (stdout: string) => stdout.split('\n').filter(l => l.startsWith('DISPATCH: '));

/** parseReviewTargeted with the receipt's own predicates (bin/gstack-ship-receipt write), for a record the reader made at `read`. */
function bind(repo: FixtureRepo, read: string, head: string) {
  Object.assign(process.env, repo.env, ENV);
  delete process.env.GSTACK_APPROVALS_DIR;
  const productOf = (c: string) => spawnSync('git', ['patch-id', '--verbatim'], { input: spawnSync('git', ['diff', 'main', c, '--', '.', ':(exclude)VERSION', ':(exclude)CHANGELOG.md'], { cwd: repo.work, encoding: 'utf8', timeout: 10_000 }).stdout, cwd: repo.work, encoding: 'utf8', timeout: 10_000 }).stdout.split(' ')[0];
  const record = { classes: ['money'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head: read };
  return parseReviewTargeted(record, productOf(head)!, productOf, from => targetedClassesSince(repo.work, from, head, 'main'), from => plainDocsSince(repo.work, from, head, 'main'), undefined, from => ruledChangeSince(repo.work, from, head, 'main'));
}

describe('a Captain-ruled edit after the read-only final review (HARN-1)', () => {
  // Value: protects=a ruled edit outside every targeted class ships on the record the final review's targeted reader made, with
  //   the rulings recorded; fails_when=the plan stops on the release stamps in the fix range, or the receipt refuses the record
  //   read before the ruled edit (RECEIPT_INVALID), forcing a whole new read-only full review; seam=bin/gstack-review-plan
  //   --range-base and parseReviewTargeted with ruledChangeSince
  test('a ruled edit with no targeted class: the plan is done and the receipt carries the record, naming the ruling', () => {
    const { repo, passHead, head } = shipped({ 'src/util.ts': UTIL.replace('trim()', 'trim().toLowerCase()') });
    const ran = patchAt(repo, passHead);
    expect(next(plan(repo, ['--range-base', passHead, '--targeted-ran', ran]).stdout)).toStartWith('NEXT: stop (');
    expect(bind(repo, passHead, head).ok).toBe(false);
    expect(rule(repo, 'src/util.ts', head).status).toBe(0);
    const p = plan(repo, ['--range-base', passHead, '--targeted-ran', ran]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain(`FIX_RANGE: runtime_lines=0 base=${passHead} ruled=1`);
    expect(next(p.stdout)).toStartWith('NEXT: done (every edit since --range-base is ruled a note (RULED_EDIT)');
    expect(dispatches(p.stdout)).toEqual([]);
    expect(p.stdout).toContain(`SKIP: targeted-only read (every edit since --range-base is ruled a note and none carries a targeted class, so the record read at ${passHead.slice(0, 12)} carries`);
    const b = bind(repo, passHead, head);
    expect(b).toMatchObject({ ok: true, targeted: { classes: ['money'], read: passHead, ruled_edits: [{ path: 'src/util.ts', approval: expect.stringMatching(/^a-[0-9a-f]{12}$/), by: 'GStack Minder (GSTA-36)' }] } });
    const unread = plan(repo, ['--range-base', passHead]);
    expect(next(unread.stdout)).toStartWith('NEXT: targeted (');
    expect(dispatches(unread.stdout)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
  });

  // Value: protects=a ruled edit that changes money code gets exactly one targeted reader on HEAD (not a round, not a full review)
  //   and the old record never carries it; fails_when=the plan stops for a new full review, or the receipt binds the record read
  //   before the money edit; seam=bin/gstack-review-plan and parseReviewTargeted
  test('a ruled edit in money code: one targeted reader on HEAD, and the earlier record does not carry', () => {
    const { repo, passHead, head } = shipped({ 'src/billing.ts': MONEY_CODE.replace('25', '30') });
    const ran = patchAt(repo, passHead);
    expect(rule(repo, 'src/billing.ts', head).status).toBe(0);
    const p = plan(repo, ['--range-base', passHead, '--targeted-ran', ran]);
    expect(p.status, p.stderr).toBe(0);
    expect(next(p.stdout)).toStartWith('NEXT: targeted (the loop is done and every edit since --range-base is ruled a note');
    expect(dispatches(p.stdout)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
    expect(bind(repo, passHead, head)).toMatchObject({ ok: false, message: expect.stringContaining('the product changed after the read') });
    expect(bind(repo, head, head).ok).toBe(true);
  });

  // Value: protects=the fail-closed negative controls; fails_when=an unruled edit, or a ruling that misses one changed path,
  //   plans no reader or carries the record; seam=bin/gstack-review-plan and parseReviewTargeted
  test('an unruled path, or a ruling that misses one of the edited paths, still stops and still refuses the record', () => {
    const { repo, passHead, head } = shipped({ 'src/util.ts': UTIL.replace('trim()', 'trim().toLowerCase()'), 'src/other.ts': 'export const o = 1;\n' });
    const ran = patchAt(repo, passHead);
    expect(rule(repo, 'src/util.ts', head).status).toBe(0);
    const p = plan(repo, ['--range-base', passHead, '--targeted-ran', ran]);
    expect(next(p.stdout)).toStartWith('NEXT: stop (');
    expect(p.stdout).toContain(`--finding 'edit:src/other.ts' --head ${head}`);
    expect(p.stdout).not.toContain("--finding 'edit:VERSION'");
    expect(bind(repo, passHead, head).ok).toBe(false);
  });

  // Value: protects=a ruled docs edit that adds a money claim gets the fresh targeted read the plan asks for, and the receipt
  //   refuses the record read before it, so plan and receipt agree (GSTA-883 ruled note on #4862); fails_when=the plan dispatches
  //   the targeted reader while write binds the old record through the ruling; seam=ruledChangeSince and targetedDelta
  test('a ruled docs edit that adds a money claim: the plan reads it fresh and the receipt refuses the old record', () => {
    const { repo, passHead, head } = shipped({ 'docs/billing.md': '# Billing\n\ncharge() now caps spend at 30 USD per run.\n' });
    const ran = patchAt(repo, passHead);
    expect(rule(repo, 'docs/billing.md', head).status).toBe(0);
    const p = plan(repo, ['--range-base', passHead, '--targeted-ran', ran]);
    expect(p.status, p.stderr).toBe(0);
    expect(next(p.stdout)).toStartWith('NEXT: targeted (');
    expect(dispatches(p.stdout)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
    expect(bind(repo, passHead, head)).toMatchObject({ ok: false, message: expect.stringContaining('the product changed after the read') });
    expect(bind(repo, head, head).ok).toBe(true);
  });
});

// Value: protects=the targeted-only read (one targeted reader on HEAD after a ruled edit, not a review round) counts as bound;
//   fails_when=review-scope prints REVIEW_SCOPE_UNBOUND: pass 3 (ledger p3) for it (GSTA-876 on #4853), or a real pass 3 with
//   no review row stops being named; seam=lib/review-scope.ts ledgerPass and summarizeReviewLoop
describe('a targeted-only read has no review row and is not unbound (GSTA-876)', () => {
  const since = '2026-11-26T19:00:00Z';
  const rows = [1, 2].map(pass => ({ skill: 'review', via: 'ship', pass, timestamp: `2026-11-26T19:0${pass}:00Z`, commit_full: String(pass).repeat(40), findings: [] }));
  function ledger(reader: string, more: Record<string, unknown>[] = []): string {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-only-')), 'p3');
    fs.mkdirSync(dir);
    dirs.push(path.dirname(dir));
    const file = path.join(dir, 'review-ledger.jsonl');
    fs.writeFileSync(file, [{ event: 'rendered', reader, at: '2026-11-26T19:10:00Z' }, ...more, { event: 'output', reader, ids: [] }].map(e => JSON.stringify(e)).join('\n') + '\n');
    return file;
  }
  test('p3 with only the targeted reader is bound; p3 with any other reader is still unbound', () => {
    const only = ledgerPass(ledger('targeted'));
    expect(only.targetedOnly).toBe(true);
    expect(summarizeReviewLoop(rows, since, [[]], [only]).unbound).toBeUndefined();
    const other = ledgerPass(ledger('red-team'));
    expect(other.targetedOnly).toBeUndefined();
    expect(summarizeReviewLoop(rows, since, [[]], [other]).unbound).toEqual(['pass 3 (ledger p3): no review-log row, so its fixes and dispositions cannot be counted']);
    const silent = ledgerPass(ledger('targeted', [{ event: 'rendered', reader: 'red-team' }, { event: 'sent', reader: 'red-team' }]));
    expect(silent.targetedOnly).toBeUndefined();
    expect(summarizeReviewLoop(rows, since, [[]], [silent]).unbound).toEqual(['pass 3 (ledger p3): no review-log row, so its fixes and dispositions cannot be counted']);
  });
});

// Value: protects=an interrupted full pass whose collected blocker no row logged stays unbound when a targeted-only read follows
//   it; fails_when=the judged targeted-only ledger counts in replaced() and voids the full pass, so neither is named
//   (GSTA-883 deferred note on #4862); seam=lib/review-scope.ts summarizeReviewLoop
describe('a targeted-only read never replaces an interrupted full pass', () => {
  const since = '2026-11-26T19:00:00Z';
  const rows = [{ skill: 'review', via: 'ship', pass: 1, timestamp: '2026-11-26T19:01:00Z', commit_full: '1'.repeat(40), findings: [] }];
  function ledger(name: string, reader: string, at: string, ids: string[], judged: boolean): string {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-replace-')), name);
    fs.mkdirSync(dir);
    dirs.push(path.dirname(dir));
    const file = path.join(dir, 'review-ledger.jsonl');
    const events = [{ event: 'rendered', reader, at }, { event: 'output', reader, ids }, ...(judged ? [{ event: 'judge' }] : [])];
    fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    return file;
  }
  test('p2 interrupted with a collected blocker, then a judged targeted-only p3: p2 is still unbound, and a judged full p3 still voids it', () => {
    const p2 = ledgerPass(ledger('p2', 'red-team', '2026-11-26T19:05:00Z', ['p2/red-team-1'], false));
    const blocker = [{ id: 'p2/red-team-1', locus: 'src/a.ts:3', raiser: 'red-team' }] as never;
    const targeted = ledgerPass(ledger('p3', 'targeted', '2026-11-26T19:10:00Z', [], true));
    expect(targeted.targetedOnly).toBe(true);
    const s = summarizeReviewLoop(rows, since, [blocker, []], [p2, targeted]);
    expect(s.unbound).toEqual(['pass 2 (ledger p2): no review-log row, so its fixes and dispositions cannot be counted']);
    const full = ledgerPass(ledger('p3', 'red-team', '2026-11-26T19:10:00Z', [], true));
    expect(summarizeReviewLoop(rows, since, [blocker, []], [p2, full]).unbound).toEqual(['pass 3 (ledger p3): no review-log row, so its fixes and dispositions cannot be counted']);
  });
});
