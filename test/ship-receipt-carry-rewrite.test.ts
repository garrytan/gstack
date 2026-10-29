/**
 * gstack-ship-receipt carry across rewritten history and regenerated outputs (GSTA-147 PR 1,
 * docs/ship-policy.md#receipt-carry): a rebase carries only onto a tree the receipt covers with the
 * product diff it recorded, and a base merge that changes only a registered output's diff carries when
 * the pregate for HEAD regenerated that output fresh.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, planTreeCarry } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const receiptIn = (body: string) => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
const writeReceipt = (repo: FixtureRepo, body: string, extra: string[] = []) =>
  runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body, ...extra]);
const carry = (repo: FixtureRepo, body: string, extra: string[] = [], cwd = repo.work) =>
  runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', ...extra], {}, cwd);
function moveMain(repo: FixtureRepo, files: Record<string, string>, message = 'main moves'): void {
  repo.git('checkout', '-q', 'main');
  for (const [rel, text] of Object.entries(files)) write(repo.work, rel, text);
  repo.git('add', '-A'); repo.git('commit', '-qm', message); repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
}

describe('carry across a rebase', () => {
  // Value: protects=a rebase onto the reviewed tree keeps its receipt (Harbor paid ~60M for a byte-identical rebase);
  // fails_when=carry demands ancestry, or needs the old commit object; seam=none; no_claim=gh pr edit (--body stands in)
  test('a rebase onto the tree the receipt covers carries, from a fresh clone that never saw the old head', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    const reviewed = receiptIn(body);
    expect(reviewed.head_tree).toBe(repo.git('rev-parse', 'HEAD^{tree}'));
    moveMain(repo, { 'docs/README.md': '# docs moved on main\n' });
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const merged = repo.git('rev-parse', 'HEAD');
    expect(carry(repo, body).status).toBe(EXIT.ok);
    expect(receiptIn(body)).toMatchObject({ head: merged, head_tree: repo.git('rev-parse', 'HEAD^{tree}'), carry: { ancestry: 'linear', trees: [reviewed.head_tree] } });

    repo.git('checkout', '-q', '-B', 'feature', 'origin/main');
    repo.git('cherry-pick', reviewed.head);
    const rebased = repo.git('rev-parse', 'HEAD');
    expect(repo.git('rev-parse', 'HEAD^{tree}')).toBe(repo.git('rev-parse', `${merged}^{tree}`));
    repo.git('push', '-q', '-f', 'origin', 'feature');
    const clone = path.join(repo.root, 'clone');
    expect(spawnSync('git', ['clone', '-q', '--single-branch', '--branch', 'main', repo.origin, clone], { env: { ...process.env, ...repo.env }, timeout: 30_000 }).status).toBe(0);
    expect(spawnSync('git', ['fetch', '-q', 'origin', 'feature:feature'], { cwd: clone, env: { ...process.env, ...repo.env }, timeout: 30_000 }).status).toBe(0);
    expect(spawnSync('git', ['checkout', '-q', 'feature'], { cwd: clone, env: { ...process.env, ...repo.env }, timeout: 30_000 }).status).toBe(0);
    expect(spawnSync('git', ['cat-file', '-e', `${merged}^{commit}`], { cwd: clone, timeout: 30_000 }).status).not.toBe(0);

    const out = carry(repo, body, [], clone);
    expect(out.status).toBe(EXIT.ok);
    expect(out.out).toContain(`CARRY: carried from ${merged.slice(0, 12)} to ${rebased.slice(0, 12)} (rebase onto a reviewed tree)`);
    expect(receiptIn(body)).toMatchObject({ head: rebased, carry: { from: reviewed.head, reason: 'base merge + rebase onto a reviewed tree', ancestry: 'rewritten', range_diff: 'tree-equal' } });
  }, 90_000);

  // Value: protects=a rebase that changed the code takes a fresh /ship; fails_when=any non-ancestor head with a receipt
  // carries; seam=none; no_claim=-
  test('a rebase onto a different tree is RECEIPT_CARRY_TREE_MISMATCH and leaves the receipt unchanged', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    repo.git('checkout', '-q', '-B', 'feature', 'origin/main');
    const head = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 1;\n" });
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.out).toContain('CARRY: refused (RECEIPT_CARRY_TREE_MISMATCH)');
    expect(out.err).toContain(`HEAD's tree ${repo.git('rev-parse', 'HEAD^{tree}').slice(0, 12)} is not a tree the receipt covers`);
    expect(out.err).toContain(`run /ship on ${head.slice(0, 12)}`);
    expect(receiptIn(body).head).toBe(reviewed);
  }, 60_000);

  // Value: protects=an identical tree on a moved base is not the reviewed diff (a stacked base closed unmerged);
  // fails_when=tree equality alone carries; seam=planTreeCarry; no_claim=-
  test('the reviewed tree on a base that moved under it is RECEIPT_CARRY_PRODUCT_CHANGED', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    moveMain(repo, { 'lib/retry.js': "exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n" });
    repo.git('checkout', '-q', '-B', 'feature', 'origin/main');
    repo.git('checkout', reviewed, '--', '.');
    repo.git('commit', '-qam', 'same tree, new base');
    expect(repo.git('rev-parse', 'HEAD^{tree}')).toBe(receiptIn(body).head_tree ?? '');
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.out).toContain('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    expect(out.err).toContain('has the reviewed tree, but its product diff against the current base differs');
    expect(receiptIn(body).head).toBe(reviewed);
    expect(planTreeCarry({ from: 'a'.repeat(40), head: 'b'.repeat(40), headTree: 't1', coveredTrees: ['t1'], productPatchId: { recorded: 'p1', head: 'p1' } })).toMatchObject({ ok: true, carry: { ancestry: 'rewritten' } });
  }, 60_000);
});

describe('carry across a base merge that changes a registered output', () => {
  // Value: protects=U1's rerun (+28M): a base merge that changes only a generated output's diff carries once the regen
  // check proves the output fresh; fails_when=outputs carry without regen evidence, or never carry; seam=none; no_claim=gh
  test('the output is product without a regen-fresh pregate and metadata with one', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n", 'generated/digest.md': '# digest v1.1.0\n' });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    moveMain(repo, {
      'gen.js': "const fs=require('fs');const {VERSION}=require('./src/version.js');fs.writeFileSync('generated/digest.md',`# Digest v${VERSION}\\n`);\n",
      'generated/digest.md': '# Digest v1.0.0\n',
    });
    spawnSync('git', ['merge', '-q', '--no-edit', 'origin/main'], { cwd: repo.work, env: { ...process.env, ...repo.env }, timeout: 30_000 });
    write(repo.work, 'generated/digest.md', '# Digest v1.1.0\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'merge main; regenerate digest');

    const bare = carry(repo, body, ['--dry-run']);
    expect(bare.status).toBe(EXIT.refused);
    expect(bare.err).toContain('generated/digest.md');
    expect(bare.out).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');

    expect(runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands']).status).toBe(EXIT.ok);
    const pregateJson = path.join(repo.work, '.gstack/tmp/pregate.json');
    const pregate = JSON.parse(fs.readFileSync(pregateJson, 'utf8'));
    const regen = pregate.checks.find((c: { id: string }) => c.id === 'regen');
    expect(regen).toMatchObject({ status: 'pass', proven: ['generated/digest.md'] });
    const tampered = path.join(repo.root, 'pregate-tampered.json');
    const label = regen.inputs.registry;
    for (const [registry, proven] of [['head (unreviewed)', ['generated/digest.md']], [label, ['generated/*']]]) {
      Object.assign(regen, { proven, inputs: { ...regen.inputs, registry } });
      fs.writeFileSync(tampered, JSON.stringify(pregate));
      const refused = carry(repo, body, ['--pregate', tampered]);
      expect(refused.out).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
      expect(refused.err).toContain('generated/digest.md');
    }
    const out = carry(repo, body, ['--pregate', pregateJson]);
    expect(out.status).toBe(EXIT.ok);
    expect(receiptIn(body)).toMatchObject({ head: repo.git('rev-parse', 'HEAD'), carry: { from: reviewed } });
  }, 120_000);

  // Value: protects=a hand-written file under an output glob is reviewed code (red team, #3564 pass 1); fails_when=a
  // regen pass that never wrote the path sets it aside as generated; seam=none; no_claim=-
  test('a file that matches an output glob but that the generator never writes stays product', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    commit(repo, { 'generated/extra.md': '# hand-written after review\n' });
    expect(runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands']).status).toBe(EXIT.ok);
    const pregateJson = path.join(repo.work, '.gstack/tmp/pregate.json');
    const regen = JSON.parse(fs.readFileSync(pregateJson, 'utf8')).checks.find((c: { id: string }) => c.id === 'regen');
    expect(regen.status).toBe('pass');
    expect(regen.proven ?? []).not.toContain('generated/extra.md');
    const out = carry(repo, body, ['--pregate', pregateJson]);
    expect(out.status).toBe(EXIT.refused);
    expect(out.out).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain('generated/extra.md');
    expect(receiptIn(body).head).toBe(reviewed);
  }, 120_000);
});
