/**
 * The merge-train side of evals.yml (scripts/train-gate.ts; plan GSTA-49 T1b):
 * dispatch routing and its refusals, the green-train record (census from the
 * run's own plan manifest, first attempt only), prefix trees modulo stamps,
 * the per-prefix bisect record and the free screening summary. Fixture repos
 * under os.tmpdir() with their own git identity; no network, no API spend.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyGate } from '../lib/ship-queue-train-verdict';
import { buildRunManifest, type PaidRunManifest } from '../scripts/lib/paid-plan';
import { buildReceipt } from '../lib/tree-receipt';
import {
  FULL_GATE_USD, JUDGE_FILE, MAX_BISECT_CASES, MAX_PREFIXES, bisectMatrix, buildTrainRecord, fullGateCases, gitIn, routeDispatch, runBisectPrefix,
  screenSummary, stampFreeTree, trainPrefixes, type BisectPlan, type RouteInput,
} from '../scripts/train-gate';
import { loadPolicyFromHead } from '../lib/ship-policy';
import { LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { cleanup, makeFixtureRepo, type FixtureRepo } from './helpers/restamp-fixture';
import { TRAIN_POLICY } from './helpers/ship-queue-train-fixture';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'train-gate-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('routeDispatch: every run keeps its mode, and train inputs are validated before any paid work', () => {
  const base: RouteInput = { nonce: '', refName: 'main', head: A, expectedSha: '', evalsAll: true, trainPolicy: false, cases: '', prefixShas: '',
    screenPr: '', screenMergeSha: '', screenPolicy: '' };
  const deps = { isAncestor: (commit: string) => commit !== C, gateCases: () => new Map([['case-a', 'rule'], ['review/SKILL.md workflow', 'judge']]) };
  const route = (over: Partial<RouteInput>) => routeDispatch({ ...base, ...over }, deps);
  const screenNonce = (policy: string) => `pr.screen.${policy}-${A.slice(0, 12)}-${B.slice(0, 12)}-abc123`;
  const bisectNonce = `gate.bisect-${A.slice(0, 12)}-${B.slice(0, 12)}-abc123`;
  const trainNonce = `gate.train-${A.slice(0, 12)}-${B.slice(0, 12)}-abc123`;

  test('a plain eval-bg or backstop dispatch routes as today, with or without a train policy', () => {
    expect(route({})).toEqual({ mode: 'dispatch', cases: [], prefixes: [] });
    expect(route({ nonce: `pr-${A.slice(0, 12)}-${B.slice(0, 12)}-abc123`, evalsAll: false })).toMatchObject({ mode: 'dispatch' });
    expect(route({ nonce: `gate.backstop-${A.slice(0, 12)}-${A.slice(0, 12)}-abc123`, trainPolicy: true })).toMatchObject({ mode: 'dispatch' });
  });

  test('a screen needs a PR number, a full merge SHA, a policy, evals_all=false, a matching nonce and a train policy', () => {
    const screen = { screenPr: '42', screenMergeSha: C, screenPolicy: 'narrow', evalsAll: false, expectedSha: C, nonce: screenNonce('narrow'), trainPolicy: true };
    expect(route(screen)).toEqual({ mode: 'screen', cases: [], prefixes: [] });
    expect(route({ ...screen, expectedSha: '' })).toMatchObject({ mode: 'screen' });
    const refused = [
      { screenPr: '0' }, { screenPr: '42; rm -rf' }, { screenMergeSha: C.slice(0, 12) }, { screenPolicy: 'wide' }, { evalsAll: true }, { expectedSha: A },
      { nonce: screenNonce('broad') }, { nonce: bisectNonce }, { cases: 'case-a' }, { trainPolicy: false },
    ];
    for (const over of refused) expect(route({ ...screen, ...over }), JSON.stringify(over)).toHaveProperty('error');
    expect((route({ ...screen, trainPolicy: false }) as { error: string }).error).toContain('needs a train block');
  });

  test('a bisect needs a bisect nonce on train/<nonce>, the train head, plan case ids and ancestor prefixes', () => {
    const bisect = { nonce: bisectNonce, refName: 'train/t1', expectedSha: A, cases: 'case-a, review/SKILL.md workflow', prefixShas: `${A},${B}`, trainPolicy: true };
    expect(route(bisect)).toEqual({ mode: 'bisect', cases: ['case-a', 'review/SKILL.md workflow'], prefixes: [A, B] });
    const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(',');
    const refused: Array<[Partial<RouteInput>, string]> = [
      [{ nonce: trainNonce }, 'needs a bisect nonce'],
      [{ refName: 'main' }, 'runs on train/<nonce>'],
      [{ expectedSha: B }, 'is not the train head'],
      [{ cases: '' }, 'cases must name'],
      [{ cases: 'case-a,case-a' }, 'cases must name'],
      [{ cases: many(MAX_BISECT_CASES + 1, i => `case-${i}`) }, 'cases must name'],
      [{ prefixShas: many(MAX_PREFIXES + 1, i => i.toString(16).padStart(40, '0')) }, 'prefix_shas must name'],
      [{ prefixShas: A.slice(0, 12) }, 'is not a full commit SHA'],
      [{ prefixShas: `${A},${C}` }, 'is not an ancestor of the train head'],
      [{ cases: 'case-a,not-a-plan-case' }, "not in the full gate's plan"],
      [{ trainPolicy: false }, 'needs a train block'],
    ];
    for (const [over, why] of refused) expect((route({ ...bisect, ...over }) as { error?: string }).error, why).toContain(why);
    expect((route({ cases: 'case-a', prefixShas: A }) as { error?: string }).error).toContain('needs a bisect nonce');
  });

  test('a train gate is the full gate of the train head on train/<nonce>, under a train policy', () => {
    const train = { nonce: trainNonce, refName: 'train/t1', expectedSha: A, trainPolicy: true };
    expect(route(train)).toEqual({ mode: 'train', cases: [], prefixes: [] });
    for (const over of [{ refName: 'main' }, { evalsAll: false }, { expectedSha: '' }, { trainPolicy: false }]) expect(route({ ...train, ...over })).toHaveProperty('error');
  });

  test("the bisect's case universe is the full gate's own plan on this checkout", () => {
    const cases = fullGateCases();
    expect([...cases.values()].filter(kind => kind === 'judge').length).toBe(Object.keys(LLM_JUDGE_TOUCHFILES).length);
    expect([...cases.values()].filter(kind => kind !== 'judge').length).toBeGreaterThan(50);
  });
});

describe('train record: the census comes from the run\'s own manifest, first attempt only', () => {
  const [j1, j2] = Object.keys(LLM_JUDGE_TOUCHFILES) as [string, string];
  const behavior = 'shared-libs-opportunity-judgment';
  const judgeEntry = buildRunManifest({ tier: 'gate', profile: 'full', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } }).entries.find(e => e.file === JUDGE_FILE)!;
  const trialFiles = [1, 2, 3].map(t => `test/skill-e2e-shared-libs-periodic.test.ts#${behavior}~t${t}`);
  const manifest = { version: 1, tier: 'gate', evalsAll: true, sliceCount: 2, selectionReason: 'evals_all', profile: 'full', selection: { e2e: null, judges: [j1, j2] },
    entries: [
      { ...judgeEntry, slice: 1 },
      ...trialFiles.map(file => ({ file, slice: 2, status: 'planned', trial: { kind: 'behavior', panel: { n: 3, k: 2 }, quarantined: false } })),
    ] } as unknown as PaidRunManifest;
  type Slice = { index: number; attempt?: number; files?: string[]; checkpoint?: true };
  let n = 0;
  function report(o: { slices?: Slice[]; outcomes?: Array<Record<string, unknown>>; collector?: Record<string, unknown> | null } = {}): string {
    const dir = path.join(scratch, `report-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const outcomes = o.outcomes ?? [j1, j2].map(id => ({ case: id, kind: 'judge', attempt: 1, outcome: 'passed', cost_usd: 0.25 }))
      .concat([1, 2, 3].map(trial => ({ case: behavior, kind: 'behavior', trial, attempt: 1, outcome: 'passed', cost_usd: 1 })));
    fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), outcomes.map(line => JSON.stringify(line)).join('\n') + '\n');
    if (o.collector !== null) fs.writeFileSync(path.join(dir, 'collector-outcomes.json'), JSON.stringify(o.collector ?? { verdict: { verdict: 'GREEN' }, census: { unattributed: [] }, panels: [] }));
    for (const s of o.slices ?? [{ index: 1 }, { index: 2 }]) {
      const at = path.join(dir, `paid-slice-${s.index}-a${s.attempt ?? 1}`);
      fs.mkdirSync(at, { recursive: true });
      fs.writeFileSync(path.join(at, `slice-${s.index}.json`), JSON.stringify({ version: 1, tier: 'gate', sliceIndex: s.index, sliceCount: 2, attempt: s.attempt ?? 1,
        ...(s.checkpoint ? { checkpoint: true } : {}), outcomes: (s.files ?? (s.index === 1 ? [JUDGE_FILE] : trialFiles)).map(file => ({ files: [file], status: 'passed' })) }));
    }
    return dir;
  }
  const build = (dir: string, reconcileExit = 0) => buildTrainRecord({ reportDir: dir, nonce: 'gate.train-x', head: A, tree: B, reconcileExit,
    prefixes: [{ index: 1, commit: C, tree: B, stamp_free_tree: 'd'.repeat(64) }], run: { id: 7, attempt: 1, url: 'https://example.invalid/runs/7' } });
  const classify = (record: unknown) => classifyGate(record, { nonce: 'gate.train-x', head: A, tree: B }, { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'success' } as never).outcome;

  test('a complete census of passing cases is GREEN, and T1 classifies it GREEN', () => {
    const record = build(report());
    expect(record).toMatchObject({ schema: 1, kind: 'train-gate', nonce: 'gate.train-x', head_sha: A, tree: B, verdict: 'GREEN', run: { id: 7 } });
    expect(record.census).toEqual({ complete: true, planned: { rule: 1, judge: 2 }, executed: { rule: 1, judge: 2 }, unbound: 0, partial_shards: 0, cancelled_shards: 0, killed_before_upload: 0 });
    expect(record.panels.map(p => [p.case, p.status, p.cost_usd])).toEqual([[j2, 'PASS', 0.25], [j1, 'PASS', 0.25], [behavior, 'PASS', 3]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    expect(classify(record)).toBe('GREEN');
  });

  test('a slice killed before its upload step is incomplete, never passed over, and a re-run attempt cannot fill it', () => {
    const killed = build(report({ slices: [{ index: 1 }], outcomes: [j1, j2].map(id => ({ case: id, kind: 'judge', attempt: 1, outcome: 'passed' })) }));
    expect(killed.verdict).toBe('RED');
    expect(killed.census).toMatchObject({ complete: false, killed_before_upload: 1, executed: { rule: 0, judge: 2 } });
    expect(classify(killed)).toBe('INCOMPLETE');
    const rerun = build(report({ slices: [{ index: 1 }, { index: 2, attempt: 2 }], outcomes: [
      ...[j1, j2].map(id => ({ case: id, kind: 'judge', attempt: 1, outcome: 'passed' })), ...[1, 2, 3].map(trial => ({ case: behavior, kind: 'behavior', trial, attempt: 2, outcome: 'passed' }))] }));
    expect(rerun.census).toMatchObject({ complete: false, killed_before_upload: 1, executed: { rule: 0, judge: 2 } });
    expect(rerun.verdict).toBe('RED');
  });

  test('a partial or cancelled shard, a missing collector, a red reconcile or a red collector is never GREEN', () => {
    expect(build(report({ slices: [{ index: 1 }, { index: 2, checkpoint: true }] })).census.partial_shards).toBe(1);
    expect(build(report({ slices: [{ index: 1 }, { index: 2, files: [] }] })).census.cancelled_shards).toBe(trialFiles.length);
    for (const record of [build(report({ slices: [{ index: 1 }, { index: 2, checkpoint: true }] })), build(report({ slices: [{ index: 1 }, { index: 2, files: [] }] })),
      build(report({ collector: null })), build(report(), 1), build(report({ collector: { verdict: { verdict: 'RED' }, census: { unattributed: [] }, panels: [] } })),
      build(report({ collector: { verdict: { verdict: 'GREEN' }, census: { unattributed: [{ file: 'x' }] }, panels: [] } }))]) {
      expect(record.verdict).toBe('RED');
    }
  });

  test('a failed case is a red VERDICT panel T1 bisects on', () => {
    const record = build(report({ outcomes: [{ case: j1, kind: 'judge', attempt: 1, outcome: 'failed', failure_class: 'assertion' },
      { case: j2, kind: 'judge', attempt: 1, outcome: 'passed' }, ...[1, 2, 3].map(trial => ({ case: behavior, kind: 'behavior', trial, attempt: 1, outcome: 'passed' }))],
      collector: { verdict: { verdict: 'RED' }, census: { unattributed: [] }, panels: [] } }));
    expect(record.verdict).toBe('RED');
    expect(record.panels.find(p => p.case === j1)).toMatchObject({ status: 'FAIL', red_class: 'VERDICT' });
    expect(classify(record)).toBe('RED');
  });

  test('rule 16: a case the report resolved FLAKY is a PASS naming both runs, and the train is GREEN; without the record it stays red', () => {
    const outcomes = [{ case: j1, kind: 'judge', attempt: 1, outcome: 'failed', failure_class: 'assertion' },
      { case: j2, kind: 'judge', attempt: 1, outcome: 'passed' }, ...[1, 2, 3].map(trial => ({ case: behavior, kind: 'behavior', trial, attempt: 1, outcome: 'passed' }))];
    const flake = { schema: 1, kind: 'gate-flake', case: j1, case_kind: 'judge', first: { attempt: 1, phase: 'first', where: 'attempt 1 (paid-slice-1-a1)' },
      rerun: { attempt: 1, phase: 'rerun', where: 'attempt 1 rerun (paid-rerun-1-a1)' } };
    const record = build(report({ outcomes, collector: { verdict: { verdict: 'GREEN' }, census: { unattributed: [] }, panels: [], flaky: [flake] } }));
    expect(record.panels.find(p => p.case === j1)).toEqual({ case: j1, kind: 'judge', status: 'PASS', red_class: null, cost_usd: null,
      flaky: { first: 'attempt 1 (paid-slice-1-a1)', rerun: 'attempt 1 rerun (paid-rerun-1-a1)' } });
    expect(record.verdict).toBe('GREEN');
    expect(classify(record)).toBe('GREEN');
    expect(build(report({ outcomes, collector: { verdict: { verdict: 'RED' }, census: { unattributed: [] }, panels: [] } })).verdict).toBe('RED');
  });
});

describe('prefix trees modulo stamps', () => {
  let repo: FixtureRepo;
  const sha: Record<string, string> = {};
  beforeAll(() => {
    repo = makeFixtureRepo({ policy: TRAIN_POLICY, prefix: 'train-gate-fx-' });
    sha.main = repo.git('rev-parse', 'HEAD');
    const branch = (name: string, file: string) => {
      repo.git('checkout', '-q', '-B', name, sha.main!);
      fs.writeFileSync(path.join(repo.work, file), `${name}\n`);
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', name);
      return repo.git('rev-parse', 'HEAD');
    };
    sha.pr1 = branch('pr1', 'one.txt');
    sha.pr2 = branch('pr2', 'two.txt');
    const merge = (parent: string, head: string, index: number, pr: number) => {
      const tree = repo.git('merge-tree', '--write-tree', parent, head);
      return repo.git('commit-tree', tree, '-p', parent, '-p', head, '-m', `train T${index}: merge #${pr} at ${head.slice(0, 12)}`);
    };
    sha.t1 = merge(sha.main!, sha.pr1!, 1, 11);
    sha.t2 = merge(sha.t1!, sha.pr2!, 2, 12);
    repo.git('checkout', '-q', '-B', 'squash', sha.main!);
    fs.writeFileSync(path.join(repo.work, 'one.txt'), 'pr1\n');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    fs.writeFileSync(path.join(repo.work, 'generated', 'digest.md'), '# digest v1.2.4.0\nbody\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(repo.work, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify({ ...pkg, version: '1.2.4' }, null, 2) + '\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'squash #11 (stamped)');
    sha.squash1 = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.work, 'one.txt'), 'pr1, edited\n');
    repo.git('commit', '-qam', 'a non-stamp edit');
    sha.edited = repo.git('rev-parse', 'HEAD');
  });
  afterAll(() => cleanup(repo));

  test('a squash merge that differs from its prefix only by stamps has the same tree modulo stamps; a code byte does not', () => {
    const git = gitIn(repo.work);
    const policy = loadPolicyFromHead(repo.work).policy;
    const t1 = stampFreeTree(git, sha.t1!, repo.work, policy);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.git('rev-parse', `${sha.t1}^{tree}`)).not.toBe(repo.git('rev-parse', `${sha.squash1}^{tree}`));
    expect(stampFreeTree(git, sha.squash1!, repo.work, policy)).toBe(t1);
    expect(stampFreeTree(git, sha.edited!, repo.work, policy)).not.toBe(t1);
    // The same verdicts as the tree receipt verify and gate reuse use (lib/tree-receipt.ts).
    const receipt = (current: string) => (buildReceipt({ repoRoot: repo.work, gated: sha.t1!, current, policy, policyLabel: 'fixture' }) as { tree: string }).tree;
    expect(receipt(sha.squash1!)).toBe('same-modulo-stamps');
    expect(receipt(sha.edited!)).toBe('changed');
    expect(stampFreeTree(git, 'f'.repeat(40), repo.work, policy)).toHaveProperty('error');
  });

  // Value: protects=a gated-to-current diff git cannot produce refuses with its cause instead of reading as 'no changes'
  //   (GST-448); fails_when=buildReceipt treats a failed diff as an empty one or drops why it failed; seam=a missing blob; no_claim=none
  test('a diff git cannot produce refuses the receipt with EVIDENCE_IDENTITY_UNKNOWN and git\'s reason', () => {
    const policy = loadPolicyFromHead(repo.work).policy;
    repo.git('checkout', '-q', '-B', 'lost-blob', sha.t1!);
    fs.writeFileSync(path.join(repo.work, 'lost.txt'), 'a blob this test deletes from the object store\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'add a blob');
    const head = repo.git('rev-parse', 'HEAD');
    const blobId = repo.git('rev-parse', `${head}:lost.txt`);
    const gitDir = repo.git('rev-parse', '--absolute-git-dir');
    fs.rmSync(path.join(gitDir, 'objects', blobId.slice(0, 2), blobId.slice(2)));
    const r = buildReceipt({ repoRoot: repo.work, gated: sha.t1!, current: head, policy, policyLabel: 'fixture' }) as { error?: string; code?: string };
    expect(r.code).toBe('EVIDENCE_IDENTITY_UNKNOWN');
    expect(r.error).toMatch(/^git diff [0-9a-f]{12} [0-9a-f]{12} failed \(.+\), so the changed files cannot be classified/);
    repo.git('checkout', '-q', '-f', 'squash');
  });

  // #3512: a stamp path carrying a tentative `*_KEY_VERSION = '<next minor>'` (gstack's own convention since #3511) digests the
  // same before and after the slot stamp moves it, so train-backstop finds the record that covers main; a base-version mention
  // on a line the base already carried digests the same at the prefix (where it equals VERSION) and on the stamped main.
  test('stampFreeTree collapses every stamp-form mention, not only the commit\'s version: a moved tentative key and a kept released one both digest equal', () => {
    const git = gitIn(repo.work);
    const policy = { ...loadPolicyFromHead(repo.work).policy, stamp_paths: ['docs/**/*.md', 'lib/policy.ts'], stamp_patterns: ["_KEY_VERSION = '{version}'"] };
    const policyFile = (text: string) => { fs.mkdirSync(path.join(repo.work, 'lib'), { recursive: true }); fs.writeFileSync(path.join(repo.work, 'lib', 'policy.ts'), text); };
    // The unstamped prefix: VERSION 1.2.3.0, a new key written as the tentative 1.3.0.0, a released key at 1.2.3.0 (the base's version).
    repo.git('checkout', '-q', '-B', 'key-prefix', sha.main!);
    policyFile("export const DOCS_KEY_VERSION = '1.3.0.0';\nexport const REVIEW_KEY_VERSION = '1.2.3.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\n");
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'prefix with a tentative key');
    const prefix = repo.git('rev-parse', 'HEAD');
    // Main after the slot stamp: VERSION 1.2.4.0, the tentative moved to the released version, the released key as written.
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    policyFile("export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const REVIEW_KEY_VERSION = '1.2.3.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\n");
    repo.git('commit', '-qam', 'stamp 1.2.4.0');
    const stamped = repo.git('rev-parse', 'HEAD');
    expect(stampFreeTree(git, stamped, repo.work, policy)).toBe(stampFreeTree(git, prefix, repo.work, policy));
    // A byte beyond a stamp-form mention still changes the digest.
    policyFile("export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const REVIEW_KEY_VERSION = '1.2.3.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\nexport const EXTRA = 1;\n");
    repo.git('commit', '-qam', 'a code byte');
    expect(stampFreeTree(git, repo.git('rev-parse', 'HEAD'), repo.work, policy)).not.toBe(stampFreeTree(git, prefix, repo.work, policy));
    // The receipt agrees with the digest on the stamp, and refuses a released key moved by hand (older than the gated version;
    // a mention equal to it is the base's own version, which the stamp_paths stage moves on a branch-added line).
    const tree = (current: string) => (buildReceipt({ repoRoot: repo.work, gated: prefix, current, policy, policyLabel: 'fixture' }) as { tree: string; residual: string[] }).tree;
    expect(tree(stamped)).toBe('same-modulo-stamps');
    repo.git('checkout', '-q', '-B', 'hand-move', prefix);
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    policyFile("export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const REVIEW_KEY_VERSION = '1.2.3.0';\nexport const OLD_KEY_VERSION = '1.2.4.0';\n");
    repo.git('commit', '-qam', 'stamp plus a released key moved by hand');
    expect(tree(repo.git('rev-parse', 'HEAD'))).toBe('changed');
    repo.git('checkout', '-q', 'squash');
  });

  test('T1..Tk come from the train head by first parents; a head that is not a train is refused', () => {
    const git = gitIn(repo.work);
    const policy = loadPolicyFromHead(repo.work).policy;
    const prefixes = trainPrefixes(git, sha.t2!, repo.work, policy);
    expect(Array.isArray(prefixes)).toBe(true);
    expect((prefixes as Array<{ index: number; commit: string }>).map(p => [p.index, p.commit])).toEqual([[1, sha.t1], [2, sha.t2]]);
    expect(trainPrefixes(git, sha.main!, repo.work, policy)).toHaveProperty('error');
  });
});

describe('bisect: one executor per prefix, one trial per case', () => {
  const plan: BisectPlan = { schema: 1, nonce: 'gate.bisect-x', cases: [{ id: 'case-a', kind: 'rule' }, { id: 'case-b', kind: 'judge' }], prefixes: [A, B] };

  test('the matrix indexes prefixes from 1 and scales its ceiling with the case count', () => {
    expect(bisectMatrix(plan)).toEqual({ slices: [1, 2], timeouts: [0, 80, 80], refs: ['', A, B] });
  });

  test('each prefix writes the record T1 reads; a case that leaves no verdict is INCOMPLETE; a wrong checkout refuses', async () => {
    const record = await runBisectPrefix(plan, 2, { rootDir: scratch, evalDir: path.join(scratch, 'bisect'), checkedOut: B,
      runCase: async (id) => { if (id === 'case-b') throw new Error('runner crashed'); return { status: 'FAIL', redClass: 'VERDICT' }; } });
    expect(record).toEqual({ schema: 1, kind: 'train-bisect-prefix', nonce: 'gate.bisect-x', prefix_sha: B, checked_out_sha: B, panels: [
      { case: 'case-a', kind: 'rule', status: 'FAIL', red_class: 'VERDICT', cost_usd: null },
      { case: 'case-b', kind: 'judge', status: 'INCOMPLETE', red_class: 'INCOMPLETE', cost_usd: null }] });
    await expect(runBisectPrefix(plan, 1, { rootDir: scratch, evalDir: scratch, checkedOut: B, runCase: async () => ({ status: 'PASS', redClass: null }) })).rejects.toThrow('not its prefix');
    await expect(runBisectPrefix(plan, 3, { rootDir: scratch, evalDir: scratch, checkedOut: B })).rejects.toThrow('names no prefix');
  });

  test('rule 16 in a bisect: a case verdict FAIL reruns once on the prefix; a pass is a flaky PASS, a second FAIL stays red, INFRA and INCOMPLETE never rerun', async () => {
    const script = (verdicts: Record<string, Array<{ status: string; redClass: string | null }>>) => {
      const calls: string[] = [];
      return { calls, runCase: async (id: string, _kind: string, evalDir: string) => { calls.push(`${id} ${path.basename(evalDir)}`); return verdicts[id]!.shift()!; } };
    };
    const fail = { status: 'FAIL', redClass: 'VERDICT' }, pass = { status: 'PASS', redClass: null };
    const flaky = script({ 'case-a': [fail, pass], 'case-b': [fail, fail] });
    const record = await runBisectPrefix(plan, 1, { rootDir: scratch, evalDir: path.join(scratch, 'bisect-flaky'), checkedOut: A, runCase: flaky.runCase });
    expect(record.panels).toEqual([
      { case: 'case-a', kind: 'rule', status: 'PASS', red_class: null, cost_usd: null, flaky: { first: `prefix ${A.slice(0, 12)} slice 1`, rerun: `prefix ${A.slice(0, 12)} slice 1 rerun` } },
      { case: 'case-b', kind: 'judge', status: 'FAIL', red_class: 'VERDICT', cost_usd: null }]);
    expect(flaky.calls).toEqual(['case-a case-a', 'case-a case-a.rerun', 'case-b case-b', 'case-b case-b.rerun']);
    const never = script({ 'case-a': [{ status: 'FAIL', redClass: 'INFRA' }], 'case-b': [{ status: 'INCOMPLETE', redClass: 'INCOMPLETE' }] });
    const kept = await runBisectPrefix(plan, 1, { rootDir: scratch, evalDir: path.join(scratch, 'bisect-never'), checkedOut: A, runCase: never.runCase });
    expect(kept.panels.map(p => [p.case, p.status, p.red_class])).toEqual([['case-a', 'FAIL', 'INFRA'], ['case-b', 'INCOMPLETE', 'INCOMPLETE']]);
    expect(never.calls).toHaveLength(2);
  });
});

test('the free screening summary says first how to request the screen, then the selection and its estimated cost', () => {
  const [j1] = Object.keys(LLM_JUDGE_TOUCHFILES) as [string];
  const manifest = { version: 1, tier: 'gate', evalsAll: false, sliceCount: 1, profile: 'pr', selection: { e2e: [], judges: [j1] }, prCoverage: { mode: 'narrow' },
    entries: [{ file: JUDGE_FILE, slice: 1, status: 'planned' }] } as unknown as PaidRunManifest;
  const lines = screenSummary(manifest, '42');
  expect(lines[0]).toStartWith('To run the paid screen of this head: `gstack-ship-queue ready --pr 42 --screen`');
  expect(lines[1]).toBe('- Screening selection: 0 case(s) + 1 judge(s), PR coverage mode `narrow`');
  expect(lines[2]).toMatch(new RegExp(`^- Estimated screen cost: ~\\$\\d+\\.\\d{2} .*\\$${FULL_GATE_USD} full gate.* No paid case ran on this push\\.$`));
});
