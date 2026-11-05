/**
 * Paid-gate verdict reuse (R2a restamp-only, R2 main moved; GSTA-48): a gate
 * edit, so every refusal is a negative control. Real git fixtures (a bare origin, the base-ref receipt
 * checkout) and scripted gh responses: no network, no API spend.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BINDING_FILE, CANDIDATE_FILE, REUSE_FILE, buildBinding, confirmReuse, findReusableGate, parseBinding, parseReuse, reuseReport, selectionFingerprint,
  type GateBinding, type GateReuse,
} from '../scripts/gate-reuse';
import type { GhRunner, WorkflowRun } from '../scripts/recover-receipts';
import type { PaidRunManifest } from '../scripts/lib/paid-plan';

const ROOT = path.resolve(import.meta.dir, '..');
const REPO = 'garrytan/gstack';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reuse-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}

const changelog = (sections: string[]) => ['# Changelog', '', ...sections, '## [1.0.0.0] - 2026-10-01', '', '- base release', ''].join('\n');
const files = (version: string, over: Record<string, string> = {}): Record<string, string> => ({
  VERSION: version + '\n',
  'package.json': JSON.stringify({ name: 'fixture', version, scripts: { test: 'bun test' } }, null, 2) + '\n',
  'agents-digest/gstack-AGENTS.md': '# gstack digest v' + version + ' — regenerate after upgrading\n\nbody\n',
  'src/feature.ts': 'export const feature = 1;\n',
  ...over,
});

let origin: string;
let receipt: string;
const sha: Record<string, string> = {};

function commit(work: string, branch: string, from: string, content: Record<string, string>, message: string): string {
  if (from) git(work, 'checkout', '-q', '-B', branch, from);
  else git(work, 'checkout', '-q', '--orphan', branch);
  for (const [rel, text] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  git(work, 'push', '-q', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  origin = path.join(scratch, 'origin.git');
  git(scratch, 'init', '-q', '--bare', origin);
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(origin, 'config', 'maintenance.auto', 'false');
  git(origin, 'config', 'gc.auto', '0');
  const work = path.join(scratch, 'work');
  git(scratch, 'clone', '-q', origin, work);
  const policy = fs.readFileSync(path.join(ROOT, '.gstack/ship-policy.json'), 'utf8');
  sha.base = commit(work, 'main', '', { ...files('1.0.0.0', { 'src/feature.ts': 'export const feature = 0;\n' }), 'CHANGELOG.md': changelog([]),
    '.gstack/ship-policy.json': policy }, 'base');
  const entry = ['## [1.0.1.0] - 2026-10-02', '', '- the feature', ''];
  sha.gated = commit(work, 'feature', sha.base, { ...files('1.0.1.0'), 'CHANGELOG.md': changelog(entry) }, 'feature, tentative stamp');
  sha.restamp = commit(work, 'restamp', sha.gated, { ...files('1.0.2.0'), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']) }, 'restamp');
  sha.code = commit(work, 'code', sha.restamp, { 'src/feature.ts': 'export const feature = 2;\n' }, 'restamp plus a code byte');
  sha.entry = commit(work, 'entry', sha.gated, { ...files('1.0.2.0'), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature, reworded', '']) }, 'restamp plus entry text');
  sha.lock = commit(work, 'lock', sha.gated, { 'bun.lock': '{\n  "lockfileVersion": 1\n}\n' }, 'a non-stamp file beside the stamp');
  const lock = (version: string) => '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "fixture",\n      "version": "' + version + '",\n    },\n  },\n}\n';
  sha.gatedLock = commit(work, 'gated-lock', sha.gated, { 'bun.lock': lock('1.0.1.0') }, 'a lockfile carrying the root version');
  sha.lockStamp = commit(work, 'lock-stamp', sha.gatedLock, { ...files('1.0.2.0'), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']),
    'bun.lock': lock('1.0.2.0') }, 'restamp that also moves the lockfile root version');
  sha.moved = commit(work, 'main', sha.base, { 'README.md': 'main moved\n' }, 'main moves');
  git(work, 'checkout', '-q', '-B', 'merged', sha.gated);
  git(work, 'merge', '-q', '--no-edit', sha.moved);
  git(work, 'push', '-q', 'origin', 'merged');
  sha.merged = git(work, 'rev-parse', 'HEAD');
  sha.rebased = commit(work, 'rebased', sha.moved, { ...files('1.0.1.0'), 'CHANGELOG.md': changelog(entry) }, 'the feature, rebased onto moved main');
  sha.rebasedCode = commit(work, 'rebased-code', sha.rebased, { 'src/feature.ts': 'export const feature = 3;\n' }, 'rebased plus a code byte');
  sha.rebasedEntry = commit(work, 'rebased-entry', sha.rebased, { 'CHANGELOG.md': changelog(['## [1.0.1.0] - 2026-10-02', '', '- the feature, reworded', '']) }, 'rebased plus entry text');
  sha.rebasedPkg = commit(work, 'rebased-pkg', sha.rebased, { 'package.json': JSON.stringify({ name: 'fixture', version: '1.0.1.0', scripts: { test: 'bun test --bail' } }, null, 2) + '\n' }, 'rebased plus a package script');
  sha.rebasedDigest = commit(work, 'rebased-digest', sha.rebased, { 'agents-digest/gstack-AGENTS.md': '# gstack digest v1.0.1.0 — regenerate after upgrading\n\nbody\nhand-written instruction\n' }, 'rebased plus release-output content');
  sha.rebasedDrop = commit(work, 'rebased-drop', sha.rebased, { 'CHANGELOG.md': ['# Changelog', '', ...entry].join('\n') }, 'rebased plus a deleted CHANGELOG section');
  sha.rebasedPreamble = commit(work, 'rebased-preamble', sha.rebased, { 'CHANGELOG.md': changelog(entry).replace('# Changelog', '# Changelog (edited)') }, 'rebased plus a CHANGELOG preamble edit');
  const protocol = (version: string, protocolVersion: string) => ({ 'agents-digest/gstack-AGENTS.md': '# gstack digest v' + version + ' — regenerate after upgrading\n\nbody\ncompatible with protocol ' + protocolVersion + '\n' });
  sha.gatedProtocol = commit(work, 'gated-protocol', sha.base, { ...files('1.0.1.0', protocol('1.0.1.0', '1.0.1.0')), 'CHANGELOG.md': changelog(entry) }, 'a digest line that repeats the version as content');
  sha.restampProtocol = commit(work, 'restamp-protocol', sha.moved, { ...files('1.0.2.0', protocol('1.0.2.0', '1.0.2.0')), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']) },
    'rebased restamp that also changes the content line');
  sha.restampProtocolKept = commit(work, 'restamp-protocol-kept', sha.moved, { ...files('1.0.2.0', protocol('1.0.2.0', '1.0.1.0')), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']) },
    'rebased restamp that keeps the content line');
  git(work, 'checkout', '-q', '-B', 'rebased-mode', sha.rebased);
  git(work, 'update-index', '--chmod=+x', 'package.json');
  git(work, 'commit', '-q', '-m', 'rebased plus a package.json mode change');
  git(work, 'push', '-q', 'origin', 'rebased-mode');
  git(work, 'reset', '-q', '--hard');
  sha.rebasedMode = git(work, 'rev-parse', 'HEAD');
  sha.mainTouch = commit(work, 'main-touch', sha.base, { 'src/feature.ts': 'export const feature = 0;\n// main note\n' }, 'main edits the file the PR edits');
  sha.touchRebased = commit(work, 'touch-rebased', sha.mainTouch, { ...files('1.0.1.0', { 'src/feature.ts': 'export const feature = 1;\n// main note\n' }), 'CHANGELOG.md': changelog(entry) },
    'the feature, rebased onto a main that edited its file');
  const digest = (version: string, body: string) => ({ 'agents-digest/gstack-AGENTS.md': '# gstack digest v' + version + ' — regenerate after upgrading\n\nbody\n' + body });
  const restampLog = { 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']) };
  sha.gatedDash = commit(work, 'gated-dash', sha.base, { ...files('1.0.1.0', digest('1.0.1.0', '-- old banner\n')), 'CHANGELOG.md': changelog(entry) }, 'a digest line that looks like a diff header');
  sha.dashReplace = commit(work, 'dash-replace', sha.gatedDash, { ...files('1.0.2.0', digest('1.0.2.0', '++ new banner\n')), ...restampLog }, 'restamp that replaces a -- line with a ++ line');
  sha.dashRemove = commit(work, 'dash-remove', sha.gatedDash, { ...files('1.0.2.0', digest('1.0.2.0', '')), ...restampLog }, 'restamp that removes a -- line');
  sha.dashAdd = commit(work, 'dash-add', sha.gated, { ...files('1.0.2.0', digest('1.0.2.0', '++ ordinary non-version body text\n')), ...restampLog }, 'restamp that adds a ++ line');
  git(work, 'checkout', '-q', '-B', 'mode', sha.restamp);
  git(work, 'update-index', '--chmod=+x', 'agents-digest/gstack-AGENTS.md');
  git(work, 'commit', '-q', '-m', 'restamp plus a digest mode change');
  git(work, 'push', '-q', 'origin', 'mode');
  sha.mode = git(work, 'rev-parse', 'HEAD');
  receipt = path.join(scratch, 'receipt');
  git(scratch, 'clone', '-q', '--depth=1', 'file://' + origin, receipt);
  git(receipt, 'fetch', '-q', '--depth=1', 'origin', sha.base);
  git(receipt, 'checkout', '-q', '--detach', sha.base);
});

const binding = (over: Partial<GateBinding> = {}): GateBinding => ({ schema: 1, repository: REPO, pr: 42, run_id: 300, run_attempt: 1,
  head_sha: sha.gated!, base_sha: sha.base!, profile: 'pr', reconcile_exit: 0, verdict: 'GREEN', manual_accepted: 0, selection_sha256: 'f'.repeat(64), ...over });
const run = (id: number, head: string, conclusion: string | null = 'success', over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id, status: 'completed', conclusion, event: 'pull_request', head_sha: head, run_attempt: 1, head_repository: { full_name: REPO },
  pull_requests: [{ number: 42 }], ...over });

type Jobs = Record<number, Array<{ name: string; conclusion: string | null }>>;

/**
 * gh: the run list, each run's artifact and job lists (a bound run ran its
 * slices; an unbound one ran none unless scripted), downloads that write the
 * scripted binding (or raw text), and merge-bases from the fixture repo.
 */
function fakeGh(runs: WorkflowRun[], bindings: Record<number, GateBinding | string>, failList = '', jobs: Jobs = {}, failCompare = false, prCommits: string[] = []): GhRunner {
  return (args) => {
    const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args.some(a => /\/pulls\/42\/commits$/.test(a))) return { status: 0, stdout: prCommits.join('\n') + '\n', stderr: '' };
    if (args.some(a => a.endsWith('/workflows/evals.yml/runs'))) return failList ? { status: 1, stdout: '', stderr: failList } : ok({ workflow_runs: runs });
    const jobList = args.find(a => /\/runs\/\d+\/jobs$/.test(a));
    if (jobList) {
      const id = Number(/runs\/(\d+)\//.exec(jobList)![1]);
      return ok({ jobs: [{ name: 'plan-slices', conclusion: 'success' }, ...(jobs[id] ?? (id in bindings ? [{ name: 'eval-slices (1)', conclusion: 'success' }] : []))] });
    }
    const compare = args.find(a => /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(a));
    if (compare) {
      if (failCompare) return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      const [, a, b] = /compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(compare)!;
      return { status: 0, stdout: git(path.join(scratch, 'work'), 'merge-base', a!, b!) + '\n', stderr: '' };
    }
    const listed = args.find(a => /\/runs\/\d+\/artifacts$/.test(a));
    if (listed) {
      const id = Number(/runs\/(\d+)\//.exec(listed)![1]);
      return ok({ artifacts: id in bindings ? [{ name: 'gate-binding-a1', expired: false }, { name: 'paid-plan', expired: false }] : [{ name: 'paid-plan', expired: false }] });
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1]!;
      fs.mkdirSync(dir, { recursive: true });
      const b = bindings[Number(args[2])]!;
      fs.writeFileSync(path.join(dir, BINDING_FILE), typeof b === 'string' ? b : JSON.stringify(b));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
  };
}

/** The tested commit of a pull_request run: the merge of the head into the base (first parent), pushed like refs/pull/N/merge. */
const merges = new Map<string, string>();
function tested(base: string, head: string): string {
  const key = base + head;
  if (!merges.has(key)) {
    const work = path.join(scratch, 'work');
    const merge = git(work, 'commit-tree', head + '^{tree}', '-p', base, '-p', head, '-m', 'merge');
    git(work, 'push', '-q', 'origin', merge + ':refs/heads/pull-merge-' + merges.size);
    merges.set(key, merge);
  }
  return merges.get(key)!;
}

let outCount = 0;
function find(head: string, runs: WorkflowRun[], bindings: Record<number, GateBinding | string>,
  over: { baseSha?: string; failList?: string; jobs?: Jobs; failCompare?: boolean; testedSha?: string; screen?: { policy: 'narrow' | 'broad' }; prCommits?: string[] } = {}) {
  const out = path.join(scratch, 'out-' + ++outCount);
  const result = findReusableGate({ repo: REPO, pr: 42, headRepo: REPO, branch: 'feature', selfRunId: 500, headSha: head,
    testedSha: over.testedSha ?? tested(over.baseSha ?? sha.base!, head), repoRoot: receipt, out, ...(over.screen ? { screen: over.screen } : {}),
    gh: fakeGh(runs, bindings, over.failList, over.jobs, over.failCompare, over.prCommits) });
  return { ...result, out, text: result.lines.join('\n') };
}

describe('fixture origin', () => {
  // Value: protects=a push into the bare origin starts no detached auto-maintenance there, so a later push never writes into an
  //   object directory a repack just removed (unable to write ./objects/3f/…, Free Tests 41980850843 shard 5); fails_when=the origin
  //   loses maintenance.auto=false; why_new=local transport drops the runner's GIT_CONFIG_COUNT backstop; seam=none;
  //   no_claim=which maintenance task removed the directory on the CI runner's git
  test('a push into the origin starts no auto-maintenance even when the runner backstop is dropped', () => {
    const trace = path.join(scratch, 'trace2.txt');
    const backstop = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' };
    const push = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/maintenance-probe'],
      { cwd: path.join(scratch, 'work'), encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...backstop, GIT_TRACE2: trace } });
    expect(push.status, push.stderr).toBe(0);
    const events = fs.readFileSync(trace, 'utf8');
    expect(events).toContain('receive-pack');
    expect(events.split('\n').filter(line => line.includes('child_start') && line.includes('maintenance'))).toEqual([]);
  });
});

describe('find: the positive case', () => {
  test('a restamp of a GREEN head on the same base yields a candidate with the receipt', () => {
    const { candidate, out, text } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() });
    expect(text).toContain('TREE: same-modulo-stamps');
    expect(candidate).not.toBeNull();
    expect(candidate!.kind).toBe('restamp-only');
    expect(candidate!.stamp_files!.sort()).toEqual(['CHANGELOG.md', 'VERSION', 'agents-digest/gstack-AGENTS.md', 'package.json']);
    expect(candidate!).toMatchObject({ reused_run_id: 300, gated_head: sha.gated, current_head: sha.restamp, base_sha: sha.base,
      old_version: '1.0.1.0', new_version: '1.0.2.0', selection_sha256: 'f'.repeat(64) });
    expect(candidate!.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseReuse(JSON.parse(fs.readFileSync(path.join(out, CANDIDATE_FILE), 'utf8')))).toEqual(candidate);
  });

  test('newer runs whose paid slices never finished are passed over to the newest executed gate', () => {
    const { candidate } = find(sha.restamp!, [run(330, sha.gated!, 'cancelled'), run(320, sha.gated!, 'cancelled'), run(310, sha.gated!, 'success'),
      run(305, sha.gated!, 'failure'), run(300, sha.gated!)], { 300: binding() },
      { jobs: { 330: [{ name: 'eval-slices (1)', conclusion: 'cancelled' }, { name: 'eval-slices (2)', conclusion: 'skipped' }],
        310: [{ name: 'eval-slices', conclusion: 'skipped' }], 305: [{ name: 'readiness', conclusion: 'failure' }] } });
    expect(candidate?.reused_run_id).toBe(300);
  });
});

describe('find: main moved (R2)', () => {
  test('a head merged with the moved main, or rebased onto it, reuses the gate when its own diff is byte-identical', () => {
    for (const head of [sha.merged!, sha.rebased!]) {
      const { candidate, text } = find(head, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved });
      expect(text).toContain('OWN DIFF: identical');
      expect(candidate).toMatchObject({ kind: 'main-moved', reused_run_id: 300, gated_head: sha.gated, current_head: head,
        gated_base: sha.base, base_sha: sha.moved, gated_merge_base: sha.base });
      expect(candidate!.why).toContain('main moved');
      expect(candidate!.own_diff_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(parseReuse(candidate)).toEqual(candidate);
    }
  });

  test('a version-equal content line in a release output: only the stamp is normalised, so keeping the line reuses and changing it does not', () => {
    const gated = binding({ head_sha: sha.gatedProtocol });
    expect(find(sha.restampProtocolKept!, [run(300, sha.gatedProtocol!)], { 300: gated }, { baseSha: sha.moved }).candidate?.kind).toBe('main-moved');
    const changed = find(sha.restampProtocol!, [run(300, sha.gatedProtocol!)], { 300: gated }, { baseSha: sha.moved });
    expect(changed.candidate).toBeNull();
    expect(changed.text).toContain("the PR's own diff (excluding stamp files) differs");
  });

  test('a restamp on a moved main: stamp files are outside the own-diff compare', () => {
    const { candidate } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved });
    expect(candidate?.kind).toBe('main-moved');
  });
});

describe('find: negative controls (each forces the full gate)', () => {
  const refused = (r: { candidate: GateReuse | null; out: string; text: string }, reason: string | RegExp) => {
    expect(r.candidate).toBeNull();
    expect(fs.existsSync(path.join(r.out, CANDIDATE_FILE))).toBe(false);
    if (typeof reason === 'string') expect(r.text).toContain(reason);
    else expect(r.text).toMatch(reason);
    expect(r.text).toContain('the full gate runs');
  };

  test('a non-stamp byte change', () => {
    refused(find(sha.code!, [run(300, sha.gated!)], { 300: binding() }), 'differs from the gated head beyond stamps: src/feature.ts');
  });

  test('CHANGELOG entry text, not only its heading', () => {
    refused(find(sha.entry!, [run(300, sha.gated!)], { 300: binding() }), 'beyond stamps: CHANGELOG.md');
  });

  test('a file outside the stamp set', () => {
    refused(find(sha.lock!, [run(300, sha.gated!)], { 300: binding() }), 'bun.lock');
    // The receipt calls a lockfile root-version bump a stamp; R2a's stamp set is narrower and still refuses it.
    refused(find(sha.lockStamp!, [run(300, sha.gatedLock!)], { 300: binding({ head_sha: sha.gatedLock }) }),
      'stamp-classified files outside the version file, package.json, CHANGELOG and release outputs: bun.lock');
  });

  test('main moved and the own diff changed: a code byte, CHANGELOG entry text, a package.json field', () => {
    for (const head of [sha.rebasedCode!, sha.rebasedEntry!, sha.rebasedPkg!]) {
      refused(find(head, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved }), "the PR's own diff (excluding stamp files) differs");
    }
  });

  test('main moved and a stamp file changed beyond its stamp: release-output content, a deleted CHANGELOG section, a CHANGELOG preamble edit, a package.json mode', () => {
    for (const head of [sha.rebasedDigest!, sha.rebasedDrop!, sha.rebasedPreamble!, sha.rebasedMode!]) {
      refused(find(head, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved }), "the PR's own diff (excluding stamp files) differs");
    }
  });

  test('main moved and changed a file the PR also changes: the pre-image differs, so the own diff is not byte-identical', () => {
    refused(find(sha.touchRebased!, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.mainTouch }), 'OWN DIFF: changed');
  });

  test('main moved and a merge-base or the tested merge commit is unavailable', () => {
    refused(find(sha.rebased!, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved, failCompare: true }), 'a merge-base is unavailable');
    refused(find(sha.rebased!, [run(300, sha.gated!)], { 300: binding() }, { testedSha: sha.rebased }), 'is not the merge of');
    refused(find(sha.rebased!, [run(300, sha.gated!)], { 300: binding() }, { testedSha: 'd'.repeat(40) }), /cannot fetch|not readable/);
  });

  test('main moved and the newest executed gate is red, partial or a different profile', () => {
    refused(find(sha.rebased!, [run(300, sha.gated!)], { 300: binding({ verdict: 'RED' }) }, { baseSha: sha.moved }), 'is RED');
    refused(find(sha.rebased!, [run(300, sha.gated!, 'cancelled')], { 300: binding() }, { baseSha: sha.moved }), 'conclusion cancelled');
    refused(find(sha.rebased!, [run(300, sha.gated!)], { 300: binding({ profile: 'full' }) }, { baseSha: sha.moved }), 'not the PR gate');
  });

  test('a newer run that finished a paid slice but bound no verdict blocks an older GREEN (never skipped)', () => {
    for (const conclusion of ['failure', 'timed_out', 'success']) {
      for (const runConclusion of ['failure', 'cancelled']) {
        refused(find(sha.rebased!, [run(310, sha.merged!, runConclusion), run(300, sha.gated!)], { 300: binding() },
          { baseSha: sha.moved, jobs: { 310: [{ name: 'eval-slices (1)', conclusion }, { name: 'eval-slices (2)', conclusion: 'cancelled' }] } }),
        'newer run 310');
      }
    }
    refused(find(sha.restamp!, [run(310, sha.gated!, 'success'), run(300, sha.gated!)], { 300: binding() },
      { jobs: { 310: [{ name: 'eval-slices (1)', conclusion: 'success' }] } }), 'finished a paid slice (success) but bound no verdict');
  });

  test('release-output lines that look like diff headers are content, not headers (receipt parser)', () => {
    for (const head of [sha.dashReplace!, sha.dashRemove!]) {
      refused(find(head, [run(300, sha.gatedDash!)], { 300: binding({ head_sha: sha.gatedDash }) }), 'beyond stamps: agents-digest/gstack-AGENTS.md');
    }
    refused(find(sha.dashAdd!, [run(300, sha.gated!)], { 300: binding() }), 'beyond stamps: agents-digest/gstack-AGENTS.md');
  });

  test('a file mode change beside a restamp', () => {
    refused(find(sha.mode!, [run(300, sha.gated!)], { 300: binding() }), 'beyond stamps: agents-digest/gstack-AGENTS.md');
  });

  test('a GREEN that includes manually accepted (unscored) cases', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ manual_accepted: 1 }) }), 'manually accepted (unscored)');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ manual_accepted: -1 }) }), 'missing or malformed');
  });

  test('a newer run that holds slice results, or is still running, blocks an older GREEN', () => {
    const gh = fakeGh([run(310, sha.gated!, 'cancelled'), run(300, sha.gated!)], { 300: binding() });
    const withSlice: GhRunner = (args, t) => args.some(a => a.endsWith('/runs/310/artifacts'))
      ? { status: 0, stdout: JSON.stringify({ artifacts: [{ name: 'paid-plan' }, { name: 'paid-slice-1-a1' }] }), stderr: '' } : gh(args, t);
    const out = path.join(scratch, 'out-slice');
    const r = findReusableGate({ repo: REPO, pr: 42, headRepo: REPO, branch: 'feature', selfRunId: 500, headSha: sha.restamp!,
      testedSha: tested(sha.base!, sha.restamp!), repoRoot: receipt, out, gh: withSlice });
    refused({ ...r, out, text: r.lines.join('\n') }, 'holds paid slice results (paid-slice-1-a1) but bound no verdict');
    refused(find(sha.restamp!, [run(310, sha.gated!, null, { status: 'in_progress' }), run(300, sha.gated!)], { 300: binding() }), 'is still in_progress');
  });

  test('a missing receipt: no executed gate bound a verdict', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], {}), 'no earlier executed gate on this PR bound a verdict');
    refused(find(sha.restamp!, [], {}), 'no earlier executed gate');
  });

  test('a missing receipt: a malformed or mismatched binding', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: '{"schema":1' }), 'missing or malformed');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ run_id: 299 }) }), 'does not match the run it came from');
    refused(find(sha.restamp!, [run(300, sha.restamp!)], { 300: binding() }), 'does not match the run it came from');
  });

  test('a missing receipt: the gated head cannot be fetched, so no tree receipt exists', () => {
    const ghost = 'e'.repeat(40);
    refused(find(sha.restamp!, [run(300, ghost)], { 300: binding({ head_sha: ghost }) }), /cannot fetch|no tree receipt/);
  });

  test('a red, partial or failed gate, and a newer red that blocks an older green', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ verdict: 'RED' }) }), 'is RED');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ reconcile_exit: 1 }) }), 'reconcile exit 1');
    refused(find(sha.restamp!, [run(300, sha.gated!, 'failure')], { 300: binding() }), 'conclusion failure');
    refused(find(sha.restamp!, [run(301, sha.gated!), run(300, sha.gated!)], { 301: binding({ run_id: 301, verdict: 'RED' }), 300: binding() }), 'run 301');
  });

  test('a full-profile binding, the same head, another PR, and a gh outage', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ profile: 'full' }) }), 'not the PR gate');
    refused(find(sha.gated!, [run(300, sha.gated!)], { 300: binding() }), 'gated this same head');
    refused(find(sha.restamp!, [run(300, sha.gated!, 'success', { pull_requests: [{ number: 7 }] })], { 300: binding() }), 'no earlier executed gate');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() }, { failList: 'HTTP 403: Resource not accessible' }), 'not authorized');
  });
});

const manifest = (over: Partial<PaidRunManifest> = {}): PaidRunManifest => ({ version: 1, tier: 'gate', evalsAll: false, sliceCount: 2,
  selectionReason: 'diff', profile: 'pr', selection: { e2e: ['case-a'], judges: [] }, prCoverage: { mode: 'pr' } as PaidRunManifest['prCoverage'],
  entries: [
    { file: 'test/a.test.ts', slice: 1, status: 'planned', estimatedMs: 1000 },
    { file: 'test/b.test.ts#case-b~t1', slice: 2, status: 'planned', trial: { kind: 'behavior', panel: { n: 3, k: 2 }, quarantined: false } },
    { file: 'test/c.test.ts', slice: 0, status: 'skipped-by-diff', reason: 'no input changed' },
  ], ...over } as PaidRunManifest);

describe('selection fingerprint and confirm', () => {
  test('slice packing and estimates do not change the fingerprint; cases, statuses and trial plans do', () => {
    const fp = selectionFingerprint(manifest());
    const repacked = manifest();
    repacked.entries = [...repacked.entries].reverse().map(e => ({ ...e, slice: e.slice ? 3 - e.slice : 0, estimatedMs: 5, reason: 'other' }));
    expect(selectionFingerprint(repacked)).toBe(fp);
    const extra = manifest();
    extra.entries = [...extra.entries, { file: 'test/d.test.ts', slice: 1, status: 'planned' }];
    const quarantined = manifest();
    quarantined.entries = quarantined.entries.map(e => e.trial ? { ...e, trial: { ...e.trial, quarantined: true } } : e);
    const skipped = manifest();
    skipped.entries = skipped.entries.map(e => e.file === 'test/a.test.ts' ? { ...e, status: 'skipped-by-diff' as const } : e);
    for (const changed of [extra, quarantined, skipped, manifest({ selection: { e2e: ['case-a', 'case-z'], judges: [] } }), manifest({ evalsAll: true })]) {
      expect(selectionFingerprint(changed)).not.toBe(fp);
    }
  });

  test('confirm reuses only when the candidate exists and the selection is identical', () => {
    const { out } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ selection_sha256: selectionFingerprint(manifest()) }) });
    const same = confirmReuse(out, manifest());
    expect(same.reuse?.reused_run_id).toBe(300);
    expect(same.reason).toContain('same selection');
    const extra = manifest();
    extra.entries = [...extra.entries, { file: 'test/d.test.ts', slice: 1, status: 'planned' }];
    expect(confirmReuse(out, extra).reuse).toBeNull();
    expect(confirmReuse(out, extra).reason).toContain('differs from the reused gate');
    expect(confirmReuse(out, null).reuse).toBeNull();
    expect(confirmReuse(path.join(scratch, 'no-candidate'), manifest()).reuse).toBeNull();
    const forged = path.join(scratch, 'forged');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(path.join(forged, CANDIDATE_FILE), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(out, CANDIDATE_FILE), 'utf8')), stamp_files: [] }));
    expect(confirmReuse(forged, manifest()).reuse).toBeNull();
  });
});

describe('bind and report', () => {
  const reportDir = (name: string, withReuse = false) => {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(dir, 'collector-outcomes.json'), JSON.stringify({ verdict: { verdict: 'GREEN' }, totals: { manual_accepted: 0 } }));
    if (withReuse) fs.writeFileSync(path.join(dir, REUSE_FILE), '{}');
    return dir;
  };
  const bindArgs = { repository: REPO, pr: 42, runId: 300, runAttempt: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), profile: 'pr', reconcileExit: 0 };

  test('an executed run binds its verdict, reconcile exit and selection; a reused run binds nothing', () => {
    const { binding: bound } = buildBinding({ ...bindArgs, reportDir: reportDir('bind-ok') });
    expect(bound).toMatchObject({ verdict: 'GREEN', reconcile_exit: 0, selection_sha256: selectionFingerprint(manifest()) });
    expect(buildBinding({ ...bindArgs, reportDir: reportDir('bind-reused', true) }).binding).toBeNull();
    const empty = path.join(scratch, 'bind-empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(buildBinding({ ...bindArgs, reportDir: empty }).binding).toBeNull();
  });

  test('the CLI binds a missing reconcile exit as -1, never as a pass', () => {
    const out = path.join(scratch, 'bind-cli');
    const bind = (head: string, testedSha: string, dir: string) => spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/gate-reuse.ts'), 'bind',
      reportDir('bind-cli-report'), '--out', dir, '--repo', REPO, '--pr', '42', '--run-id', '300', '--run-attempt', '1', '--head-sha', head,
      '--tested-sha', testedSha, '--profile', 'pr', '--reconcile-exit', ''], { cwd: receipt, encoding: 'utf8', timeout: 30_000 });
    const r = bind(sha.gated!, tested(sha.moved!, sha.gated!), out);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(out, BINDING_FILE), 'utf8'))).toMatchObject({ reconcile_exit: -1, base_sha: sha.moved, head_sha: sha.gated });
    // A tested commit that is not the merge of this head binds nothing.
    const none = path.join(scratch, 'bind-cli-none');
    expect(bind(sha.restamp!, tested(sha.moved!, sha.gated!), none).status).toBe(0);
    expect(fs.existsSync(path.join(none, BINDING_FILE))).toBe(false);
  });

  test('report prints the reused verdict with its receipt, and fails closed without a valid record', () => {
    const { out } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() });
    const reuse = parseReuse(JSON.parse(fs.readFileSync(path.join(out, CANDIDATE_FILE), 'utf8')))!;
    const text = reuseReport(reuse, REPO);
    expect(text).toContain('GATE REUSED (R2a, restamp-only)');
    expect(text).toContain('TREE: same-modulo-stamps receipt=' + reuse.receipt_sha256);
    expect(text).toContain('https://github.com/garrytan/gstack/actions/runs/300');
    const moved = find(sha.rebased!, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved }).candidate!;
    const movedText = reuseReport(moved, REPO);
    expect(movedText).toContain('GATE REUSED (R2, main moved)');
    expect(movedText).toContain('OWN DIFF: identical sha256=' + moved.own_diff_sha256);
    expect(movedText).toContain('why: main moved');
    expect(movedText).toContain('at ' + sha.gated);
    const bad = spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/gate-reuse.ts'), 'report', path.join(scratch, 'missing.json'), '--repo', REPO],
      { encoding: 'utf8', timeout: 30_000 });
    expect(bad.status).toBe(1);
  });
});

describe.skipIf(!Bun.which('jq') || !Bun.which('bash'))('the PR comment for a reused verdict', () => {
  test('runs no repository code and names the reused run and receipt; without reconcile exit 0 it never says PASS (reused)', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/evals.yml'), 'utf8')) as any;
    const script = (workflow.jobs['slices-comment'].steps.find((s: any) => s.name === 'Post PR comment').run as string);
    const root = path.join(scratch, 'comment');
    const paidDir = path.join(root, 'paid-report');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(paidDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\ncase "$*" in *--jq*) exit 0;; esac\nfor arg do case "$arg" in body=*) printf "%s\\n" "${arg#body=}";; esac; done\n');
    fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    fs.writeFileSync(path.join(binDir, 'bc'), '#!/bin/sh\nread -r expression\nprintf "0\\n"\n');
    fs.chmodSync(path.join(binDir, 'bc'), 0o755);
    const { out } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() });
    fs.copyFileSync(path.join(out, CANDIDATE_FILE), path.join(paidDir, REUSE_FILE));
    fs.writeFileSync(path.join(paidDir, 'manifest.json'), JSON.stringify({ profile: 'pr', selection: { e2e: [], judges: [] } }));
    const body = script.replaceAll('/tmp/paid-report', paidDir).replaceAll('/tmp/verdict', path.join(root, 'verdict'))
      .replaceAll('$' + '{{ github.repository }}', REPO).replaceAll('$' + '{{ github.event.pull_request.number }}', '42');
    const exec = (reconcile: string) => spawnSync('bash', ['-e', '-c', body], { cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: binDir + ':' + process.env.PATH, RECONCILE_EXIT: reconcile, GITHUB_REPOSITORY: REPO } });
    const reused = exec('0');
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('## E2E Evals: ✅ PASS (reused: restamp-only, R2a)');
    expect(reused.stdout).toContain('TREE: same-modulo-stamps receipt=');
    expect(reused.stdout).toContain('actions/runs/300');
    const moved = find(sha.rebased!, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved }).candidate!;
    fs.writeFileSync(path.join(paidDir, REUSE_FILE), JSON.stringify(moved));
    const movedComment = exec('0');
    expect(movedComment.status, movedComment.stderr).toBe(0);
    expect(movedComment.stdout).toContain('## E2E Evals: ✅ PASS (reused: main moved, R2)');
    expect(movedComment.stdout).toContain('OWN DIFF: identical sha256=' + moved.own_diff_sha256);
    expect(movedComment.stdout).toContain('because main moved');
    const failed = exec('1');
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout).not.toContain('PASS (reused');
    expect(failed.stdout).toContain('❌ FAIL');
  });
});

describe('dispatched screens (GSTA-49 T1b): authenticated by PR, head, repository and tested base', () => {
  const title = (policy: string, pr = 42) => `E2E Evals [eval-bg pr.screen.${policy}-${'c'.repeat(12)}-${'d'.repeat(12)}-abc123] screen #${pr}`;
  // A screen dispatches on main: the run's head_sha is main's tip, never the PR head; the binding carries the PR head and the merge commit.
  const screenRun = (id: number, policy = 'narrow', over: Partial<WorkflowRun> = {}) => run(id, sha.base!, 'success', { event: 'workflow_dispatch', pull_requests: [], display_title: title(policy), ...over });
  const screenBinding = (head: string, policy: 'narrow' | 'broad' = 'narrow', over: Partial<GateBinding> = {}) =>
    binding({ head_sha: head, purpose: 'screen', tested_sha: tested(sha.base!, head), screen_policy: policy, ...over });
  const commits = () => [sha.gated!, sha.restamp!];
  const screen = (policy: 'narrow' | 'broad', runs: WorkflowRun[], bindings: Record<number, GateBinding | string>, over: { prCommits?: string[]; jobs?: Jobs } = {}) =>
    find(sha.restamp!, runs, bindings, { screen: { policy }, prCommits: over.prCommits ?? commits(), jobs: over.jobs });

  test('a screen, a restamp-only push, then a re-screen of the same policy reuses through R2a', () => {
    const { candidate, text } = screen('narrow', [screenRun(300)], { 300: screenBinding(sha.gated!) });
    expect(text).toContain('TREE: same-modulo-stamps');
    expect(candidate).toMatchObject({ kind: 'restamp-only', reused_run_id: 300, gated_head: sha.gated, current_head: sha.restamp, base_sha: sha.base, reused_screen_policy: 'narrow' });
    expect(reuseReport(candidate!, REPO)).toContain('(a narrow screen)');
  });

  test("a PR push under a train policy (no paid slice, no binding) is passed over; the PR's earlier screen still reuses", () => {
    const summary = run(320, sha.restamp!, 'success');
    const { candidate } = screen('narrow', [summary, screenRun(300)], { 300: screenBinding(sha.gated!) }, { jobs: { 320: [{ name: 'eval-slices', conclusion: 'skipped' }] } });
    expect(candidate?.reused_run_id).toBe(300);
  });

  test('a broad screen never adopts a narrow run; a narrow screen never adopts a pull_request gate (broad); a broad screen may', () => {
    const narrowRun = screen('broad', [screenRun(300)], { 300: screenBinding(sha.gated!) });
    expect(narrowRun.candidate).toBeNull();
    expect(narrowRun.text).toContain('gated the narrow selection; a broad screen never adopts it');
    const prRun = screen('narrow', [run(300, sha.gated!)], { 300: binding() });
    expect(prRun.candidate).toBeNull();
    expect(prRun.text).toContain('gated the broad selection; a narrow screen never adopts it');
    expect(screen('broad', [run(300, sha.gated!)], { 300: binding() }).candidate?.reused_run_id).toBe(300);
  });

  test('a forged screen is refused: another PR, a head outside the PR, a mismatched binding, a tested commit off its bound base, another repository', () => {
    const refused: Array<[WorkflowRun[], Record<number, GateBinding | string>, string, string[]?]> = [
      [[screenRun(300, 'narrow', { display_title: title('narrow', 43) })], { 300: screenBinding(sha.gated!) }, 'no earlier executed gate on this PR bound a verdict'],
      [[screenRun(300)], { 300: screenBinding(sha.gated!) }, 'is not a commit of PR #42', [sha.restamp!]],
      [[screenRun(300)], { 300: screenBinding(sha.gated!, 'narrow', { pr: 43 }) }, 'does not match the run it came from'],
      [[screenRun(300)], { 300: binding() }, 'does not match the run it came from'],
      [[screenRun(300)], { 300: screenBinding(sha.gated!, 'narrow', { tested_sha: tested(sha.moved!, sha.gated!) }) }, 'does not merge its head into its bound base'],
      [[screenRun(300, 'narrow', { head_repository: { full_name: 'fork/gstack' } })], { 300: screenBinding(sha.gated!) }, 'no earlier executed gate on this PR bound a verdict'],
      [[run(300, sha.gated!)], { 300: screenBinding(sha.gated!) }, 'does not match the run it came from'],
    ];
    for (const [runs, bindings, why, prCommits] of refused) {
      const { candidate, text } = screen('narrow', runs, bindings, { prCommits });
      expect(candidate, why).toBeNull();
      expect(text, why).toContain(why);
    }
  });

  test('train, bisect and plain dispatch runs never bind a verdict, so they never reuse or get reused', () => {
    const report = path.join(scratch, 'bind-purpose');
    fs.mkdirSync(report, { recursive: true });
    fs.writeFileSync(path.join(report, 'manifest.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(report, 'collector-outcomes.json'), JSON.stringify({ verdict: { verdict: 'GREEN' }, totals: { manual_accepted: 0 } }));
    const args = { repository: REPO, pr: 42, runId: 300, runAttempt: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), profile: 'full', reconcileExit: 0, reportDir: report };
    for (const purpose of ['train', 'bisect', 'dispatch'] as const) {
      const bound = buildBinding({ ...args, purpose });
      expect(bound.binding, purpose).toBeNull();
      expect(bound.reason).toBe(`a ${purpose} run never binds a verdict for reuse`);
    }
    expect(buildBinding({ ...args, profile: 'pr', purpose: 'screen', testedSha: 'c'.repeat(40), screenPolicy: 'broad' }).binding)
      .toMatchObject({ purpose: 'screen', tested_sha: 'c'.repeat(40), screen_policy: 'broad' });
    // A train dispatch in the history is neither a screen nor a pull_request run of this PR: never listed, never a candidate.
    const trainRun = run(310, sha.base!, 'success', { event: 'workflow_dispatch', pull_requests: [], display_title: 'E2E Evals [eval-bg gate.train-x]' });
    expect(screen('narrow', [trainRun, screenRun(300)], { 300: screenBinding(sha.gated!), 310: screenBinding(sha.gated!) }).candidate?.reused_run_id).toBe(300);
  });
});

describe('rule-16 flaky GREENs are reusable (GSTA-53, F1)', () => {
  const flaky = (over: Partial<GateBinding> = {}) => binding({ flaky_cases: ['tpa-absent-darwin'], ...over });
  /** A run that bound once per attempt: gate-binding-a<n> each, download by name (a `gh run rerun --failed` attempt binds again). */
  function attemptsGh(runs: WorkflowRun[], perAttempt: Record<number, GateBinding>): GhRunner {
    const inner = fakeGh(runs, { 300: perAttempt[1]! });
    return (args, timeoutMs) => {
      if (args.some(a => /\/runs\/300\/artifacts$/.test(a))) {
        return { status: 0, stdout: JSON.stringify({ artifacts: [...Object.keys(perAttempt).map(n => ({ name: `gate-binding-a${n}`, expired: false })), { name: 'paid-slice-1-a1', expired: false }] }), stderr: '' };
      }
      if (args[0] === 'run' && args[1] === 'download' && args[2] === '300') {
        const dir = args[args.indexOf('-D') + 1]!;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, BINDING_FILE), JSON.stringify(perAttempt[Number(args[args.indexOf('-n') + 1]!.slice('gate-binding-a'.length))]));
        return { status: 0, stdout: '', stderr: '' };
      }
      return inner(args, timeoutMs);
    };
  }
  const findWith = (head: string, gh: GhRunner, baseSha = sha.base!) => {
    const out = path.join(scratch, 'out-' + ++outCount);
    const result = findReusableGate({ repo: REPO, pr: 42, headRepo: REPO, branch: 'feature', selfRunId: 500, headSha: head, testedSha: tested(baseSha, head), repoRoot: receipt, out, gh });
    return { ...result, out, text: result.lines.join('\n') };
  };

  test('R2a: a restamp of a flaky-annotated GREEN reuses it and carries the flaky case names', () => {
    const { candidate } = find(sha.restamp!, [run(300, sha.gated!)], { 300: flaky() });
    expect(candidate).toMatchObject({ kind: 'restamp-only', reused_run_id: 300, reused_flaky: ['tpa-absent-darwin'] });
    expect(parseReuse(candidate)).toEqual(candidate);
    expect(reuseReport(candidate!, REPO)).toContain('flaky (rule 16): tpa-absent-darwin failed once and passed on their one rerun in the reused gate');
  });

  test('R2: main moved with an identical own diff reuses a flaky-annotated GREEN', () => {
    const { candidate } = find(sha.rebased!, [run(300, sha.gated!)], { 300: flaky() }, { baseSha: sha.moved });
    expect(candidate).toMatchObject({ kind: 'main-moved', reused_run_id: 300, reused_flaky: ['tpa-absent-darwin'] });
  });

  test('a manual --failed attempt that went green: its newest binding is reused (R2a and R2), never the red first attempt', () => {
    const attempts = { 1: binding({ verdict: 'RED', reconcile_exit: 1 }), 2: flaky({ run_attempt: 2 }) };
    const restamp = findWith(sha.restamp!, attemptsGh([run(300, sha.gated!)], attempts));
    expect(restamp.candidate, restamp.text).toMatchObject({ kind: 'restamp-only', reused_run_attempt: 2, reused_flaky: ['tpa-absent-darwin'] });
    const moved = findWith(sha.rebased!, attemptsGh([run(300, sha.gated!)], attempts), sha.moved!);
    expect(moved.candidate, moved.text).toMatchObject({ kind: 'main-moved', reused_run_attempt: 2 });
  });

  test('negative control: a run still red after its rerun is never reused, whatever it calls flaky', () => {
    const stillRed = find(sha.restamp!, [run(300, sha.gated!, 'failure')], { 300: flaky({ verdict: 'RED', reconcile_exit: 1 }) });
    expect(stillRed.candidate).toBeNull();
    expect(stillRed.text).toContain('is RED, reconcile exit 1');
    const moved = find(sha.rebased!, [run(300, sha.gated!, 'failure')], { 300: flaky({ verdict: 'RED', reconcile_exit: 1 }) }, { baseSha: sha.moved });
    expect(moved.candidate).toBeNull();
    const newestRed = findWith(sha.restamp!, attemptsGh([run(300, sha.gated!, 'failure')], { 1: flaky(), 2: binding({ run_attempt: 2, verdict: 'RED', reconcile_exit: 1 }) }));
    expect(newestRed.candidate).toBeNull();
    expect(newestRed.text).toContain('is RED');
  });

  test('bind records the report\'s flaky cases; a malformed flaky list is no binding', () => {
    const dir = path.join(scratch, 'bind-flaky');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(dir, 'collector-outcomes.json'), JSON.stringify({ verdict: { verdict: 'GREEN' }, totals: { manual_accepted: 0 },
      flaky: [{ case: 'tpa-absent-darwin' }, { case: 'plan-design-with-ui-scope' }] }));
    const { binding: bound, reason } = buildBinding({ repository: REPO, pr: 42, runId: 300, runAttempt: 2, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), profile: 'pr', reconcileExit: 0, reportDir: dir });
    expect(bound).toMatchObject({ verdict: 'GREEN', run_attempt: 2, flaky_cases: ['tpa-absent-darwin', 'plan-design-with-ui-scope'] });
    expect(reason).toContain('bound GREEN (flaky: tpa-absent-darwin, plan-design-with-ui-scope)');
    expect(parseBinding({ ...binding(), flaky_cases: 'x' })).toBeNull();
    expect(parseBinding({ ...binding(), flaky_cases: [''] })).toBeNull();
    expect(parseBinding(binding())?.flaky_cases).toBeUndefined();
  });
});

