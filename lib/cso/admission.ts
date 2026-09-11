import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { CsoError, sha256 } from './contracts';
import { discardAtomicNoReplaceTemp, recoverAtomicNoReplaceJson, secureDirectory } from './state';
import { atomicWriteSync } from '../fs-atomic';

export const GROUP_LIMITS = { cpu: 2, memoryMiB: 4096, pids: 256, writableMiB: 2048, outputBytes: 1024 * 1024 } as const;
export const ROLE_LIMITS = {
  anchor: {cpu:.05,memoryMiB:64,pids:8,writableMiB:16},
  app: {cpu:.85,memoryMiB:2304,pids:96,writableMiB:1264},
  verifier: {cpu:.55,memoryMiB:512,pids:32,writableMiB:256},
  tests: {cpu:.55,memoryMiB:1280,pids:64,writableMiB:1024},
  postgres: {cpu:.25,memoryMiB:1024,pids:96,writableMiB:512},
  browser: {cpu:.30,memoryMiB:512,pids:16,writableMiB:256},
} as const;
export type Role = keyof typeof ROLE_LIMITS;
export interface Lease { endpoint: string; slot: number; path: string; runId: string; ownerPid: number; expiresAt: number; token:string; supervised:boolean }
function alive(pid: number): boolean { try { process.kill(pid,0); return true; } catch { return false; } }
function processIdentity(pid:number):string|undefined{if(process.platform!=='linux')return;try{const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),tail=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);return /^\d+$/.test(tail[19]??'')?`linux:${tail[19]}`:undefined;}catch{return;}}
function sameDirectory(left:fs.Stats,right:fs.Stats):boolean{return left.dev===right.dev&&left.ino===right.ino&&left.uid===right.uid&&left.mode===right.mode;}
function sameFile(left:fs.Stats,right:fs.Stats):boolean{return left.dev===right.dev&&left.ino===right.ino&&left.uid===right.uid&&left.mode===right.mode&&left.nlink===right.nlink;}
function privateDirectory(path:string,label:string):fs.Stats{const stat=fs.lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)throw new CsoError('UNSAFE_PATH',`${label} is not a private owned directory`);return stat;}
function privateFile(path:string,label:string):fs.Stats{const stat=fs.lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0||stat.size>1024*1024)throw new CsoError('UNSAFE_PATH',`${label} is not a private regular file`);return stat;}
type Claim={path:string;token:string;identity:fs.Stats;pid:number;processIdentity:string|null};
type ClaimOwner={pid:number;processIdentity:string|null;token:string;createdAt:number};
function validateClaimOwner(value:unknown,expectedToken?:string,publisherPid?:number):ClaimOwner{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CsoError('INCOMPATIBLE_INPUT','Reproduction recovery owner is invalid');
  const owner=value as Record<string,unknown>;
  if(Object.keys(owner).sort().join(',')!=='createdAt,pid,processIdentity,token'||!Number.isSafeInteger(owner.pid)||Number(owner.pid)<=1||
    typeof owner.token!=='string'||!/^[a-f0-9]{32}$/.test(owner.token)||(expectedToken!==undefined&&owner.token!==expectedToken)||
    !Number.isFinite(owner.createdAt)||Number(owner.createdAt)<0||!(owner.processIdentity===null||(typeof owner.processIdentity==='string'&&/^linux:\d+$/.test(owner.processIdentity)))||
    (publisherPid!==undefined&&Number(owner.pid)!==publisherPid))throw new CsoError('INCOMPATIBLE_INPUT','Reproduction recovery owner is invalid');
  return{pid:Number(owner.pid),processIdentity:owner.processIdentity as string|null,token:owner.token,createdAt:Number(owner.createdAt)};
}
function inspectClaim(path:string,expectedToken?:string):Claim{
  const before=privateFile(path,'Reproduction recovery claim');if(before.size<=0||before.size>4096)throw new CsoError('UNSAFE_PATH','Reproduction recovery claim has an invalid size');
  let owner:any;try{owner=JSON.parse(fs.readFileSync(path,'utf8'));}catch{throw new CsoError('INCOMPATIBLE_INPUT','Reproduction recovery owner is invalid');}
  const after=privateFile(path,'Reproduction recovery claim');if(!sameFile(before,after))throw new CsoError('INCOMPATIBLE_INPUT','Reproduction recovery owner is invalid');
  owner=validateClaimOwner(owner,expectedToken);
  return{path,token:owner.token,identity:after,pid:owner.pid,processIdentity:owner.processIdentity};
}
function releaseClaim(claim:Claim):void{
  const current=inspectClaim(claim.path,claim.token);if(!sameFile(current.identity,claim.identity))throw new CsoError('PERSISTENCE_FAILED','Reproduction recovery ownership changed');
  const final=privateFile(claim.path,'Reproduction recovery claim');if(!sameFile(final,claim.identity))throw new CsoError('PERSISTENCE_FAILED','Reproduction recovery ownership changed');
  fs.unlinkSync(claim.path);
}
function acquireClaim(parent:string,expected:fs.Stats):Claim{
  const path=join(parent,'.recovery'),assertParent=()=>{const current=privateDirectory(parent,'Reproduction lease slot');if(!sameDirectory(expected,current))throw new CsoError('INSUFFICIENT_CAPACITY','Reproduction lease changed during recovery');};
  const recoverPublications=()=>{
    const pattern=/^\.recovery\.tmp\.(\d{1,10})\.[a-f0-9]{8}$/;
    for(const name of fs.readdirSync(parent)){
      const match=name.match(pattern);if(!match)continue;
      const publisherPid=Number(match[1]),temporary=join(parent,name),options={label:'Reproduction recovery claim',maxBytes:4096,
        validate:(value:unknown,pid:number)=>{validateClaimOwner(value,undefined,pid);}};
      assertParent();if(fs.existsSync(path))recoverAtomicNoReplaceJson(path,options);if(fs.existsSync(temporary))discardAtomicNoReplaceTemp(temporary,publisherPid,options);assertParent();
    }
  };
  for(let attempt=0;attempt<64;attempt++){
    assertParent();recoverPublications();const token=randomBytes(16).toString('hex');
    try{
      atomicWriteSync(path,JSON.stringify({pid:process.pid,processIdentity:processIdentity(process.pid)??null,token,createdAt:Date.now()})+'\n',{mode:0o600,noReplace:true});
      const claim=inspectClaim(path,token);try{assertParent();}catch(error){try{releaseClaim(claim);}catch{}throw error;}return claim;
    }catch(error:any){
      if(error instanceof CsoError)throw error;
      if(error?.code!=='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Reproduction recovery claim could not be created');
    }
    assertParent();const observed=inspectClaim(path),isAlive=alive(observed.pid),identity=isAlive?processIdentity(observed.pid):undefined;
    if(isAlive&&!(typeof observed.processIdentity==='string'&&identity!==undefined&&identity!==observed.processIdentity))throw new CsoError('INSUFFICIENT_CAPACITY','Another helper is recovering the reproduction lease');
    try{releaseClaim(observed);}catch(error){if(error instanceof CsoError&&error.code==='PERSISTENCE_FAILED')continue;throw error;}
  }
  throw new CsoError('INSUFFICIENT_CAPACITY','Reproduction recovery claim changed repeatedly');
}
/** One host-user pool shared by every workspace/state root on this machine. */
export function machinePoolRoot():string{
  const uid=process.getuid?.()??userInfo().uid;
  return secureDirectory(join(fs.realpathSync(tmpdir()),`gstack-cso-pool-${uid}`));
}
function reclaimSlot(path:string,pool:string,slot:number,observed:fs.Stats,expectedToken?:string):boolean{
  let claim:Claim;try{claim=acquireClaim(path,observed);}catch(error){if(error instanceof CsoError&&error.code==='INSUFFICIENT_CAPACITY')return false;throw error;}
  try{const current=privateDirectory(path,'Reproduction lease slot');if(!sameDirectory(observed,current)){releaseClaim(claim);return false;}if(expectedToken){privateFile(join(path,'lease.json'),'Reproduction lease');const lease=JSON.parse(fs.readFileSync(join(path,'lease.json'),'utf8'));if(lease.token!==expectedToken){releaseClaim(claim);return false;}}
    const tomb=join(pool,`.slot-${slot}.stale-${process.pid}-${randomBytes(8).toString('hex')}`);fs.renameSync(path,tomb);const moved=privateDirectory(tomb,'Reproduction lease tomb');if(!sameDirectory(observed,moved))throw new CsoError('SNAPSHOT_RACE','Reproduction lease changed while quarantined');fs.mkdirSync(path,{mode:0o700});releaseClaim({...claim,path:join(tomb,'.recovery')});for(const name of fs.readdirSync(tomb)){if(!['lease.json','lease.token'].includes(name)&&!/^lease\.json\.tmp\.\d+\.[a-f0-9]{8}$/.test(name)&&!/^\.recovery\.tmp\.\d+\.[a-f0-9]{8}$/.test(name))throw new CsoError('UNSAFE_PATH','Stale reproduction lease contains an unexpected object');privateFile(join(tomb,name),'Stale reproduction lease file');fs.unlinkSync(join(tomb,name));}fs.rmdirSync(tomb);return true;
  }catch(error){if(error instanceof CsoError)throw error;return false;}
}
function slotControl(pool:string,slot:number):{path:string;stat:fs.Stats}{
  const path=join(pool,`.slot-${slot}.control`);
  try{fs.mkdirSync(path,{mode:0o700});}catch(error:any){if(error?.code!=='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Reproduction slot control directory could not be created');}
  const stat=privateDirectory(path,'Reproduction slot control directory');for(const name of fs.readdirSync(path))if(name!=='.recovery'&&!/^\.recovery\.tmp\.\d+\.[a-f0-9]{8}$/.test(name))throw new CsoError('UNSAFE_PATH','Reproduction slot control directory contains an unexpected object');return{path,stat};
}
function writeLease(lease:Lease):void{
  const keys=Object.keys(lease).sort().join(','),expected='endpoint,expiresAt,ownerPid,path,runId,slot,supervised,token';
  if(keys!==expected||!/^unix:\/\/[/.A-Za-z0-9_-]+$/.test(lease.endpoint)||![0,1].includes(lease.slot)||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(lease.runId)||lease.ownerPid!==process.pid||!Number.isSafeInteger(lease.expiresAt)||
    !/^[a-f0-9]{32}$/.test(lease.token)||typeof lease.supervised!=='boolean')
    throw new CsoError('PERSISTENCE_FAILED','Reproduction lease metadata is invalid');
  const expectedPath=join(machinePoolRoot(),sha256(lease.endpoint).slice(0,24),`slot-${lease.slot}`);
  if(lease.path!==expectedPath)throw new CsoError('PERSISTENCE_FAILED','Reproduction lease path is invalid');
  // This exact helper-owned schema contains only control metadata. In
  // particular, its random capability may resemble a wallet address and must
  // remain byte-identical to lease.token; untrusted reports still use writeJson.
  atomicWriteSync(join(lease.path,'lease.json'),JSON.stringify(lease)+'\n',{mode:0o600});
}
export function admit(endpoint: string, runId: string, deadline: number): Lease {
  if (!/^unix:\/\/[/.A-Za-z0-9_-]+$/.test(endpoint)) throw new CsoError('ISOLATION_FAILED','Only a pinned local Unix Docker endpoint is admitted on this host');
  const pool = secureDirectory(join(machinePoolRoot(),sha256(endpoint).slice(0,24)));
  for (let slot=0;slot<2;slot++) {
    const path=join(pool,`slot-${slot}`),control=slotControl(pool,slot);let mutation:Claim;
    try{mutation=acquireClaim(control.path,control.stat);}catch(error){if(error instanceof CsoError&&error.code==='INSUFFICIENT_CAPACITY')continue;throw error;}
    try{
      try {
        fs.mkdirSync(path,{mode:0o700});
      } catch(error:any) {
        if(error?.code!=='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Reproduction lease slot could not be created');
        try {
          const observed=privateDirectory(path,'Reproduction lease slot');
          const old = JSON.parse(fs.readFileSync(join(path,'lease.json'),'utf8'));
          // A supervised lease is removed only after its watchdog or owner has
          // confirmed exact-resource cleanup. This preserves the two-group cap
          // through supervisor death and daemon outages.
          if (old.supervised === true || (typeof old.ownerPid === 'number' && alive(old.ownerPid))) continue;
          // Unsupervised stale slots cannot have created containers: supervision
          // is acknowledged before the anchor create call.
          if(!reclaimSlot(path,pool,slot,observed,typeof old.token==='string'?old.token:undefined))continue;
        } catch(recoveryError) {
          if(recoveryError instanceof CsoError)throw recoveryError;
          // No live initializer can publish into this path while this stable
          // slot-control claim is held. Recover a crashed partial publication
          // only after the compatibility grace period.
          let stat:fs.Stats;try{stat=privateDirectory(path,'Reproduction lease slot');}catch(statError){if(statError instanceof CsoError)throw statError;continue;}
          if(Date.now()-stat.mtimeMs<=5000)continue;
          if(!reclaimSlot(path,pool,slot,stat))continue;
        }
      }
      // Both authenticated records become visible as one logical publication
      // when the stable slot-control claim is released.
      const lease:Lease={endpoint,slot,path,runId,ownerPid:process.pid,expiresAt:deadline,token:randomBytes(16).toString('hex'),supervised:false};writeLease(lease);fs.writeFileSync(join(path,'lease.token'),lease.token+'\n',{mode:0o600,flag:'wx'});return lease;
    }finally{releaseClaim(mutation);}
  }
  throw new CsoError('INSUFFICIENT_CAPACITY','Two reproduction groups are already admitted for this Docker endpoint');
}
export function markSupervised(lease:Lease):void{
  const current=JSON.parse(fs.readFileSync(join(lease.path,'lease.json'),'utf8'));
  if(current.token!==lease.token||current.ownerPid!==lease.ownerPid)throw new CsoError('INSUFFICIENT_CAPACITY','Reproduction lease changed before watchdog supervision');
  lease.supervised=true;writeLease(lease);
}
export function release(lease: Lease): void {
  let observed:fs.Stats;try{observed=privateDirectory(lease.path,'Reproduction lease slot');}catch(error:any){if(error?.code==='ENOENT')throw new CsoError('PERSISTENCE_FAILED','Exact reproduction lease was already missing');throw error;}
  const claim=acquireClaim(lease.path,observed);
  try{
    const currentStat=privateDirectory(lease.path,'Reproduction lease slot');if(!sameDirectory(observed,currentStat))throw new CsoError('PERSISTENCE_FAILED','Reproduction lease changed before exact release');
    const names=fs.readdirSync(lease.path).filter(name=>name!=='.recovery'&&!/^\.recovery\.tmp\.\d+\.[a-f0-9]{8}$/.test(name)).sort();if(names.join('\0')!=='lease.json\0lease.token')throw new CsoError('PERSISTENCE_FAILED','Reproduction lease contents changed before exact release');
    privateFile(join(lease.path,'lease.json'),'Reproduction lease');privateFile(join(lease.path,'lease.token'),'Reproduction lease token');
    const current=JSON.parse(fs.readFileSync(join(lease.path,'lease.json'),'utf8')),token=fs.readFileSync(join(lease.path,'lease.token'),'utf8').trim();
    if(current.runId!==lease.runId||current.ownerPid!==lease.ownerPid||current.token!==lease.token||token!==lease.token)throw new CsoError('PERSISTENCE_FAILED','Reproduction lease ownership changed before exact release');
    fs.unlinkSync(join(lease.path,'lease.token'));fs.unlinkSync(join(lease.path,'lease.json'));releaseClaim(claim);fs.rmdirSync(lease.path);
    if(fs.existsSync(lease.path))throw new CsoError('PERSISTENCE_FAILED','Exact reproduction lease removal could not be proven');
  }catch(error){try{if(fs.existsSync(claim.path))releaseClaim(claim);}catch{}if(error instanceof CsoError)throw error;throw new CsoError('PERSISTENCE_FAILED','Exact reproduction lease removal failed');}
}
export function total(roles: Role[]) {
  const value = roles.reduce((a,r) => ({cpu:a.cpu+ROLE_LIMITS[r].cpu,memoryMiB:a.memoryMiB+ROLE_LIMITS[r].memoryMiB,pids:a.pids+ROLE_LIMITS[r].pids,writableMiB:a.writableMiB+ROLE_LIMITS[r].writableMiB}), {cpu:0,memoryMiB:0,pids:0,writableMiB:0});
  if (value.cpu > GROUP_LIMITS.cpu || value.memoryMiB > GROUP_LIMITS.memoryMiB || value.pids > GROUP_LIMITS.pids || value.writableMiB > GROUP_LIMITS.writableMiB)
    throw new CsoError('INSUFFICIENT_CAPACITY','Requested sidecars exceed the aggregate reproduction-group limit');
  return value;
}
