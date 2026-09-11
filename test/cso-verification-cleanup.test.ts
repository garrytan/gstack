import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../lib/cso/contracts';
import { patchHash, treeHash, verifyRepair } from '../lib/cso/verification';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

describe('CSO verification persistence ordering',()=>{
  test('cleanup acknowledgement failure leaves no certified bundle on disk',async()=>{
    const runDir=fs.mkdtempSync(path.join(os.tmpdir(),'cso-cleanup-order-'));roots.push(runDir);
    const snapshot=path.join(runDir,'snapshot');fs.mkdirSync(snapshot);
    const files:Record<string,string>={
      'package.json':JSON.stringify({scripts:{test:'node --test'}}),
      'app.js':'vulnerable\n',
      'app.test.js':'test("ok",()=>{})\n',
    };
    for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(snapshot,name),body);
    const request:any={findingId:'a'.repeat(32),runtimeProfile:'node',port:3456,start:{executable:'/usr/local/bin/node',args:['app.js']},
      legitimate:[{name:'health',path:'/health',method:'GET',expected:{status:200,includes:'ok'}}],
      security:{name:'tenant isolation',path:'/user?id=2',method:'GET',expected:{status:403},vulnerable:{status:200,includes:'tenant-b'}},
      existingTests:[{executable:'/usr/local/bin/node',args:['--test','--test-reporter=tap','./app.test.js']}],testFiles:['app.test.js'],fixtures:{},boundaryFiles:['app.js'],
      changes:[{path:'app.js',beforeSha256:sha256(files['app.js']),after:'fixed\n',effect:'source'}],
      review:{reviewer:'independent-reviewer',independent:true,rootCauseRepaired:true,featurePreserved:true,boundaryMocks:false,
        rationale:'The tenant predicate is restored without changing the feature',reviewedPatchHash:''}};
    request.review.reviewedPatchHash=patchHash(request);
    const entries=Object.entries(files).map(([name,body])=>({path:name,originalHash:sha256(body),executionHash:sha256(body),bytes:Buffer.byteLength(body),mode:0o600}));
    const manifest:any={version:3,createdAt:'2026-01-01T00:00:00Z',expiresAt:'2026-01-08T00:00:00Z',root:'/repo',headCommit:'b'.repeat(40),
      originalHash:'c'.repeat(64),executionHash:treeHash(snapshot),entries};
    const watchdog=path.join(runDir,'no-ack-watchdog');
    fs.writeFileSync(watchdog,'#!/bin/sh\nset -eu\ntouch "$6/attempt.ready"\nwhile test ! -f "$6/attempt.terminal"; do sleep 0.01; done\nexit 0\n',{mode:0o755});
    const runtime:any={id:'node',stack:'node',image:`runtime@sha256:${'d'.repeat(64)}`,platform:'linux/amd64'};
    const executor:any={observe:async(_source:string,phase:'before'|'after')=>({booted:true,legitimate:true,
      security:phase==='before'?'intended_failure':'pass',existingTests:true,output:'ok',inputHash:''})};
    await expect(verifyRepair({runId:'run',runDir,manifest,rawRequest:request,runtime,verifier:runtime,policyHash:'e'.repeat(64),archives:[],executor,
      watchdogPath:watchdog,attemptDeadline:Date.now()+10_000})).rejects.toThrow('did not acknowledge');
    const bundles=path.join(runDir,'bundles');expect(fs.existsSync(bundles)?fs.readdirSync(bundles):[]).toEqual([]);
  });
});
