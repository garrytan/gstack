import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectMilestoneLandingProjection, readMilestoneBlock, startMilestoneBlock, stopMilestoneBlock } from '../lib/milestone-block';
import { inspectLandingIntent } from '../lib/landing-safety';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], { timeout: 30_000, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function sha256(file: string): string {
  return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture(options: { responseLoss?: boolean; barrierSize?: number; remoteDrift?: boolean; prePutMutation?: 'head' | 'base' | 'head_repo' | 'head_ref'; extraMergeParent?: boolean; liveTargetMoved?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-provider-race-')));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:Example/PortfolioOps.git');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  git(repo, 'add', 'value.txt');
  git(repo, 'commit', '-qm', 'base');
  const baseOid = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'head\n');
  git(repo, 'commit', '-qam', 'head');
  const headOid = git(repo, 'rev-parse', 'HEAD');
  const headTree = git(repo, 'rev-parse', `${headOid}^{tree}`);
  const mergeSha = '3'.repeat(40);
  const putLog = path.join(root, 'put.log');
  const merged = path.join(root, 'merged');
  const barrier = path.join(root, 'barrier');
  const queryLog = path.join(root, 'query.log');
  fs.mkdirSync(barrier);

  const gh = path.join(root, 'gh');
  fs.writeFileSync(gh, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const args = process.argv.slice(2);
const root = ${JSON.stringify(root)};
const barrier = ${JSON.stringify(barrier)};
const merged = ${JSON.stringify(merged)};
const putLog = ${JSON.stringify(putLog)};
const baseOid = ${JSON.stringify(baseOid)};
const headOid = ${JSON.stringify(headOid)};
const headTree = ${JSON.stringify(headTree)};
const mergeSha = ${JSON.stringify(mergeSha)};
const responseLoss = ${JSON.stringify(options.responseLoss ?? false)};
const barrierSize = ${JSON.stringify(options.barrierSize ?? 2)};
const remoteDrift = ${JSON.stringify(options.remoteDrift ?? false)};
const prePutMutation = ${JSON.stringify(options.prePutMutation ?? null)};
const extraMergeParent = ${JSON.stringify(options.extraMergeParent ?? false)};
const liveTargetMoved = ${JSON.stringify(options.liveTargetMoved ?? false)};
if (args[0] === '--version') { console.log('gh version fixture'); process.exit(0); }
if (args.includes('graphql')) {
  fs.appendFileSync(${JSON.stringify(queryLog)}, 'QUERY\n');
  const queryNumber = fs.readFileSync(${JSON.stringify(queryLog)}, 'utf8').trim().split('\n').length;
  const owner = args.find((arg) => arg.startsWith('owner='))?.slice('owner='.length) ?? 'Example';
  const name = args.find((arg) => arg.startsWith('name='))?.slice('name='.length) ?? 'PortfolioOps';
  const driftMarker = path.join(root, 'remote-drifted');
  if (remoteDrift && !fs.existsSync(driftMarker)) {
    fs.writeFileSync(driftMarker, 'yes');
    Bun.spawnSync(['/usr/bin/git','remote','set-url','origin','git@github.com:Other/PortfolioOps.git'],{ timeout: 30_000,cwd:${JSON.stringify(repo)}});
  }
  const isMerged = fs.existsSync(merged);
  if (!isMerged) {
    const prior = fs.readdirSync(barrier).filter((name) => name.startsWith(String(process.ppid) + '-')).length;
    const round = prior + 1;
    fs.writeFileSync(path.join(barrier, String(process.ppid) + '-' + String(round)), 'arrived');
    const deadline = Date.now() + 600;
    while (fs.readdirSync(barrier).length < round * barrierSize && Date.now() < deadline) await Bun.sleep(10);
  }
  const state = isMerged ? 'MERGED' : 'OPEN';
  const observedBase = !isMerged && queryNumber >= 2 && prePutMutation === 'base' ? '8'.repeat(40) : baseOid;
  const observedHead = !isMerged && queryNumber >= 2 && prePutMutation === 'head' ? '9'.repeat(40) : headOid;
  const observedHeadRef = !isMerged && queryNumber >= 2 && prePutMutation === 'head_ref' ? 'replacement' : 'feature';
  const observedHeadRepositoryId = !isMerged && queryNumber >= 2 && prePutMutation === 'head_repo' ? 'R_foreign' : 'R_fixture';
  console.log(JSON.stringify({data:{repository:{
    id:'R_fixture',nameWithOwner:owner + '/' + name,viewerPermission:'ADMIN',
    pullRequest:{number:17,state,baseRefName:'main',baseRefOid:observedBase,
      headRefName:observedHeadRef,headRefOid:observedHead,headRepository:{id:observedHeadRepositoryId,nameWithOwner:owner + '/' + name},mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',
      mergeCommit:state === 'MERGED' ? {oid:mergeSha} : null,autoMergeRequest:null,mergeQueueEntry:null}
  }}}));
  process.exit(0);
}
if (args.includes('--method') && args.includes('PUT')) {
  fs.appendFileSync(putLog, 'PUT\\n');
  fs.writeFileSync(merged, mergeSha);
  if (responseLoss) { process.kill(process.ppid, 'SIGKILL'); await Bun.sleep(50); process.exit(0); }
  await Bun.sleep(150);
  console.log(JSON.stringify({merged:true,sha:mergeSha,message:'merged'}));
  process.exit(0);
}
if (args.some((arg) => arg.includes('/git/commits/'))) {
  console.log(JSON.stringify({sha:mergeSha,tree:{sha:headTree},parents:[{sha:baseOid},...(extraMergeParent?[{sha:'7'.repeat(40)}]:[])]}));
  process.exit(0);
}
if (args.some((arg) => arg.includes('/git/ref/heads/'))) {
  console.log(JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:liveTargetMoved?'6'.repeat(40):mergeSha}}));
  process.exit(0);
}
console.error('unsupported gh invocation', args.join(' '));
process.exit(2);
`);
  fs.chmodSync(gh, 0o700);

  const gitPath = fs.realpathSync('/usr/bin/git');
  const gitInfo = fs.statSync(gitPath);
  const ghInfo = fs.statSync(gh);
  const manifest = path.join(root, 'runtime.json');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 'ecpe.gstack-runtime.v1',
    tools: {
      git: { realpath: gitPath, owner_uid: gitInfo.uid, mode: gitInfo.mode & 0o777, sha256: sha256(gitPath), version: git(repo, '--version') },
      gh: { realpath: gh, owner_uid: ghInfo.uid, mode: ghInfo.mode & 0o777, sha256: sha256(gh), version: 'gh version fixture' },
    },
  }), { mode: 0o600 });

  const driver = path.join(root, 'driver.ts');
  const providerUrl = new URL('../lib/provider-access.ts', import.meta.url).href;
  const milestoneUrl = new URL('../lib/milestone-block.ts', import.meta.url).href;
  fs.writeFileSync(driver, `import * as provider from ${JSON.stringify(providerUrl)};\nimport * as milestone from ${JSON.stringify(milestoneUrl)};\nconst expected = ${JSON.stringify({ prNumber: 17, expectedHeadOid: headOid, expectedBaseOid: baseOid, expectedTargetRef: 'origin/main', expectedRepositoryNodeId: 'R_fixture' })};\ntry { const command = process.argv[2] ?? 'direct'; let result; if(command==='block-direct'||command==='block-reconcile'){const resolved=await provider.resolveDirectMergeLandingIntent(process.cwd(),expected);const landing={kind:'ordinary',participant:'portfolioops',repositoryNodeId:expected.expectedRepositoryNodeId,prNumber:expected.prNumber,expectedHeadOid:expected.expectedHeadOid,expectedBaseOid:expected.expectedBaseOid,targetRef:expected.expectedTargetRef,subjectTree:${JSON.stringify(headTree)},rawProviderIntentId:resolved.intentId,shipReceiptId:null,lanes:['single_repo_code']};result=await milestone.withMilestoneLandingJournal({stateRoot:process.argv[3],assertedBlockId:process.argv[4],landing,reconcileOnly:command==='block-reconcile'},()=>command==='block-reconcile'?provider.reconcileDirectMergeProviderHead(process.cwd(),expected):provider.directMergeProviderHead(process.cwd(),expected));}else if(command==='merged-snapshot'){result=await provider.snapshotMergedProviderLanding(process.cwd(),{...expected,expectedHeadRepositoryNodeId:'R_fixture',expectedHeadRefName:'feature',expectedHeadTree:${JSON.stringify(headTree)},mergeSha:${JSON.stringify(mergeSha)}});}else result = command === 'discover' ? await provider.discoverDirectMergeProviderHead(process.cwd(), 17) : command === 'reconcile' ? await provider.reconcileDirectMergeProviderHead(process.cwd(), expected) : await provider.directMergeProviderHead(process.cwd(), expected); console.log(JSON.stringify(result)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }\n`);
  return { root, repo, manifest, putLog, baseOid, headOid, headTree };
}

async function output(child: ReturnType<typeof Bun.spawn>) {
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { exitCode: await child.exited, stdout, stderr };
}

describe('direct provider merge crash recovery', () => {
  test('serializes two processes across the provider mutation boundary', async () => {
    const f = fixture();
    const env = {
      PATH: '/usr/bin:/bin',
      ECPE_TESTING: '1',
      ECPE_TEST_RUNTIME_MANIFEST: f.manifest,
      GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority'),
    };
    const first = Bun.spawn([process.execPath, path.join(f.root, 'driver.ts')], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' });
    const second = Bun.spawn([process.execPath, path.join(f.root, 'driver.ts')], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' });
    const results = await Promise.all([output(first), output(second)]);

    const successful=results.filter((result) => result.exitCode === 0);
    expect(successful.length).toBeGreaterThanOrEqual(1);
    for(const result of successful)expect(JSON.parse(result.stdout)).toMatchObject({status:'merged',baseAtomicity:'verified'});
    for (const result of results.filter((candidate) => candidate.exitCode !== 0)) {
      expect(result.stderr).toContain('provider_landing_owner_busy');
    }
    expect(new Set(fs.readdirSync(path.join(f.root,'barrier')).map(name=>name.split('-')[0])).size).toBe(1);
    expect(fs.readFileSync(f.putLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('refuses legacy response-loss recovery without a protected ShipReceipt and never repeats PUT', async () => {
    const f = fixture({ responseLoss: true, barrierSize: 1 });
    const stateRoot=path.join(f.root,'state');fs.mkdirSync(stateRoot,{mode:0o700});
    const env = {
      PATH: '/usr/bin:/bin',
      ECPE_TESTING: '1',
      ECPE_TEST_RUNTIME_MANIFEST: f.manifest,
      ECPE_TEST_STATE_ROOT:stateRoot,
      GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority'),
    };
    const direct = await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'direct'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(direct.exitCode).toBe(137);
    expect(fs.readFileSync(f.putLog, 'utf8').trim().split('\n')).toHaveLength(1);

    const effectScope=path.join(import.meta.dir,'..','scripts','authority','effect-scope.ts');
    const recovered = await output(Bun.spawn([process.execPath,effectScope,'provider-merge','discover','--skill','land-and-deploy','--pr','17'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(recovered.exitCode).toBe(1);
    expect(recovered.stderr).toContain('ship_receipt_invalid');
    const reused = await output(Bun.spawn([process.execPath,effectScope,'provider-merge','discover','--skill','land-and-deploy','--pr','17'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(reused.exitCode).toBe(1);
    expect(reused.stderr).toContain('ship_receipt_invalid');
    expect(fs.readFileSync(f.putLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('fresh discovery refuses to checkpoint a legacy outer journal without a protected ShipReceipt', async () => {
    const f = fixture({ responseLoss: true, barrierSize: 1 });
    const stateRoot=path.join(f.root,'state');fs.mkdirSync(stateRoot,{mode:0o700});
    const roots={code_root_id:'repo-code',workspace_root_id:'workspace-root',state_root_id:'state-root'};
    const started=startMilestoneBlock({stateRoot,roots,codeRootHead:f.headOid,registryHash:'a'.repeat(64),duration:'P30D',participants:['harness-governance','portfolioops','cdo-os'],lanes:['docs_ux','single_repo_code','cross_repo_contract']});
    const blockId=started.block.block_id;
    const env={PATH:'/usr/bin:/bin',ECPE_TESTING:'1',ECPE_TEST_RUNTIME_MANIFEST:f.manifest,ECPE_TEST_STATE_ROOT:stateRoot,GSTACK_AUTHORITY_ROOT:path.join(f.root,'authority')};
    const killed=await output(Bun.spawn([process.execPath,path.join(f.root,'driver.ts'),'block-direct',stateRoot,blockId],{cwd:f.repo,env,stdout:'pipe',stderr:'pipe'}));
    expect(killed.exitCode).toBe(137);
    expect(fs.readFileSync(f.putLog,'utf8').trim().split('\n')).toHaveLength(1);
    const prepared=readMilestoneBlock(stateRoot,blockId);
    expect(prepared.landings).toHaveLength(1);
    expect(prepared.landings?.[0]).toMatchObject({phase:'prepared',kind:'ordinary',subject_tree:f.headTree});
    expect(inspectLandingIntent(path.join(f.root,'authority'),prepared.landings![0].raw_provider_intent_id).phase).toBe('prepared');
    expect(()=>stopMilestoneBlock({stateRoot,roots,blockId,reason:'aborted'})).toThrow('milestone_landing_reconciliation_required');
    fs.writeFileSync(path.join(f.repo,'after-merge.txt'),'checkout moved after provider acceptance\n');
    git(f.repo,'add','after-merge.txt');git(f.repo,'commit','-qm','move local checkout after accepted merge');
    expect(git(f.repo,'rev-parse','HEAD^{tree}')).not.toBe(f.headTree);

    const effectScope=path.join(import.meta.dir,'..','scripts','authority','effect-scope.ts');
    const recovered=await output(Bun.spawn([process.execPath,effectScope,'provider-merge','discover','--skill','land-and-deploy','--pr','17'],{cwd:f.repo,env,stdout:'pipe',stderr:'pipe'}));
    expect(recovered.exitCode).toBe(1);
    expect(recovered.stderr).toContain('ship_receipt_invalid');
    expect(readMilestoneBlock(stateRoot,blockId).landings?.[0].phase).toBe('prepared');
    expect(fs.readFileSync(f.putLog,'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('fails closed before PUT when origin moves after the frozen descriptor', async () => {
    const f = fixture({ remoteDrift: true, barrierSize: 1 });
    const env = { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: f.manifest, GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority') };
    const result = await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'direct'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('provider_remote_moved');
    expect(fs.existsSync(f.putLog)).toBeFalse();
  });

  for (const mutation of ['head', 'base', 'head_repo', 'head_ref'] as const) {
    test(`fails closed before PUT when the second provider snapshot moves ${mutation}`, async () => {
      const f = fixture({ prePutMutation: mutation, barrierSize: 1 });
      const env = { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: f.manifest, GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority') };
      const result = await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'direct'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/provider_(head|base|head_repository|head_ref)_moved/);
      expect(fs.existsSync(f.putLog)).toBeFalse();
    });
  }

  test('rejects a merge commit with more than the frozen base parent', async () => {
    const f = fixture({ extraMergeParent: true, barrierSize: 1 });
    const env = { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: f.manifest, GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority') };
    const result = await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'direct'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('provider_merge_commit_invalid');
    expect(fs.readFileSync(f.putLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('freshly verifies the merged PR, exact merge tree, and live target', async () => {
    const f = fixture({ barrierSize: 1 });
    const env = { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: f.manifest, GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority') };
    expect((await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'direct'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }))).exitCode).toBe(0);
    const inspected = await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'merged-snapshot'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      providerState: 'MERGED', repositoryNodeId: 'R_fixture', headRepositoryNodeId: 'R_fixture',
      expectedHeadOid: f.headOid, expectedBaseOid: f.baseOid, mergeSha: '3'.repeat(40),
      mergeTree: f.headTree, liveTargetOid: '3'.repeat(40), baseParentVerified: true,
      headTreeVerified: true, liveTargetVerified: true,
    });
  });

  test('rejects a stale checkpoint when the live target has advanced', async () => {
    const f = fixture({ barrierSize: 1, liveTargetMoved: true });
    const env = { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: f.manifest, GSTACK_AUTHORITY_ROOT: path.join(f.root, 'authority') };
    expect((await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'direct'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }))).exitCode).toBe(0);
    const inspected = await output(Bun.spawn([process.execPath, path.join(f.root, 'driver.ts'), 'merged-snapshot'], { cwd: f.repo, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(inspected.exitCode).toBe(1);
    expect(inspected.stderr).toContain('provider_merged_target_moved');
  });
});
