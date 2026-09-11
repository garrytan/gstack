import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type LandingSafety = typeof import('../lib/landing-safety');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function loadSafety(): Promise<LandingSafety | null> {
  try { return await import('../lib/landing-safety'); } catch { return null; }
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], { timeout: 30_000, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function oid(char: string): string { return char.repeat(40); }

describe('landing safety boundary', () => {
  test('rejects a head that does not contain the frozen live base before merge', async () => {
    const safety = await loadSafety();
    expect(safety).not.toBeNull();
    if (!safety) return;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-landing-base-')); roots.push(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'value.txt'), 'one\n');
    git(repo, 'add', 'value.txt'); git(repo, 'commit', '-qm', 'one');
    const oldHead = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'value.txt'), 'two\n');
    git(repo, 'commit', '-qam', 'two');
    const liveBase = git(repo, 'rev-parse', 'HEAD');

    await expect(safety.assertBaseContained(repo, liveBase, oldHead, '/usr/bin/git'))
      .rejects.toThrow('base_not_contained');
    await expect(safety.assertBaseContained(repo, oldHead, liveBase, '/usr/bin/git'))
      .resolves.toBeUndefined();
  });

  test('fsyncs one owner-only intent and exact retry reuses it', async () => {
    const safety = await loadSafety();
    expect(safety).not.toBeNull();
    if (!safety) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-landing-intent-')); roots.push(root);
    const descriptor = {
      repoId: 'github.com/konghak/portfolioops', repositoryNodeId: 'R_123', prNumber: 17,
      expectedHeadOid: oid('1'), expectedBaseOid: oid('2'), targetRef: 'origin/main',
      mode: 'direct_observed' as const, providerOperationId: 'github-direct-pr-17',
    };

    const first = safety.prepareLandingIntent(root, descriptor);
    const second = safety.prepareLandingIntent(root, descriptor);
    expect(second).toEqual(first);
    expect(first.phase).toBe('prepared');
    const files = fs.readdirSync(root).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(root, files[0])).mode & 0o777).toBe(0o600);
    expect(safety.inspectLandingIntent(root, first.intentId)).toMatchObject({
      phase: 'prepared', expectedHeadOid: oid('1'), expectedBaseOid: oid('2'),
    });
    expect(safety.inspectLandingIntentForDescriptor(root, descriptor)).toEqual(first);
    expect(safety.inspectLandingIntentForDescriptor(root, { ...descriptor, expectedHeadOid: oid('9') })).toBeNull();
  });

  test('terminal reconciliation distinguishes abandon, cancel, exact merge, and safety stop', async () => {
    const safety = await loadSafety();
    expect(safety).not.toBeNull();
    if (!safety) return;
    const make = (suffix: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `ecpe-landing-${suffix}-`)); roots.push(root);
      const intent = safety.prepareLandingIntent(root, {
        repoId: 'github.com/konghak/portfolioops', repositoryNodeId: 'R_123', prNumber: 17,
        expectedHeadOid: oid('1'), expectedBaseOid: oid('2'), targetRef: 'origin/main',
        mode: 'direct_observed', providerOperationId: `operation-${suffix}`,
      });
      return { root, intent };
    };

    const abandoned = make('abandon');
    expect(safety.reconcileLandingIntent(abandoned.root, abandoned.intent.intentId, {
      terminal: true, providerState: 'not_submitted', headOid: oid('1'), baseOid: oid('2'),
    })).toMatchObject({ status: 'abandoned_terminal' });

    const queued = make('queue');
    const cancellation = safety.reconcileLandingIntent(queued.root, queued.intent.intentId, {
      terminal: true, providerState: 'queued', headOid: oid('1'), baseOid: oid('2'), queueId: 'Q_1',
    });
    expect(cancellation).toMatchObject({ status: 'cancel_required' });
    expect(cancellation.proposalHash).toMatch(/^[0-9a-f]{64}$/);

    const merged = make('merged');
    expect(safety.reconcileLandingIntent(merged.root, merged.intent.intentId, {
      terminal: false, providerState: 'merged', headOid: oid('1'), baseOid: oid('2'),
      mergeSha: oid('3'), mergeTreeMatches: true,
    })).toMatchObject({ status: 'checkpointed', mergeSha: oid('3') });

    const moved = make('moved');
    expect(safety.reconcileLandingIntent(moved.root, moved.intent.intentId, {
      terminal: false, providerState: 'merged', headOid: oid('4'), baseOid: oid('2'),
      mergeSha: oid('3'), mergeTreeMatches: true,
    })).toMatchObject({ status: 'safety_stop', reason: 'provider_head_moved' });
  });

  test('exposes a closed typed merged checkpoint only for exact parent and tree evidence', async () => {
    const safety = await loadSafety();
    expect(safety).not.toBeNull();
    if (!safety) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-landing-typed-')); roots.push(root);
    const descriptor = {
      repoId: 'github.com/konghak/portfolioops', repositoryNodeId: 'R_123', prNumber: 17,
      expectedHeadOid: oid('1'), expectedBaseOid: oid('2'), targetRef: 'origin/main',
      mode: 'direct_observed' as const, providerOperationId: 'github-direct-pr-17',
    };
    const intent = safety.prepareLandingIntent(root, descriptor);
    safety.reconcileLandingIntent(root, intent.intentId, {
      terminal: false, providerState: 'merged', headOid: oid('1'), baseOid: oid('2'),
      mergeSha: oid('3'), mergeTreeMatches: true, mergeTree: oid('4'), mergeParents: [oid('2')],
    });

    const checkpoint = safety.inspectExactMergedLandingCheckpoint(root, {
      descriptor, mergeSha: oid('3'), mergeTree: oid('4'), mergeParents: [oid('2')],
    });
    expect(checkpoint).toMatchObject({
      schema: 'ecpe.merged-landing-checkpoint.v1', raw_intent_id: intent.intentId,
      expected_head_oid: oid('1'), expected_base_oid: oid('2'), merge_sha: oid('3'),
      merge_tree: oid('4'), merge_parents: [oid('2')], base_parent_verified: true,
      head_tree_verified: true,
    });
    expect(checkpoint.checkpoint_id).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpoint.binding_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects raw checkpoint result fields that are not in the closed merged schema', async () => {
    const safety = await loadSafety();
    expect(safety).not.toBeNull();
    if (!safety) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-landing-forged-')); roots.push(root);
    const descriptor = {
      repoId: 'github.com/konghak/portfolioops', repositoryNodeId: 'R_123', prNumber: 17,
      expectedHeadOid: oid('1'), expectedBaseOid: oid('2'), targetRef: 'origin/main',
      mode: 'direct_observed' as const, providerOperationId: 'github-direct-pr-17',
    };
    const intent = safety.prepareLandingIntent(root, descriptor);
    safety.reconcileLandingIntent(root, intent.intentId, {
      terminal: false, providerState: 'merged', headOid: oid('1'), baseOid: oid('2'),
      mergeSha: oid('3'), mergeTreeMatches: true, mergeTree: oid('4'), mergeParents: [oid('2')],
    });
    const file = path.join(root, `${intent.intentId}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.result.forged = true;
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    expect(() => safety.inspectExactMergedLandingCheckpoint(root, {
      descriptor, mergeSha: oid('3'), mergeTree: oid('4'), mergeParents: [oid('2')],
    })).toThrow('landing_checkpoint_invalid');
  });

  test('rejects hard-linked checkpoint records and a symlinked authority root', async () => {
    const safety = await loadSafety(); expect(safety).not.toBeNull(); if (!safety) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-landing-protected-')); roots.push(root);
    const descriptor = { repoId: 'github.com/konghak/portfolioops', repositoryNodeId: 'R_123', prNumber: 17,
      expectedHeadOid: oid('1'), expectedBaseOid: oid('2'), targetRef: 'origin/main', mode: 'direct_observed' as const,
      providerOperationId: 'github-direct-pr-17' };
    const intent = safety.prepareLandingIntent(root, descriptor);
    safety.reconcileLandingIntent(root, intent.intentId, { terminal: false, providerState: 'merged', headOid: oid('1'), baseOid: oid('2'),
      mergeSha: oid('3'), mergeTreeMatches: true, mergeTree: oid('4'), mergeParents: [oid('2')] });
    const linked = path.join(root, 'linked.json'); fs.linkSync(path.join(root, `${intent.intentId}.json`), linked);
    expect(() => safety.inspectExactMergedLandingCheckpoint(root, { descriptor, mergeSha: oid('3'), mergeTree: oid('4'), mergeParents: [oid('2')] }))
      .toThrow('landing_intent_permissions_invalid');
    fs.unlinkSync(linked);
    const alias = `${root}-alias`; fs.symlinkSync(root, alias); roots.push(alias);
    expect(() => safety.inspectExactMergedLandingCheckpoint(alias, { descriptor, mergeSha: oid('3'), mergeTree: oid('4'), mergeParents: [oid('2')] }))
      .toThrow('landing_intent_permissions_invalid');
  });

  test('discovers the exact repository and PR when different repositories share a PR number', async () => {
    const safety=await loadSafety();expect(safety).not.toBeNull();if(!safety)return;
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ecpe-landing-repo-pr-'));roots.push(root);
    const first=safety.prepareLandingIntent(root,{repoId:'github.com/example/one',repositoryNodeId:'R_one',prNumber:17,expectedHeadOid:oid('1'),expectedBaseOid:oid('2'),targetRef:'origin/main',mode:'direct_observed',providerOperationId:'github.com:direct-pr:17'});
    const second=safety.prepareLandingIntent(root,{repoId:'github.com/example/two',repositoryNodeId:'R_two',prNumber:17,expectedHeadOid:oid('3'),expectedBaseOid:oid('4'),targetRef:'origin/main',mode:'direct_observed',providerOperationId:'github.com:direct-pr:17'});
    expect(safety.inspectLandingIntentForPr(root,{prNumber:17,repoId:'github.com/example/one',providerOperationId:'github.com:direct-pr:17'})).toEqual(first);
    expect(safety.inspectLandingIntentForPr(root,{prNumber:17,repoId:'github.com/example/two',providerOperationId:'github.com:direct-pr:17'})).toEqual(second);
    expect(safety.inspectLandingIntentForPr(root,{prNumber:17,repoId:'github.com/example/new-repo',providerOperationId:'github.com:direct-pr:17'})).toBeNull();
    const fresh=safety.prepareLandingIntent(root,{repoId:'github.com/example/new-repo',repositoryNodeId:'R_new',prNumber:17,expectedHeadOid:oid('5'),expectedBaseOid:oid('6'),targetRef:'origin/main',mode:'direct_observed',providerOperationId:'github.com:direct-pr:17'});
    expect(safety.inspectLandingIntentForPr(root,{prNumber:17,repoId:'github.com/example/new-repo',providerOperationId:'github.com:direct-pr:17'})).toEqual(fresh);
  });

  test('recovers a stale owner lock left by a killed process', async () => {
    const safety = await loadSafety();
    expect(safety).not.toBeNull();
    if (!safety) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-landing-stale-lock-')); roots.push(root);
    const intent = safety.prepareLandingIntent(root, {
      repoId: 'github.com/konghak/portfolioops', repositoryNodeId: 'R_123', prNumber: 17,
      expectedHeadOid: oid('1'), expectedBaseOid: oid('2'), targetRef: 'origin/main',
      mode: 'direct_observed', providerOperationId: 'operation-stale-lock',
    });
    fs.writeFileSync(path.join(root, `.${intent.intentId}.lock`), '99999999\n', { mode: 0o600 });
    expect(safety.reconcileLandingIntent(root, intent.intentId, {
      terminal: true, providerState: 'not_submitted', headOid: oid('1'), baseOid: oid('2'),
    })).toMatchObject({ status: 'abandoned_terminal' });
  });
});
