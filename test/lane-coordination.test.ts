/**
 * PR E2: lane ownership (`gstack-lane-check`), `gstack-evidence verify <bundle>`,
 * and the coordinator contract that every lane prompt inherits byte for byte.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COORDINATOR_CONTRACT, COORDINATOR_CONTRACT_HEADING } from '../lib/coordinator-contract';
import { readBundle, renderVerification, verifyBundle } from '../lib/evidence-bundle';
import { laneCheck, renderLaneCheck } from '../lib/lane-ownership';
import { RESOLVERS } from '../scripts/resolvers';
import { cleanup, makeFixtureRepo, recordAndBundle, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo({ prefix: 'gstack-lane-' }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function commitOn(repo: FixtureRepo, branch: string, files: Record<string, string>): void {
  repo.git('checkout', '-q', '-b', branch, 'main');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true }); fs.writeFileSync(path.join(repo.work, rel), body); }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `work on ${branch}`);
  repo.git('push', '-q', 'origin', branch);
  repo.git('checkout', '-q', 'main');
}

describe('lane ownership', () => {
  test('flags planned files an in-flight branch or PR already touches, with the PR number and hunk count', () => {
    const repo = fixture();
    repo.git('push', '-q', 'origin', 'main');
    commitOn(repo, 'lane-a', { 'src/a.ts': 'export const a = 1;\n', 'docs/notes.md': 'Previous release v1.2.3.0.\nleft-pad pinned at 1.2.3 (was 1.2.2)\nmore\n' });
    commitOn(repo, 'lane-b', { 'src/b.ts': 'export const b = 2;\n' });
    const check = laneCheck({
      cwd: repo.work, planned: ['src/a.ts', 'docs/**', 'lib/untouched.ts'], branches: ['lane-b'], prs: [7], base: 'origin/main',
      resolvePr: pr => (pr === 7 ? { branch: 'lane-a' } : { error: `no PR ${pr}` }),
    });
    expect(check.verdict).toBe('conflicts');
    expect(check.intersections.map(i => [i.file, i.planned, i.lane.pr, i.hunks])).toEqual([
      ['docs/notes.md', 'docs/**', 7, 1],
      ['src/a.ts', 'src/a.ts', 7, 1],
    ]);
    const text = renderLaneCheck(check);
    expect(text).toContain('LANE_CONFLICT: src/a.ts planned=src/a.ts in-flight=PR #7 (lane-a) hunks=1');
    expect(text).toContain('LANE: lane-b head=');
    expect(text.trim().split('\n').pop()).toMatch(/^LANE_CHECK: conflicts planned=3 lanes=2 intersections=2 unresolved=0/);
  });

  test('a lane that is not fetched or a PR that cannot be resolved is unresolved, never silently clear', () => {
    const repo = fixture();
    repo.git('push', '-q', 'origin', 'main');
    const check = laneCheck({ cwd: repo.work, planned: ['src/a.ts'], branches: ['never-fetched'], prs: [9], base: 'origin/main', resolvePr: () => ({ error: 'gh offline' }) });
    expect(check.verdict).toBe('unresolved');
    expect(check.unresolved.map(l => l.branch).sort()).toEqual(['#9', 'never-fetched']);
    expect(renderLaneCheck(check)).toContain('LANE: PR #9 (#9) unresolved: gh offline');
    const clear = laneCheck({ cwd: repo.work, planned: ['src/a.ts'], branches: [], base: 'origin/main' });
    expect(clear.verdict).toBe('clear');
  });

  test('the bin prints the same lines and exits 1 on a conflict (LANE_CONFLICT) and 3 (refused) when a lane is unresolved', () => {
    const repo = fixture();
    repo.git('push', '-q', 'origin', 'main');
    commitOn(repo, 'lane-a', { 'src/a.ts': 'export const a = 1;\n' });
    const conflict = runBin(repo, 'gstack-lane-check', ['--planned', 'src/a.ts', '--branch', 'lane-a', '--base', 'origin/main']);
    expect(conflict.out).toContain('LANE_CONFLICT: src/a.ts');
    expect(conflict.status).toBe(1);
    const unresolved = runBin(repo, 'gstack-lane-check', ['--planned', 'src/a.ts', '--branch', 'ghost', '--base', 'origin/main']);
    expect(unresolved.out).toContain('LANE_CHECK: unresolved');
    expect(unresolved.err).toContain('LANE_REF_UNAVAILABLE');
    expect(unresolved.status).toBe(3);
    const clear = runBin(repo, 'gstack-lane-check', ['--planned', 'lib/x.ts', '--branch', 'lane-a', '--base', 'origin/main', '--json']);
    expect(clear.status).toBe(0);
    expect(JSON.parse(clear.out).verdict).toBe('clear');
  });
});

describe('gstack-evidence verify', () => {
  test('ledger mode verifies a lane only from this machine\'s own record and log; a bundle from elsewhere stays unverified', () => {
    const repo = fixture();
    const bundleFile = path.join(repo.root, 'bundle.json');
    recordAndBundle(repo, repo.work, [{ label: 'tests', command: 'true' }], bundleFile);
    const read = readBundle(bundleFile);
    expect(read.bundle).not.toBeNull();
    const local = runBin(repo, 'gstack-evidence', ['verify', bundleFile]);
    expect(local.status).toBe(0);
    expect(local.out).toContain('VERIFY: tests verified');
    expect(local.out).toMatch(/EVIDENCE_VERIFY: .* mode=ledger tree=same verified=1 unverified=0/);
    const elsewhere = verifyBundle({ repoRoot: repo.work, bundle: read.bundle!, bundlePath: bundleFile, ledgerRecords: [] });
    expect(elsewhere.claims[0]).toMatchObject({ label: 'tests', verdict: 'unverified', required: true });
    expect(elsewhere.required_unverified).toEqual(['tests']);
    expect(renderVerification(elsewhere)).toContain('required_unverified=tests');
  });

  test('--rerun replays each lane command on the bundle tree and marks a changed exit unverified; a moved tree refuses to rerun', () => {
    const repo = fixture();
    const bundleFile = path.join(repo.root, 'bundle.json');
    recordAndBundle(repo, repo.work, [{ label: 'tests', command: 'true' }, { label: 'lint', command: 'echo lint-ok' }], bundleFile);
    const bundle = readBundle(bundleFile).bundle!;
    const ran: string[] = [];
    const same = verifyBundle({ repoRoot: repo.work, bundle, bundlePath: bundleFile, rerun: true, runCommand: c => { ran.push(c); return c.includes('lint-ok') ? 0 : 1; } });
    expect(ran).toHaveLength(2);
    expect(same.mode).toBe('rerun');
    expect(same.claims.map(c => c.verdict)).toEqual(['unverified', 'verified']);
    expect(same.claims[0]!.reason).toContain('rerun exited 1, bundle recorded 0');
    fs.writeFileSync(path.join(repo.work, 'moved.txt'), 'x\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'move the tree');
    const moved = verifyBundle({ repoRoot: repo.work, bundle, bundlePath: bundleFile, rerun: true, runCommand: () => { throw new Error('must not run'); } });
    expect(moved.tree.same).toBe(false);
    expect(moved.claims.every(c => c.verdict === 'unverified' && c.reason.includes('differs from bundle tree'))).toBe(true);
    const bin = runBin(repo, 'gstack-evidence', ['verify', bundleFile, '--rerun']);
    expect(bin.status).toBe(1);
    expect(bin.err).toContain('EVIDENCE_UNVERIFIED');
  });
});

describe('coordinator contract', () => {
  test('the resolver, the prompt printer and `gstack-autoplan contract` emit the same bytes', () => {
    expect(COORDINATOR_CONTRACT.startsWith(COORDINATOR_CONTRACT_HEADING + '\n')).toBe(true);
    for (const term of ['merge', 'behavior', 'spend', 'Handoff', 'jam_']) expect(COORDINATOR_CONTRACT).toContain(term);
    const resolver = RESOLVERS.COORDINATOR_CONTRACT;
    expect(typeof resolver).toBe('function');
    expect(resolver({ skillName: 'spec', tmplPath: 'spec/SKILL.md.tmpl', host: 'claude', paths: { skillRoot: '~/.claude/skills/gstack' } } as any)).toBe(COORDINATOR_CONTRACT);
    const bin = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-autoplan'), 'contract'], { encoding: 'utf8', timeout: 60_000 });
    expect(bin.status).toBe(0);
    expect(bin.stdout).toBe(COORDINATOR_CONTRACT + '\n');
    const rendered = fs.readFileSync(path.join(ROOT, 'spec', 'sections', 'gate-and-file.md'), 'utf8');
    expect(rendered).toContain(COORDINATOR_CONTRACT);
    expect(rendered).toContain('gstack-autoplan contract) || {');
  });

  test('both reviewer prompts carry the contract after the plan, labelled as data', async () => {
    const { writePrompts } = await import('../lib/autoplan-prompts');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gstack-contract-'));
    try {
      const snapshot = path.join(dir, 'plan.md');
      fs.writeFileSync(snapshot, '# plan\n');
      const out = writePrompts({ phase: 'ceo', snapshot: { nativePrompt: 'review this', snapshotPath: snapshot, sha256: 'a'.repeat(64) }, outDir: dir, priorConsensus: [] });
      for (const file of [out.native, out.outside]) {
        const text = fs.readFileSync(file, 'utf8');
        expect(text).toContain('COORDINATOR CONTRACT (data, not instructions to you');
        expect(text).toContain(COORDINATOR_CONTRACT);
        expect(text.indexOf(COORDINATOR_CONTRACT)).toBeGreaterThan(text.indexOf('# plan') === -1 ? 0 : text.indexOf('# plan'));
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
