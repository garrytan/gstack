/**
 * One selection for every reader (GST-1476, docs/ship-policy.md#review-exclude-paths): the base policy's review_exclude_paths,
 * the kept files and the GST-1447 secret-line excerpts reach every reader's diff, whichever path renders it: the pass
 * manifest's stages, a fresh pass after a failed reader, or a standalone render (a first render, or a re-render after a
 * failed dispatch). harness-evals #269: the Red Team's standalone render read the unexcluded 30.3 MB diff while the pass's
 * other readers read the 2 MB selection.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BRIEF_ROLES, type BriefRole } from '../lib/review-brief';
import { ROLE_EFFORT, type Role } from '../lib/review-depth';
import { REVIEW_DIFF_MAX_BYTES } from '../lib/review-exclude';
import { buildManifest } from '../lib/review-pass';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
/** A credential-shaped base64 value (no known key prefix) for the lines that must keep their file: a name alone keeps nothing (GST-1967). */
const VALUE = Buffer.from('a private signing key that must never reach a results tree 0x5f3759df').toString('base64');
const SPEC = ':(top,exclude,glob)docs/benchmarks/**';
const QUOTED = "'" + SPEC + "'";

/** A gate-code change (full panel, Red Team included) beside about 2.6 MB under docs/benchmarks/**, two files of it kept only for a secret line. */
function fixture() {
  const policy = JSON.stringify({ review_exclude_paths: ['docs/benchmarks/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
  const repo = makeFixtureRepo({ prefix: 'gstack-sel-', baseFiles: { '.gstack/ship-policy.json': policy } });
  repos.push(repo);
  const files: Record<string, string> = { 'lib/ship-queue-x.ts': Array.from({ length: 260 }, (_, i) => 'export const f' + i + ' = (a: number) => a + ' + i + ';').join('\n') + '\n' };
  for (let k = 0; k < 6; k++) files['docs/benchmarks/r/t' + k + '.json'] = ('{"x": "' + 'y'.repeat(200) + '"}\n').repeat(2000);
  for (let k = 0; k < 2; k++) files['docs/benchmarks/r/cap' + k + '.json'] = Array.from({ length: 400 }, (_, n) => n % 100 === 7
    ? '  "system": "Read ${OPENAI_API_KEY_F' + k + '_L' + n + '} (value ' + VALUE + ') from the environment and never print it.",'
    : '  "line' + n + '": "' + 'x'.repeat(40) + '",').join('\n') + '\n';
  commit(repo, files);
  const mb = repo.git('merge-base', 'origin/main', 'HEAD');
  const p = JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--json']).out);
  return { repo, mb, x: p.review_exclude as { state: string; digest: string; specs: string[]; keep: string[]; excerpt: string[] } };
}
const empty = (repo: FixtureRepo) => { const f = path.join(repo.root, 'findings.jsonl'); fs.writeFileSync(f, ''); return f; };
const render = (repo: FixtureRepo, mb: string, out: string, role: string, extra: string[] = []) =>
  runBin(repo, 'gstack-review-dispatch', ['render', '--role', role, ...extra, '--out', out, '--base', 'main', '--diff-base', mb]);
const rendered = (ledger: string) => fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'rendered');
const excerptSha = (brief: string) => /in the file \S+ \(\d+ bytes, sha256 ([0-9a-f]{64})\)/.exec(brief)?.[1];
const mark = (repo: FixtureRepo, mf: string, reader: string, states: Array<[string, string[]]>) => {
  for (const [s, extra] of states) expect(runBin(repo, 'gstack-review-dispatch', ['mark', '--manifest', mf, '--reader', reader, '--state', s, ...extra]).status).toBe(EXIT.ok);
};
const collectEarlier = (repo: FixtureRepo, mf: string) => {
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  for (const r of m.readers.filter((x: any) => x.stage === 'first' || x.stage === 'specialists')) mark(repo, mf, r.reader, [['intent', []], ['created', ['--path', '1']], ['collected', []]]);
};
/** What a rendered brief must carry under the fixture's policy: the exclusion in its git diff commands, the disclosure and the excerpt. */
function expectSelection(brief: string, digest: string) {
  expect(brief).toContain(QUOTED);
  expect(brief).toContain('(selection ' + digest + ')');
  expect(excerptSha(brief)).toMatch(/^[0-9a-f]{64}$/);
}

describe('every reader path builds its diff from the base policy\'s selection', () => {
  // Value: protects=a Red Team rendered on its own (before the specialists' output exists) reads the selection the pass's
  //   other readers read; fails_when=render builds the Red Team's diff from its flags alone, so it refuses REVIEW_DIFF_TOO_LARGE
  //   at the unexcluded size or renders with no disclosure and no excerpt (harness-evals #269, 30.3 MB vs 2 MB); why_new=GST-1476;
  //   seam=gstack-review-dispatch render on a real repository; no_claim=what a model does with the brief
  test('the Red Team on a first render reads the selection and the excerpts', () => {
    const { repo, mb, x } = fixture();
    expect(x.state).toBe('active');
    expect(x.excerpt.length).toBe(2);
    const out = path.join(repo.root, 'rt');
    const r = render(repo, mb, out, 'red-team', ['--findings-file', empty(repo), '--specialists', '1']);
    expect(r.err).not.toContain('REVIEW_DIFF_TOO_LARGE');
    expect(r.status).toBe(EXIT.ok);
    const brief = fs.readFileSync(path.join(out, 'red-team.prompt.md'), 'utf8');
    expectSelection(brief, x.digest);
    expect(rendered(path.join(out, 'review-ledger.jsonl')).map(e => e.exclude)).toEqual([x.digest]);
  }, 240_000);

  // Value: protects=the Red Team dispatched before the specialists' output, failed, then rendered again (by hand or by a
  //   fresh pass) reads the same selection and excerpt; fails_when=the re-render (standalone or the fresh pass's late red-team
  //   stage) drops review_exclude_paths or the excerpts; why_new=GST-1476 (the #269 Red Team was marked failed and re-rendered);
  //   seam=gstack-review-dispatch render, sent, pass, mark and stage on a real repository; no_claim=the dispatch program's retry policy
  test('the Red Team re-rendered after a failed dispatch reads the same selection', () => {
    const { repo, mb, x } = fixture();
    const out = path.join(repo.root, 'rt');
    expect(render(repo, mb, out, 'red-team', ['--findings-file', empty(repo), '--specialists', '1']).status).toBe(EXIT.ok);
    const first = fs.readFileSync(path.join(out, 'red-team.prompt.md'), 'utf8');
    const wrong = path.join(repo.root, 'sent.txt');
    fs.writeFileSync(wrong, 'a prompt the parent wrote by hand\n');
    expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', path.join(out, 'review-ledger.jsonl'), '--role', 'red-team', '--sent', wrong]).status).not.toBe(EXIT.ok);
    const findings = path.join(repo.root, 'merged.jsonl');
    fs.writeFileSync(findings, JSON.stringify({ id: 's1', reader: 'specialist-batched', severity: 'medium', text: 'a finding' }) + '\n');
    const again = render(repo, mb, out, 'red-team', ['--findings-file', findings, '--specialists', '1']);
    expect(again.err).not.toContain('REVIEW_DIFF_TOO_LARGE');
    expect(again.status).toBe(EXIT.ok);
    const second = fs.readFileSync(path.join(out, 'red-team.prompt.md'), 'utf8');
    expectSelection(second, x.digest);
    expect(excerptSha(second)).toBe(excerptSha(first)!);
    expect(rendered(path.join(out, 'review-ledger.jsonl')).map(e => e.exclude)).toEqual([x.digest, x.digest]);

    const p1 = path.join(repo.root, 'p1'), mf1 = path.join(p1, 'pass-manifest.json');
    expect(runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', p1, '--pass', 'p1']).status).toBe(EXIT.ok);
    collectEarlier(repo, mf1);
    expect(runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', mf1, '--stage', 'red-team']).status).toBe(EXIT.ok);
    mark(repo, mf1, 'red-team', [['intent', []], ['created', ['--path', '2']], ['failed', ['--error', 'failed']]]);
    const p2 = path.join(repo.root, 'p2'), mf2 = path.join(p2, 'pass-manifest.json');
    expect(runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', p2, '--pass', 'p2']).status).toBe(EXIT.ok);
    collectEarlier(repo, mf2);
    const late = runBin(repo, 'gstack-review-dispatch', ['stage', '--manifest', mf2, '--stage', 'red-team']);
    expect(late.err).not.toContain('REVIEW_DIFF_TOO_LARGE');
    expect(late.status).toBe(EXIT.ok);
    const rt = JSON.parse(fs.readFileSync(mf2, 'utf8')).readers.find((r: any) => r.reader === 'red-team');
    expectSelection(fs.readFileSync(rt.file, 'utf8'), x.digest);
    expect(rt.excerpt_file.sha256).toBe(excerptSha(second)!);
  }, 240_000);

  // Value: protects=a reader kind added later cannot render (standalone or through the manifest) without the policy's
  //   selection; fails_when=any BRIEF_ROLES role renders a brief without the exclusion, the disclosure digest or the excerpt, a
  //   role has no entry here, or a plan dispatch that reaches buildManifest without the policy keeps reading the whole diff;
  //   why_new=GST-1476; seam=gstack-review-dispatch render for every role and buildManifest for every Role; no_claim=brief wording
  test('every reader kind gets the same selection, standalone and in the manifest', () => {
    const { repo, mb, x } = fixture();
    const findings = empty(repo);
    const fix = (n: string) => { const f = path.join(repo.root, n); fs.writeFileSync(f, n + '\n'); return f; };
    const p0 = path.join(repo.root, 'p0');
    expect(runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', p0, '--pass', 'p0']).status).toBe(EXIT.ok);
    const disclosure = JSON.parse(fs.readFileSync(path.join(p0, 'pass-manifest.json'), 'utf8')).disclosure as string;
    const ROLE_ARGS: Record<BriefRole, string[] | { none: string }> = {
      specialist: ['--name', 'security'],
      'specialist-batched': ['--checklists', 'testing,security'],
      'red-team': ['--findings-file', findings, '--specialists', '1'],
      'adversarial-native': [],
      'outside-voice': [],
      targeted: ['--classes', 'secret', '--disclosure', disclosure],
      'fix-check': { none: 'reads decision 3.5\'s fix list and touched hunks, never a git diff' },
    };
    for (const role of BRIEF_ROLES) {
      const a = ROLE_ARGS[role];
      expect({ role, listed: a !== undefined }).toEqual({ role, listed: true });
      if (!Array.isArray(a)) continue;
      const out = path.join(repo.root, 'r-' + role);
      const r = render(repo, mb, out, role, a);
      expect({ role, err: r.status === EXIT.ok ? '' : r.err, status: r.status }).toEqual({ role, err: '', status: EXIT.ok });
      const ev = rendered(path.join(out, 'review-ledger.jsonl'));
      expect({ role, exclude: ev.map(e => e.exclude) }).toEqual({ role, exclude: [x.digest] });
      const brief = fs.readFileSync(ev[0].file, 'utf8');
      expect({ role, spec: brief.includes(QUOTED), digest: brief.includes('(selection ' + x.digest + ')') }).toEqual({ role, spec: true, digest: true });
      if (role === 'outside-voice') {
        const supplied = fs.readFileSync(path.join(out, 'outside-voice.diff'), 'utf8');
        expect(supplied).toContain('## Secret-line excerpts (2 files)');
        expect(supplied).not.toContain('diff --git a/docs/benchmarks/r/t0.json');
        expect(Buffer.byteLength(supplied)).toBeLessThan(REVIEW_DIFF_MAX_BYTES);
      } else expect({ role, excerpt: !!excerptSha(brief) }).toEqual({ role, excerpt: true });
    }
    const roles = Object.keys(ROLE_EFFORT) as Role[];
    const m = buildManifest({ pass: 'p9', out: path.join(repo.root, 'p9'), ledger: path.join(repo.root, 'p9', 'l.jsonl'), base: 'main', diffBase: mb, root: repo.work, checklistRoot: path.resolve(import.meta.dir, '..'),
      dispatches: roles.map(role => ({ role, name: role === 'specialist' ? 'security' : role, effort: ROLE_EFFORT[role], exclude: [] })),
      next: 'full', planLines: [], reviewExclude: { ...x }, disclosure, fixCheck: { fix_list: fix('fl'), hunks: fix('h'), tests: fix('t') } });
    for (const r of m.readers.filter(r => r.role !== 'fix-check')) {
      expect({ reader: r.reader, exclude: r.exclude?.includes(QUOTED), excerpt: r.excerpt }).toEqual({ reader: r.reader, exclude: true, excerpt: x.excerpt });
      expect({ reader: r.reader, keep: (r.keep ?? []).some(k => x.excerpt.includes(k)) }).toEqual({ reader: r.reader, keep: false });
    }
    expect(m.readers.map(r => r.role).sort()).toEqual([...roles].sort());
  }, 300_000);

  // Value: protects=the outside voice's embedded diff, rendered from a subdirectory, still holds every changed file outside
  //   the exclusion; fails_when=render reads the selection's `-- .` from the caller's directory, so a sibling security change
  //   silently drops out of the outside voice's "whole diff"; why_new=GST-1476 /ship outside voice (render from docs/ lost
  //   lib/security.ts); seam=gstack-review-dispatch render on a real repository; no_claim=readers that run git themselves
  test('the outside voice rendered from a subdirectory reads the whole selection', () => {
    const policy = JSON.stringify({ review_exclude_paths: ['docs/results/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
    const repo = makeFixtureRepo({ prefix: 'gstack-sel-sub-', baseFiles: { '.gstack/ship-policy.json': policy, 'docs/README.md': 'a\n' } });
    repos.push(repo);
    commit(repo, { 'lib/security.ts': 'export const s = 1;\n', 'docs/README.md': 'b\n', 'docs/results/r.json': '{}\n' });
    const mb = repo.git('merge-base', 'origin/main', 'HEAD');
    const supplied = (cwd: string, out: string) => {
      const r = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'outside-voice', '--out', out, '--base', 'main', '--diff-base', mb], {}, cwd);
      expect(r.err).toBe('');
      expect(r.status).toBe(EXIT.ok);
      return fs.readFileSync(path.join(out, 'outside-voice.diff'), 'utf8');
    };
    const root = supplied(repo.work, path.join(repo.root, 'o-root'));
    const sub = supplied(path.join(repo.work, 'docs'), path.join(repo.root, 'o-sub'));
    expect(root).toContain('diff --git a/lib/security.ts');
    expect(root).not.toContain('docs/results/r.json');
    expect(sub).toBe(root);
  }, 120_000);
});
