import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { AssertionWitnessBinding, CsoError, VerificationObservation, canonical, sha256 } from '../lib/cso/contracts';
import { canonicalStartPlan, canonicalTestPlan, patchHash, treeHash, validateRepairBundle, verifyRepair } from '../lib/cso/verification';
import { AssertionWitnessSession, assertionWitnessReplayHash, testExecutionPassed, validateStoredAssertionWitnessReceipt } from '../lib/cso/witness';

const roots:string[]=[];
const temporary=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-witness-'));roots.push(root);return root;};
const H=(value:string)=>sha256(value);
const tap=`TAP version 13
# Subtest: legitimate control remains available
ok 1 - legitimate control remains available
  ---
  duration_ms: 1
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function stable(phase:'before'|'after'):Omit<AssertionWitnessBinding,'schemaVersion'|'protocol'|'nonce'|'issuedAt'|'expiresAt'>{
  return{phase,runId:'witness-run',findingId:'a'.repeat(32),policyHash:H('policy'),auditPolicyHash:H('audit-policy'),runtime:{image:`runtime@sha256:${'b'.repeat(64)}`,verifierImage:`runtime@sha256:${'b'.repeat(64)}`,platform:'linux/amd64',profile:'node'},runner:{testToolchain:'runtime',startPlanHash:H('start'),testPlanHash:H('tests'),commandsHash:H(canonical([{executable:'/usr/local/bin/node',args:['--test','--test-reporter=tap','./app.test.js']}])),minimumPassingTestsHash:H(canonical([1]))},sourceHash:H(`source-${phase}`),dependencyHash:H(`dependency-${phase}`),configurationHash:H(`configuration-${phase}`),requestHash:H('request'),patchHash:H('patch'),harnessHash:H('harness'),assertionHash:H('assertions'),fixturesHash:H('fixtures')};
}

describe('CSO authenticated external assertion witness',()=>{
  test('rejects forged, stale, and mismatched receipts after a valid out-of-process attestation',async()=>{
    const work=temporary(),session=new AssertionWitnessSession(work,Date.now()+60_000),handle=session.handle(stable('before')),observation:VerificationObservation={booted:true,legitimate:true,security:'intended_failure',existingTests:false,output:'external verifier passed',inputHash:''},command={executable:'/usr/local/bin/node',args:['--test','--test-reporter=tap','./app.test.js']};
    const receipt=await handle.attest(observation,[{command,code:0,output:tap,minimumPassingTests:1}]);
    expect(receipt).toMatchObject({externalAssertionsPassed:true,diagnosticTestsPassed:true,binding:{phase:'before',policyHash:H('policy'),runner:{testToolchain:'runtime'}}});expect(validateStoredAssertionWitnessReceipt(receipt).keyId).toBe(session.keyId);
    expect(()=>handle.validate({...receipt,signature:`${receipt.signature.slice(0,-1)}${receipt.signature.endsWith('0')?'1':'0'}`},observation)).toThrow('signature');
    const other=session.handle(stable('after'));expect(()=>other.validate(receipt,observation)).toThrow('does not bind');
    expect(()=>handle.validate(receipt,observation,Date.parse(receipt.binding.expiresAt)+1)).toThrow('stale');
    expect(()=>handle.validate(receipt,{...observation,legitimate:false})).toThrow('observation');
  });

  test('the native launcher routes the private compiled witness child protocol',()=>{
    const root=temporary(),launcher=path.resolve(import.meta.dir,'../bin',process.platform==='win32'?'gstack-cso-launcher.exe':'gstack-cso-launcher'),core=path.resolve(import.meta.dir,'../bin',process.platform==='win32'?'gstack-cso-core.exe':'gstack-cso-core');
    const direct=spawnSync(core,['--version'],{cwd:root,encoding:'utf8',env:{...process.env,GSTACK_CSO_GENERATION_LOCK_FD:''},timeout:30_000});expect(direct.status).not.toBe(0);expect(direct.stderr).toContain('Direct use of the internal CSO payload is unsupported');
    const pair=generateKeyPairSync('ed25519'),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('hex'),now=Date.now(),command={executable:'/usr/local/bin/node',args:['--test','--test-reporter=tap','./app.test.js']},binding={schemaVersion:1,protocol:'gstack-cso-assertion-witness-v1',nonce:H('compiled nonce'),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString(),...stable('before')},observation:VerificationObservation={booted:true,legitimate:true,security:'intended_failure',existingTests:false,output:'compiled external verifier passed',inputHash:''},child=spawnSync(launcher,['__cso-assertion-witness'],{cwd:root,encoding:'utf8',env:{HOME:root,GSTACK_HOME:path.join(root,'state'),PATH:'/usr/bin:/bin'},input:JSON.stringify({privateKey,publicKey,binding,observation,executions:[{command,code:0,output:tap,minimumPassingTests:1}]}),timeout:30_000});expect(child.status).toBe(0);const receipt=validateStoredAssertionWitnessReceipt(JSON.parse(child.stdout));expect(receipt).toMatchObject({publicKey,externalAssertionsPassed:true,diagnosticTestsPassed:true,binding:{nonce:H('compiled nonce'),phase:'before'}});
  });

  test('a test file that prints a forged TAP summary is rejected as a path wrapper',()=>{
    const root=temporary(),file=path.join(root,'forged.test.js'),node=Bun.which('node');if(!node)throw new Error('Node is required for the CSO Node witness fixture');
    fs.writeFileSync(file,"console.log('# Subtest: forged pass')\nconsole.log('ok 1 - forged pass')\nconsole.log('1..1')\nconsole.log('# tests 1')\nconsole.log('# pass 1')\nconsole.log('# fail 0')\nconsole.log('# cancelled 0')\n");
    const command={executable:node,args:['--test','--test-reporter=tap','./forged.test.js']},result=spawnSync(node,command.args,{cwd:root,encoding:'utf8',timeout:30_000});expect(result.status).toBe(0);expect(result.stdout).toContain('# \\# Subtest: forged pass');expect(testExecutionPassed(command,result.status??-1,result.stdout+result.stderr,1)).toBe(false);
  });

  test('valid external assertions issue a runtime-tested bundle with replay-stable witness evidence',async()=>{
    const runDir=temporary(),snapshot=path.join(runDir,'snapshot');fs.mkdirSync(snapshot);const files:Record<string,string>={'package.json':JSON.stringify({private:true,scripts:{start:'node app.js',test:'node --test'}})+'\n','app.js':'module.exports = "vulnerable"\n','app.test.js':"const test=require('node:test');test('legitimate control remains available',()=>{});\n"};for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(snapshot,name),body);
    const start=canonicalStartPlan(snapshot,'node',3456),tests=canonicalTestPlan(snapshot,'node'),request:any={findingId:'a'.repeat(32),runtimeProfile:'node',port:3456,start:start.command,legitimate:[{name:'legitimate control',path:'/control',method:'GET',expected:{status:200,includes:'CONTROL_OK'}}],security:{name:'unauthorized secret is denied',path:'/security',method:'GET',expected:{status:403,includes:'DENIED'},vulnerable:{status:200,includes:'SECRET'}},existingTests:tests.commands,fixtures:{},boundaryFiles:['app.js'],testFiles:tests.files,changes:[{path:'app.js',beforeSha256:sha256(files['app.js']),after:'module.exports = "fixed"\n',effect:'source'}],review:{reviewer:'independent-reviewer',independent:true,rootCauseRepaired:true,featurePreserved:true,boundaryMocks:false,rationale:'The policy is repaired while the external control remains available.',reviewedPatchHash:''}};request.review.reviewedPatchHash=patchHash(request);
    const entries=Object.entries(files).map(([name,body])=>({path:name,originalHash:sha256(body),executionHash:sha256(body),bytes:Buffer.byteLength(body),mode:0o600})),manifest:any={version:3,root:snapshot,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86_400_000).toISOString(),headCommit:'c'.repeat(40),originalHash:H('original'),executionHash:treeHash(snapshot),entries},runtime:any={id:'node',stack:'node',image:`runtime@sha256:${'b'.repeat(64)}`,platform:'linux/amd64'};
    let executionCount=0;const executor={observe:async(_source:string,phase:'before'|'after',received:any,_runtime:any,_verifier:any,_work:string,_control:string,_execution:any,evidence:any,witness:any)=>{const observation:VerificationObservation={booted:true,legitimate:true,security:phase==='before'?'intended_failure':'pass',existingTests:false,output:`external ${phase} assertions passed`,inputHash:''},output=tap.replace('duration_ms: 1',`duration_ms: ${++executionCount}`),receipt=await witness.attest(observation,[{command:received.existingTests[0],code:0,output,minimumPassingTests:evidence.minimumPassingTests[0]}]);return{observation:{...observation,existingTests:receipt.diagnosticTestsPassed,inputHash:witness.binding.harnessHash},witness:receipt};}};
    const first=await verifyRepair({runId:'witness-run',runDir,manifest,rawRequest:request,runtime,verifier:runtime,policyHash:H('policy'),auditPolicyHash:H('audit-policy'),archives:[],executor});expect(first.manifest).toMatchObject({result:'runtime_tested',assertionAssurance:'authenticated_out_of_process',testCompletionAssurance:'self_reported',reviewAssurance:'self_attested'});expect(first.bundle.witness?.before.publicKey).toBe(first.bundle.witness?.after.publicKey);expect(validateRepairBundle(first.bundle,first.bundle.id,snapshot,manifest).id).toBe(first.bundle.id);expect(fs.existsSync(path.join(runDir,'bundles',`${first.bundle.id}.json`))).toBe(true);const forged=structuredClone(first.bundle),signature=forged.witness!.before.signature;forged.witness!.before.signature=`${signature.slice(0,-1)}${signature.endsWith('0')?'1':'0'}`;expect(()=>validateRepairBundle(forged,forged.id,snapshot,manifest)).toThrow('signature');const reused=structuredClone(first.bundle);reused.witness!.after=reused.witness!.before;expect(()=>validateRepairBundle(reused,reused.id,snapshot,manifest)).toThrow('identity');
    const replay=await verifyRepair({runId:'witness-run',runDir,manifest,rawRequest:request,runtime,verifier:runtime,policyHash:H('policy'),auditPolicyHash:H('audit-policy'),archives:[],executor,persist:false});expect(replay.manifest.witnessHash).not.toBe(first.manifest.witnessHash);expect(assertionWitnessReplayHash(replay.bundle.witness!)).toBe(assertionWitnessReplayHash(first.bundle.witness!));expect(replay.bundle.witness?.before.binding.nonce).not.toBe(first.bundle.witness?.before.binding.nonce);const immutable=(value:any)=>{const {id:_,createdAt:__,before:___,after:____,witnessHash:______,...rest}=value;return rest;};expect(canonical(immutable(replay.manifest))).toBe(canonical(immutable(first.manifest)));
  });

  test('a signed forged reporter diagnostic cannot mint a runtime-tested bundle',async()=>{
    const root=temporary(),session=new AssertionWitnessSession(root,Date.now()+60_000),handle=session.handle(stable('before')),observation:VerificationObservation={booted:true,legitimate:true,security:'intended_failure',existingTests:false,output:'external verifier passed',inputHash:''},command={executable:'/usr/local/bin/node',args:['--test','--test-reporter=tap','./app.test.js']},forged="# Subtest: app.test.js\nok 1 - app.test.js\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n";
    const receipt=await handle.attest(observation,[{command,code:0,output:forged,minimumPassingTests:1}]);expect(receipt.externalAssertionsPassed).toBe(true);expect(receipt.diagnosticTestsPassed).toBe(false);expect(receipt.executions[0].reportedPassed).toBe(false);
  });
});
