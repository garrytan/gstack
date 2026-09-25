import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recoverAtomicNoReplaceJson, withLock } from '../lib/cso/state';

const roots:string[]=[];
function tmp():string{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cso-publication-race-'));roots.push(dir);return dir;}
afterEach(()=>{for(const dir of roots.splice(0))fs.rmSync(dir,{recursive:true,force:true});});

describe('CSO publication enumeration racing with final unlink',()=>{
  for(const phase of ['open','read'] as const)for(const change of ['unlink','rewrite','ctime only'] as const)test(`a torn ${phase} stat requires an unchanged inode and a link transition (${change})`,()=>{
    const dir=tmp(),target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.cafebabe`;
    fs.writeFileSync(temporary,'{"value":"original"}\n',{mode:0o600});fs.linkSync(temporary,target);
    const fstat=fs.fstatSync,initial=fs.lstatSync(target,{bigint:true});let reads=0,injected=false,failure:unknown;
    const descriptorSpy=spyOn(fs,'fstatSync').mockImplementation(((fd:any,options?:any)=>{
      if(++reads===(phase==='open'?1:2)){
        injected=true;
        if(change==='rewrite'){fs.writeFileSync(target,'{"value":"modified"}\n');fs.utimesSync(target,1_700_000_000,1_700_000_000);}
        if(change!=='ctime only')fs.unlinkSync(temporary);
        const stat=fstat(fd,options);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{nlink:options?.bigint?2n:2,ctimeNs:initial.ctimeNs+1n});
      }
      return options===undefined?fstat(fd):fstat(fd,options);
    }) as typeof fs.fstatSync);
    try{recoverAtomicNoReplaceJson(target,{label:'Test publication',maxBytes:4096});}catch(error){failure=error;}finally{descriptorSpy.mockRestore();}
    expect(injected).toBe(true);
    expect(failure).toMatchObject(change!=='unlink'?{name:'CsoError',code:'SNAPSHOT_RACE'}:phase==='open'?{code:'INSUFFICIENT_CAPACITY'}:{name:'AtomicPublicationTransition',code:'SNAPSHOT_RACE'});
    expect(fs.readFileSync(target,'utf8')).toBe(change==='rewrite'?'{"value":"modified"}\n':'{"value":"original"}\n');
    expect(fs.existsSync(temporary)).toBe(change==='ctime only');
  });

  test('a vanished publication temp cannot reclassify its live owner active link as an interrupted publication',()=>{
    const dir=tmp();let injected=false,entered=false;
    withLock(dir,()=>{
      const leases=path.join(dir,'.mutation-lock-leases'),candidate=fs.readdirSync(leases).find(name=>name.endsWith('.json'))!,stale=`${candidate}.tmp.${process.pid}.cafebabe`,readdir=fs.readdirSync;
      const directorySpy=spyOn(fs,'readdirSync').mockImplementation(((file:any,options?:any)=>{
        const entries=options===undefined?readdir(file):readdir(file,options);
        if(String(file)===leases&&!injected){injected=true;return[...entries,stale];}
        return entries;
      }) as typeof fs.readdirSync);
      let failure:unknown;try{withLock(dir,()=>{entered=true;});}catch(error){failure=error;}finally{directorySpy.mockRestore();}
      expect(injected).toBe(true);expect(entered).toBe(false);expect(failure).toMatchObject({code:'INSUFFICIENT_CAPACITY'});
    });
    expect(fs.readdirSync(path.join(dir,'.mutation-lock-leases'))).toEqual([]);
  });

  test('a vanished temp does not authorize a stable malicious hard link',()=>{
    const dir=tmp();expect(withLock(dir,()=>1)).toBe(1);
    const leases=path.join(dir,'.mutation-lock-leases'),token='b'.repeat(32),candidate=`${token}.json`,target=path.join(leases,candidate),alias=path.join(dir,'foreign-alias'),stale=`${candidate}.tmp.${process.pid}.cafebabe`,readdir=fs.readdirSync;
    fs.writeFileSync(target,JSON.stringify({pid:process.pid,token,createdAt:0})+'\n',{mode:0o600});fs.linkSync(target,alias);
    let injected=false,entered=false,failure:unknown;
    const directorySpy=spyOn(fs,'readdirSync').mockImplementation(((file:any,options?:any)=>{
      const entries=options===undefined?readdir(file):readdir(file,options);
      if(String(file)===leases&&!injected){injected=true;return[...entries,stale];}
      return entries;
    }) as typeof fs.readdirSync);
    try{withLock(dir,()=>{entered=true;});}catch(error){failure=error;}finally{directorySpy.mockRestore();}
    expect(injected).toBe(true);expect(entered).toBe(false);expect(failure).toMatchObject({code:'UNSAFE_PATH'});
    expect(fs.statSync(target).nlink).toBe(2);expect(fs.readFileSync(target,'utf8')).toBe(fs.readFileSync(alias,'utf8'));
  });

  for(const change of ['unchanged','foreign inode','changed content','changed permissions','unrecognized alias','extra link'] as const)test.skipIf(process.platform==='win32'&&change==='changed permissions')(`validates the ${change} observation`,()=>{
    const dir=tmp(),target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.cafebabe`,foreign=path.join(dir,'foreign.json'),alias=path.join(dir,'alias');
    fs.writeFileSync(temporary,'{"value":"original"}\n',{mode:0o600});fs.linkSync(temporary,target);
    fs.writeFileSync(foreign,'{"value":"original"}\n',{mode:0o600});
    const fd=fs.openSync(change==='foreign inode'?foreign:target,fs.constants.O_RDONLY),lstat=fs.lstatSync,readdir=fs.readdirSync;
    let enumerated=false,observed=false,failure:unknown,permissionModes:[number,number]|undefined;
    const directorySpy=spyOn(fs,'readdirSync').mockImplementation(((file:any,options?:any)=>{
      const entries=options===undefined?readdir(file):readdir(file,options);
      if(String(file)===dir&&!enumerated){
        enumerated=true;
        if(change==='unrecognized alias')fs.renameSync(temporary,alias);
        else if(change==='extra link'){fs.linkSync(target,alias);fs.linkSync(target,`${alias}-second`);fs.unlinkSync(temporary);}
        else fs.unlinkSync(temporary);
      }
      return entries;
    }) as typeof fs.readdirSync);
    const statSpy=spyOn(fs,'lstatSync').mockImplementation(((file:any,options?:any)=>{
      if(enumerated&&!observed&&String(file)===target){
        observed=true;
        if(change==='unrecognized alias'||change==='extra link')return lstat(file,options);
        if(change==='changed content'){fs.writeFileSync(target,'{"value":"modified"}\n');fs.utimesSync(target,1_700_000_000,1_700_000_000);}
        if(change==='changed permissions'){const before=fs.statSync(target).mode;fs.chmodSync(target,0o644);permissionModes=[before,fs.statSync(target).mode];}
        fs.unlinkSync(target);
        if(change==='foreign inode')fs.unlinkSync(foreign);
        return fs.fstatSync(fd,options);
      }
      return options===undefined?lstat(file):lstat(file,options);
    }) as typeof fs.lstatSync);
    try{recoverAtomicNoReplaceJson(target,{label:'Test publication',maxBytes:4096});}catch(error){failure=error;}
    finally{directorySpy.mockRestore();statSpy.mockRestore();fs.closeSync(fd);}
    expect(enumerated).toBe(true);expect(observed).toBe(true);
    if(change==='changed permissions'){expect(permissionModes).toBeDefined();expect(permissionModes![1]).not.toBe(permissionModes![0]);}
    expect(failure).toMatchObject(change==='unchanged'?{name:'AtomicPublicationTransition',code:'SNAPSHOT_RACE'}:{code:'UNSAFE_PATH'});
    if(change==='unrecognized alias'||change==='extra link'){
      expect(fs.readFileSync(target,'utf8')).toBe('{"value":"original"}\n');
      expect(fs.existsSync(alias)).toBe(true);
      expect(fs.statSync(target).nlink).toBe(change==='extra link'?3:2);
    }
  });

  test('the lease scanner retries a detached same-inode observation without admitting overlapping work',()=>{
    const dir=tmp();expect(withLock(dir,()=>1)).toBe(1);
    const leases=path.join(dir,'.mutation-lock-leases'),token='c'.repeat(32),target=path.join(leases,`${token}.json`),temporary=`${target}.tmp.2147483647.cafebabe`;
    fs.writeFileSync(temporary,JSON.stringify({pid:2147483647,token,createdAt:0})+'\n',{mode:0o600});fs.linkSync(temporary,target);
    const fd=fs.openSync(target,fs.constants.O_RDONLY),lstat=fs.lstatSync,readdir=fs.readdirSync;
    let targetReads=0,enumerated=false,observed=false,entered=0;
    const directorySpy=spyOn(fs,'readdirSync').mockImplementation(((file:any,options?:any)=>{
      const entries=options===undefined?readdir(file):readdir(file,options);
      if(String(file)===leases&&targetReads>=3&&!enumerated){enumerated=true;fs.unlinkSync(temporary);}
      return entries;
    }) as typeof fs.readdirSync);
    const statSpy=spyOn(fs,'lstatSync').mockImplementation(((file:any,options?:any)=>{
      if(String(file)===target){
        targetReads++;
        if(enumerated&&!observed){observed=true;fs.unlinkSync(target);return fs.fstatSync(fd,options);}
      }
      return options===undefined?lstat(file):lstat(file,options);
    }) as typeof fs.lstatSync);
    try{expect(withLock(dir,()=>{
      entered++;
      let contention:unknown;try{withLock(dir,()=>{entered++;});}catch(error){contention=error;}
      expect(contention).toMatchObject({code:'INSUFFICIENT_CAPACITY'});
      return 2;
    })).toBe(2);}finally{directorySpy.mockRestore();statSpy.mockRestore();fs.closeSync(fd);}
    expect(observed).toBe(true);expect(entered).toBe(1);expect(fs.readdirSync(leases)).toEqual([]);
  });
});
