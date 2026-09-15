import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  AssertionWitnessBinding, AssertionWitnessReceipt, Command, CsoError, MAX_OUTPUT,
  VerificationObservation, canonical, object, oneOf, sha256, string, validateCommand,
  validateVerificationObservation,
} from './contracts';
import { runProcess } from './process';

export interface WitnessTestExecution { command:Command; code:number; output:string; minimumPassingTests:number }
export interface WitnessedVerificationResult { observation:VerificationObservation; witness:AssertionWitnessReceipt }
export interface AssertionWitnessHandle {
  readonly binding:AssertionWitnessBinding;
  attest(observation:VerificationObservation,executions:WitnessTestExecution[]):Promise<AssertionWitnessReceipt>;
  validate(receipt:unknown,observation:VerificationObservation,now?:number):AssertionWitnessReceipt;
}

const HASH=/^[a-f0-9]{64}$/;
const PUBLIC_KEY=/^[a-f0-9]{88}$/;
const SIGNATURE=/^[a-f0-9]{128}$/;
const PROTOCOL='gstack-cso-assertion-witness-v1' as const;
const MAX_RECEIPT_AGE=300_000;
const exact=(value:Record<string,any>,allowed:readonly string[],name:string)=>{for(const key of Object.keys(value))if(!allowed.includes(key))throw new CsoError('INVALID_SCHEMA',`Unexpected ${name} field: ${key}`);};
const hash=(value:unknown,name:string):string=>{if(typeof value!=='string'||!HASH.test(value))throw new CsoError('INVALID_SCHEMA',`${name} must be a sha256 hash`);return value;};
const timestamp=(value:unknown,name:string):string=>{const result=string(value,name,64),ms=Date.parse(result);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==result)throw new CsoError('INVALID_SCHEMA',`${name} must be a canonical UTC timestamp`);return result;};

export function validateAssertionWitnessBinding(value:unknown):AssertionWitnessBinding{
  const v=object(value,'assertion witness binding'),runtime=object(v.runtime,'assertion witness runtime'),runner=object(v.runner,'assertion witness runner');
  exact(v,['schemaVersion','protocol','nonce','phase','issuedAt','expiresAt','runId','findingId','policyHash','auditPolicyHash','runtime','runner','sourceHash','dependencyHash','configurationHash','requestHash','patchHash','harnessHash','assertionHash','fixturesHash'],'assertion witness binding');
  exact(runtime,['image','verifierImage','platform','profile'],'assertion witness runtime');exact(runner,['testToolchain','startPlanHash','testPlanHash','commandsHash','minimumPassingTestsHash'],'assertion witness runner');
  if(v.schemaVersion!==1||v.protocol!==PROTOCOL)throw new CsoError('INVALID_SCHEMA','Unsupported assertion witness protocol');
  const issuedAt=timestamp(v.issuedAt,'assertion witness issuedAt'),expiresAt=timestamp(v.expiresAt,'assertion witness expiresAt'),duration=Date.parse(expiresAt)-Date.parse(issuedAt);
  if(duration<=0||duration>MAX_RECEIPT_AGE)throw new CsoError('INVALID_SCHEMA','Assertion witness lifetime exceeds the bounded attempt policy');
  if(typeof v.nonce!=='string'||!HASH.test(v.nonce))throw new CsoError('INVALID_SCHEMA','Assertion witness nonce must be 32 random bytes');
  const findingId=string(v.findingId,'assertion witness findingId',64);if(!/^[a-f0-9]{32}$/.test(findingId))throw new CsoError('INVALID_SCHEMA','Assertion witness findingId is invalid');
  return{schemaVersion:1,protocol:PROTOCOL,nonce:v.nonce,phase:oneOf(v.phase,['before','after'],'assertion witness phase'),issuedAt,expiresAt,runId:string(v.runId,'assertion witness runId',200),findingId,policyHash:hash(v.policyHash,'assertion witness policyHash'),auditPolicyHash:hash(v.auditPolicyHash,'assertion witness auditPolicyHash'),runtime:{image:string(runtime.image,'assertion witness runtime image',500),verifierImage:string(runtime.verifierImage,'assertion witness verifier image',500),platform:string(runtime.platform,'assertion witness runtime platform',100),profile:string(runtime.profile,'assertion witness runtime profile',100)},runner:{testToolchain:oneOf(runner.testToolchain,['runtime','project'],'assertion witness test toolchain'),startPlanHash:hash(runner.startPlanHash,'assertion witness start plan'),testPlanHash:hash(runner.testPlanHash,'assertion witness test plan'),commandsHash:hash(runner.commandsHash,'assertion witness commands'),minimumPassingTestsHash:hash(runner.minimumPassingTestsHash,'assertion witness execution floors')},sourceHash:hash(v.sourceHash,'assertion witness sourceHash'),dependencyHash:hash(v.dependencyHash,'assertion witness dependencyHash'),configurationHash:hash(v.configurationHash,'assertion witness configurationHash'),requestHash:hash(v.requestHash,'assertion witness requestHash'),patchHash:hash(v.patchHash,'assertion witness patchHash'),harnessHash:hash(v.harnessHash,'assertion witness harnessHash'),assertionHash:hash(v.assertionHash,'assertion witness assertionHash'),fixturesHash:hash(v.fixturesHash,'assertion witness fixturesHash')};
}

function receiptUnsigned(receipt:AssertionWitnessReceipt):Omit<AssertionWitnessReceipt,'signature'>{const {signature:_,...unsigned}=receipt;return unsigned;}
function observationForReceipt(observation:VerificationObservation,binding:AssertionWitnessBinding,diagnosticTestsPassed:boolean):VerificationObservation{
  const checked=validateVerificationObservation(observation);
  return{...checked,existingTests:diagnosticTestsPassed,inputHash:binding.harnessHash};
}
export function witnessObservationHash(observation:VerificationObservation):string{return sha256(canonical(validateVerificationObservation(observation)));}

export function validateStoredAssertionWitnessReceipt(value:unknown):AssertionWitnessReceipt{
  const v=object(value,'assertion witness receipt'),binding=validateAssertionWitnessBinding(v.binding);
  exact(v,['schemaVersion','binding','keyId','publicKey','observationHash','externalAssertionsPassed','diagnosticTestsPassed','executions','signature'],'assertion witness receipt');
  if(v.schemaVersion!==1||typeof v.keyId!=='string'||!HASH.test(v.keyId)||typeof v.publicKey!=='string'||!PUBLIC_KEY.test(v.publicKey)||typeof v.signature!=='string'||!SIGNATURE.test(v.signature))throw new CsoError('INVALID_SCHEMA','Assertion witness cryptographic metadata is invalid');
  if(sha256(Buffer.from(v.publicKey,'hex'))!==v.keyId)throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness key identity does not match its public key');
  if(typeof v.observationHash!=='string'||!HASH.test(v.observationHash)||typeof v.externalAssertionsPassed!=='boolean'||typeof v.diagnosticTestsPassed!=='boolean'||!Array.isArray(v.executions)||!v.executions.length||v.executions.length>100)throw new CsoError('INVALID_SCHEMA','Assertion witness outcomes are malformed');
  const executions=v.executions.map((raw:any,index:number)=>{const item=object(raw,`assertion witness execution ${index}`);exact(item,['commandHash','exitCode','outputHash','minimumPassingTests','executedTests','passingTests','reportedPassed'],`assertion witness execution ${index}`);if(!Number.isSafeInteger(item.exitCode)||item.exitCode<-1||item.exitCode>255||!Number.isSafeInteger(item.minimumPassingTests)||item.minimumPassingTests<1||!Number.isSafeInteger(item.executedTests)||item.executedTests<0||!Number.isSafeInteger(item.passingTests)||item.passingTests<0||item.passingTests>item.executedTests||typeof item.reportedPassed!=='boolean'||(item.reportedPassed&&item.passingTests<item.minimumPassingTests))throw new CsoError('INVALID_SCHEMA','Assertion witness execution outcome is malformed');return{commandHash:hash(item.commandHash,'assertion witness commandHash'),exitCode:item.exitCode,outputHash:hash(item.outputHash,'assertion witness outputHash'),minimumPassingTests:item.minimumPassingTests,executedTests:item.executedTests,passingTests:item.passingTests,reportedPassed:item.reportedPassed};});
  if(v.diagnosticTestsPassed!==executions.every(item=>item.reportedPassed))throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness diagnostic summary does not match its executions');
  const receipt:AssertionWitnessReceipt={schemaVersion:1,binding,keyId:v.keyId,publicKey:v.publicKey,observationHash:v.observationHash,externalAssertionsPassed:v.externalAssertionsPassed,diagnosticTestsPassed:v.diagnosticTestsPassed,executions,signature:v.signature};
  let valid=false;try{valid=verify(null,Buffer.from(canonical(receiptUnsigned(receipt))),createPublicKey({key:Buffer.from(receipt.publicKey,'hex'),format:'der',type:'spki'}),Buffer.from(receipt.signature,'hex'));}catch{}
  if(!valid)throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness signature is invalid');return receipt;
}

export function validateAssertionWitnessReceipt(value:unknown,expected:AssertionWitnessBinding,expectedPublicKey:string,observation:VerificationObservation,now=Date.now()):AssertionWitnessReceipt{
  const receipt=validateStoredAssertionWitnessReceipt(value),binding=validateAssertionWitnessBinding(expected);
  if(canonical(receipt.binding)!==canonical(binding)||receipt.publicKey!==expectedPublicKey)throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness receipt does not bind this verification challenge');
  if(now<Date.parse(binding.issuedAt)||now>Date.parse(binding.expiresAt))throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness receipt is stale');
  const normalized=observationForReceipt(observation,binding,receipt.diagnosticTestsPassed),external=normalized.booted&&normalized.legitimate&&normalized.security!=='inconclusive';
  if(receipt.observationHash!==witnessObservationHash(normalized)||receipt.externalAssertionsPassed!==external)throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness receipt does not bind the external verifier observation');
  return receipt;
}

export function assertionWitnessSemanticValue(receipt:AssertionWitnessReceipt):unknown{
  const checked=validateStoredAssertionWitnessReceipt(receipt),{nonce:_,issuedAt:__,expiresAt:___,...stable}=checked.binding;
  return{binding:stable,observationHash:checked.observationHash,externalAssertionsPassed:checked.externalAssertionsPassed,diagnosticTestsPassed:checked.diagnosticTestsPassed,executions:checked.executions};
}
export function assertionWitnessPairHash(pair:{before:AssertionWitnessReceipt;after:AssertionWitnessReceipt}):string{
  return sha256(canonical({before:assertionWitnessSemanticValue(pair.before),after:assertionWitnessSemanticValue(pair.after)}));
}

function witnessReplayValue(receipt:AssertionWitnessReceipt):unknown{
  const checked=validateStoredAssertionWitnessReceipt(receipt),{nonce:_,issuedAt:__,expiresAt:___,...binding}=checked.binding;
  return{binding,externalAssertionsPassed:checked.externalAssertionsPassed,diagnosticTestsPassed:checked.diagnosticTestsPassed,
    executions:checked.executions.map(({outputHash:_,...execution})=>execution)};
}
export function assertionWitnessReplayHash(pair:{before:AssertionWitnessReceipt;after:AssertionWitnessReceipt}):string{
  return sha256(canonical({before:witnessReplayValue(pair.before),after:witnessReplayValue(pair.after)}));
}

interface TestExecutionSummary {executedTests:number;passingTests:number;reportedPassed:boolean}
function testExecutionSummary(command:Command,code:number,output:string,minimumPassingTests=1):TestExecutionSummary{
  const failed={executedTests:0,passingTests:0,reportedPassed:false};
  if(!Number.isInteger(minimumPassingTests)||minimumPassingTests<1||code!==0||!output||output.includes('[sensitive process output redacted]'))return failed;
  const clean=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,''),args=command.args,name=basename(command.executable),json=()=>{const end=clean.lastIndexOf('}');if(end<0)return undefined;for(let start=clean.lastIndexOf('{',end);start>=0;start=clean.lastIndexOf('{',start-1)){try{const value=JSON.parse(clean.slice(start,end+1));if(value&&typeof value==='object')return value;}catch{}}};
  let executedTests=0,passingTests=0,valid=false;
  if(name==='node'&&args.includes('--test')&&args.includes('--test-reporter=tap')){const paths=args.filter(arg=>arg.startsWith('./')).map(arg=>arg.slice(2)),registered=[...clean.matchAll(/^# Subtest:\s+(.+?)\s*$/gm)].map(match=>match[1]),isPathWrapper=(label:string)=>paths.some(path=>label===path||label.endsWith(`/${path}`));executedTests=Number(clean.match(/^# tests\s+(\d+)\s*$/m)?.[1]);passingTests=Number(clean.match(/^# pass\s+(\d+)\s*$/m)?.[1]);valid=registered.some(label=>!isPathWrapper(label))&&!registered.some(isPathWrapper)&&executedTests>=passingTests&&/^# fail\s+0\s*$/m.test(clean)&&/^# cancelled\s+0\s*$/m.test(clean);}
  else if(name==='bun'&&args.includes('test')){passingTests=Number(clean.match(/^\s*(\d+)\s+pass(?:es)?\s*$/mi)?.[1]);executedTests=Number(clean.match(/\bRan\s+(\d+)\s+tests?\b/i)?.[1]);valid=executedTests>=passingTests&&/^\s*0\s+fail(?:ures?)?\s*$/mi.test(clean);}
  else if(name==='jest'&&args.includes('--json')){const value=json();passingTests=Number(value?.numPassedTests);executedTests=Number(value?.numTotalTests);valid=value?.success===true&&value?.numFailedTests===0&&value?.numRuntimeErrorTestSuites===0&&executedTests>=passingTests;}
  else if(name==='vitest'&&args.includes('--reporter=verbose')){const match=clean.match(/^\s*Tests\s+.*?(\d+)\s+passed.*?\((\d+)\)\s*$/mi);passingTests=Number(match?.[1]);executedTests=Number(match?.[2]);valid=executedTests>=passingTests&&!/\b\d+\s+failed\b/i.test(match?.[0]??'');}
  else if(name==='mocha'&&args.includes('json')){const stats=json()?.stats;passingTests=Number(stats?.passes);executedTests=Number(stats?.tests);valid=stats?.failures===0&&Number.isSafeInteger(stats?.pending)&&executedTests===passingTests+stats.pending;}
  else if(name==='ava'&&args.includes('--tap')){executedTests=Number(clean.match(/^# tests\s+(\d+)\s*$/m)?.[1]);passingTests=Number(clean.match(/^# pass\s+(\d+)\s*$/m)?.[1]);valid=executedTests>=passingTests&&/^# fail\s+0\s*$/m.test(clean);}
  else if(name==='python'&&args.some(arg=>arg.includes('import pytest;')&&arg.includes('pytest.main'))){passingTests=Number(clean.match(/(?:^|\s)(\d+)\s+passed\b/i)?.[1]);const skipped=Number(clean.match(/(?:^|\s)(\d+)\s+skipped\b/i)?.[1]??0);executedTests=passingTests+skipped;valid=true;}
  else if(name==='python'&&args.some(arg=>arg.includes('import os,sys,unittest;')&&arg.includes('unittest.main'))){executedTests=Number(clean.match(/\bRan\s+(\d+)\s+tests?\b/i)?.[1]);const skipped=Number(clean.match(/\bskipped=(\d+)\b/i)?.[1]??0);passingTests=executedTests-skipped;valid=Number.isSafeInteger(skipped);}
  else if(name==='bundle'&&args[0]==='exec'&&args[1]==='rspec'&&args.includes('json')){const summary=json()?.summary,pending=Number(summary?.pending_count??0);executedTests=Number(summary?.example_count);passingTests=executedTests-pending;valid=Number.isSafeInteger(pending)&&summary?.failure_count===0&&(summary?.errors_outside_of_examples_count??0)===0;}
  else if(name==='bundle'&&args[0]==='exec'&&args[1]==='rails'&&args[2]==='test'&&args.includes('--no-color')){const match=clean.match(/\b(\d+)\s+runs?\s*,\s*(\d+)\s+assertions?\s*,\s*0\s+failures?\s*,\s*0\s+errors?\s*,\s*(\d+)\s+skips?\b/i),skipped=Number(match?.[3]);executedTests=Number(match?.[1]);passingTests=executedTests-skipped;valid=Number.isSafeInteger(skipped);}
  const countsValid=Number.isSafeInteger(executedTests)&&executedTests>=0&&Number.isSafeInteger(passingTests)&&passingTests>=0&&executedTests>=passingTests;
  return countsValid?{executedTests,passingTests,reportedPassed:valid&&passingTests>=minimumPassingTests}:failed;
}
export function testExecutionPassed(command:Command,code:number,output:string,minimumPassingTests=1):boolean{
  return testExecutionSummary(command,code,output,minimumPassingTests).reportedPassed;
}

interface ChildRequest {privateKey:string;publicKey:string;binding:AssertionWitnessBinding;observation:VerificationObservation;executions:WitnessTestExecution[]}
async function readChildInput():Promise<string>{const chunks:Buffer[]=[];let bytes=0;for await(const value of process.stdin){const chunk=Buffer.from(value);bytes+=chunk.length;if(bytes>2*MAX_OUTPUT)throw new CsoError('INVALID_SCHEMA','Assertion witness request exceeds the bounded input limit');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
function createReceipt(input:unknown):AssertionWitnessReceipt{
  const v=object(input,'assertion witness child request');exact(v,['privateKey','publicKey','binding','observation','executions'],'assertion witness child request');const binding=validateAssertionWitnessBinding(v.binding);
  if(Date.now()<Date.parse(binding.issuedAt)||Date.now()>Date.parse(binding.expiresAt))throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness challenge is stale');
  if(typeof v.privateKey!=='string'||v.privateKey.length>4096||typeof v.publicKey!=='string'||!PUBLIC_KEY.test(v.publicKey))throw new CsoError('INVALID_SCHEMA','Assertion witness signing input is invalid');
  let privateKey;try{privateKey=createPrivateKey(v.privateKey);const derived=createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('hex');if(derived!==v.publicKey)throw new Error();}catch{throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness signing authority does not match the challenge');}
  const rawObservation=validateVerificationObservation(v.observation);if(!Array.isArray(v.executions)||!v.executions.length||v.executions.length>100)throw new CsoError('INVALID_SCHEMA','Assertion witness needs one or more canonical test executions');
  let outputBytes=0;const rawExecutions:WitnessTestExecution[]=v.executions.map((raw:any,index:number)=>{const item=object(raw,`witness execution ${index}`);exact(item,['command','code','output','minimumPassingTests'],`witness execution ${index}`);const command=validateCommand(item.command,`witness execution ${index}.command`);if(!Number.isSafeInteger(item.code)||item.code<-1||item.code>255||typeof item.output!=='string'||item.output.includes('\0')||!Number.isSafeInteger(item.minimumPassingTests)||item.minimumPassingTests<1)throw new CsoError('INVALID_SCHEMA','Assertion witness test execution is malformed');outputBytes+=Buffer.byteLength(item.output);if(outputBytes>MAX_OUTPUT)throw new CsoError('INVALID_SCHEMA','Assertion witness test output exceeds the group capture limit');return{command,code:item.code,output:item.output,minimumPassingTests:item.minimumPassingTests};});
  if(sha256(canonical(rawExecutions.map(item=>item.command)))!==binding.runner.commandsHash||sha256(canonical(rawExecutions.map(item=>item.minimumPassingTests)))!==binding.runner.minimumPassingTestsHash)throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness executions do not match the helper-derived runner');
  const executions=rawExecutions.map(item=>{const summary=testExecutionSummary(item.command,item.code,item.output,item.minimumPassingTests);return{commandHash:sha256(canonical(item.command)),exitCode:item.code,outputHash:sha256(item.output),minimumPassingTests:item.minimumPassingTests,...summary};}),diagnosticTestsPassed=executions.every(item=>item.reportedPassed),observation=observationForReceipt(rawObservation,binding,diagnosticTestsPassed),externalAssertionsPassed=observation.booted&&observation.legitimate&&observation.security!=='inconclusive';
  const unsigned:Omit<AssertionWitnessReceipt,'signature'>={schemaVersion:1,binding,keyId:sha256(Buffer.from(v.publicKey,'hex')),publicKey:v.publicKey,observationHash:witnessObservationHash(observation),externalAssertionsPassed,diagnosticTestsPassed,executions};
  return{...unsigned,signature:sign(null,Buffer.from(canonical(unsigned)),privateKey).toString('hex')};
}

export async function runAssertionWitnessChild():Promise<void>{const receipt=createReceipt(JSON.parse(await readChildInput()));process.stdout.write(JSON.stringify(receipt)+'\n');}

export class AssertionWitnessSession{
  private privateKey:string;readonly publicKey:string;readonly keyId:string;private nonces=new Set<string>();
  constructor(private workDirectory:string,private deadline:number){const stat=lstatSync(workDirectory),real=realpathSync(workDirectory),resolved=lstatSync(real);if(!stat.isDirectory()||stat.isSymbolicLink()||!resolved.isDirectory()||resolved.isSymbolicLink()||stat.dev!==resolved.dev||stat.ino!==resolved.ino||(process.getuid&&resolved.uid!==process.getuid())||(resolved.mode&0o022)!==0)throw new CsoError('UNSAFE_PATH','Assertion witness working directory must be private and owned');this.workDirectory=real;const pair=generateKeyPairSync('ed25519');this.privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();this.publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('hex');this.keyId=sha256(Buffer.from(this.publicKey,'hex'));}
  handle(stable:Omit<AssertionWitnessBinding,'schemaVersion'|'protocol'|'nonce'|'issuedAt'|'expiresAt'>):AssertionWitnessHandle{
    const now=Date.now(),expires=Math.min(this.deadline,now+MAX_RECEIPT_AGE);if(expires<=now)throw new CsoError('DEADLINE','No time remains for an authenticated assertion witness');let nonce='';do{nonce=randomBytes(32).toString('hex');}while(this.nonces.has(nonce));this.nonces.add(nonce);
    const binding=validateAssertionWitnessBinding({schemaVersion:1,protocol:PROTOCOL,nonce,issuedAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),...stable});let consumed=false;
    return{binding,attest:async(observation,executions)=>{if(consumed)throw new CsoError('INCOMPATIBLE_INPUT','Assertion witness challenge was already consumed');consumed=true;const input=JSON.stringify({privateKey:this.privateKey,publicKey:this.publicKey,binding,observation,executions} satisfies ChildRequest);if(Buffer.byteLength(input)>2*MAX_OUTPUT)throw new CsoError('REDACTION_FAILED','Assertion witness input exceeds the bounded helper channel');const bun=/^bun(?:\.exe)?$/i.test(basename(process.execPath)),file=bun?process.execPath:join(dirname(process.execPath),process.platform==='win32'?'gstack-cso-launcher.exe':'gstack-cso-launcher'),args=bun?[import.meta.path,'--child']:['__cso-assertion-witness'],env=process.platform==='win32'?{PATH:dirname(process.execPath),SYSTEMROOT:process.env.SYSTEMROOT??'C:\\Windows',WINDIR:process.env.WINDIR??'C:\\Windows'}:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC'},result=await runProcess(file,args,{cwd:this.workDirectory,env,timeoutMs:Math.max(1,expires-Date.now()),maxBytes:128*1024,input,raw:true});if(result.timedOut)throw new CsoError('DEADLINE','Assertion witness exceeded the verification deadline');if(result.truncated||result.code!==0)throw new CsoError('TOOL_FAILED','Authenticated assertion witness did not return a bounded receipt');let receipt:unknown;try{receipt=JSON.parse(result.stdout);}catch{throw new CsoError('TOOL_FAILED','Authenticated assertion witness returned invalid output');}return validateAssertionWitnessReceipt(receipt,binding,this.publicKey,observation);},validate:(receipt,observation,current=Date.now())=>validateAssertionWitnessReceipt(receipt,binding,this.publicKey,observation,current)};
  }
}

if(import.meta.main&&process.argv.at(-1)==='--child')runAssertionWitnessChild().catch(()=>{process.stderr.write('assertion witness failed\n');process.exitCode=1;});
