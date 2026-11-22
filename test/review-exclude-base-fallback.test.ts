/**
 * A base policy that fails only on its review_exclude_paths or review_content_patterns sets those keys aside instead of
 * stopping every /ship (GST-3399): harness-evals main went to 65 patterns, past the schema's 64, and every plan there refused
 * POLICY_INVALID, the PR that shortens the list included. The keys' removal only widens review, every other base key still
 * applies, the head's copy still never counts, and any other error still refuses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EXIT } from '../lib/headless-artifacts';
import { receiptExcludeFallback } from '../lib/ship-receipt-depth';
import { loadBasePolicy } from '../lib/ship-queue';
import { READERS_KEY_VERSION } from '../lib/ship-policy-keys';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const patterns = (n: number) => Array.from({ length: n }, (_, i) => `data/p${i}/**`);
const policyText = (p: Record<string, unknown>) => JSON.stringify({ min_gstack_version: READERS_KEY_VERSION, readers: { forbid_paths: ['private/**'] }, ...p }) + '\n';
/** A repository whose main holds `policy`, and a branch that changes a data file, a code file and `head` (extra files, the policy included). */
function repoWith(policy: Record<string, unknown>, head: Record<string, string> = {}) {
  const repo = makeFixtureRepo({ prefix: 'gstack-xfb-', baseFiles: { '.gstack/ship-policy.json': policyText(policy), 'data/p0/keep.json': '{}\n' } });
  repos.push(repo);
  commit(repo, { 'data/p0/r.json': '{"n": 1}\n', 'lib/a.ts': 'export const a = 1;\n', ...head });
  return repo;
}
const plan = (repo: FixtureRepo) => runBin(repo, 'gstack-review-plan', ['--base', 'main']);
const planJson = (repo: FixtureRepo) => { const r = runBin(repo, 'gstack-review-plan', ['--base', 'main', '--json']); expect(r.status, r.err).toBe(EXIT.ok); return JSON.parse(r.out); };

describe('an invalid exclusion list on the base is set aside, never loosened (GST-3399)', () => {
  // Value: protects=a base whose only error is review_exclude_paths' length plans with every file reviewed and its other keys
  //   applied, with a loud line on stdout and stderr and the record in --json; fails_when=the plan refuses POLICY_INVALID (the
  //   harness-evals deadlock), applies some of the 65 patterns, or drops the base's readers.forbid_paths with the bad key;
  //   why_new=GST-3399; seam=gstack-review-plan on a real repository; no_claim=what reviewers do with the files
  test('65 patterns on the base: the plan reviews every file, keeps forbid_paths and says why', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65) });
    const r = plan(repo);
    expect(r.status, r.err).toBe(EXIT.ok);
    expect(r.out).toContain('REVIEW_EXCLUDE: fallback (WARNING: the base policy origin/main@');
    expect(r.out).toContain('review_exclude_paths: more than 64 patterns');
    expect(r.out).toContain('every file is reviewed');
    expect(r.err).toContain('gstack-review-plan: REVIEW_EXCLUDE: fallback (WARNING');
    expect(r.out).toMatch(/READERS: forbid_fetch=0 forbid_paths=1 /);
    const j = planJson(repo);
    expect(j.review_exclude.state).toBe('fallback');
    expect(j.review_exclude.errors).toEqual(['review_exclude_paths: more than 64 patterns']);
    expect(j.paths).toContain('data/p0/r.json');
    expect(j.readers.forbid_paths).toEqual(['private/**']);
    expect(receiptExcludeFallback(j.review_exclude)).toEqual({ source: j.review_exclude.source, errors: ['review_exclude_paths: more than 64 patterns'] });
  }, 120_000);

  // Value: protects=the PR that fixes the list is planned under the base's (set-aside) list, not its own valid one; fails_when=
  //   the head's 61 patterns are applied before they land; seam=gstack-review-plan --json; no_claim=the land step
  test('the PR that shortens the list is still planned with nothing excluded', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65) }, { '.gstack/ship-policy.json': policyText({ review_exclude_paths: patterns(61) }) });
    const j = planJson(repo);
    expect(j.review_exclude.state).toBe('fallback');
    expect(j.paths).toContain('data/p0/r.json');
  }, 120_000);

  // Value: protects=a valid base list plans exactly as before (negative control); fails_when=a valid list falls back or stops
  //   excluding; seam=gstack-review-plan; no_claim=the excluded file count beyond this fixture
  test('a valid base list still excludes its files', () => {
    const repo = repoWith({ review_exclude_paths: patterns(64) });
    const r = plan(repo);
    expect(r.status, r.err).toBe(EXIT.ok);
    expect(r.out).not.toContain('fallback');
    expect(r.out).toMatch(/REVIEW_EXCLUDE: patterns=1\/64 excluded=1 /);
    expect(planJson(repo).review_exclude.state).toBe('active');
  }, 120_000);

  // Value: protects=a branch that adds a list still gets the head-only notice and a normal review (negative control); fails_when=
  //   the head's policy is read; seam=gstack-review-plan; no_claim=other head-only keys
  test('a list only the head declares is still ignored', () => {
    const repo = repoWith({}, { '.gstack/ship-policy.json': policyText({ review_exclude_paths: patterns(3) }) });
    const r = plan(repo);
    expect(r.status, r.err).toBe(EXIT.ok);
    expect(r.out).toContain('REVIEW_EXCLUDE: none (head sets review_exclude_paths; it applies after it lands on main) patterns=3');
    expect(r.out).not.toContain('fallback');
  }, 120_000);

  // Value: protects=only exclusion errors are set aside: a base with any other invalid key still refuses before any reader;
  //   fails_when=the fallback swallows an error in a key whose default would loosen review or readers; seam=gstack-review-plan
  //   and gstack-ship-queue's loadBasePolicy; no_claim=the wording of the refusal
  test('a base with another invalid key still refuses, in the plan and in the queue', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65), review: { panel: 'some' } });
    const r = plan(repo);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('POLICY_INVALID');
    expect(r.out).not.toContain('REVIEW_EXCLUDE: fallback');
    const q = loadBasePolicy({ repoRoot: repo.work, base: 'main', gh: () => ({ ok: false, out: '' }) });
    expect('code' in q && q.code).toBe('POLICY_INVALID');
  }, 120_000);

  // Value: protects=only the two exclusion keys themselves are set aside: an unknown key that merely starts with one of their names
  //   (review_exclude_paths[0]) is an error of its own and still refuses; fails_when=the key filter is unanchored and drops that key
  //   with the list; seam=lib/ship-policy.ts finish; no_claim=the wording of the refusal
  test('an unknown key that starts with an exclusion key name still refuses', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65), 'review_exclude_paths[0]': 'data/**' });
    const r = plan(repo);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('POLICY_INVALID');
    expect(r.out).not.toContain('REVIEW_EXCLUDE: fallback');
  }, 120_000);

  // Value: protects=the merge step reads a base that fails only on its exclusion list, with its other keys, so the PR that fixes
  //   the list can land; fails_when=gstack-ship-queue refuses POLICY_INVALID on it; seam=loadBasePolicy; no_claim=land's checks
  test('the queue reads such a base with its other keys', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65) });
    const q = loadBasePolicy({ repoRoot: repo.work, base: 'main', gh: () => ({ ok: false, out: '' }) });
    expect('code' in q ? q : null).toBeNull();
    expect('policy' in q && q.policy.review_exclude_paths).toEqual([]);
    expect('policy' in q && q.policy.readers?.forbid_paths).toEqual(['private/**']);
  }, 120_000);

  // Value: protects=the setting aside is for reading the base, never for checking it: validate still names the bad list so the
  //   owner fixes it; fails_when=gstack-ship-policy validate --policy-from base reports such a base valid; seam=the validate CLI;
  //   no_claim=validate's other output
  test('validate still reports the base list as invalid', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65) });
    const r = runBin(repo, 'gstack-ship-policy', ['validate', '--policy-from', 'base', '--base', 'main']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('POLICY_INVALID: 1 error(s)');
    expect(r.err).toContain('more than 64 patterns at review_exclude_paths');
  }, 120_000);

  // Value: protects=show-effective, which /ship's POLICY line and /land-and-deploy's stamp check read, reports such a base valid
  //   with its other keys and the loud fallback line; fails_when=it exits 1 with valid:false (land-and-deploy then reads no
  //   queue_mode) or drops the warning; seam=the show-effective CLI; no_claim=renderEffective's other lines
  test('show-effective reads the base with its other keys and warns', () => {
    const repo = repoWith({ review_exclude_paths: patterns(65), queue_mode: 'stamp-at-merge' });
    const r = runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'main', '--json']);
    expect(r.status, r.err).toBe(EXIT.ok);
    const j = JSON.parse(r.out);
    expect({ valid: j.valid, queue_mode: j.policy.queue_mode, excluded: j.policy.review_exclude_paths }).toEqual({ valid: true, queue_mode: 'stamp-at-merge', excluded: [] });
    expect(r.err).toContain('gstack-ship-policy: REVIEW_EXCLUDE: fallback (WARNING');
    expect(r.err).not.toContain('POLICY_INVALID');
  }, 120_000);
});
