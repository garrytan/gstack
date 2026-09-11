import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchCsoCommand, type CsoCliDependencies } from '../lib/cso/cli';
import { canonical, CsoError, sha256 } from '../lib/cso/contracts';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import {
  catalogImageProvisioningPolicy,
  inspectCatalogImages,
  openLocalCatalogImageSession,
  provisionCatalogImages,
  qualifiedCatalogImages,
  type CatalogImageSession,
  type QualifiedCatalogImage,
} from '../lib/cso/image-provisioning';
import { scannerVersionHash, type QualifiedScanner, type ScannerCatalog } from '../lib/cso/scanner-catalog';
import { SCANNER_IDS, scannerPlans, type ScannerId } from '../lib/cso/scanners';
import type { RuntimePlatform } from '../lib/cso/runtime-catalog';
import { completeRuntimeCatalogFixture } from './helpers/cso-runtime-catalog';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const target:RuntimePlatform=process.arch==='arm64'?'linux/arm64':'linux/amd64';
const hash='a'.repeat(64),digest=`sha256:${hash}`,sourceCommit='b'.repeat(40),workflow='https://github.com/garrytan/gstack/actions/runs/42';
function scannerProfile(scanner:ScannerId,platform:RuntimePlatform):QualifiedScanner{
  const arch=platform.endsWith('arm64')?'arm64':'amd64',version=scanner==='osv'?'2.4.0':'4.0.0';
  return{id:`${scanner}-provision-${arch}`,scanner,state:'qualified',platform,image:`ghcr.io/garrytan/gstack/cso-scanners/${scanner}-${arch}@${digest}`,
    entrypoint:'/opt/cso/entrypoint',executable:'/opt/cso/bin/scanner',version,versionOutputSha256:scannerVersionHash(`${scanner} version ${version}\n`),helperAbi:3,isolationPolicyHash:ISOLATION_POLICY_HASH,
    capabilities:scannerPlans({snapshotRoot:'/source',offline:true,selected:[scanner]})[0].requiredFeatures,
    ...(scanner==='semgrep'?{assets:{semgrepRules:{path:'/policy/catalog/semgrep.yml',sha256:hash}}}:{}),
    ...(['osv','trivy'].includes(scanner)?{assets:{advisoryDatabase:{path:'/opt/cso/scanner-data/db',contentSha256:hash,updatedAt:'2026-09-09T00:00:00.000Z',ecosystems:['npm']}}}:{}),
    qualifiedAt:'2026-09-09T00:00:00.000Z',qualification:{sourceCommit,workflow,sbomDigest:digest,provenanceDigest:digest,verifiedProvenance:true,containmentPassed:true,adapterContractPassed:true,offlineAssetsPassed:true}};
}
function scannerCatalog():ScannerCatalog{
  const scanners=SCANNER_IDS.flatMap(scanner=>[scannerProfile(scanner,'linux/amd64'),scannerProfile(scanner,'linux/arm64')]);
  return{schemaVersion:1,revision:'scanner-provisioning-fixture',helperAbi:3,promotion:{sourceCommit,workflow,evidenceDigest:`sha256:${sha256(canonical(scanners))}`},scanners};
}
function session(options:{present?:(entry:QualifiedCatalogImage)=>boolean;pull?:(entry:QualifiedCatalogImage)=>void}={}):{value:CatalogImageSession;calls:{present:string[];pull:string[]};closed:()=>boolean}{
  const calls={present:[] as string[],pull:[] as string[]};let closed=false;
  return{calls,closed:()=>closed,value:{docker:{endpoint:'unix:///trusted/docker.sock',version:'27.0.0',security:['seccomp']},
    present:async entry=>{calls.present.push(entry.image);return options.present?.(entry)??false;},
    pull:async entry=>{calls.pull.push(entry.image);options.pull?.(entry);},close:()=>{closed=true;}}};
}
function nodeRepo():string{
  const root=fs.mkdtempSync(join(os.tmpdir(),'cso-image-doctor-'));roots.push(root);
  fs.writeFileSync(join(root,'package.json'),JSON.stringify({name:'doctor-fixture',version:'1.0.0'}));
  fs.writeFileSync(join(root,'package-lock.json'),JSON.stringify({name:'doctor-fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'doctor-fixture',version:'1.0.0'}}}));
  fs.writeFileSync(join(root,'app.js'),'export const ready = true\n');
  for(const args of [['init','-q'],['config','user.email','fixture@example.test'],['config','user.name','Fixture'],['add','.'],['commit','-qm','fixture']]){
    const result=spawnSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',env:{HOME:root,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.status)throw new Error(result.stderr);
  }
  return root;
}
function railsPostgresRepo():string{
  const root=fs.mkdtempSync(join(os.tmpdir(),'cso-image-doctor-rails-'));roots.push(root);fs.mkdirSync(join(root,'config'));
  fs.writeFileSync(join(root,'Gemfile'),'');
  fs.writeFileSync(join(root,'Gemfile.lock'),`GEM\n  remote: https://rubygems.org/\n  specs:\n    pg (1.5.9)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  pg\n\nRUBY VERSION\n   ruby 3.3.6p108\n\nBUNDLED WITH\n   2.6.9\n`);
  fs.writeFileSync(join(root,'config/database.yml'),'test:\n  adapter: postgresql\n  database: app_test\n');
  for(const args of [['init','-q'],['config','user.email','fixture@example.test'],['config','user.name','Fixture'],['add','.'],['commit','-qm','fixture']]){
    const result=spawnSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',env:{HOME:root,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.status)throw new Error(result.stderr);
  }
  return root;
}

describe('trusted CSO image provisioning',()=>{
  test('setup derives a bounded allowance per declared catalog image',()=>{
    expect(catalogImageProvisioningPolicy(11)).toEqual({perImageMs:30_000,aggregateMs:360_000});
    expect(catalogImageProvisioningPolicy(11,'300')).toEqual({perImageMs:300_000,aggregateMs:3_330_000});
    expect(()=>catalogImageProvisioningPolicy(11,'4')).toThrow('5..300');
    expect(()=>catalogImageProvisioningPolicy(11,'301')).toThrow('5..300');
    expect(()=>catalogImageProvisioningPolicy(12,'300')).toThrow('bounded setup preload capacity');
  });

  test('plans only qualified exact-digest images for the native platform',()=>{
    const runtimes=completeRuntimeCatalogFixture('image-provisioning-fixture'),entries=qualifiedCatalogImages(runtimes,scannerCatalog(),target);
    expect(entries).toHaveLength(11);
    expect(entries.filter(entry=>entry.kind==='runtime')).toHaveLength(5);expect(entries.filter(entry=>entry.kind==='scanner')).toHaveLength(6);
    expect(entries.every(entry=>entry.platform===target)).toBe(true);
    expect(entries.every(entry=>/^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/.test(entry.image))).toBe(true);
    expect(entries.map(entry=>`${entry.kind}:${entry.id}`)).toEqual([...entries.map(entry=>`${entry.kind}:${entry.id}`)].sort());
  });

  test('doctor inspection is read-only and marks exact absent digests unavailable',async()=>{
    const entries=qualifiedCatalogImages(completeRuntimeCatalogFixture('doctor-inspection-fixture'),scannerCatalog(),target),fake=session({present:()=>false});
    const result=await inspectCatalogImages(entries,async()=>fake.value);
    expect(result.docker.status).toBe('ready');
    expect(result.images.every(item=>item.status==='unavailable'&&item.reason?.includes('not present'))).toBe(true);
    expect(fake.calls.present).toEqual(entries.map(entry=>entry.image));
    expect(fake.calls.pull).toEqual([]);
    expect(fake.closed()).toBe(true);
  });

  test('preload pulls only missing entries and reports failures without disabling static audits',async()=>{
    const entries=qualifiedCatalogImages(completeRuntimeCatalogFixture('setup-provisioning-fixture'),scannerCatalog(),target),present=entries[0],laterPresent=entries.at(-1)!,failed=entries[2],fake=session({
      present:entry=>entry.image===present.image||entry.image===laterPresent.image,
      pull:entry=>{if(entry.image===failed.image)throw new CsoError('PREREQUISITE','Public registry is unavailable');},
    });
    const result=await provisionCatalogImages(entries,target,async()=>fake.value);
    expect(result).toMatchObject({status:'partial',downloads:true,requested:11,inspected:11,alreadyPresent:2,downloaded:1,deadlineReached:false});
    expect(result.unavailable).toHaveLength(8);expect(result.unavailable[0]).toMatchObject({id:failed.id,status:'unavailable'});
    expect(result.unavailable.at(-1)?.reason).toContain('Network provisioning stopped');
    expect(fake.calls.present).toEqual(entries.map(entry=>entry.image));expect(fake.calls.pull).not.toContain(present.image);expect(fake.calls.pull).not.toContain(laterPresent.image);expect(fake.calls.pull).toHaveLength(2);expect(fake.closed()).toBe(true);
    expect(result.summary).toContain('Rerun setup');
  });

  test('the aggregate deadline still bounds the complete provisioning pass',async()=>{
    const entries=qualifiedCatalogImages(completeRuntimeCatalogFixture('setup-deadline-fixture'),scannerCatalog(),target).slice(0,4),started=Date.now(),deadline=started+100;
    let receivedDeadline=0,presentCalls=0,pullCalls=0,closed=false;
    const result=await provisionCatalogImages(entries,target,async value=>{receivedDeadline=value;return{docker:{endpoint:'unix:///trusted/docker.sock',version:'27.0.0',security:['seccomp']},
      present:async()=>{presentCalls++;return false;},pull:async()=>{pullCalls++;while(Date.now()<value)await Bun.sleep(2);throw new CsoError('DEADLINE','Qualified image pull reached the aggregate preload deadline');},close:()=>{closed=true;}};},deadline);
    expect(receivedDeadline).toBe(deadline);expect(Date.now()-started).toBeLessThan(1000);
    expect(result).toMatchObject({status:'partial',requested:4,inspected:1,alreadyPresent:0,downloaded:0,deadlineReached:true});
    expect(result.unavailable).toHaveLength(4);expect(result.summary).toContain('bounded aggregate deadline');
    expect(presentCalls).toBe(1);expect(pullCalls).toBe(1);expect(closed).toBe(true);
  });

  test('one per-image timeout does not consume the remaining images allowance',async()=>{
    const entries=qualifiedCatalogImages(completeRuntimeCatalogFixture('setup-per-image-fixture'),scannerCatalog(),target).slice(0,2),pulls:string[]=[];
    const result=await provisionCatalogImages(entries,target,async deadline=>({docker:{endpoint:'unix:///trusted/docker.sock',version:'27.0.0',security:['seccomp']},
      present:async()=>false,
      pull:async(entry,imageDeadline=deadline)=>{pulls.push(entry.id);if(entry===entries[0]){while(Date.now()<imageDeadline)await Bun.sleep(1);throw new CsoError('DEADLINE','Per-image pull deadline reached');}},
      close:()=>{},
    }),Date.now()+1000,25);
    expect(pulls).toEqual(entries.map(entry=>entry.id));
    expect(result).toMatchObject({status:'partial',requested:2,inspected:2,downloaded:1,deadlineReached:false});
    expect(result.unavailable).toEqual([expect.objectContaining({id:entries[0].id,reason:expect.stringContaining('per-image')})]);
    expect(result.summary).toContain('GSTACK_CSO_IMAGE_PULL_TIMEOUT_SECONDS');
  });

  test('a local image check completing after the aggregate deadline cannot be counted',async()=>{
    const entry=qualifiedCatalogImages(completeRuntimeCatalogFixture('setup-late-success-fixture'),scannerCatalog(),target)[0],deadline=Date.now()+25;
    let pulls=0,closed=false;
    const result=await provisionCatalogImages([entry],target,async()=>({docker:{endpoint:'unix:///trusted/docker.sock',version:'27.0.0',security:['seccomp']},
      present:async()=>{while(Date.now()<deadline)await Bun.sleep(1);return true;},pull:async()=>{pulls++;},close:()=>{closed=true;}}),deadline);
    expect(result).toMatchObject({status:'partial',requested:1,inspected:0,alreadyPresent:0,downloaded:0,deadlineReached:true});
    expect(result.unavailable).toEqual([expect.objectContaining({id:entry.id,status:'unavailable',reason:expect.stringContaining('deadline')})]);
    expect(pulls).toBe(0);expect(closed).toBe(true);
  });

  test('the production session rejects remote Docker before inspecting or pulling images',async()=>{
    await expect(openLocalCatalogImageSession({HOME:os.tmpdir(),DOCKER_HOST:'tcp://127.0.0.1:2375'})).rejects.toThrow('Remote TCP');
  });

  test.skipIf(process.platform==='win32')('doctor and setup command contracts share exact local availability without doctor downloads',async()=>{
    const repo=nodeRepo(),runtimeCatalog=completeRuntimeCatalogFixture('doctor-cli-fixture'),scanners=scannerCatalog(),fake=session({present:()=>false}),dependencies:CsoCliDependencies={
      runtimeCatalog,scannerCatalog:scanners,catalogImageSession:async()=>fake.value,watchdogPath:()=>'/trusted/watchdog',
    };
    const doctor=await dispatchCsoCommand('doctor',['--repo',repo],dependencies) as any;
    expect(doctor.downloads).toBe(false);expect(doctor.elapsedMs).toBeLessThan(30_000);
    expect(doctor.checks.find((item:any)=>item.capability==='local-docker-isolation')).toMatchObject({status:'ready'});
    const runtime=doctor.checks.find((item:any)=>item.capability==='qualified-runtimes');
    expect(runtime).toMatchObject({status:'missing',detail:{availability:'unavailable'}});expect(runtime.detail.prerequisite).toContain('not present');
    for(const scanner of SCANNER_IDS)expect(doctor.checks.find((item:any)=>item.capability===`scanner:${scanner}`)).toMatchObject({status:'missing',detail:{availability:'unavailable'}});
    expect(fake.calls.pull).toEqual([]);

    const setupFake=session({present:()=>true}),summary=await dispatchCsoCommand('provision-images',['--setup-summary','--per-image-seconds','5'],{
      ...dependencies,catalogImageSession:async()=>setupFake.value,
    });
    expect(summary).toBe('Qualified CSO images ready: 11 available (0 downloaded, 11 already local).');
    expect(setupFake.calls.pull).toEqual([]);
    await expect(dispatchCsoCommand('provision-images',['--per-image-seconds','301'],dependencies)).rejects.toThrow('5..300');
  });

  test.skipIf(process.platform==='win32')('doctor includes the required PostgreSQL sidecar in Rails readiness without pulling',async()=>{
    const repo=railsPostgresRepo(),runtimeCatalog=completeRuntimeCatalogFixture('doctor-rails-postgresql-fixture'),fake=session({present:entry=>!entry.id.includes('postgresql')}),dependencies:CsoCliDependencies={
      runtimeCatalog,scannerCatalog:scannerCatalog(),catalogImageSession:async()=>fake.value,watchdogPath:()=>'/trusted/watchdog',
    };
    const doctor=await dispatchCsoCommand('doctor',['--repo',repo],dependencies) as any,runtime=doctor.checks.find((item:any)=>item.capability==='qualified-runtimes');
    expect(doctor.downloads).toBe(false);expect(doctor.checks.find((item:any)=>item.capability==='application-preparation')).toMatchObject({status:'ready'});
    expect(runtime).toMatchObject({status:'missing',detail:{availability:'unavailable',requiredSidecars:[{kind:'postgresql',availability:'unavailable'}]}});
    expect(runtime.detail.requiredSidecars[0].prerequisite).toContain('not present');expect(fake.calls.pull).toEqual([]);expect(fake.closed()).toBe(true);
  });
});
