import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectPrivatePilotWorkspace } from './private-pilot-workspace';
import { inspectSafetyLatch, readMilestoneBlock } from './milestone-block';
import { createSafetySourceSeal, inspectSafetySourceSeal, SAFETY_SOURCE_REGISTRY_HASH, type SafetySourceSeal } from './safety-source-registry';
import { durableAtomicWrite } from './durable-atomic-write';

const digest=(value:unknown)=>new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
function location(stateRoot:string,latchId:string):string{if(!/^latch-[0-9a-f]{32}$/.test(latchId))throw new Error('safety_source_latch_invalid');return path.join(path.resolve(stateRoot),'ecpe','safety-source-seals',`${latchId}.json`)}
function write(target:string,value:SafetySourceSeal):void{durableAtomicWrite(target,JSON.stringify(value)+'\n')}
function read(stateRoot:string,latchId:string):SafetySourceSeal{let value:SafetySourceSeal;try{const target=location(stateRoot,latchId);const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('safety_source_invalid');value=JSON.parse(fs.readFileSync(target,'utf8'))}catch(error){if(error instanceof Error&&error.message==='safety_source_invalid')throw error;throw new Error('safety_source_missing')}return value}

export function sealSafetyDowngradeSource(input:{stateRoot:string;blockId:string;participant:'portfolioops';lane:'docs_ux'|'single_repo_code'|'cross_repo_contract';latchId:string}){
  const block=readMilestoneBlock(input.stateRoot,input.blockId);if(block.stop_receipt_id===null||!['terminal_unreported','closing_final','recording_pending','partial_closed'].includes(block.phase))throw new Error('safety_source_block_invalid');
  const latch=inspectSafetyLatch({stateRoot:input.stateRoot,participant:input.participant,lane:input.lane});if(latch.result!=='latched'||latch.latch_id!==input.latchId||latch.source_block_id!==input.blockId)throw new Error('safety_source_latch_mismatch');
  const workspace=inspectPrivatePilotWorkspace({stateRoot:input.stateRoot,purpose:'ecpe-v3-pilot',key:`${input.blockId}\0${input.participant}`});if(workspace.phase!=='terminal'||workspace.cleaned)throw new Error('safety_source_workspace_not_terminal');
  const cleanupManifestHash=digest({handle:workspace.handle,head:workspace.head,tree:workspace.tree,phase:workspace.phase,cleaned:workspace.cleaned});
  const seal=createSafetySourceSeal({blockId:input.blockId,participant:input.participant,lane:input.lane,latchId:input.latchId,registryHash:SAFETY_SOURCE_REGISTRY_HASH,subjectHead:workspace.head,subjectTree:workspace.tree,profileHash:latch.profile_lineage_hash!,terminalReceiptId:block.stop_receipt_id,cleanupManifestHash});const target=location(input.stateRoot,input.latchId);
  if(fs.existsSync(target)){const existing=read(input.stateRoot,input.latchId);if(JSON.stringify(existing)!==JSON.stringify(seal))throw new Error('safety_source_conflict');return{result:'reused',...existing}}
  write(target,seal);return{result:'sealed',...seal};
}

export function inspectSafetyDowngradeSource(input:{stateRoot:string;participant:'portfolioops';lane:'docs_ux'|'single_repo_code'|'cross_repo_contract';latchId:string}){return{result:'sealed',...inspectSafetySourceSeal(read(input.stateRoot,input.latchId),{participant:input.participant,lane:input.lane,latchId:input.latchId})}}
