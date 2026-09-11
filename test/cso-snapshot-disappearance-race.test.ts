import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture } from '../lib/cso/snapshot';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-snapshot-disappearance-'));roots.push(root);
  const repo=path.join(root,'repo'),runDir=path.join(root,'run');
  fs.mkdirSync(repo);fs.mkdirSync(runDir,{mode:0o700});
  const git=(...args:string[])=>{const result=spawnSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8',env:{HOME:root,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.status)throw new Error(result.stderr);return result.stdout.trim();};
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
  const tracked=path.join(repo,'tracked.txt');fs.writeFileSync(tracked,'security-relevant source\n');git('add','tracked.txt');git('commit','-qm','base');
  return{repo,runDir,tracked,parked:path.join(repo,'.tracked.txt.parked')};
}

describe('CSO snapshot source-disappearance races',()=>{
  test('rejects a tracked path that disappears at its capture lstat and is restored before final membership validation',async()=>{
    const {repo,runDir,tracked,parked}=fixture(),lstat=fs.lstatSync;
    let trackedLstats=0,injected=false,failure:unknown;
    const patched=spyOn(fs,'lstatSync').mockImplementation(((candidate:any,options?:any)=>{
      if(path.resolve(String(candidate))===tracked&&++trackedLstats===2){
        // The first lstat is rejectSpecialFiles' directory walk. The second is
        // capture's per-entry existence check. Move the tracked file for that
        // exact syscall, then restore it before any final Git membership check.
        injected=true;fs.renameSync(tracked,parked);
        try{return options===undefined?lstat(candidate):lstat(candidate,options);}
        finally{fs.renameSync(parked,tracked);}
      }
      return options===undefined?lstat(candidate):lstat(candidate,options);
    }) as typeof fs.lstatSync);
    try{await capture(repo,runDir);}catch(error){failure=error;}finally{patched.mockRestore();}
    expect(injected).toBe(true);
    expect(fs.readFileSync(tracked,'utf8')).toBe('security-relevant source\n');
    expect(failure).toMatchObject({code:'SNAPSHOT_RACE'});
  });
  test('rejects a nonignored source file introduced during the final content validation',async()=>{
    const {repo,runDir,tracked}=fixture(),late=path.join(repo,'late-vulnerable.js'),lstat=fs.lstatSync;let injected=false,failure:unknown;
    const patched=spyOn(fs,'lstatSync').mockImplementation(((candidate:any,options?:any)=>{
      if(!injected&&path.resolve(String(candidate))===tracked&&fs.existsSync(path.join(runDir,'history-status.json'))){injected=true;fs.writeFileSync(late,'export const vulnerable = true\n');}
      return options===undefined?lstat(candidate):lstat(candidate,options);
    }) as typeof fs.lstatSync);
    try{await capture(repo,runDir);}catch(error){failure=error;}finally{patched.mockRestore();}
    expect(injected).toBe(true);expect(fs.readFileSync(late,'utf8')).toContain('vulnerable');expect(failure).toMatchObject({code:'SNAPSHOT_RACE'});expect(fs.existsSync(path.join(runDir,'snapshot.json'))).toBe(false);
  });
  test.skipIf(process.platform==='win32')('binds the audited repository root while source is copied',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-snapshot-root-swap-'));roots.push(root);const repo=path.join(root,'repo'),parked=path.join(root,'parked'),decoy=path.join(root,'decoy'),gitDir=path.join(root,'gitdir'),runDir=path.join(root,'run'),tracked=path.join(repo,'tracked.txt');fs.mkdirSync(repo);fs.mkdirSync(runDir,{mode:0o700});
    const run=(...args:string[])=>{const result=spawnSync('/usr/bin/git',args,{encoding:'utf8',env:{HOME:root,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.status)throw new Error(result.stderr);};
    run('init','-q',`--separate-git-dir=${gitDir}`,repo);run('-C',repo,'config','user.email','fixture@example.test');run('-C',repo,'config','user.name','Fixture');fs.writeFileSync(tracked,'secure original source\n');run('-C',repo,'add','tracked.txt');run('-C',repo,'commit','-qm','base');fs.mkdirSync(decoy);fs.writeFileSync(path.join(decoy,'.git'),`gitdir: ${gitDir}\n`);fs.writeFileSync(path.join(decoy,'tracked.txt'),'vulnerable decoy source\n');
    const lstat=fs.lstatSync;let seen=0,injected=false,failure:unknown;
    const patched=spyOn(fs,'lstatSync').mockImplementation(((candidate:any,options?:any)=>{if(path.resolve(String(candidate))===tracked&&++seen===2){injected=true;fs.renameSync(repo,parked);fs.renameSync(decoy,repo);}return options===undefined?lstat(candidate):lstat(candidate,options);}) as typeof fs.lstatSync);
    try{await capture(repo,runDir);}catch(error){failure=error;}finally{patched.mockRestore();if(injected){fs.renameSync(repo,decoy);fs.renameSync(parked,repo);}}
    expect(injected).toBe(true);expect(failure).toMatchObject({code:'SNAPSHOT_RACE'});expect(fs.readFileSync(path.join(repo,'tracked.txt'),'utf8')).toBe('secure original source\n');expect(fs.existsSync(path.join(runDir,'snapshot.json'))).toBe(false);
  });
});
