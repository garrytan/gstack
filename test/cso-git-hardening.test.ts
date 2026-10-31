import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture } from '../lib/cso/snapshot';
import { childEnvironment, executable, git as readGitMetadata, runProcess } from '../lib/cso/process';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

const fixtureGit=(repo:string,home:string)=>(...args:string[])=>{const result=spawnSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8',env:{HOME:home,PATH:'/usr/bin:/bin'},timeout:30_000});if(result.error||result.status!==0)throw new Error(`fixture git ${args.join(' ')} failed (status ${result.status}, signal ${result.signal}): ${result.error?.message??result.stderr}`);return result.stdout;};
// Each fixture builds its own repository from Git; nothing is copied from a shared
// template (Free Tests 40288142343 shard 17: fs.cpSync of the template threw inside
// its directory walk once and passed on the serial retry). Auto-maintenance is off
// because `git commit` otherwise starts a detached `git maintenance run --auto` that
// creates and deletes .git/objects/maintenance.lock after the commit returns, under
// the tests' own .git reads and the afterEach rmSync (docs/TESTING_INTERNALS.md,
// Free-suite flake rules); fixtureGit's replacement env never sees the shard backstop.
function seedRepo(repo:string,home:string){
  const git=fixtureGit(repo,home);fs.mkdirSync(repo);
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
  git('config','maintenance.auto','false');git('config','gc.auto','0');
  fs.writeFileSync(path.join(repo,'tracked.ts'),'export const tracked = true\n');git('add','tracked.ts');git('commit','-qm','base');
  return git;
}
// The first /usr/bin/git spawns on a cold macOS runner can eat a test's whole 5 s budget before the code under test runs; pay them once here.
beforeAll(()=>{
  const warm=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cso-git-hardening-warm-')));
  try{seedRepo(path.join(warm,'repo'),warm);}finally{fs.rmSync(warm,{recursive:true,force:true});}
},{timeout:30_000});

function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cso-git-hardening-'))),repo=path.join(root,'repo'),runDir=path.join(root,'state','run');
  roots.push(root);const git=seedRepo(repo,root);fs.mkdirSync(runDir,{recursive:true,mode:0o700});
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
    expect(failure.message).toContain('(request rejected)');
    expect(failure.message).not.toContain(root);
    expect(failure.message).not.toContain('secret-ref-name');
  });

  test.skipIf(process.platform==='win32')('labels the fixed object-format phase without exposing repository data',async()=>{
    const {root,repo}=fixture();fs.appendFileSync(path.join(repo,'.git','config'),'\n[broken configuration\n');let failure:any;
    try{await readGitMetadata(repo,['rev-parse','--show-object-format'],root);}catch(error){failure=error;}
    expect(failure).toMatchObject({code:'MISSING_INPUT'});
    expect(failure.message).toContain('object-format exited');
    expect(failure.message).toContain('(configuration rejected)');
    expect(failure.message).not.toContain(root);
  });

  test.skipIf(process.platform==='win32')('refuses trusted Git calls that are not bound to one audited worktree',async()=>{
    const {root}=fixture();
    await expect(runProcess(executable('git'),['rev-parse','--is-inside-work-tree'],{cwd:root,env:childEnvironment(root),raw:true})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  });

  test.skipIf(process.platform==='win32')('pins every metadata read to the audited worktree and ignores configured global excludes',async()=>{
    const {root,repo,runDir,git}=fixture(),empty=path.join(root,'decoy-worktree'),excludes=path.join(root,'global-excludes');
    fs.mkdirSync(empty);fs.writeFileSync(excludes,'untracked-security.ts\n');
    fs.writeFileSync(path.join(repo,'untracked-security.ts'),'export const vulnerable = true\n');
    const caseSensitive=!fs.existsSync(path.join(repo,'TRACKED.ts'));
    if(caseSensitive)fs.writeFileSync(path.join(repo,'TRACKED.ts'),'export const caseVariant = true\n');
    git('config','core.worktree',empty);git('config','core.excludesFile',excludes);git('config','core.ignoreCase','true');git('config','core.precomposeUnicode','true');

    const manifest=await capture(repo,runDir,'HEAD');

    expect(manifest.entries.map(entry=>entry.path)).toContain('untracked-security.ts');
    if(caseSensitive)expect(manifest.entries.map(entry=>entry.path)).toContain('TRACKED.ts');
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

  test.skipIf(process.platform==='win32')('retained history withholds diffs of credential files the snapshot excludes',async()=>{
    const {repo,runDir,git}=fixture();
    fs.writeFileSync(path.join(repo,'.env'),'UPSTREAM_TOKEN=planted-history-value\n');fs.writeFileSync(path.join(repo,'tracked.ts'),'export const tracked = false\n');
    git('add','.env','tracked.ts');git('commit','-qm','configure upstream');

    await capture(repo,runDir);
    const history=fs.readFileSync(path.join(runDir,'history.txt'),'utf8');

    expect(history).not.toContain('planted-history-value');
    expect(history).toContain('diff withheld: .env (credential or execution configuration)');
    expect(history).toContain('+export const tracked = false');
    expect(history).toContain('Subject: configure upstream');
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
    const race=replaceWithSymlinkAfterLstat(marker,oversized);
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
