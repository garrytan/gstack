import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical, sha256, type VerificationObservation } from '../lib/cso/contracts';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { saveReport, withLock } from '../lib/cso/state';
import { canonicalStartPlan, canonicalTestPlan, patchHash, verifyRepair } from '../lib/cso/verification';

const ROOT=path.resolve(import.meta.dir,'..'),launcher=path.join(ROOT,'bin',process.platform==='win32'?'gstack-cso-launcher.exe':'gstack-cso-launcher');
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
let root='',repo='',state='';

function command(args:string[]){return spawnSync(launcher,args,{cwd:repo,encoding:'utf8',env:{HOME:root,GSTACK_HOME:state,PATH:'/usr/bin:/bin'},timeout:30_000});}
function git(...args:string[]){const result=spawnSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8',env:{HOME:root,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.status)throw new Error(result.stderr);return result.stdout;}
function runDir(run:any){return path.join(state,'security','cso',run.repoId,run.runId);}
function writeInput(name:string,value:unknown){const file=path.join(root,name);fs.writeFileSync(file,JSON.stringify(value));return file;}

beforeEach(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-cli-lifecycle-'));repo=path.join(root,'repo');state=path.join(root,'state');fs.mkdirSync(repo);
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({name:'cso-cli-lifecycle',version:'1.0.0',private:true,scripts:{start:'node app.js',test:'node --test'}})+'\n');
  fs.writeFileSync(path.join(repo,'package-lock.json'),JSON.stringify({name:'cso-cli-lifecycle',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'cso-cli-lifecycle',version:'1.0.0'}}})+'\n');
  fs.writeFileSync(path.join(repo,'app.js'),'module.exports = "vulnerable"\n');
  fs.writeFileSync(path.join(repo,'app.test.js'),"const test=require('node:test');test('legitimate control remains available',()=>{});\n");
  git('add','.');git('commit','-qm','fixture');
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));

describe('CSO interrupted-run and replay commands',()=>{
  test('resume reports watchdog recovery without replenishing the original policy or deadline',()=>{
    const run=JSON.parse(command(['start','--repo',repo,'--scope','auth','--offline','--budget','120']).stdout),dir=runDir(run),reportPath=path.join(dir,'report.json'),original=JSON.parse(fs.readFileSync(reportPath,'utf8'));
    const recovery='supervisor-death execution-copy cleanup complete',dockerRecovery='deadline cleanup complete',control=path.join(dir,'supervision','repair-attempt'),preparationControl=path.join(dir,'preparation-execution','offline-attempt');fs.mkdirSync(control,{recursive:true});fs.mkdirSync(preparationControl,{recursive:true});fs.writeFileSync(path.join(control,'attempt.event'),`${recovery}\n`);fs.writeFileSync(path.join(preparationControl,'watchdog.event'),`${dockerRecovery}\n`);
    original.status='interrupted';saveReport(dir,original);

    const resumed=command(['resume',run.runId]);expect(resumed.status).toBe(0);const result=JSON.parse(resumed.stdout),active=JSON.parse(fs.readFileSync(reportPath,'utf8'));
    expect(result).toMatchObject({runId:run.runId,deadline:original.deadline,policy:original.policy,recovery:[recovery,dockerRecovery]});expect(active.status).toBe('running');expect(active.deadline).toBe(original.deadline);expect(active.policy).toEqual(original.policy);
    expect(active.events.filter((item:any)=>item.kind==='watchdog-recovery'&&[recovery,dockerRecovery].includes(item.message))).toHaveLength(2);expect(active.events.at(-1)).toMatchObject({kind:'resume',message:'Continued retained snapshot under original policy'});

    active.status='interrupted';active.deadline=new Date(Date.now()-1_000).toISOString();const exhaustedDeadline=active.deadline;saveReport(dir,active);
    const expired=command(['resume',run.runId]);expect(expired.status).not.toBe(0);expect(expired.stderr).toContain('DEADLINE');expect(expired.stderr).toContain('Original run budget is exhausted');
    const retained=JSON.parse(fs.readFileSync(reportPath,'utf8'));expect(retained.status).toBe('interrupted');expect(retained.deadline).toBe(exhaustedDeadline);expect(retained.policy).toEqual(original.policy);expect(retained.events.at(-1)).toMatchObject({kind:'deadline',message:'Original budget is exhausted; resume did not replenish it'});
    expect(retained.events.filter((item:any)=>item.kind==='watchdog-recovery'&&[recovery,dockerRecovery].includes(item.message))).toHaveLength(2);
  });

  test.skipIf(process.platform==='win32')('replay accepts retained or exactly matching supplied source and rejects expired or changed inputs before Docker admission',async()=>{
    const started=command(['start','--repo',repo,'--comprehensive','--offline']);expect(started.status).toBe(0);const run=JSON.parse(started.stdout),dir=runDir(run),snapshot=path.join(dir,'snapshot'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'snapshot.json'),'utf8'));
    const finding={title:'Unprotected record read',rootCause:'Record lookup omits the caller authorization predicate',location:{path:'app.js',line:1,symbol:'recordLookup'},advisoryIds:[],severity:'high',confidence:'high',confidenceRationale:'The caller-to-record trace directly establishes the missing authorization predicate',evidence:'supported',attackerControl:'Authenticated caller chooses the record identifier',impact:'Another tenant record is returned',scenario:'A tenant supplies another tenant record identifier and receives the record',trace:['GET /records/:id','recordLookup','record response'],references:['app.js:1','OWASP API1:2023'],recommendation:'Bind the lookup to the authenticated caller before returning the record',challenge:{reviewer:'independent-reviewer',independent:true,mode:'independent_agent',callers:'Authenticated route forwards the record identifier',controls:'Authentication exists without record authorization',counterevidence:'Opaque identifiers reduce guessing but do not authorize known identifiers',conclusion:'The record lookup lacks a caller authorization predicate'}};
    expect(command(['submit',run.runId,writeInput('replay-finding.json',{findings:[finding]})]).status).toBe(0);const reportPath=path.join(dir,'report.json'),report=JSON.parse(fs.readFileSync(reportPath,'utf8')),findingId=report.findings[0].id,start=canonicalStartPlan(snapshot,'node',3456),tests=canonicalTestPlan(snapshot,'node');
    const request:any={findingId,runtimeProfile:`node-24.4.0-${process.arch==='arm64'?'arm64':'amd64'}`,port:3456,start:start.command,legitimate:[{name:'legitimate control',path:'/control',method:'GET',expected:{status:200,includes:'CONTROL_OK'}}],security:{name:'unauthorized record is denied',path:'/records/other',method:'GET',expected:{status:403,includes:'DENIED'},vulnerable:{status:200,includes:'RECORD'}},existingTests:tests.commands,fixtures:{},boundaryFiles:['app.js'],testFiles:tests.files,changes:[{path:'app.js',beforeSha256:sha256(fs.readFileSync(path.join(snapshot,'app.js'))),after:'module.exports = "fixed"\n',effect:'source'}],review:{reviewer:'independent-reviewer',independent:true,rootCauseRepaired:true,featurePreserved:true,boundaryMocks:false,rationale:'The caller predicate is added while the legitimate control and existing test remain unchanged.',reviewedPatchHash:''}};request.review.reviewedPatchHash=patchHash(request);
    const platform=process.arch==='arm64'?'linux/arm64':'linux/amd64',runtime:any={id:request.runtimeProfile,stack:'node',platform,image:`ghcr.io/garrytan/gstack/cso-staging/node-${process.arch==='arm64'?'arm64':'amd64'}@sha256:${'b'.repeat(64)}`},executor={observe:async(_source:string,phase:'before'|'after',received:any,_runtime:any,_verifier:any,_work:string,_control:string,_execution:any,evidence:any,witness:any)=>{const observation:VerificationObservation={booted:true,legitimate:true,security:phase==='before'?'intended_failure':'pass',existingTests:false,output:`external ${phase} assertions passed`,inputHash:''},receipt=await witness.attest(observation,[{command:received.existingTests[0],code:0,output:tap,minimumPassingTests:evidence.minimumPassingTests[0]}]);return{observation:{...observation,existingTests:receipt.diagnosticTestsPassed,inputHash:witness.binding.harnessHash},witness:receipt};}};
    const verified=await verifyRepair({runId:run.runId,runDir:dir,manifest,rawRequest:request,runtime,verifier:runtime,policyHash:ISOLATION_POLICY_HASH,auditPolicyHash:sha256(canonical(report.policy)),archives:[],executor});
    report.findings[0].reproduction='reproduced';report.findings[0].repair='runtime_tested';report.findings[0].verificationId=verified.bundle.id;report.findings[0].verificationAssurance={assertions:'authenticated_out_of_process',testCompletion:'self_reported',review:'self_attested'};saveReport(dir,report);

    const leased=withLock(dir,()=>command(['replay',verified.bundle.id])) as ReturnType<typeof command>;expect(leased.status).not.toBe(0);expect(leased.stderr).toContain('INSUFFICIENT_CAPACITY');expect(leased.stderr).toContain('Another helper is updating this run');
    const retained=command(['replay',verified.bundle.id]);expect(retained.status).not.toBe(0);expect(retained.stderr).toContain('PREREQUISITE');expect(retained.stderr).toContain('MISSING_QUALIFIED_RUNTIME');
    const manifestPath=path.join(dir,'snapshot.json'),expiredManifest={...manifest,expiresAt:new Date(Date.now()-1_000).toISOString()};fs.writeFileSync(manifestPath,`${JSON.stringify(expiredManifest,null,2)}\n`);
    const expiredPresent=command(['replay',verified.bundle.id]);expect(expiredPresent.status).not.toBe(0);expect(expiredPresent.stderr).toContain('MISSING_INPUT');expect(expiredPresent.stderr).toContain('Retained source expired');
    const suppliedExpired=command(['replay',verified.bundle.id,'--source',repo]);expect(suppliedExpired.status).not.toBe(0);expect(suppliedExpired.stderr).toContain('PREREQUISITE');expect(suppliedExpired.stderr).toContain('MISSING_QUALIFIED_RUNTIME');expect(suppliedExpired.stderr).not.toContain('Retained source expired');
    const noncanonicalExpiry=new Date(Date.now()+86400_000).toISOString().replace(/\.\d{3}Z$/,'Z');fs.writeFileSync(manifestPath,`${JSON.stringify({...manifest,expiresAt:noncanonicalExpiry},null,2)}\n`);
    const invalidExpiry=command(['replay',verified.bundle.id,'--source',repo]);expect(invalidExpiry.status).not.toBe(0);expect(invalidExpiry.stderr).toContain('INCOMPATIBLE_INPUT');expect(invalidExpiry.stderr).toContain('Retained snapshot expiry is invalid');expect(invalidExpiry.stderr).not.toContain('MISSING_QUALIFIED_RUNTIME');
    fs.writeFileSync(manifestPath,`${JSON.stringify({...manifest,expiresAt:new Date(Date.now()+86400_000).toISOString()},null,2)}\n`);fs.writeFileSync(path.join(snapshot,'app.js'),'module.exports = "tampered"\n');
    const corruptRetained=command(['replay',verified.bundle.id,'--source',repo]);expect(corruptRetained.status).not.toBe(0);expect(corruptRetained.stderr).toContain('INCOMPATIBLE_INPUT');expect(corruptRetained.stderr).toContain('Retained snapshot changed');expect(corruptRetained.stderr).not.toContain('MISSING_QUALIFIED_RUNTIME');
    fs.rmSync(snapshot,{recursive:true,force:true});fs.rmSync(path.join(dir,'readable'),{recursive:true,force:true});
    const expired=command(['replay',verified.bundle.id]);expect(expired.status).not.toBe(0);expect(expired.stderr).toContain('MISSING_INPUT');expect(expired.stderr).toContain('Retained source expired');
    fs.writeFileSync(path.join(repo,'app.js'),'module.exports = "changed"\n');const changed=command(['replay',verified.bundle.id,'--source',repo]);expect(changed.status).not.toBe(0);expect(changed.stderr).toContain('INCOMPATIBLE_INPUT');expect(changed.stderr).toContain('does not match the bundle input hashes');
    fs.writeFileSync(path.join(repo,'app.js'),'module.exports = "vulnerable"\n');const supplied=command(['replay',verified.bundle.id,'--source',repo]);expect(supplied.status).not.toBe(0);expect(supplied.stderr).toContain('PREREQUISITE');expect(supplied.stderr).toContain('MISSING_QUALIFIED_RUNTIME');expect(supplied.stderr).not.toContain('does not match the bundle input hashes');
  },30_000);
});
