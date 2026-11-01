/**
 * Lane D (GSTA-112, E5): `allowlist` in the pregate policy lets a repo accept
 * benign findings the `secrets` check would otherwise refuse (dummy per-trial
 * tokens in receipts, a run id read as a phone number, a known public key in
 * a rebuilt bundle: harness-evals #81/#83, GSTA-102, GSTA-106), by finding id
 * or category, path and a pattern anchored at the finding. The real value of a
 * credential-named environment variable (`env.value`, #3449) can never be
 * allowlisted: validation refuses the entry, and the matcher ignores one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { applyAllowlist, type AllowlistFinding } from '../lib/pregate/allowlist';
import { NON_ALLOWLISTABLE, validateConfig } from '../lib/pregate/config';
import { CHECK_IDS } from '../lib/pregate/index';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (pregate: Record<string, unknown> | null) => { const r = makeFixtureRepo({ pregate }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const secrets = (repo: FixtureRepo, env: Record<string, string> = {}) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--only', 'secrets'], env);
const row = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'secrets');
const codes = (c: unknown) => validateConfig(c, CHECK_IDS).map(e => `${e.code}:${e.path}`);

const TRIAL = '{\n  "trial": 1,\n  "key": "sk-trial-9f8e7d6c-5b4a-3f2e-1d0c-7b6a5f4e3d2c"\n}\n';
const TRIAL_ENTRY = { finding: 'env.kv', paths: ['evals/**'], pattern: 'sk-trial-[0-9a-f-]+', reason: 'dummy per-trial meter ids in eval receipts' };

describe('allowlist: policy validation', () => {
  // Value: protects=the key's shape: finding id or non-secret category, paths and/or pattern, a reason; the env.value rule and
  //   the secret wildcard are refused at validation; fails_when=an entry without a reason or scope is accepted, or env.value can be
  //   named; why_new=the key is new; seam=none; no_claim=regex runtime cost
  test('accepts an id or category entry with a reason and a scope; refuses env.value, the secret wildcard, an empty scope and a bad regex', () => {
    expect(codes({ allowlist: [TRIAL_ENTRY] })).toEqual([]);
    expect(codes({ allowlist: [{ finding: 'pii', pattern: '\\d{11}', reason: 'GitHub run ids' }] })).toEqual([]);
    expect(codes({ allowlist: [{ finding: 'env.kv', paths: ['evals/**'] }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].reason']);
    expect(codes({ allowlist: [{ finding: 'env.kv', reason: 'x' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0]']);
    expect(codes({ allowlist: [{ finding: 'env.value', pattern: '.*', reason: 'never' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].finding']);
    expect(codes({ allowlist: [{ finding: 'secret', pattern: '.*', reason: 'never' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].finding']);
    expect(codes({ allowlist: [{ finding: 'env.kv', pattern: '(', reason: 'x' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].pattern']);
    expect(codes({ allowlist: [{ finding: 'env.kv', paths: ['../x'], reason: 'x' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].paths[0]']);
    expect(codes({ allowlist: { finding: 'env.kv' } })).toEqual(['PREGATE_CONFIG_INVALID:allowlist']);
    expect(codes({ allowlist: Array.from({ length: 65 }, () => TRIAL_ENTRY) })).toContain('PREGATE_CONFIG_INVALID:allowlist');
    expect(codes({ allowlist: [{ ...TRIAL_ENTRY, extra: 1 }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].extra']);
    expect(codes({ allowlist: [{ finding: 'env.kv', paths: [], reason: 'x' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].paths']);
    expect(codes({ allowlist: [{ finding: 'env.kv', pattern: 'a'.repeat(257), reason: 'x' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].pattern']);
    // A pattern entry never covers a finding the scanner gave no position; a paths-only entry does.
    const positionless: AllowlistFinding = { id: 'env.kv', category: 'secret', severity: 'MEDIUM', file: 'evals/x.json' };
    const inert = applyAllowlist([positionless], [TRIAL_ENTRY]);
    expect(inert.kept).toHaveLength(1);
    expect(inert.untested.map(u => [u.index, u.finding.id])).toEqual([[0, 'env.kv']]);
    expect(applyAllowlist([positionless], [{ finding: 'env.kv', paths: ['evals/**'], reason: 'r' }]).allowlisted).toHaveLength(1);
    expect(NON_ALLOWLISTABLE).toContain('env.value');
    // The scanner's own refusal (an oversize input fails closed) is never a benign finding: refused by validation, kept by the matcher.
    expect(codes({ allowlist: [{ finding: 'engine.input_too_large', paths: ['**'], reason: 'x' }] })).toEqual(['PREGATE_CONFIG_INVALID:allowlist[0].finding']);
    const refusal: AllowlistFinding = { id: 'engine.input_too_large', category: 'engine', severity: 'HIGH', file: 'big.json' };
    expect(applyAllowlist([refusal], [{ finding: 'engine.input_too_large', paths: ['**'], reason: 'x' }]).kept).toHaveLength(1);
  });
});

describe('allowlist: the secrets check', () => {
  // Value: protects=a benign dummy token in the allowlisted path with the allowlisted shape passes and is named as allowlisted;
  //   the same token outside the path, or a shape the pattern does not cover, still fails PREGATE_SECRETS; fails_when=the
  //   allowlist is ignored (the pre-change behaviour: 1,800 dummy tokens failed harness-evals #81) or it silences a finding its
  //   scope does not cover; why_new=the key is new; seam=none; no_claim=none
  test('a dummy trial token is allowlisted by path and pattern, and named; outside the scope it still fails', () => {
    const repo = fixture({ ...BASE_PREGATE, allowlist: [TRIAL_ENTRY] });
    commit(repo, { 'evals/receipts/t1.json': TRIAL });
    const ok = secrets(repo);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.err).not.toContain('PREGATE_SECRETS');
    const r = row(repo);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('1 allowlisted (env.kv)');
    expect(r.lines.join('\n')).toContain('allowlisted env.kv (evals/receipts/t1.json, added line 3) by allowlist[0] env.kv: dummy per-trial meter ids in eval receipts');
    expect(r.inputs.allowlist).toMatch(/^[0-9a-f]{64}$/);
    commit(repo, { 'notes/t2.json': TRIAL });
    const outside = secrets(repo);
    expect(outside.status).toBe(EXIT.fail);
    expect(outside.err).toContain('(PREGATE_SECRETS)');
    expect(row(repo).lines.join('\n')).toContain('notes/t2.json');
    const shape = fixture({ ...BASE_PREGATE, allowlist: [{ ...TRIAL_ENTRY, pattern: 'sk-trial-[0-9]+' }] });
    commit(shape, { 'evals/receipts/t1.json': TRIAL });
    expect(secrets(shape).status).toBe(EXIT.fail);
  });

  // Value: protects=a pattern entry scoped to the finding that misses it says so, naming the column the pattern is tested from
  //   (#3630: `session: HttpSession` as a pattern never matched, and the row was silent); fails_when=the miss is silent again or
  //   the finding is dropped; why_new=the row is new; seam=none; no_claim=none
  test('a pattern entry that names the finding but misses its value prints a row and keeps the finding', () => {
    const line = 'session: HttpSessionStore\n';
    const missed = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'env.kv', paths: ['config.yaml'], pattern: 'session: HttpSessionStore', reason: 'a type name' }] });
    commit(missed, { 'config.yaml': line });
    expect(secrets(missed).status).toBe(EXIT.fail);
    expect(row(missed).lines.join('\n')).toContain('allowlist[0] env.kv pattern did not match env.kv (config.yaml, added line 1, col 10): a pattern is matched from where the flagged value starts, not from the name; the finding is kept');
    const value = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'env.kv', paths: ['config.yaml'], pattern: 'HttpSessionStore', reason: 'a type name' }] });
    commit(value, { 'config.yaml': line });
    expect(secrets(value).status).toBe(EXIT.ok);
    expect(row(value).detail).toContain('1 allowlisted (env.kv)');
    const other = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'env.kv', paths: ['config.yaml'], pattern: 'dummy-[0-9]+', reason: 'another value' }] });
    commit(other, { 'config.yaml': line });
    expect(secrets(other).status).toBe(EXIT.fail);
    expect(row(other).lines.join('\n')).not.toContain('pattern did not match');
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    const py = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'env.kv', paths: ['app.py'], pattern: token, reason: 'a fixture' }] });
    commit(py, { 'app.py': `x = 1\nCONFIG = """\npassword: ${token}\n"""\n` });
    expect(secrets(py).status).toBe(EXIT.ok);
    expect(row(py).lines.join('\n')).toContain('allowlisted env.kv (app.py, line 3) by allowlist[0] env.kv: a fixture');
  });

  // Value: protects=a category entry covers an advisory pii hit (a run id after a generic word, which the engine's run-word exemption does not cover, read as a phone number) and the WARN count drops;
  //   fails_when=category matching is id-only; why_new=new; seam=none; no_claim=none
  test('a category entry silences the advisory pii finding for a run id', () => {
    const repo = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'pii', pattern: '\\d{11}', reason: 'GitHub Actions run ids in reports' }] });
    commit(repo, { 'docs/runs.md': 'job 40302077688 passed\n' });
    expect(secrets(repo).status).toBe(EXIT.ok);
    const r = row(repo);
    expect([r.status, r.code]).toEqual(['pass', undefined]);
    expect(r.detail).toContain('1 allowlisted (pii.phone.e164)');
    const control = fixture(BASE_PREGATE);
    commit(control, { 'docs/runs.md': 'job 40302077688 passed\n' });
    secrets(control);
    expect([row(control).status, row(control).code]).toEqual(['warn', 'PREGATE_SECRETS']);
    expect(row(control).detail).toContain('pii.phone.e164');
  });

  // Value: protects=env.value is never allowlisted: a config naming it is refused before any check runs, and the matcher keeps an
  //   env.value finding even when an entry's scope would match it; fails_when=either path lets a configured credential's value
  //   through; why_new=the rule is new; seam=none; no_claim=none
  test('env.value survives every allowlist: the config is refused, and the matcher never drops it', () => {
    const value = 'q8Zt3vRm7Lk2Xn9Pw4Cs6Hd1Yf5Gb0Je';
    const refused = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'env.value', pattern: '.*', reason: 'no' }] });
    commit(refused, { 'lib/leak.txt': `token=${value}\n` });
    const r = secrets(refused, { FIXTURE_API_TOKEN: value });
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(PREGATE_CONFIG_INVALID)');
    expect(r.err).toContain('allowlist[0].finding');
    const findings: AllowlistFinding[] = [
      { id: 'env.value', category: 'secret', severity: 'HIGH', file: 'lib/leak.txt', line: 1, col: 7, lineText: `token=${value}` },
      { id: 'env.kv', category: 'secret', severity: 'MEDIUM', file: 'lib/leak.txt', line: 1, col: 7, lineText: `token=${value}` },
    ];
    const wide = [{ finding: 'env.value', pattern: '.*', reason: 'no' }, { finding: 'env.kv', pattern: '.*', reason: 'wide' }];
    const applied = applyAllowlist(findings, wide);
    expect(applied.kept.map(f => f.id)).toEqual(['env.value']);
    expect(applied.allowlisted.map(a => a.finding.id)).toEqual(['env.kv']);
    const live = fixture({ ...BASE_PREGATE, allowlist: [{ finding: 'env.kv', pattern: '.*', reason: 'wide' }] });
    commit(live, { 'lib/leak.txt': `token=${value}\n` });
    const leak = secrets(live, { FIXTURE_API_TOKEN: value });
    expect(leak.status).toBe(EXIT.fail);
    expect(row(live).lines.join('\n')).toContain('env.value');
  });
});
