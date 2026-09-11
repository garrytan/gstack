import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture } from '../lib/cso/snapshot';
import { childEnvironment, executable, git as readGitMetadata, runProcess } from '../lib/cso/process';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-git-hardening-')),repo=path.join(root,'repo'),runDir=path.join(root,'state','run');
  roots.push(root);fs.mkdirSync(repo);fs.mkdirSync(runDir,{recursive:true,mode:0o700});
  const git=(...args:string[])=>{const result=spawnSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8',env:{HOME:root,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.status)throw new Error(result.stderr);return result.stdout;};
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(repo,'tracked.ts'),'export const tracked = true\n');git('add','tracked.ts');git('commit','-qm','base');
  return{root,repo,runDir,git};
}

function replaceWithSymlinkAfterLstat(target:string,replacement:string,occurrence=1){
  const original=fs.lstatSync;let hits=0,swapped=false;
  const patched=spyOn(fs,'lstatSync').mockImplementation(((candidate:any,options?:any)=>{
    const result=options===undefined?original(candidate):original(candidate,options);
    if(path.resolve(String(candidate))===target&&++hits===occurrence){
      fs.renameSync(target,`${target}.parked`);fs.symlinkSync(replacement,target);swapped=true;
    }
    return result;
  }) as typeof fs.lstatSync);
  return{patched,wasSwapped:()=>swapped};
}

describe('CSO Git metadata hardening',()=>{
  test.skipIf(process.platform==='win32')('reports a bounded operation and exit status without exposing Git argv or paths',async()=>{
    const {root,repo}=fixture();let failure:any;
    try{await readGitMetadata(repo,['rev-parse','--verify','secret-ref-name'],root);}catch(error){failure=error;}
    expect(failure).toMatchObject({code:'MISSING_INPUT'});
    expect(failure.message).toContain('rev-parse exited');
    expect(failure.message).not.toContain(root);
    expect(failure.message).not.toContain('secret-ref-name');
  });

  test.skipIf(process.platform==='win32')('refuses trusted Git calls that are not bound to one audited worktree',async()=>{
    const {root}=fixture();
    await expect(runProcess(executable('git'),['rev-parse','--is-inside-work-tree'],{cwd:root,env:childEnvironment(root),raw:true})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  });

  test.skipIf(process.platform==='win32')('pins every metadata read to the audited worktree and ignores configured global excludes',async()=>{
    const {root,repo,runDir,git}=fixture(),empty=path.join(root,'decoy-worktree'),excludes=path.join(root,'global-excludes');
    fs.mkdirSync(empty);fs.writeFileSync(excludes,'untracked-security.ts\n');
    fs.writeFileSync(path.join(repo,'untracked-security.ts'),'export const vulnerable = true\n');
    fs.writeFileSync(path.join(repo,'TRACKED.ts'),'export const caseVariant = true\n');
    git('config','core.worktree',empty);git('config','core.excludesFile',excludes);git('config','core.ignoreCase','true');git('config','core.precomposeUnicode','true');

    const manifest=await capture(repo,runDir,'HEAD');

    expect(manifest.entries.map(entry=>entry.path)).toContain('untracked-security.ts');
    expect(manifest.entries.map(entry=>entry.path)).toContain('TRACKED.ts');
    expect(fs.readFileSync(path.join(runDir,'snapshot','untracked-security.ts'),'utf8')).toContain('vulnerable');
    expect(manifest.changedPaths).toContain('untracked-security.ts');
  });

  test.skipIf(process.platform==='win32')('ignores replacement refs when retaining tracked deletions and history',async()=>{
    const {repo,runDir,git}=fixture(),head=git('rev-parse','HEAD').trim(),emptyTree=git('mktree').trim(),replacement=git('commit-tree',emptyTree,'-m','replacement-history').trim();
    git('replace',head,replacement);git('rm','-q','-f','tracked.ts');

    const manifest=await capture(repo,runDir);
    const history=fs.readFileSync(path.join(runDir,'history.txt'),'utf8');

    expect(manifest.headCommit).toBe(head);
    expect(manifest.deletedPaths).toEqual([{path:'tracked.ts',pathId:expect.stringMatching(/^[a-f0-9]{32}$/)}]);
    expect(history).toContain('Subject: base');
    expect(history).not.toContain('replacement-history');
  });

  test.skipIf(process.platform==='win32')('rejects repository config includes before Git can consume them',async()=>{
    const {root,repo,runDir}=fixture(),included=path.join(root,'included.conf');
    fs.writeFileSync(included,'[core]\n\tworktree = /tmp/cso-decoy\n');
    fs.appendFileSync(path.join(repo,'.git','config'),`\n[include]\n\tpath = ${included}\n`);

    await expect(capture(repo,runDir)).rejects.toMatchObject({code:'UNSAFE_PATH',message:'Repository Git config includes are not allowed during a security snapshot'});
  });

  test.skipIf(process.platform==='win32')('binds an absent main-worktree config so it cannot appear after inspection',async()=>{
    const {root,repo,git}=fixture(),worktreeConfig=path.join(repo,'.git','config.worktree'),lstat=fs.lstatSync;
    git('config','extensions.worktreeConfig','true');let injected=false;
    const patched=spyOn(fs,'lstatSync').mockImplementation(((candidate:any,options?:any)=>{
      try{return options===undefined?lstat(candidate):lstat(candidate,options);}catch(error:any){
        if(!injected&&path.resolve(String(candidate))===worktreeConfig&&error?.code==='ENOENT'){
          fs.writeFileSync(worktreeConfig,'[cso]\n\tmarker = created-after-inspection\n');injected=true;
        }
        throw error;
      }
    }) as typeof fs.lstatSync);
    try{await expect(runProcess(executable('git'),['--no-optional-locks','-C',repo,'rev-parse','--is-inside-work-tree'],{cwd:root,env:childEnvironment(root),raw:true})).rejects.toMatchObject({code:'SNAPSHOT_RACE'});}finally{patched.mockRestore();}
    expect(injected).toBe(true);
  });

  test.skipIf(process.platform==='win32')('does not follow a repository config swapped after its bounded lstat',async()=>{
    const {root,repo,runDir}=fixture(),config=path.join(repo,'.git','config'),oversized=path.join(root,'oversized-config');
    fs.writeFileSync(oversized,'[core]\n'+'.'.repeat(1024*1024));
    const race=replaceWithSymlinkAfterLstat(config,oversized);
    try{await expect(capture(repo,runDir)).rejects.toMatchObject({code:'SNAPSHOT_RACE'});}finally{race.patched.mockRestore();}
    expect(race.wasSwapped()).toBe(true);
  });

  test.skipIf(process.platform==='win32')('does not follow a worktree .git pointer swapped between lstat and open',async()=>{
    const {root,repo,runDir}=fixture(),gitDir=path.join(root,'git-data'),marker=path.join(repo,'.git'),oversized=path.join(root,'oversized-git-pointer');
    fs.renameSync(marker,gitDir);fs.writeFileSync(marker,'gitdir: ../git-data\n');fs.writeFileSync(oversized,'gitdir: '+'.'.repeat(16*1024));
    const race=replaceWithSymlinkAfterLstat(marker,oversized,2);
    try{await expect(capture(repo,runDir)).rejects.toMatchObject({code:'SNAPSHOT_RACE'});}finally{race.patched.mockRestore();}
    expect(race.wasSwapped()).toBe(true);
  });

  test.skipIf(process.platform==='win32')('does not follow a linked-worktree commondir pointer swapped after lstat',async()=>{
    const {root,repo,git}=fixture(),linked=path.join(root,'linked');
    git('worktree','add','-q','-b','linked-security-test',linked);
    const marker=fs.readFileSync(path.join(linked,'.git'),'utf8').trim().replace(/^gitdir:\s*/,''),gitDir=fs.realpathSync(path.resolve(linked,marker)),common=path.join(gitDir,'commondir'),oversized=path.join(root,'oversized-commondir');
    fs.writeFileSync(oversized,'.'.repeat(16*1024));
    const race=replaceWithSymlinkAfterLstat(common,oversized);
    try{await expect(runProcess(executable('git'),['--no-optional-locks','-C',linked,'rev-parse','--is-inside-work-tree'],{cwd:root,env:childEnvironment(root),raw:true})).rejects.toMatchObject({code:'SNAPSHOT_RACE'});}finally{race.patched.mockRestore();}
    expect(race.wasSwapped()).toBe(true);
  });
});
