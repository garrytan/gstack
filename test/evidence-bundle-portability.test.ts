/**
 * C3: `gstack-evidence bundle` is the portable form of the machine-local
 * evidence ledger. A fresh coordinator clone with an empty state root reads
 * the bundle without the gate VM; imported assertions stay distinct from
 * verified lanes; a bundle without an execution identity refuses reuse.
 * C7: `gstack-evidence ancestor` checks preregistration shas against HEAD.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { gitArgvIn } from './helpers/scratch-repo';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, recordAndBundle, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo({ prefix: 'bundle-', ...opts }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function gatedAndPushed(repo: FixtureRepo): { head: string; bundle: string } {
  makePr(repo, 'pr-a', { expects: '1.2.4.0' });
  expect(restamp(repo, ['--version', '1.2.4.0']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp 1.2.4.0');
  repo.git('push', '-q', '-u', 'origin', 'pr-a');
  const bundle = path.join(repo.root, 'bundle.json');
  recordAndBundle(repo, repo.work, [{ label: 'tests', command: 'true' }], bundle);
  return { head: repo.git('rev-parse', 'HEAD'), bundle };
}

describe('evidence bundle portability', () => {
  test('a fresh clone with an empty state root reads the bundle and reaches the same eligible verdict', () => {
    const repo = fixture();
    const g = gatedAndPushed(repo);
    const bundle = JSON.parse(fs.readFileSync(g.bundle, 'utf8'));
    expect(bundle).toMatchObject({ schema_version: 1, kind: 'gstack-evidence-bundle', repo: { commit: g.head, dirty: false }, required_lanes: ['tests'] });
    expect(bundle.lanes[0]).toMatchObject({ label: 'tests', verified: true, exit: 0 });
    expect(bundle.lanes[0].cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.comparison).toMatchObject({ version_rel: 'VERSION', version: '1.2.4.0', changelog: 'CHANGELOG.md', stamp_paths: ['docs/**/*.md'], release_outputs: ['generated/**'] });
    expect(bundle.identity.runtime.bun).toBeTruthy();

    const fresh = path.join(repo.root, 'coordinator');
    const home = path.join(repo.root, 'coordinator-home');
    fs.mkdirSync(home, { recursive: true });
    const clone = gitArgvIn(repo.root, ['clone', '-q', path.join(repo.root, 'origin.git'), fresh], 60_000, { ...process.env, ...repo.env });
    expect(clone.status).toBe(0);
    gitArgvIn(fresh, ['checkout', '-q', 'pr-a'], 30_000, { ...process.env, ...repo.env });
    const env = { GSTACK_HOME: home, GSTACK_STATE_DIR: home, HOME: home };
    const r = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', g.head, '--bundle', g.bundle], env, fresh);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^TREE: same-modulo-stamps$/m);
    expect(r.out).toMatch(/^gate-reuse: eligible \(reusable: tests; rerun: -\)$/m);
    expect(fs.existsSync(path.join(home, '.gstack'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'evidence'))).toBe(false);
  });

  test('imported assertions are listed apart from verified lanes and never make the gate reusable', () => {
    const repo = fixture();
    makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    expect(restamp(repo, ['--version', '1.2.4.0']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp 1.2.4.0');
    expect(runBin(repo, 'gstack-evidence', ['run', '--label', 'tests', '--', 'true']).status).toBe(0);
    const imported = path.join(repo.root, 'ci.json');
    fs.writeFileSync(imported, JSON.stringify([{ label: 'e2e', command: 'bun run test:e2e', exit: 0, source: 'github-actions run 42', run_url: 'https://ci.example/runs/42' }]));
    const out = path.join(repo.root, 'bundle.json');
    const b = runBin(repo, 'gstack-evidence', ['bundle', '--out', out, '--base', 'main', '--label', 'tests', '--require', 'tests,e2e', '--selection', 'tests=unit shard 1/1', '--import', imported]);
    expect(b.status).toBe(0);
    expect(b.out).toMatch(/^EVIDENCE_BUNDLE: .*bundle\.json tree=[0-9a-f]{40} lanes=1 verified=1 imported=1$/m);
    const bundle = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(bundle.lanes[0]).toMatchObject({ label: 'tests', verified: true, selection: 'unit shard 1/1' });
    expect(bundle.imported[0]).toMatchObject({ label: 'e2e', verified: false, run_url: 'https://ci.example/runs/42' });
    expect(bundle.imported[0].reason).toBe('imported assertion from github-actions run 42; not independently verified');
    const r = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', 'HEAD', '--bundle', out]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^  gate tests: reusable/m);
    expect(r.out).toMatch(/^  gate e2e: not-reusable \(required lane has no verified record in the bundle\)$/m);
    expect(r.out).toMatch(/^  gate e2e: not-reusable \(imported assertion from github-actions run 42; not independently verified\)$/m);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(e2e: required lane has no verified record in the bundle; e2e: imported assertion/m);
  });

  test('a lane recorded on a dirty tree or another commit is in the bundle but not verified', () => {
    const repo = fixture();
    makePr(repo, 'pr-a');
    expect(runBin(repo, 'gstack-evidence', ['run', '--label', 'old', '--', 'true']).status).toBe(0);
    fs.writeFileSync(path.join(repo.work, 'more.txt'), 'more\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'more');
    fs.writeFileSync(path.join(repo.work, 'more.txt'), 'dirty\n');
    expect(runBin(repo, 'gstack-evidence', ['run', '--label', 'dirty', '--', 'true']).status).toBe(0);
    repo.git('checkout', '--', 'more.txt');
    const out = path.join(repo.root, 'bundle.json');
    const b = runBin(repo, 'gstack-evidence', ['bundle', '--out', out, '--base', 'main', '--label', 'old', '--label', 'dirty', '--label', 'absent']);
    expect(b.status).toBe(1);
    expect(b.err).toMatch(/no ledger record for label absent.*\(EVIDENCE_IDENTITY_UNKNOWN\)/);
    expect(b.out).toMatch(/^EVIDENCE_BUNDLE: .* lanes=2 verified=0 imported=0$/m);
    const bundle = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(bundle.lanes.map((l: any) => [l.label, l.verified])).toEqual([['old', false], ['dirty', false]]);
    expect(bundle.lanes[0].reason).toMatch(/^ran on [0-9a-f]{12}, HEAD is [0-9a-f]{12}$/);
    expect(bundle.lanes[1].reason).toBe('ran on a dirty or unfingerprinted tree (committed heads only)');
    const r = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', 'HEAD', '--bundle', out]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(old: ran on .*; dirty: ran on a dirty/m);
  });

  test('a bundle without an execution identity, or that is not a bundle, refuses reuse (EVIDENCE_BUNDLE_INVALID)', () => {
    const repo = fixture();
    const g = gatedAndPushed(repo);
    const stripped = path.join(repo.root, 'no-identity.json');
    const bundle = JSON.parse(fs.readFileSync(g.bundle, 'utf8'));
    delete bundle.identity;
    fs.writeFileSync(stripped, JSON.stringify(bundle));
    const r = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', g.head, '--bundle', stripped]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(invalid bundle: .*no-identity\.json is not a gstack-evidence-bundle v1\)/m);
    const garbage = path.join(repo.root, 'garbage.json');
    fs.writeFileSync(garbage, '{not json');
    const g2 = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', g.head, '--bundle', garbage]);
    expect(g2.status).toBe(EXIT.fail);
    expect(g2.out).toMatch(/^gate-reuse: not-eligible \(invalid bundle: .*garbage\.json: /m);
  });

  test('bundle needs a committed head and --out', () => {
    const repo = fixture();
    expect(runBin(repo, 'gstack-evidence', ['bundle']).status).toBe(2);
    const nowhere = path.join(repo.root, 'not-a-repo');
    fs.mkdirSync(nowhere);
    const r = runBin(repo, 'gstack-evidence', ['bundle', '--out', path.join(nowhere, 'b.json')], {}, nowhere);
    expect(r.status).not.toBe(0);
  });
});

describe('gstack-evidence ancestor (C7)', () => {
  test('each preregistration sha is checked against HEAD; a missing or unrelated one fails with PREREGISTRATION_NOT_ANCESTOR', () => {
    const repo = fixture();
    const base = repo.git('rev-parse', 'HEAD');
    makePr(repo, 'pr-a');
    const head = repo.git('rev-parse', 'HEAD');
    repo.git('checkout', '-q', '-b', 'stray', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'stray.txt'), 'stray\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'stray');
    const stray = repo.git('rev-parse', 'HEAD');
    repo.git('checkout', '-q', 'pr-a');
    const ok = runBin(repo, 'gstack-evidence', ['ancestor', base, head.slice(0, 12)]);
    expect(ok.status).toBe(0);
    expect(ok.out).toMatch(new RegExp(`^ANCESTOR: ok ${base} \\(ancestor of HEAD\\)$`, 'm'));
    expect(ok.out).toMatch(new RegExp(`^ANCESTOR: ok ${head.slice(0, 12)} \\(ancestor of HEAD\\)$`, 'm'));
    const bad = runBin(repo, 'gstack-evidence', ['ancestor', stray, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'nothex']);
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(new RegExp(`^ANCESTOR: missing ${stray} \\(not an ancestor of HEAD\\) — fix: .* \\(PREREGISTRATION_NOT_ANCESTOR\\)$`, 'm'));
    expect(bad.out).toMatch(/^ANCESTOR: missing deadbeef.* \(unknown commit \(fetch it first\)\)/m);
    expect(bad.out).toMatch(/^ANCESTOR: missing nothex \(not a hex commit id\)/m);
  });

  test('--from-policy reads preregistration_shas from the base branch copy; none means no check', () => {
    const none = fixture();
    makePr(none, 'pr-a');
    const n = runBin(none, 'gstack-evidence', ['ancestor', '--from-policy', '--base', 'main']);
    expect(n.status).toBe(0);
    expect(n.out).toBe('ANCESTOR: none (no preregistration_shas)\n');

    const seeded = fixture();
    const base = seeded.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(seeded.work, '.gstack', 'ship-policy.json'), JSON.stringify({ ...BASE_POLICY, preregistration_shas: [base] }, null, 2) + '\n');
    seeded.git('add', '-A'); seeded.git('commit', '-q', '-m', 'preregister'); seeded.git('push', '-q', 'origin', 'main');
    makePr(seeded, 'pr-a');
    const r = runBin(seeded, 'gstack-evidence', ['ancestor', '--from-policy', '--base', 'main']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(new RegExp(`^ANCESTOR: ok ${base} \\(ancestor of HEAD\\)$`, 'm'));
    seeded.git('checkout', '-q', '--orphan', 'rewritten');
    seeded.git('commit', '-q', '-m', 'orphan history');
    const o = runBin(seeded, 'gstack-evidence', ['ancestor', '--from-policy', '--base', 'main']);
    expect(o.status).toBe(1);
    expect(o.out).toMatch(/PREREGISTRATION_NOT_ANCESTOR/);
  });
});
