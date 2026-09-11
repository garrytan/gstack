import { afterAll, describe, expect, test } from 'bun:test';
import { evaluateCanaryPair } from '../lib/lane-canary';
import { appendEcpeBatch, appendTimelineBatch, readEcpeTimelineCandidates } from '../lib/ecpe-metrics';
import { startMilestoneBlock } from '../lib/milestone-block';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const roots:string[]=[];
afterAll(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})));
const git=(cwd:string,args:string[])=>{const result=spawnSync('/usr/bin/git',args,{ timeout: 30_000,cwd,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim()};

describe('ECPE shadow comparison', () => {
  test('unknown safety never counts as a qualified pair', () => {
    expect(evaluateCanaryPair({ legacy: { safety: 'pass', durationMs: 100 }, profile: { safety: 'unknown', durationMs: 80 } }).result).toBe('inconclusive');
    expect(evaluateCanaryPair({ legacy: { safety: 'pass', durationMs: 100 }, profile: { safety: 'pass', durationMs: 80 } }).result).toBe('qualified');
  });

  test('reserved producer derives and appends one exact terminal comparison',()=>{
    const root=mkdtempSync(join(tmpdir(),'shadow-producer-'));roots.push(root);
    const repo=join(root,'portfolio'),state=join(root,'state');mkdirSync(repo);mkdirSync(state,{mode:0o700});mkdirSync(join(root,'config'));mkdirSync(join(repo,'.gstack'));
    writeFileSync(join(repo,'.gstack/work-profile.yaml'),readFileSync(join(import.meta.dir,'fixtures/work-profile/shadow.yaml')));writeFileSync(join(repo,'README.md'),'x\n');
    git(repo,['init','-b','main']);git(repo,['config','user.name','T']);git(repo,['config','user.email','t@e']);git(repo,['add','.']);git(repo,['commit','-m','base']);git(repo,['remote','add','origin',repo]);git(repo,['update-ref','refs/remotes/origin/main','HEAD']);git(repo,['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main']);git(repo,['switch','-c','feature']);
    writeFileSync(join(root,'config/workspace-registry.toml'),`[registry]\nversion=2\n[[entry]]\nid="portfolioops"\npath="portfolio"\nkind="repository"\nremote_required=false\ntrusted_base_ref="refs/heads/main"\nactive=true\n`);
    const started=startMilestoneBlock({stateRoot:state,roots:{code_root_id:'code',workspace_root_id:'workspace',state_root_id:'state'},codeRootHead:git(repo,['rev-parse','HEAD']),registryHash:'a'.repeat(64),duration:'P30D',participants:['harness-governance','portfolioops','cdo-os'],lanes:['docs_ux','single_repo_code','cross_repo_contract']});
    const timeline=join(state,'projects','portfolioops','timeline.jsonl'),runId='run-shadow-1',timestamp='2026-09-01T00:00:00.000Z';
    appendEcpeBatch(timeline,[{schema_version:1,run_id:runId,timestamp,wtree:'portfolioops',work_kind:'change',finish_line:'local_change',kind:'decision',semantic_roles:['code'],capability_ids:['unit']}]);appendTimelineBatch(state,'portfolioops',[{skill:'ship',event:'completed',run_id:runId,ts:'2026-09-01T00:01:00.000Z'}]);
    const args=[join(import.meta.dir,'..','bin/gstack-ecpe-observe'),'shadow-comparison','--run-id',runId,'--block-id',started.block.block_id,'--lane','single_repo_code','--assert-target-ref','origin/main'];
    const env={...process.env,ECPE_TESTING:'1',ECPE_TEST_STATE_ROOT:state,GSTACK_HOME:state,GSTACK_PROJECT_SLUG:'portfolioops'};
    const first=spawnSync(process.execPath,args,{ timeout: 30_000,cwd:repo,encoding:'utf8',env});if(first.status!==0)throw new Error(first.stderr);
    expect(JSON.parse(first.stdout)).toMatchObject({block_id:started.block.block_id,lane:'single_repo_code',participant:'portfolioops',safety_outcomes:'complete'});
    const second=spawnSync(process.execPath,args,{ timeout: 30_000,cwd:repo,encoding:'utf8',env});if(second.status!==0)throw new Error(second.stderr);
    expect(readEcpeTimelineCandidates(state,[timeline],'portfolioops').observations.filter(item=>item.kind==='shadow_comparison')).toHaveLength(1);
  });
});
