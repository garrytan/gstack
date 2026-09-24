import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recoverAtomicNoReplaceJson, withLock } from '../lib/cso/state';

const roots:string[]=[];
const tmp=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-lease-identity-'));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function syntheticIds(root:string,first:bigint,step=1n):()=>void{
  const lstat=fs.lstatSync.bind(fs),fstat=fs.fstatSync.bind(fs),ids=new Map<string,bigint>();
  const map=(stat:fs.Stats|fs.BigIntStats,bigint:boolean)=>{
    const key=`${stat.dev}:${stat.ino}`;
    if(!ids.has(key))return stat;
    const ino=ids.get(key)!;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{dev:bigint?first:Number(first),ino:bigint?ino:Number(ino)});
  };
  const pathSpy=spyOn(fs,'lstatSync').mockImplementation(((file:any,options?:any)=>{
    const stat=lstat(file,options);
    if(String(file).startsWith(root+path.sep)){
      const key=`${stat.dev}:${stat.ino}`;
      if(!ids.has(key))ids.set(key,first+step*BigInt(ids.size));
    }
    return map(stat,options?.bigint===true);
  }) as typeof fs.lstatSync);
  const fdSpy=spyOn(fs,'fstatSync').mockImplementation(((fd:any,options?:any)=>map(fstat(fd,options),options?.bigint===true)) as typeof fs.fstatSync);
  return()=>{fdSpy.mockRestore();pathSpy.mockRestore();};
}

function leaseFixture(dir:string,ownerPid:number,token:string){
  withLock(dir,()=>0);
  const leases=path.join(dir,'.mutation-lock-leases'),candidate=path.join(leases,`${token}.json`),decision=path.join(leases,`${token}.decision`);
  fs.writeFileSync(candidate,JSON.stringify({pid:ownerPid,token,createdAt:0})+'\n',{mode:0o600});
  const stat=fs.lstatSync(candidate,{bigint:true});
  fs.writeFileSync(decision,JSON.stringify({schemaVersion:1,token,kind:'ticket',ticket:'0000000000000001',candidateDev:String(stat.dev),candidateIno:String(stat.ino),ownerPid,ownerCreatedAt:0,publisherPid:ownerPid,createdAt:0})+'\n',{mode:0o600});
  return {leases,candidate,decision,stat};
}

describe('CSO exact filesystem lease identity',()=>{
  test('the last safe integer and its next inode remain distinct',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740991n);
    try{
      const first=path.join(dir,'first'),second=path.join(dir,'second');
      fs.writeFileSync(first,'a');fs.writeFileSync(second,'b');
      expect(fs.lstatSync(first,{bigint:true}).ino).toBe(9007199254740991n);
      expect(fs.lstatSync(second,{bigint:true}).ino).toBe(9007199254740992n);
      expect(withLock(dir,()=>1)).toBe(1);
    }finally{restore();}
  });

  test.each([9007199254740991n,9007199254740992n,9007199254740993n])('serializes and releases identity starting at %s across consecutive mutations',(first)=>{
    const dir=tmp(),restore=syntheticIds(dir,first);
    try{
      for(let i=0;i<4;i++)expect(withLock(dir,()=>{
        const leases=path.join(dir,'.mutation-lock-leases'),files=fs.readdirSync(leases);
        const candidate=path.join(leases,files.find(name=>name.endsWith('.json'))!),decision=path.join(leases,files.find(name=>name.endsWith('.decision'))!),record=JSON.parse(fs.readFileSync(decision,'utf8'));
        expect(record.candidateDev).toBe(String(fs.lstatSync(candidate,{bigint:true}).dev));
        expect(record.candidateIno).toBe(String(fs.lstatSync(candidate,{bigint:true}).ino));
        expect(BigInt(record.candidateIno)).toBeGreaterThanOrEqual(first);
        return i;
      })).toBe(i);
      expect(fs.readdirSync(path.join(dir,'.mutation-lock-leases'))).toEqual([]);
    }finally{restore();}
  });

  test('recovers a dead owner and its exact high-ID decision, then admits the next operation',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {leases,candidate,decision}=leaseFixture(dir,2147483647,'a'.repeat(32));
      expect(withLock(dir,()=>1)).toBe(1);
      expect(fs.existsSync(candidate)).toBe(false);expect(fs.existsSync(decision)).toBe(false);
      expect(withLock(dir,()=>2)).toBe(2);expect(fs.readdirSync(leases)).toEqual([]);
    }finally{restore();}
  });

  test('a decision left after exact candidate removal keeps its high ID until recovery',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {leases,candidate,decision,stat}=leaseFixture(dir,2147483647,'e'.repeat(32));
      expect(JSON.parse(fs.readFileSync(decision,'utf8')).candidateIno).toBe(String(stat.ino));
      fs.unlinkSync(candidate);
      expect(withLock(dir,()=>3)).toBe(3);
      expect(fs.readdirSync(leases)).toEqual([]);
    }finally{restore();}
  });

  test('a live foreign lease is not stolen, even when its timestamp is old',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {candidate,decision}=leaseFixture(dir,process.pid,'b'.repeat(32));
      expect(()=>withLock(dir,()=>1)).toThrow('Another operation in this helper');
      expect(fs.existsSync(candidate)).toBe(true);expect(fs.existsSync(decision)).toBe(true);
    }finally{restore();}
  });

  test('a legacy rounded high-ID decision is ambiguous and remains blocked',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740993n,2n);
    try{
      const token='c'.repeat(32),{candidate,decision,stat}=leaseFixture(dir,2147483647,token);
      expect(stat.ino%2n).toBe(1n);
      const record=JSON.parse(fs.readFileSync(decision,'utf8'));
      record.candidateIno=String(Number(stat.ino));
      fs.writeFileSync(decision,JSON.stringify(record)+'\n',{mode:0o600});
      expect(record.candidateIno).not.toBe(String(stat.ino));
      let failure:unknown;try{withLock(dir,()=>1);}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'UNSAFE_PATH'});
      expect(fs.existsSync(candidate)).toBe(true);expect(fs.existsSync(decision)).toBe(true);
    }finally{restore();}
  });

  test('a neighboring replacement inode is rejected during exact release',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      let replaced='';
      let failure:unknown;try{withLock(dir,()=>{
        const leases=path.join(dir,'.mutation-lock-leases'),active=fs.readdirSync(leases).find(name=>name.includes('.active.'))!;
        replaced=path.join(leases,active);const bytes=fs.readFileSync(replaced);
        fs.renameSync(replaced,`${replaced}.original`);fs.writeFileSync(replaced,bytes,{mode:0o600});
      });}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'PERSISTENCE_FAILED'});
      expect(fs.existsSync(replaced)).toBe(true);
    }finally{restore();}
  });

  test.skipIf(process.platform==='win32')('a symlink substituted for a dead owner is never reclaimed',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {candidate,decision}=leaseFixture(dir,2147483647,'f'.repeat(32)),original=`${candidate}.original`;
      fs.renameSync(candidate,original);fs.symlinkSync(original,candidate);
      let failure:unknown;try{withLock(dir,()=>1);}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'UNSAFE_PATH'});
      expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(decision)).toBe(true);
    }finally{restore();}
  });

  test('atomic recovery matches only the exact high-ID hard-link publication',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.deadbeef`;
      fs.writeFileSync(temporary,'{"value":"retained"}\n',{mode:0o600});fs.linkSync(temporary,target);
      recoverAtomicNoReplaceJson(target,{label:'Synthetic publication',maxBytes:4096});
      expect(fs.existsSync(temporary)).toBe(false);expect(JSON.parse(fs.readFileSync(target,'utf8'))).toEqual({value:'retained'});
    }finally{restore();}
  });

  test('adjacent IDs that round to the same Number cannot impersonate a publication',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.deadbeef`,time=new Date(1_700_000_000_000);
      fs.writeFileSync(target,'{"value":"retained"}\n',{mode:0o600});
      fs.writeFileSync(temporary,'{"value":"retained"}\n',{mode:0o600});
      fs.utimesSync(target,time,time);fs.utimesSync(temporary,time,time);
      fs.linkSync(target,path.join(dir,'other'));fs.linkSync(temporary,path.join(dir,'another'));
      const original=fs.lstatSync(target,{bigint:true}),foreign=fs.lstatSync(temporary,{bigint:true});
      expect(foreign.ino-original.ino).toBe(1n);
      expect(Number(foreign.ino)).toBe(Number(original.ino));
      let failure:unknown;try{recoverAtomicNoReplaceJson(target,{label:'Synthetic publication',maxBytes:4096});}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'UNSAFE_PATH'});
      expect(fs.existsSync(temporary)).toBe(true);
      expect(fs.readFileSync(target,'utf8')).toBe('{"value":"retained"}\n');
    }finally{restore();}
  });

  test('atomic recovery rejects a same-millisecond timestamp change while the file is opened',()=>{
    const dir=tmp(),target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.deadbeef`,fstat=fs.fstatSync;
    fs.writeFileSync(temporary,'{"value":"retained"}\n',{mode:0o600});fs.linkSync(temporary,target);
    fs.utimesSync(target,1_700_000_000.0001,1_700_000_000.0001);
    let injected=false,failure:unknown;
    const reader=spyOn(fs,'fstatSync').mockImplementation(((fd:any,options?:any)=>{
      const stat=fstat(fd,options);
      if(injected||options?.bigint!==true)return stat;
      injected=true;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{mtimeNs:stat.mtimeMs*1_000_000n+600_000n});
    }) as typeof fs.fstatSync);
    try{recoverAtomicNoReplaceJson(target,{label:'Synthetic publication',maxBytes:4096});}catch(error){failure=error;}finally{reader.mockRestore();}
    expect(injected).toBe(true);
    expect(failure).toMatchObject({code:'SNAPSHOT_RACE'});
    expect(fs.existsSync(temporary)).toBe(true);
  });
});
