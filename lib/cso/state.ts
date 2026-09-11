import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, parse, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteSync } from '../fs-atomic';
import { CsoError, RunReportV3, canonical, completeness, fingerprint, renderReport, sha256 } from './contracts';
import { redact, sanitizeForJson, sanitizeHelperForJson } from './process';
const MAX_STATE_FILE=1024*1024;

type AtomicRecoveryIdentity={dev:number;ino:number;nlink:number;size:number;mode:number;uid:number;mtimeMs:number;ctimeMs:number};
export interface AtomicNoReplaceRecoveryOptions {
  label:string;maxBytes:number;
  validate?:(value:unknown,publisherPid:number)=>void;
  publisherAlive?:(value:unknown,publisherPid:number)=>boolean;
}
class AtomicPublicationTransition extends CsoError { constructor(message:string){super('SNAPSHOT_RACE',message);this.name='AtomicPublicationTransition';} }
function recoveryIdentity(stat:fs.Stats):AtomicRecoveryIdentity{return{dev:stat.dev,ino:stat.ino,nlink:stat.nlink,size:stat.size,mode:stat.mode,uid:stat.uid,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};}
function sameRecoveryIdentity(left:AtomicRecoveryIdentity,right:AtomicRecoveryIdentity):boolean{return left.dev===right.dev&&left.ino===right.ino&&left.nlink===right.nlink&&left.size===right.size&&left.mode===right.mode&&left.uid===right.uid&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs;}
function recoveryProcessAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(error:any){return error?.code==='EPERM';}}
function liveRecognizedPublication(temp:string,target:string,pid:number,options:AtomicNoReplaceRecoveryOptions):boolean{
  if(!recoveryProcessAlive(pid))return false;
  try{const temporary=fs.lstatSync(temp);if(temporary.isSymbolicLink()||!temporary.isFile()||temporary.nlink<1||temporary.nlink>2||(process.getuid&&temporary.uid!==process.getuid())||(process.platform!=='win32'&&(temporary.mode&0o077)!==0))return false;if(temporary.size===0)return temporary.nlink===1;if(temporary.nlink!==2||!privatePublicationFile(temporary,options))return false;const published=fs.lstatSync(target);return published.nlink===2&&samePublicationInode(temporary,published,options);}catch{return false;}
}
function liveEmptyPublication(path:string,pid:number):boolean{if(!recoveryProcessAlive(pid))return false;try{const stat=fs.lstatSync(path);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size===0&&stat.nlink===1&&(!process.getuid||stat.uid===process.getuid())&&(process.platform==='win32'||(stat.mode&0o077)===0);}catch{return false;}}
function privatePublicationObservation(stat:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{return stat.isFile()&&!stat.isSymbolicLink()&&stat.size>=0&&stat.size<=options.maxBytes&&stat.nlink>=1&&stat.nlink<=2&&(!process.getuid||stat.uid===process.getuid())&&(process.platform==='win32'||(stat.mode&0o077)===0);}
function livePublicationAdvanced(temp:string,pid:number,observed:fs.Stats|undefined,options:AtomicNoReplaceRecoveryOptions):boolean{
  if(!observed||!privatePublicationObservation(observed,options)||!recoveryProcessAlive(pid))return false;
  Atomics.wait(LEASE_ELECTION_WAIT,0,0,LEASE_ELECTION_POLL_MS);
  let current:fs.Stats;try{current=fs.lstatSync(temp);}catch(error:any){return error?.code==='ENOENT';}
  if(!privatePublicationObservation(current,options)||current.dev!==observed.dev||current.ino!==observed.ino)return false;
  if(current.nlink!==observed.nlink||current.size!==observed.size)return true;
  return false;
}
function publicationOwnerAlive(value:unknown,publisherPid:number,options:AtomicNoReplaceRecoveryOptions):boolean{return options.publisherAlive?.(value,publisherPid)??recoveryProcessAlive(publisherPid);}
function privatePublicationFile(stat:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{return stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=options.maxBytes&&
  (!process.getuid||stat.uid===process.getuid())&&(process.platform==='win32'||(stat.mode&0o077)===0);}
function samePublicationObject(left:fs.Stats,right:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{return privatePublicationFile(left,options)&&privatePublicationFile(right,options)&&
  left.dev===right.dev&&left.ino===right.ino&&left.size===right.size&&left.mode===right.mode&&left.uid===right.uid;}
function samePublicationInode(left:fs.Stats,right:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{return samePublicationObject(left,right,options)&&left.mtimeMs===right.mtimeMs;}
function publicationLinkTransition(observed:fs.Stats,current:fs.Stats,links:1|2,options:AtomicNoReplaceRecoveryOptions):boolean{
  const from=links===1?1:2,to=links===1?2:1;
  return observed.nlink===from&&current.nlink===to&&samePublicationInode(observed,current,options);
}
function publicationPathRemoved(observed:fs.Stats,current:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{return observed.nlink>=1&&observed.nlink<=2&&current.nlink>=0&&current.nlink<observed.nlink&&samePublicationObject(observed,current,options);}
function publicationProgress(left:fs.Stats,right:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{return left.nlink>=0&&left.nlink<=2&&right.nlink>=0&&right.nlink<=2&&left.nlink!==right.nlink&&samePublicationInode(left,right,options);}
function atomicTempTarget(path:string,publisherPid?:number):{target:string;pid:number}|undefined{
  const match=basename(path).match(/^(.*)\.tmp\.(\d{1,10})\.[a-f0-9]{8}$/),pid=match?Number(match[2]):0;
  return match&&match[1]&&Number.isSafeInteger(pid)&&pid>1&&(publisherPid===undefined||pid===publisherPid)?{target:join(dirname(path),match[1]),pid}:undefined;
}
function settledAtomicTemp(path:string,observed:fs.Stats,options:AtomicNoReplaceRecoveryOptions):boolean{
  const publication=atomicTempTarget(path);if(!publication)return false;
  let target:fs.Stats;try{target=fs.lstatSync(publication.target);}catch{return false;}
  return observed.nlink>=1&&observed.nlink<=2&&target.nlink===1&&privatePublicationFile(observed,options)&&privatePublicationFile(target,options)&&
    observed.dev===target.dev&&observed.ino===target.ino&&observed.size===target.size&&observed.mode===target.mode&&observed.uid===target.uid&&observed.mtimeMs===target.mtimeMs;
}
function readPublicationBytes(fd:number,size:number,label:string):string{
  const bytes=Buffer.alloc(size);let offset=0;
  while(offset<size){const count=fs.readSync(fd,bytes,offset,size-offset,offset);if(count<=0)throw new CsoError('SNAPSHOT_RACE',`${label} interrupted publication changed while it was read`);offset+=count;}
  const extra=Buffer.alloc(1);if(fs.readSync(fd,extra,0,1,size)!==0)throw new CsoError('SNAPSHOT_RACE',`${label} interrupted publication changed while it was read`);
  return bytes.toString('utf8');
}
function recoveryJson(path:string,links:1|2,options:AtomicNoReplaceRecoveryOptions,observed?:fs.Stats):{identity:AtomicRecoveryIdentity;value:unknown}{
  let fd:number|undefined;
  try{
    const before=fs.lstatSync(path);
    if(before.nlink===0){
      let current:fs.Stats;try{current=fs.lstatSync(path);}catch(error:any){if(error?.code==='ENOENT')throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} was removed while it was inspected`);throw error;}
      if(samePublicationInode(before,current,options)&&(current.nlink===0||current.nlink===links))throw new AtomicPublicationTransition(`${options.label} changed link state while it was inspected`);
      throw new CsoError('UNSAFE_PATH',`${options.label} was replaced while it was inspected`);
    }
    if(observed&&publicationLinkTransition(observed,before,links,options))throw new AtomicPublicationTransition(`${options.label} interrupted publication changed link state`);
    if(observed&&publicationProgress(observed,before,options)&&!sameRecoveryIdentity(recoveryIdentity(observed),recoveryIdentity(before)))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} changed phase during concurrent recovery`);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==links||before.size<=0||before.size>options.maxBytes||
      (process.getuid&&before.uid!==process.getuid())||(process.platform!=='win32'&&(before.mode&0o077)!==0))
      throw new CsoError('UNSAFE_PATH',`${options.label} interrupted publication is not one private regular file`);
    fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const opened=fs.fstatSync(fd);
    if(!sameRecoveryIdentity(recoveryIdentity(before),recoveryIdentity(opened))){
      if(publicationLinkTransition(before,opened,links,options))throw new AtomicPublicationTransition(`${options.label} interrupted publication changed link state while it was opened`);
      if(publicationProgress(before,opened,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} changed phase during concurrent recovery while it was opened`);
      throw new CsoError('SNAPSHOT_RACE',`${options.label} interrupted publication changed while it was opened`);
    }
    const serialized=readPublicationBytes(fd,opened.size,options.label);let value:unknown;try{value=JSON.parse(serialized);}catch{throw new CsoError('UNSAFE_PATH',`${options.label} interrupted publication is not valid JSON`);}
    const final=fs.fstatSync(fd);if(readPublicationBytes(fd,opened.size,options.label)!==serialized)throw new CsoError('SNAPSHOT_RACE',`${options.label} interrupted publication changed while it was read`);let after:fs.Stats;try{after=fs.lstatSync(path);}catch(error:any){if(error?.code==='ENOENT'&&publicationPathRemoved(opened,final,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} was removed by another recovery helper while it was read`);throw error;}const openedIdentity=recoveryIdentity(opened),finalIdentity=recoveryIdentity(final),afterIdentity=recoveryIdentity(after);
    if(!sameRecoveryIdentity(openedIdentity,finalIdentity)||!sameRecoveryIdentity(openedIdentity,afterIdentity)){
      const coherentTransition=(sameRecoveryIdentity(openedIdentity,finalIdentity)&&publicationLinkTransition(opened,after,links,options))||
        (publicationLinkTransition(opened,final,links,options)&&sameRecoveryIdentity(finalIdentity,afterIdentity));
      if(coherentTransition)throw new AtomicPublicationTransition(`${options.label} interrupted publication changed link state while it was read`);
      if(publicationProgress(opened,final,options)&&publicationProgress(final,after,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} changed phase during concurrent recovery while it was read`);
      throw new CsoError('SNAPSHOT_RACE',`${options.label} interrupted publication changed while it was read`);
    }
    return{identity:recoveryIdentity(opened),value};
  }catch(error:any){if(error instanceof CsoError)throw error;if(error?.code==='ENOENT'){if(observed&&settledAtomicTemp(path,observed,options))throw new AtomicPublicationTransition(`${options.label} interrupted publication settled while it was observed`);if(observed&&!fs.existsSync(path))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} was removed by another recovery helper`);throw new CsoError('SNAPSHOT_RACE',`${options.label} interrupted publication disappeared`);}throw new CsoError('UNSAFE_PATH',`${options.label} interrupted publication could not be validated`);}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function atomicTempCandidates(target:string):Array<{path:string;pid:number}>{
  const directory=dirname(target),name=basename(target),escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(`^${escaped}\\.tmp\\.(\\d{1,10})\\.([a-f0-9]{8})$`);
  return fs.readdirSync(directory).flatMap(entry=>{const match=entry.match(pattern),pid=match?Number(match[1]):0;return match&&Number.isSafeInteger(pid)&&pid>1?[{path:join(directory,entry),pid}]:[];});
}
function matchesRecoveryInode(stat:fs.Stats,identity:AtomicRecoveryIdentity,options:AtomicNoReplaceRecoveryOptions):boolean{return privatePublicationFile(stat,options)&&stat.dev===identity.dev&&stat.ino===identity.ino&&stat.size===identity.size&&stat.mode===identity.mode&&stat.uid===identity.uid&&stat.mtimeMs===identity.mtimeMs;}
/** Recover only the hard-link publication window of atomicWriteSync(noReplace). */
export function recoverAtomicNoReplaceJson(target:string,options:AtomicNoReplaceRecoveryOptions):void{
  let targetStat:fs.Stats;try{targetStat=fs.lstatSync(target);}catch(error:any){if(error?.code==='ENOENT')return;throw new CsoError('UNSAFE_PATH',`${options.label} could not be inspected`);}
  // Callers own legacy-directory and special-file handling. Only a regular
  // file can be the no-replace hard-link publication this helper recognizes.
  if(!targetStat.isFile()||targetStat.isSymbolicLink())return;
  if(targetStat.nlink===1)return;
  if(targetStat.nlink===0){
    let current:fs.Stats;try{current=fs.lstatSync(target);}catch(error:any){if(error?.code==='ENOENT')throw new AtomicPublicationTransition(`${options.label} was removed while it was inspected`);throw new CsoError('UNSAFE_PATH',`${options.label} could not be reinspected`);}
    if(samePublicationInode(targetStat,current,options)&&current.nlink>=0&&current.nlink<=2)throw new AtomicPublicationTransition(`${options.label} changed link state while it was inspected`);
    throw new CsoError('UNSAFE_PATH',`${options.label} was replaced while it was inspected`);
  }
  if(targetStat.nlink!==2)throw new CsoError('UNSAFE_PATH',`${options.label} has an unrecognized hard-link count`);
  const canonical=recoveryJson(target,2,options,targetStat),matches=atomicTempCandidates(target).flatMap(candidate=>{try{const observed=fs.lstatSync(candidate.path);return observed.dev===canonical.identity.dev&&observed.ino===canonical.identity.ino?[{...candidate,observed}]:[];}catch{return[];}});
  if(matches.length!==1){
    let settled:fs.Stats|undefined;try{settled=fs.lstatSync(target);}catch{}
    if(settled&&publicationLinkTransition(targetStat,settled,2,options))throw new AtomicPublicationTransition(`${options.label} interrupted publication settled during candidate enumeration`);
    throw new CsoError('UNSAFE_PATH',`${options.label} hard link does not match one recognized interrupted publication`);
  }
  const candidate=matches[0],temporary=recoveryJson(candidate.path,2,options,candidate.observed);
  if(!sameRecoveryIdentity(canonical.identity,temporary.identity))throw new CsoError('UNSAFE_PATH',`${options.label} hard link changed identity`);
  options.validate?.(canonical.value,candidate.pid);options.validate?.(temporary.value,candidate.pid);
  if(publicationOwnerAlive(canonical.value,candidate.pid,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} publication is still owned by a live helper`);
  let finalTarget:fs.Stats,finalTemp:fs.Stats;
  try{finalTarget=fs.lstatSync(target);finalTemp=fs.lstatSync(candidate.path);}catch(error:any){
    if(error?.code!=='ENOENT')throw error;
    for(const path of [target,candidate.path]){try{const stat=fs.lstatSync(path);if(!matchesRecoveryInode(stat,canonical.identity,options))throw new CsoError('UNSAFE_PATH',`${options.label} was replaced during concurrent recovery`);}catch(recoveryError:any){if(recoveryError instanceof CsoError)throw recoveryError;if(recoveryError?.code!=='ENOENT')throw recoveryError;}}
    throw new AtomicPublicationTransition(`${options.label} was settled by another recovery helper`);
  }
  if(!sameRecoveryIdentity(canonical.identity,recoveryIdentity(finalTarget))||!sameRecoveryIdentity(canonical.identity,recoveryIdentity(finalTemp))){
    if(matchesRecoveryInode(finalTarget,canonical.identity,options)&&matchesRecoveryInode(finalTemp,canonical.identity,options)&&finalTarget.nlink<=2&&finalTemp.nlink<=2)throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} hard link changed during concurrent recovery`);
    throw new CsoError('SNAPSHOT_RACE',`${options.label} hard link changed before recovery`);
  }
  try{fs.unlinkSync(candidate.path);}catch(error:any){if(error?.code!=='ENOENT')throw new CsoError('PERSISTENCE_FAILED',`${options.label} interrupted publication could not be recovered`);}
  let recovered:{identity:AtomicRecoveryIdentity;value:unknown};try{recovered=recoveryJson(target,1,options);}catch(error){
    if(error instanceof CsoError&&error.code==='SNAPSHOT_RACE'&&!fs.existsSync(target))throw new AtomicPublicationTransition(`${options.label} was removed by another recovery helper`);
    throw error;
  }
  options.validate?.(recovered.value,candidate.pid);
  if(recovered.identity.dev!==canonical.identity.dev||recovered.identity.ino!==canonical.identity.ino)throw new CsoError('UNSAFE_PATH',`${options.label} changed identity during recovery`);
}

/** Remove a never-published temp, or validate a temp that became published while observed. */
export function discardAtomicNoReplaceTemp(path:string,publisherPid:number,options:AtomicNoReplaceRecoveryOptions):void{
  let observed:fs.Stats;try{observed=fs.lstatSync(path);}catch(error:any){
    if(error?.code==='ENOENT'){
      const publication=atomicTempTarget(path,publisherPid);
      if(publication){
        try{const settled=recoveryJson(publication.target,1,options);options.validate?.(settled.value,publisherPid);if(publicationOwnerAlive(settled.value,publisherPid,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} publication is still owned by a live helper`);return;}catch(settledError){if(settledError instanceof CsoError&&settledError.code==='SNAPSHOT_RACE'&&!fs.existsSync(publication.target))return;if(settledError instanceof CsoError)throw settledError;}
      }
      throw new CsoError('SNAPSHOT_RACE',`${options.label} interrupted publication disappeared`);
    }
    throw new CsoError('UNSAFE_PATH',`${options.label} interrupted publication could not be inspected`);
  }
  if(observed.nlink===2&&privatePublicationFile(observed,options)){
    const target=atomicTempTarget(path,publisherPid)?.target;
    let published:fs.Stats|undefined;try{if(target)published=fs.lstatSync(target);}catch{}
    if(target&&published&&published.dev===observed.dev&&published.ino===observed.ino&&published.nlink===2&&privatePublicationFile(published,options)){
      recoverAtomicNoReplaceJson(target,options);
      const settled=recoveryJson(target,1,options);
      if(settled.identity.dev!==observed.dev||settled.identity.ino!==observed.ino)throw new CsoError('UNSAFE_PATH',`${options.label} published target changed identity while it settled`);
      options.validate?.(settled.value,publisherPid);
      if(publicationOwnerAlive(settled.value,publisherPid,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} publication is still owned by a live helper`);
      return;
    }
  }
  const temporary=recoveryJson(path,1,options,observed);options.validate?.(temporary.value,publisherPid);
  if(publicationOwnerAlive(temporary.value,publisherPid,options))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} publication is still owned by a live helper`);
  let final:fs.Stats;try{final=fs.lstatSync(path);}catch(error:any){if(error?.code==='ENOENT')throw new AtomicPublicationTransition(`${options.label} temp was removed by another recovery helper`);throw error;}
  if(!sameRecoveryIdentity(temporary.identity,recoveryIdentity(final)))throw new CsoError('SNAPSHOT_RACE',`${options.label} temp changed before recovery`);
  try{fs.unlinkSync(path);}catch(error:any){if(error?.code==='ENOENT')throw new AtomicPublicationTransition(`${options.label} temp was removed by another recovery helper`);throw new CsoError('PERSISTENCE_FAILED',`${options.label} unpublished temp could not be removed`);}
}

export function stateRoot(env: Record<string,string|undefined> = process.env): string {
  // Mirrors bin/gstack-paths. Security artifacts are intentionally outside every sync allowlist.
  const userHome=env.HOME||(process.platform==='win32'?env.USERPROFILE:'');
  return resolve(env.GSTACK_HOME || (env.CLAUDE_PLUGIN_ROOT?.toLowerCase().includes('gstack') ? env.CLAUDE_PLUGIN_DATA : '') || join(userHome || '.', '.gstack'));
}
function ensureDirectory(path:string,hardenExistingLeaf:boolean):string{
  const p=resolve(path),root=parse(p).root;
  if(p===root)throw new CsoError('UNSAFE_PATH','Private state cannot use a filesystem root');
  let cursor=root,leafCreated=false;
  for (const part of relative(root,p).split(sep).filter(Boolean)) {
    cursor = join(cursor,part);
    let created=false;
    try{fs.mkdirSync(cursor,{mode:0o700});created=true;}catch(error:any){if(error?.code!=='EEXIST')throw error;}
    if(cursor===p)leafCreated=created;
    const s = fs.lstatSync(cursor);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new CsoError('UNSAFE_PATH','Private state has a symlink or non-directory ancestor');
    // Root-owned system ancestors are normal; a writable ancestor owned by anyone else is not.
    if (s.uid !== process.getuid?.() && s.uid !== 0) throw new CsoError('UNSAFE_PATH','Private state ancestor has an unexpected owner');
    if (process.platform!=='win32'&&(s.mode & 0o022) && !(s.mode & 0o1000)) throw new CsoError('UNSAFE_PATH','Private state has a group- or world-writable ancestor');
  }
  const s = fs.statSync(p);
  if (process.getuid && s.uid !== process.getuid()) throw new CsoError('UNSAFE_PATH','Private directory must be owned by the current user');
  if(hardenExistingLeaf||leafCreated)fs.chmodSync(p,0o700);
  return p;
}
/** The supplied leaf is CSO-owned. Existing ancestors are validated, never mutated. */
export function secureDirectory(path:string):string{return ensureDirectory(path,true);}
export function privateRoot():string{
  const container=ensureDirectory(stateRoot(),false);
  return secureDirectory(join(container,'security','cso'));
}
export function assertStateOutside(repo:string):void{
  const source=fs.realpathSync(repo),candidate=resolve(stateRoot(),'security','cso');
  const relation=relative(source,candidate);if(relation===''||(!relation.startsWith(`..${sep}`)&&relation!=='..'&&!isAbsolute(relation)))throw new CsoError('UNSAFE_PATH','CSO private state must be outside the audited repository');
}
export function repoId(repo: string): string { return sha256(fs.realpathSync(repo)).slice(0,24); }
export function newRun(repo: string): {runId:string; dir:string; repoId:string} {
  assertStateOutside(repo);
  const id = repoId(repo), runId = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  return {runId, repoId:id, dir:secureDirectory(join(privateRoot(),id,runId))};
}
export function runDirectory(id: string): string {
  if (!/^\d{13}-[a-f0-9]{16}$/.test(id)) throw new CsoError('INVALID_ARGUMENT','Run identifier must be the ID returned by start');
  const root = privateRoot();
  for (const item of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{24}$/.test(item)) continue;
    const dir = join(root,item,id);
    if (fs.existsSync(dir)) return secureDirectory(dir);
  }
  throw new CsoError('MISSING_INPUT','Run was not found or has expired');
}
export function writeJson(path: string, value: unknown): void {
  try {
    secureDirectory(dirname(path));
    if (fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink()) throw new CsoError('UNSAFE_PATH','State file cannot be a symlink');
    const sanitized = JSON.stringify(sanitizeForJson(value),null,2);
    if(Buffer.byteLength(sanitized)+1>MAX_STATE_FILE)throw new CsoError('PERSISTENCE_FAILED','Private state exceeds the 1 MiB persistence limit; the previous artifact was preserved');
    JSON.parse(sanitized); atomicWriteSync(path,sanitized + '\n',{mode:0o600});
  } catch(e) { if (e instanceof CsoError) throw e; throw new CsoError('PERSISTENCE_FAILED','Private report could not be written; no saved report is claimed'); }
}
export function writeHelperJson(path:string,value:unknown):void{
  try{
    secureDirectory(dirname(path));if(fs.existsSync(path)&&fs.lstatSync(path).isSymbolicLink())throw new CsoError('UNSAFE_PATH','State file cannot be a symlink');
    const serialized=JSON.stringify(sanitizeHelperForJson(value),null,2);if(Buffer.byteLength(serialized)+1>MAX_STATE_FILE)throw new CsoError('PERSISTENCE_FAILED','Private helper state exceeds the 1 MiB persistence limit; the previous artifact was preserved');JSON.parse(serialized);atomicWriteSync(path,serialized+'\n',{mode:0o600});
  }catch(error){if(error instanceof CsoError)throw error;throw new CsoError('PERSISTENCE_FAILED','Private helper state could not be written; no saved artifact is claimed');}
}
export function writeJsonExclusive(path:string,value:unknown):void{
  try{
    secureDirectory(dirname(path));
    if(fs.existsSync(path)&&fs.lstatSync(path).isSymbolicLink())throw new CsoError('UNSAFE_PATH','State file cannot be a symlink');
    const sanitized=JSON.stringify(sanitizeHelperForJson(value),null,2);JSON.parse(sanitized);
    if(Buffer.byteLength(sanitized)+1>MAX_STATE_FILE)throw new CsoError('PERSISTENCE_FAILED','Private immutable artifact exceeds the 1 MiB persistence limit');
    atomicWriteSync(path,sanitized+'\n',{mode:0o600,noReplace:true});
  }catch(error:any){
    if(error instanceof CsoError)throw error;
    if(error?.code==='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Immutable artifact already exists; it was not replaced');
    throw new CsoError('PERSISTENCE_FAILED','Private immutable artifact could not be written');
  }
}
function readPrivateJson(path:string):unknown{
  let fd:number|undefined;
  try{
    const before=fs.lstatSync(path);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<=0||before.size>MAX_STATE_FILE||
      (process.getuid&&before.uid!==process.getuid())||(process.platform!=='win32'&&(before.mode&0o077)!==0))
      throw new CsoError('UNSAFE_PATH','Invalid private state file');
    fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(fd);
    if(!sameRecoveryIdentity(recoveryIdentity(before),recoveryIdentity(opened)))
      throw new CsoError('SNAPSHOT_RACE','Private state file changed while it was opened');
    const raw=fs.readFileSync(fd,'utf8');
    const final=fs.fstatSync(fd),after=fs.lstatSync(path);
    if(!sameRecoveryIdentity(recoveryIdentity(opened),recoveryIdentity(final))||
      !sameRecoveryIdentity(recoveryIdentity(opened),recoveryIdentity(after)))
      throw new CsoError('SNAPSHOT_RACE','Private state file changed while it was read');
    try{return JSON.parse(raw);}catch{throw new CsoError('MISSING_INPUT','Private state file is missing or invalid');}
  }catch(error:any){
    if(error instanceof CsoError)throw error;
    if(error?.code==='ENOENT'||error?.code==='ELOOP')throw new CsoError('SNAPSHOT_RACE','Private state file changed while it was opened');
    throw new CsoError('MISSING_INPUT','Private state file is missing or invalid');
  }finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
export function readJson(path: string): any {
  try {
    secureDirectory(dirname(path));recoverAtomicNoReplaceJson(path,{label:'Private immutable artifact',maxBytes:MAX_STATE_FILE});return readPrivateJson(path);
  } catch(e) { if (e instanceof CsoError) throw e; throw new CsoError('MISSING_INPUT','Private state file is missing or invalid'); }
}
export function saveReport(dir: string, report: RunReportV3): void {
  report.completeness = completeness(report);
  const safe=sanitizeHelperForJson(report) as RunReportV3;
  for(const finding of safe.findings){const expected=fingerprint(finding);if(finding.id!==expected||finding.fingerprint!==expected)throw new CsoError('PERSISTENCE_FAILED','Finding identity changed during redaction; the previous report was preserved');}
  try{secureDirectory(dir);const serialized=JSON.stringify(safe,null,2);if(Buffer.byteLength(serialized)+1>MAX_STATE_FILE)throw new CsoError('PERSISTENCE_FAILED','Private state exceeds the 1 MiB persistence limit; the previous artifact was preserved');atomicWriteSync(join(dir,'report.json'),serialized+'\n',{mode:0o600});}catch(error){if(error instanceof CsoError)throw error;throw new CsoError('PERSISTENCE_FAILED','Private report could not be written; no saved report is claimed');}
  try { atomicWriteSync(join(dir,'report.md'),renderReport(safe),{mode:0o600}); }
  catch { throw new CsoError('PERSISTENCE_FAILED','JSON was saved but the readable report could not be written'); }
}
export function loadReport(dir: string): RunReportV3 {
  const v = readJson(join(dir,'report.json'));
  if (v.schemaVersion !== 3 || !Array.isArray(v.coverage) || !Array.isArray(v.findings)) throw new CsoError('INCOMPATIBLE_INPUT','Expected a v3 run report');
  return v;
}
export function event(report: RunReportV3, kind: string, message: string): void {
  report.events.push({at:new Date().toISOString(),kind,message:redact(message)});
}
export function executionDeadline(report: RunReportV3): number { return Date.parse(report.deadline) - 60_000; }
export function requireTime(report: RunReportV3): void {
  if (Date.now() >= executionDeadline(report)) throw new CsoError('DEADLINE','Investigation deadline reached; the final minute is reserved for reporting');
}
const LOCK_PROTOCOL='immutable-lease-set-v3';
const LOCK_OWNER_MAX_BYTES=4096;
const LOCK_TOKEN=/^[a-f0-9]{32}$/;
const PROCESS_IDENTITY=/^linux:\d+$/;
const LEASE_PUBLICATION_TEMP=/^([a-f0-9]{32})\.(json|decision)\.tmp\.(\d{1,10})\.[a-f0-9]{8}$/;
const LEASE_BLOCKED_WAIT_MS=250;
const LEASE_ELECTION_POLL_MS=1;
const LEASE_ELECTION_WAIT=new Int32Array(new SharedArrayBuffer(4));
const LEASE_CANDIDATE=/^([a-f0-9]{32})\.json$/;
const LEASE_DECISION=/^([a-f0-9]{32})\.decision$/;
const LEASE_ACTIVE=/^([a-f0-9]{32})\.active\.([a-f0-9]{16})$/;
type LockOwner={pid:number;processIdentity?:string;token:string;createdAt:number};
type LockIdentity={dev:number;ino:number};
type LeaseLinks=1|2;
type LeaseDecision={schemaVersion:1;token:string;kind:'ticket'|'withdraw';ticket?:string;candidateDev:string;candidateIno:string;ownerPid:number;ownerProcessIdentity?:string;ownerCreatedAt:number;publisherPid:number;publisherProcessIdentity?:string;createdAt:number};
function processAlive(pid:number):boolean{if(!Number.isInteger(pid)||pid<=1)return false;try{process.kill(pid,0);return true;}catch(error:any){return error?.code==='EPERM';}}
function processIdentity(pid:number):string|undefined{if(process.platform!=='linux')return;try{const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),tail=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);return /^\d+$/.test(tail[19]??'')?`linux:${tail[19]}`:undefined;}catch{return;}}
function validateOwner(value:unknown,expectedToken?:string):LockOwner{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CsoError('UNSAFE_PATH','Run mutation lease owner is malformed');
  const owner=value as Record<string,unknown>;
  if(!Number.isInteger(owner.pid)||Number(owner.pid)<=1||typeof owner.token!=='string'||!LOCK_TOKEN.test(owner.token)||
    (expectedToken!==undefined&&owner.token!==expectedToken)||!Number.isFinite(owner.createdAt)||Number(owner.createdAt)<0||
    (owner.processIdentity!==undefined&&(typeof owner.processIdentity!=='string'||!PROCESS_IDENTITY.test(owner.processIdentity))))
    throw new CsoError('UNSAFE_PATH','Run mutation lease owner is malformed');
  return {pid:Number(owner.pid),token:owner.token,createdAt:Number(owner.createdAt),...(owner.processIdentity===undefined?{}:{processIdentity:owner.processIdentity as string})};
}
function validateLeaseDecision(value:unknown,expectedToken?:string):LeaseDecision{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CsoError('UNSAFE_PATH','Run mutation lease decision is malformed');
  const decision=value as Record<string,unknown>,kind=decision.kind,ticket=decision.ticket;
  if(decision.schemaVersion!==1||typeof decision.token!=='string'||!LOCK_TOKEN.test(decision.token)||(expectedToken!==undefined&&decision.token!==expectedToken)||
    (kind!=='ticket'&&kind!=='withdraw')||(kind==='ticket'&&(typeof ticket!=='string'||!/^[a-f0-9]{16}$/.test(ticket)||ticket==='0000000000000000'))||(kind==='withdraw'&&ticket!==undefined)||
    typeof decision.candidateDev!=='string'||!/^\d+$/.test(decision.candidateDev)||!Number.isSafeInteger(Number(decision.candidateDev))||
    typeof decision.candidateIno!=='string'||!/^\d+$/.test(decision.candidateIno)||!Number.isSafeInteger(Number(decision.candidateIno))||
    !Number.isInteger(decision.ownerPid)||Number(decision.ownerPid)<=1||!Number.isFinite(decision.ownerCreatedAt)||Number(decision.ownerCreatedAt)<0||
    !Number.isInteger(decision.publisherPid)||Number(decision.publisherPid)<=1||!Number.isFinite(decision.createdAt)||Number(decision.createdAt)<0||
    (decision.ownerProcessIdentity!==undefined&&(typeof decision.ownerProcessIdentity!=='string'||!PROCESS_IDENTITY.test(decision.ownerProcessIdentity)))||
    (decision.publisherProcessIdentity!==undefined&&(typeof decision.publisherProcessIdentity!=='string'||!PROCESS_IDENTITY.test(decision.publisherProcessIdentity))))throw new CsoError('UNSAFE_PATH','Run mutation lease decision is malformed');
  return decision as LeaseDecision;
}
function decisionOwner(decision:LeaseDecision):LockOwner{return{pid:decision.ownerPid,token:decision.token,createdAt:decision.ownerCreatedAt,...(decision.ownerProcessIdentity?{processIdentity:decision.ownerProcessIdentity}:{})};}
function decisionPublisher(decision:LeaseDecision):LockOwner{return{pid:decision.publisherPid,token:decision.token,createdAt:decision.createdAt,...(decision.publisherProcessIdentity?{processIdentity:decision.publisherProcessIdentity}:{})};}
function leaseDecisionRecoveryOptions(token:string):AtomicNoReplaceRecoveryOptions{return{label:'Run mutation lease decision',maxBytes:LOCK_OWNER_MAX_BYTES,
  validate:(value,pid)=>{const decision=validateLeaseDecision(value,token);if(decision.publisherPid!==pid)throw new CsoError('UNSAFE_PATH','Run mutation lease decision temp does not match its publisher');},
  publisherAlive:(value,pid)=>{const decision=validateLeaseDecision(value,token);if(decision.publisherPid!==pid)throw new CsoError('UNSAFE_PATH','Run mutation lease decision temp does not match its publisher');return ownerIsAlive(decisionPublisher(decision));}};}
function ownerLinkTransition(left:fs.Stats,right:fs.Stats):boolean{return left.isFile()&&right.isFile()&&left.dev===right.dev&&left.ino===right.ino&&left.size===right.size&&left.mode===right.mode&&left.uid===right.uid&&
  left.nlink>=0&&left.nlink<=2&&right.nlink>=0&&right.nlink<=2&&left.nlink!==right.nlink;}
function readOwner(path:string,expectedToken?:string,expectedLinks:LeaseLinks=1,observed?:fs.Stats):{owner:LockOwner;identity:LockIdentity}{
  let fd:number|undefined;
  try{
    const before=fs.lstatSync(path);
    if(observed&&ownerLinkTransition(observed,before))throw new CsoError('INSUFFICIENT_CAPACITY','Run mutation lease changed phase while it was read');
    if(before.isSymbolicLink()||!before.isFile()||before.nlink!==expectedLinks||before.size<=0||before.size>LOCK_OWNER_MAX_BYTES||
      (process.getuid&&before.uid!==process.getuid())||(process.platform!=='win32'&&(before.mode&0o077)!==0))
      throw new CsoError('UNSAFE_PATH','Run mutation lease is invalid');
    fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(fd);
    if(ownerLinkTransition(before,opened))throw new CsoError('INSUFFICIENT_CAPACITY','Run mutation lease changed phase while it was read');
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==expectedLinks||opened.size!==before.size)
      throw new CsoError('UNSAFE_PATH','Run mutation lease changed while it was read');
    let parsed:unknown;try{parsed=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw new CsoError('UNSAFE_PATH','Run mutation lease is malformed');}
    const final=fs.fstatSync(fd),after=fs.lstatSync(path);
    const coherentTransition=(ownerLinkTransition(opened,final)&&final.dev===after.dev&&final.ino===after.ino&&final.nlink===after.nlink)||
      (opened.dev===final.dev&&opened.ino===final.ino&&opened.nlink===final.nlink&&ownerLinkTransition(opened,after));
    if(coherentTransition)throw new CsoError('INSUFFICIENT_CAPACITY','Run mutation lease changed phase while it was read');
    if(after.isSymbolicLink()||after.dev!==opened.dev||after.ino!==opened.ino||after.nlink!==expectedLinks||final.dev!==opened.dev||final.ino!==opened.ino||final.nlink!==expectedLinks||final.size!==opened.size)
      throw new CsoError('UNSAFE_PATH','Run mutation lease changed while it was read');
    return {owner:validateOwner(parsed,expectedToken),identity:{dev:opened.dev,ino:opened.ino}};
  }catch(error:any){
    if(error instanceof CsoError)throw error;
    if(error?.code==='ENOENT')throw new CsoError('INSUFFICIENT_CAPACITY','Run mutation lease changed during recovery');
    throw new CsoError('UNSAFE_PATH','Run mutation lease could not be validated');
  }finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function ownerIsAlive(owner:LockOwner):boolean{
  const pid=owner.pid;if(!processAlive(pid))return false;
  const current=processIdentity(pid);
  return !(typeof owner.processIdentity==='string'&&current!==undefined&&owner.processIdentity!==current);
}
function recoverLeasePublications(leases:string):void{
  for(let attempt=0;attempt<4;attempt++){
    try{
      for(const name of fs.readdirSync(leases)){
        const match=name.match(LEASE_PUBLICATION_TEMP);if(!match)continue;
        const token=match[1],kind=match[2] as 'json'|'decision',publisherPid=Number(match[3]),temp=join(leases,name),target=join(leases,`${token}.${kind}`),options:AtomicNoReplaceRecoveryOptions=kind==='json'?{label:'Run mutation lease',maxBytes:LOCK_OWNER_MAX_BYTES,
          validate:(value,pid)=>{const owner=validateOwner(value,token);if(owner.pid!==pid)throw new CsoError('UNSAFE_PATH','Run mutation lease temp does not match its publisher');},
          publisherAlive:(value,pid)=>{const owner=validateOwner(value,token);if(owner.pid!==pid)throw new CsoError('UNSAFE_PATH','Run mutation lease temp does not match its publisher');return ownerIsAlive(owner);}}:
          leaseDecisionRecoveryOptions(token);
        let publicationObserved:fs.Stats|undefined;try{publicationObserved=fs.lstatSync(temp);}catch{}
        if(liveEmptyPublication(temp,publisherPid))throw new CsoError('INSUFFICIENT_CAPACITY',`${options.label} publication is still changing under a live helper`);
        try{
          if(fs.existsSync(target))recoverAtomicNoReplaceJson(target,options);
          if(fs.existsSync(temp))discardAtomicNoReplaceTemp(temp,publisherPid,options);
        }catch(error){
          // A live cooperating publisher may still be writing its private temp.
          // Do not accept or remove unstable bytes; report ordinary contention.
          const transientShape=error instanceof CsoError&&error.code==='UNSAFE_PATH'&&error.message===`${options.label} interrupted publication is not one private regular file`;
          if(error instanceof CsoError&&((error.code==='SNAPSHOT_RACE'&&livePublicationAdvanced(temp,publisherPid,publicationObserved,options))||(transientShape&&(liveRecognizedPublication(temp,target,publisherPid,options)||livePublicationAdvanced(temp,publisherPid,publicationObserved,options)))))throw new AtomicPublicationTransition(`${options.label} publication advanced under its live helper`);
          throw error;
        }
      }
      return;
    }catch(error){
      // Retry only a proven same-inode no-replace transition. Foreign inode,
      // content, permission, and pathname races remain visible failures.
      if(!(error instanceof AtomicPublicationTransition))throw error;
    }
  }
  throw new CsoError('INSUFFICIENT_CAPACITY','Another helper is publishing a run mutation lease');
}
function readLegacyOwner(path:string):{pid:number;processIdentity?:string;token:string;createdAt:number}{
  let fd:number|undefined;
  try{
    const before=fs.lstatSync(path);
    if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1||before.size<=0||before.size>LOCK_OWNER_MAX_BYTES||(process.getuid&&before.uid!==process.getuid()))
      throw new CsoError('UNSAFE_PATH','Legacy run mutation lock owner is invalid');
    fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(fd);
    if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1)throw new CsoError('UNSAFE_PATH','Legacy run mutation lock owner changed while it was read');
    let value:unknown;try{value=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw new CsoError('UNSAFE_PATH','Legacy run mutation lock owner is malformed');}
    const after=fs.lstatSync(path),record=value as Record<string,unknown>;
    if(after.dev!==opened.dev||after.ino!==opened.ino||!record||typeof record!=='object'||Array.isArray(record)||!Number.isInteger(record.pid)||Number(record.pid)<=1||
      typeof record.token!=='string'||record.token.length<1||record.token.length>256||
      (record.processIdentity!==undefined&&(typeof record.processIdentity!=='string'||!PROCESS_IDENTITY.test(record.processIdentity))))
      throw new CsoError('UNSAFE_PATH','Legacy run mutation lock owner is malformed');
    return {pid:Number(record.pid),token:record.token,createdAt:typeof record.createdAt==='number'&&Number.isFinite(record.createdAt)?record.createdAt:0,...(record.processIdentity===undefined?{}:{processIdentity:record.processIdentity as string})};
  }catch(error:any){
    if(error instanceof CsoError)throw error;
    if(error?.code==='ENOENT')throw new CsoError('INSUFFICIENT_CAPACITY','A legacy helper may still be initializing this run; its incomplete lock was left intact');
    throw new CsoError('UNSAFE_PATH','Legacy run mutation lock owner could not be validated');
  }finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function exactUnlink(path:string,token:string,identity:LockIdentity,links:LeaseLinks=1):void{
  let current:{owner:LockOwner;identity:LockIdentity};
  try{current=readOwner(path,token,links);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');}
  if(current.identity.dev!==identity.dev||current.identity.ino!==identity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');
  // One final pathname check narrows lstat/read/unlink replacement races. Lease
  // names are immutable and never reused by cooperating helpers.
  let final:fs.Stats;try{final=fs.lstatSync(path);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');}
  if(final.isSymbolicLink()||final.dev!==identity.dev||final.ino!==identity.ino||final.nlink!==links)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');
  try{fs.unlinkSync(path);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');}
}
function acquireMigrationClaim(path:string):{owner:LockOwner;identity:LockIdentity}{
  for(let attempt=0;attempt<4;attempt++){
    recoverAtomicNoReplaceJson(path,{label:'Legacy run mutation recovery claim',maxBytes:LOCK_OWNER_MAX_BYTES,
      validate:(value,pid)=>{const owner=validateOwner(value);if(owner.pid!==pid)throw new CsoError('UNSAFE_PATH','Legacy recovery temp does not match its publisher');}});
    const owner:LockOwner={pid:process.pid,processIdentity:processIdentity(process.pid),token:randomBytes(16).toString('hex'),createdAt:Date.now()};
    try{
      atomicWriteSync(path,JSON.stringify(owner)+'\n',{mode:0o600,noReplace:true});
      return readOwner(path,owner.token);
    }catch(error:any){
      if(error instanceof CsoError)throw error;
      if(error?.code!=='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Legacy run mutation recovery claim could not be published');
      const stale=readOwner(path);
      if(ownerIsAlive(stale.owner))throw new CsoError('INSUFFICIENT_CAPACITY','Another helper is recovering this run');
      try{exactUnlink(path,stale.owner.token,stale.identity);}catch(recoveryError){
        if(attempt===3)throw recoveryError;
      }
    }
  }
  throw new CsoError('INSUFFICIENT_CAPACITY','Another helper is recovering this run');
}
function ensureLockProtocol(dir:string):string{
  const lock=join(dir,'.mutation-lock'),marker=JSON.stringify({protocol:LOCK_PROTOCOL})+'\n';
  try{atomicWriteSync(lock,marker,{mode:0o600,noReplace:true});}
  catch(error:any){
    if(error?.code!=='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Run mutation lock protocol could not be initialized');
    recoverAtomicNoReplaceJson(lock,{label:'Run mutation lock protocol',maxBytes:LOCK_OWNER_MAX_BYTES,
      validate:value=>{if(!value||typeof value!=='object'||Array.isArray(value)||(value as any).protocol!==LOCK_PROTOCOL)throw new CsoError('UNSAFE_PATH','Run mutation lock protocol is invalid');}});
    const stat=fs.lstatSync(lock);
    if(stat.isSymbolicLink())throw new CsoError('UNSAFE_PATH','Run mutation lock is a symlink');
    if(stat.isFile()){
      let protocol='';try{if(stat.nlink!==1||stat.size<=0||stat.size>LOCK_OWNER_MAX_BYTES||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('invalid');protocol=JSON.parse(fs.readFileSync(lock,'utf8')).protocol;}catch{}
      if(protocol!==LOCK_PROTOCOL||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid()))throw new CsoError('UNSAFE_PATH','Run mutation lock protocol is invalid');
    }else if(stat.isDirectory()){
      // v2 created the canonical directory before publishing owner.json. A
      // missing/malformed owner can still belong to a paused live initializer,
      // so it is never age-reclaimed. Fully published dead owners can migrate.
      const owner=readLegacyOwner(join(lock,'owner.json'));
      if(ownerIsAlive(owner as LockOwner))throw new CsoError('INSUFFICIENT_CAPACITY','Another helper is updating this run');
      const migration=join(lock,'.v3-migration'),claim=acquireMigrationClaim(migration),current=fs.lstatSync(lock);
      if(current.dev!==stat.dev||current.ino!==stat.ino){try{exactUnlink(migration,claim.owner.token,claim.identity);}catch{}throw new CsoError('INSUFFICIENT_CAPACITY','Another helper changed this run during recovery');}
      const tomb=join(dir,`.mutation-lock.legacy-${process.pid}-${randomBytes(4).toString('hex')}`);
      try{fs.renameSync(lock,tomb);atomicWriteSync(lock,marker,{mode:0o600,noReplace:true});fs.rmSync(tomb,{recursive:true,force:true});}
      catch{try{if(!fs.existsSync(lock)&&fs.existsSync(tomb))fs.renameSync(tomb,lock);}catch{}try{if(fs.existsSync(migration))exactUnlink(migration,claim.owner.token,claim.identity);}catch{}throw new CsoError('PERSISTENCE_FAILED','Legacy run mutation lock could not be migrated safely');}
    }else throw new CsoError('UNSAFE_PATH','Run mutation lock has an invalid file type');
  }
  const leases=join(dir,'.mutation-lock-leases');
  if(!fs.existsSync(leases))try{fs.mkdirSync(leases,{mode:0o700});}catch(error:any){if(error?.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(leases);if(stat.isSymbolicLink()||!stat.isDirectory()||(process.getuid&&stat.uid!==process.getuid()))throw new CsoError('UNSAFE_PATH','Run mutation lease directory is invalid');
  if(process.platform!=='win32')fs.chmodSync(leases,0o700);
  return leases;
}
type LeaseState={token:string;owner:LockOwner;identity:LockIdentity;candidate?:string;decisionPath?:string;decision?:LeaseDecision;decisionIdentity?:LockIdentity;active?:string;number?:bigint};
type HeldRunLease={path:string;decision:string;decisionIdentity:LockIdentity;active:string;token:string;identity:LockIdentity};
function privateLeaseArtifact(stat:fs.Stats):boolean{return stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=LOCK_OWNER_MAX_BYTES&&
  (!process.getuid||stat.uid===process.getuid())&&(process.platform==='win32'||(stat.mode&0o077)===0);}
function readLeaseDecision(path:string,token:string):{decision:LeaseDecision;identity:LockIdentity}{
  const options=leaseDecisionRecoveryOptions(token);recoverAtomicNoReplaceJson(path,options);
  const recovered=recoveryJson(path,1,options);
  return{decision:validateLeaseDecision(recovered.value,token),identity:{dev:recovered.identity.dev,ino:recovered.identity.ino}};
}
function decisionMatchesIdentity(decision:LeaseDecision,identity:LockIdentity):boolean{return decision.candidateDev===String(identity.dev)&&decision.candidateIno===String(identity.ino);}
function decisionMatchesOwner(decision:LeaseDecision,owner:LockOwner):boolean{return decision.ownerPid===owner.pid&&decision.ownerCreatedAt===owner.createdAt&&decision.ownerProcessIdentity===owner.processIdentity;}
function scanRunLeases(leases:string):LeaseState[]{
  const deadline=Date.now()+LEASE_BLOCKED_WAIT_MS;let contention:CsoError|undefined;
  for(let attempt=0;attempt<LEASE_BLOCKED_WAIT_MS/LEASE_ELECTION_POLL_MS+16;attempt++){
    contention=undefined;
    const names=fs.readdirSync(leases).sort();
    if(names.some(name=>LEASE_PUBLICATION_TEMP.test(name))){try{recoverLeasePublications(leases);contention=new CsoError('INSUFFICIENT_CAPACITY','Run mutation lease publication changed during the lease scan');}catch(error){if(!(error instanceof CsoError)||error.code!=='INSUFFICIENT_CAPACITY'||Date.now()>=deadline)throw error;contention=error;Atomics.wait(LEASE_ELECTION_WAIT,0,0,LEASE_ELECTION_POLL_MS);}continue;}
    const grouped=new Map<string,{candidate?:string;decision?:string;actives:Array<{path:string;encoded:string}>}>();
    for(const name of names){
      const candidate=name.match(LEASE_CANDIDATE),decision=name.match(LEASE_DECISION),active=name.match(LEASE_ACTIVE),token=candidate?.[1]??decision?.[1]??active?.[1];
      if(!token)throw new CsoError('UNSAFE_PATH','Run mutation lease directory contains an invalid artifact');
      const group=grouped.get(token)??{actives:[]};
      if(candidate){if(group.candidate)throw new CsoError('UNSAFE_PATH','Run mutation lease has duplicate candidate state');group.candidate=join(leases,name);}
      else if(decision){if(group.decision)throw new CsoError('UNSAFE_PATH','Run mutation lease has duplicate decision state');group.decision=join(leases,name);}
      else if(active)group.actives.push({path:join(leases,name),encoded:active[2]});
      grouped.set(token,group);
    }
    let retry=false;const states:LeaseState[]=[];
    for(const [token,group] of grouped){
      if(group.actives.length>1||group.actives.length===1&&!group.decision||!group.candidate&&!group.decision){retry=true;break;}
      let decisionRecord:{decision:LeaseDecision;identity:LockIdentity}|undefined;
      if(group.decision)try{decisionRecord=readLeaseDecision(group.decision,token);}catch(error){if(error instanceof CsoError&&(error.code==='SNAPSHOT_RACE'||error.code==='INSUFFICIENT_CAPACITY')){if(error.code==='INSUFFICIENT_CAPACITY'){if(Date.now()>=deadline)throw error;contention=error;}retry=true;break;}throw error;}
      if(group.actives[0]&&(!decisionRecord||decisionRecord.decision.kind!=='ticket'||decisionRecord.decision.ticket!==group.actives[0].encoded))throw new CsoError('UNSAFE_PATH','Run mutation lease active phase does not match its ticket decision');
      const ownerPath=group.candidate??group.actives[0]?.path;let inspected:{owner:LockOwner;identity:LockIdentity}|undefined;
      if(ownerPath){const expected=(group.candidate&&group.actives[0]?2:1) as LeaseLinks;let observed:fs.Stats;try{observed=fs.lstatSync(ownerPath);}catch(error:any){if(error?.code==='ENOENT'){retry=true;break;}throw error;}if(!privateLeaseArtifact(observed)){throw new CsoError('UNSAFE_PATH','Run mutation lease owner phase is not one private regular file');}if(observed.nlink!==expected){retry=true;break;}try{inspected=readOwner(ownerPath,token,expected,observed);}catch(error){if(error instanceof CsoError&&error.code==='INSUFFICIENT_CAPACITY'){if(Date.now()>=deadline)throw error;contention=error;retry=true;break;}throw error;}}
      if(group.candidate&&group.actives[0]){let activeStat:fs.Stats;try{activeStat=fs.lstatSync(group.actives[0].path);}catch(error:any){if(error?.code==='ENOENT'){retry=true;break;}throw error;}if(!privateLeaseArtifact(activeStat)||activeStat.dev!==inspected!.identity.dev||activeStat.ino!==inspected!.identity.ino)throw new CsoError('UNSAFE_PATH','Run mutation lease active phase does not match its candidate inode');if(activeStat.nlink!==2){retry=true;break;}}
      const identity=inspected?.identity??{dev:Number(decisionRecord!.decision.candidateDev),ino:Number(decisionRecord!.decision.candidateIno)},owner=inspected?.owner??decisionOwner(decisionRecord!.decision);
      if(decisionRecord&&(!decisionMatchesIdentity(decisionRecord.decision,identity)||!decisionMatchesOwner(decisionRecord.decision,owner)))throw new CsoError('UNSAFE_PATH','Run mutation lease decision does not match its candidate owner');
      const number=decisionRecord?.decision.kind==='ticket'?BigInt(`0x${decisionRecord.decision.ticket}`):undefined;
      states.push({token,owner,identity,...(group.candidate?{candidate:group.candidate}:{}),...(group.decision&&decisionRecord?{decisionPath:group.decision,decision:decisionRecord.decision,decisionIdentity:decisionRecord.identity}:{}),...(group.actives[0]?{active:group.actives[0].path}:{}),...(number!==undefined?{number}:{})});
    }
    if(!retry&&fs.readdirSync(leases).sort().join('\0')===names.join('\0'))return states;
    Atomics.wait(LEASE_ELECTION_WAIT,0,0,LEASE_ELECTION_POLL_MS);
  }
  if(contention)throw contention;
  throw new CsoError('UNSAFE_PATH','Run mutation lease phases could not be validated as one coherent set');
}
function releaseLeaseState(state:LeaseState):void{
  if(state.candidate)exactUnlink(state.candidate,state.token,state.identity,state.active?2:1);
  if(state.active)exactUnlink(state.active,state.token,state.identity,1);
  if(state.decisionPath&&state.decisionIdentity)exactDecisionUnlink(state.decisionPath,state.token,state.decisionIdentity);
}
function exactDecisionUnlink(path:string,token:string,identity:LockIdentity):void{
  let current:{decision:LeaseDecision;identity:LockIdentity};try{current=readLeaseDecision(path,token);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before exact release');}
  if(current.identity.dev!==identity.dev||current.identity.ino!==identity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before exact release');
  let final:fs.Stats;try{final=fs.lstatSync(path);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before exact release');}
  if(!privateLeaseArtifact(final)||final.nlink!==1||final.dev!==identity.dev||final.ino!==identity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before exact release');
  try{fs.unlinkSync(path);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before exact release');}
}
function publishLeasePhase(candidate:string,target:string,token:string,identity:LockIdentity):void{
  const before=readOwner(candidate,token,1);if(before.identity.dev!==identity.dev||before.identity.ino!==identity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease changed before phase publication');
  try{fs.linkSync(candidate,target);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease phase could not be published');}
  const source=fs.lstatSync(candidate),phase=fs.lstatSync(target);if(source.dev!==identity.dev||source.ino!==identity.ino||phase.dev!==identity.dev||phase.ino!==identity.ino||source.nlink!==2||phase.nlink!==2)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease phase changed during publication');
}
function makeLeaseDecision(owner:LockOwner,identity:LockIdentity,kind:'ticket'|'withdraw',ticket?:string):LeaseDecision{
  const publisherIdentity=processIdentity(process.pid);
  return{schemaVersion:1,token:owner.token,kind,...(ticket?{ticket}:{}),candidateDev:String(identity.dev),candidateIno:String(identity.ino),ownerPid:owner.pid,...(owner.processIdentity?{ownerProcessIdentity:owner.processIdentity}:{}),ownerCreatedAt:owner.createdAt,publisherPid:process.pid,...(publisherIdentity?{publisherProcessIdentity:publisherIdentity}:{}),createdAt:Date.now()};
}
function publishLeaseDecision(path:string,decision:LeaseDecision):void{
  try{atomicWriteSync(path,JSON.stringify(decision)+'\n',{mode:0o600,noReplace:true});}catch(error:any){if(error?.code!=='EEXIST')throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision could not be published');}
}
function releaseKnownLease(candidate:string,decisionPath:string,active:string|undefined,token:string,identity:LockIdentity,expectedDecisionIdentity?:LockIdentity,requireActive=false):void{
  let candidateStat:fs.Stats;try{candidateStat=fs.lstatSync(candidate);}catch{throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');}
  if(!privateLeaseArtifact(candidateStat)||candidateStat.dev!==identity.dev||candidateStat.ino!==identity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before exact release');
  let activeStat:fs.Stats|undefined;try{if(active)activeStat=fs.lstatSync(active);}catch(error:any){if(error?.code!=='ENOENT')throw new CsoError('PERSISTENCE_FAILED','Run mutation lease active phase changed before cleanup');}
  if(requireActive&&!activeStat)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease active phase changed before exact release');
  if(activeStat&&(!privateLeaseArtifact(activeStat)||activeStat.dev!==identity.dev||activeStat.ino!==identity.ino))throw new CsoError('PERSISTENCE_FAILED','Run mutation lease active phase changed before cleanup');
  const expected=activeStat?2:1;if(candidateStat.nlink!==expected||activeStat&&activeStat.nlink!==2)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease link state changed before cleanup');
  let decisionRecord:{decision:LeaseDecision;identity:LockIdentity}|undefined;try{decisionRecord=readLeaseDecision(decisionPath,token);}catch(error:any){if(!(error instanceof CsoError)||error.code!=='SNAPSHOT_RACE')throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before cleanup');}
  if(expectedDecisionIdentity&&!decisionRecord)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before exact release');
  if(decisionRecord&&(!decisionMatchesIdentity(decisionRecord.decision,identity)||decisionRecord.decision.ownerPid!==process.pid||expectedDecisionIdentity&&(decisionRecord.identity.dev!==expectedDecisionIdentity.dev||decisionRecord.identity.ino!==expectedDecisionIdentity.ino)))throw new CsoError('PERSISTENCE_FAILED','Run mutation lease decision changed before cleanup');
  exactUnlink(candidate,token,identity,expected);if(activeStat)exactUnlink(active!,token,identity,1);if(decisionRecord)exactDecisionUnlink(decisionPath,token,decisionRecord.identity);
}
function compareLeaseOrder(left:LeaseState,rightNumber:bigint,rightToken:string):number{return left.number!<rightNumber?-1:left.number!>rightNumber?1:left.token<rightToken?-1:left.token>rightToken?1:0;}
function recoverDeadLease(state:LeaseState):boolean{
  if(ownerIsAlive(state.owner))return false;
  try{releaseLeaseState(state);}catch(error){
    if(!(error instanceof CsoError)||error.code!=='PERSISTENCE_FAILED')throw error;
    for(const path of [state.candidate,state.active].filter((value):value is string=>Boolean(value))){try{const stat=fs.lstatSync(path);if(!privateLeaseArtifact(stat)||stat.dev!==state.identity.dev||stat.ino!==state.identity.ino)throw new CsoError('UNSAFE_PATH','Dead run mutation lease was replaced during recovery');}catch(recoveryError:any){if(recoveryError instanceof CsoError)throw recoveryError;if(recoveryError?.code!=='ENOENT')throw recoveryError;}}
    if(state.decisionPath&&state.decisionIdentity)try{const stat=fs.lstatSync(state.decisionPath);if(!privateLeaseArtifact(stat)||stat.dev!==state.decisionIdentity.dev||stat.ino!==state.decisionIdentity.ino)throw new CsoError('UNSAFE_PATH','Dead run mutation lease decision was replaced during recovery');}catch(recoveryError:any){if(recoveryError instanceof CsoError)throw recoveryError;if(recoveryError?.code!=='ENOENT')throw recoveryError;}
    Atomics.wait(LEASE_ELECTION_WAIT,0,0,LEASE_ELECTION_POLL_MS);
  }
  return true;
}
function chooseRunLeaseTicket(leases:string,token:string,owner:LockOwner,identity:LockIdentity):{path:string;number:bigint;identity:LockIdentity}{
  for(;;){
    const states=scanRunLeases(leases);let recovered=false,max=0n;
    const own=states.find(state=>state.token===token);
    if(!own?.candidate||own.identity.dev!==identity.dev||own.identity.ino!==identity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease candidate changed before ticket selection');
    if(own.decision){
      if(own.decision.kind==='withdraw')throw new CsoError('INSUFFICIENT_CAPACITY','This run mutation lease was withdrawn before ticket selection');
      if(own.number===undefined||!own.decisionPath||!own.decisionIdentity)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ticket decision is incomplete');
      return{path:own.decisionPath,number:own.number,identity:own.decisionIdentity};
    }
    for(const state of states){
      if(state.token===token)continue;
      if(recoverDeadLease(state)){recovered=true;break;}
      if(state.active)throw new CsoError('INSUFFICIENT_CAPACITY',state.owner.pid===process.pid?'Another operation in this helper is updating this run':'Another helper is updating this run');
      if(!state.candidate||state.decision?.kind==='withdraw')continue;
      if(state.owner.pid===process.pid)throw new CsoError('INSUFFICIENT_CAPACITY','Another operation in this helper is updating this run');
      if(state.number!==undefined&&state.number>max)max=state.number;
    }
    if(recovered)continue;
    const number=max+1n;if(number>0xffffffffffffffffn)throw new CsoError('INSUFFICIENT_CAPACITY','Run mutation lease ticket space is exhausted');
    const encoded=number.toString(16).padStart(16,'0'),path=join(leases,`${token}.decision`);
    publishLeaseDecision(path,makeLeaseDecision(owner,identity,'ticket',encoded));
  }
}
function fenceRunLeaseCandidate(leases:string,state:LeaseState):void{
  if(!state.candidate||state.decision)return;
  const observed=readOwner(state.candidate,state.token,1);
  if(observed.identity.dev!==state.identity.dev||observed.identity.ino!==state.identity.ino)throw new CsoError('UNSAFE_PATH','Run mutation lease candidate changed before withdrawal');
  publishLeaseDecision(join(leases,`${state.token}.decision`),makeLeaseDecision(state.owner,state.identity,'withdraw'));
}
function activateRunLease(leases:string,token:string,candidate:string,decisionPath:string,active:string,number:bigint,identity:LockIdentity):void{
  const blockedDeadline=Date.now()+LEASE_BLOCKED_WAIT_MS;
  for(;;){
    const states=scanRunLeases(leases),own=states.find(state=>state.token===token);
    if(!own||own.candidate!==candidate||own.decisionPath!==decisionPath||own.decision?.kind!=='ticket'||own.number!==number||own.active||own.identity.dev!==identity.dev||own.identity.ino!==identity.ino)throw new CsoError(own?.decision?.kind==='withdraw'?'INSUFFICIENT_CAPACITY':'PERSISTENCE_FAILED',own?.decision?.kind==='withdraw'?'This run mutation lease was withdrawn before activation':'Run mutation lease ticket changed before activation');
    let retry=false,lost=false;const pending:LeaseState[]=[];
    for(const state of states){
      if(state.token===token)continue;
      if(recoverDeadLease(state)){retry=true;break;}
      if(state.active)throw new CsoError('INSUFFICIENT_CAPACITY',state.owner.pid===process.pid?'Another operation in this helper is updating this run':'Another helper is updating this run');
      if(!state.candidate||state.decision?.kind==='withdraw')continue;
      if(state.owner.pid===process.pid)throw new CsoError('INSUFFICIENT_CAPACITY','Another operation in this helper is updating this run');
      if(state.number===undefined)pending.push(state);else if(compareLeaseOrder(state,number,token)<0)lost=true;
    }
    if(retry)continue;
    if(lost)throw new CsoError('INSUFFICIENT_CAPACITY','An earlier run mutation lease ticket won the election');
    if(pending.length){if(Date.now()<blockedDeadline){Atomics.wait(LEASE_ELECTION_WAIT,0,0,LEASE_ELECTION_POLL_MS);continue;}for(const state of pending)fenceRunLeaseCandidate(leases,state);continue;}
    publishLeasePhase(candidate,active,token,identity);
    const verified=scanRunLeases(leases),current=verified.find(state=>state.token===token);if(!current||current.candidate!==candidate||current.decisionPath!==decisionPath||current.decision?.kind!=='ticket'||current.number!==number||current.active!==active||current.identity.dev!==identity.dev||current.identity.ino!==identity.ino||verified.some(state=>state.token!==token&&state.active))throw new CsoError('PERSISTENCE_FAILED','Run mutation lease activation could not be verified exclusively');
    return;
  }
}
function acquireRunLease(dir:string):HeldRunLease{
  secureDirectory(dir);
  const leases=ensureLockProtocol(dir);recoverLeasePublications(leases);
  const token=randomBytes(16).toString('hex'),lease=join(leases,`${token}.json`),owner:LockOwner={pid:process.pid,processIdentity:processIdentity(process.pid),token,createdAt:Date.now()};
  atomicWriteSync(lease,JSON.stringify(owner)+'\n',{mode:0o600,noReplace:true});
  const ownStat=fs.lstatSync(lease),ownIdentity={dev:ownStat.dev,ino:ownStat.ino};
  const decision=join(leases,`${token}.decision`);let decisionIdentity:LockIdentity|undefined,active:string|undefined;
  try{
    const chosen=chooseRunLeaseTicket(leases,token,owner,ownIdentity);decisionIdentity=chosen.identity;
    active=join(leases,`${token}.active.${chosen.number.toString(16).padStart(16,'0')}`);activateRunLease(leases,token,lease,decision,active,chosen.number,ownIdentity);
    const published=readOwner(active,token,2);if(published.identity.dev!==ownIdentity.dev||published.identity.ino!==ownIdentity.ino)throw new CsoError('PERSISTENCE_FAILED','Run mutation lease ownership changed before work began');
  }catch(error){
    try{releaseKnownLease(lease,decision,active,token,ownIdentity,decisionIdentity);}catch(releaseError){throw releaseError;}
    throw error;
  }
  return{path:lease,decision,decisionIdentity:decisionIdentity!,active,token,identity:ownIdentity};
}
function releaseRunLease(lease:HeldRunLease,path=lease.path):void{const directory=dirname(path);releaseKnownLease(path,join(directory,basename(lease.decision)),join(directory,basename(lease.active)),lease.token,lease.identity,lease.decisionIdentity,true);}
export function withLock<T>(dir: string, fn: () => T): T | Promise<Awaited<T>> {
  const lease=acquireRunLease(dir),unlock=()=>releaseRunLease(lease);
  let value:T;
  try {
    value=fn();
  } catch(error){
    try{unlock();}catch(releaseError){throw releaseError;}
    throw error;
  }
  if(value&&typeof (value as any).then==='function')return Promise.resolve(value).finally(unlock) as Promise<Awaited<T>>;
  // Keep release errors outside the callback catch path. Retrying an exact
  // release after it partially succeeds can only obscure which lease phase
  // changed and attempts the same fail-closed cleanup twice.
  unlock();return value as any;
}

function boundedMarker(path:string,admit:()=>void=()=>{}):string{
  admit();
  try{const stat=fs.lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>8192)return'';return fs.readFileSync(path,'utf8');}catch{return'';}
}
/** A detached watchdog owns these paths until it records exact cleanup or an acknowledgement. */
export function hasPendingWatchdogCleanup(dir:string,admit:()=>void=()=>{}):boolean{
  let visited=0,pending=false;
  const walk=(at:string,depth:number)=>{
    if(pending||depth>6||visited++>4000)return;
    const entries:fs.Dirent[]=[];let directory:fs.Dir;
    admit();try{directory=fs.opendirSync(at);}catch{return;}
    try{for(;;){admit();const entry=directory.readSync();if(!entry)break;entries.push(entry);}}finally{directory.closeSync();}
    const names=new Set(entries.map(entry=>entry.name));
    if(names.has('attempt.ready')&&!names.has('attempt.stopped')&&!boundedMarker(join(at,'attempt.event'),admit).includes('execution-copy cleanup complete')){pending=true;return;}
    if(names.has('watchdog.ready')&&!names.has('watchdog.stopped')&&!boundedMarker(join(at,'watchdog.event'),admit).includes('cleanup complete')){pending=true;return;}
    for(const entry of entries){if(!/^[A-Za-z0-9._-]{1,120}$/.test(entry.name)||!entry.isDirectory())continue;walk(join(at,entry.name),depth+1);if(pending)return;}
  };
  for(const name of ['supervision','preparation-execution']){
    admit();const root=join(dir,name);if(!fs.existsSync(root))continue;
    admit();
    const rootStat=fs.lstatSync(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new CsoError('UNSAFE_PATH','Watchdog supervision state is not a private directory');
    walk(root,0);if(pending)return true;
  }
  return false;
}

const EPHEMERAL_REPLAY='.ephemeral-replay.json';
/** Delete a replay-only snapshot unless detached cleanup still owns its control tree. */
export function finalizeReplayTemporary(dir:string):void{
  if(hasPendingWatchdogCleanup(dir)){writeJsonExclusive(join(dir,EPHEMERAL_REPLAY),{schemaVersion:1,kind:'replay-temporary',retainedAt:new Date().toISOString()});return;}
  fs.rmSync(dir,{recursive:true,force:true});
}

/** Remove one private tree cooperatively without following links or holding directory handles across checks. */
function boundedRemoveTree(root:string,admit:()=>void,preserveRootName?:string):void{
  type Frame={path:string;root:boolean;names?:string[];index:number};
  const stack:Frame[]=[{path:root,root:true,index:0}];
  while(stack.length){
    const frame=stack[stack.length-1];
    if(!frame.names){
      admit();let stat:fs.Stats;try{stat=fs.lstatSync(frame.path);}catch(error:any){if(error?.code==='ENOENT'){stack.pop();continue;}throw error;}
      if(stat.isSymbolicLink()||!stat.isDirectory()){admit();fs.unlinkSync(frame.path);stack.pop();continue;}
      const names:string[]=[];admit();const directory=fs.opendirSync(frame.path);
      try{for(;;){admit();const entry=directory.readSync();if(!entry)break;if(!(frame.root&&entry.name===preserveRootName))names.push(entry.name);}}finally{directory.closeSync();}
      frame.names=names;frame.index=0;
    }
    if(frame.index<frame.names.length){const name=frame.names[frame.index++];stack.push({path:join(frame.path,name),root:false,index:0});continue;}
    if(frame.root&&preserveRootName)return;
    admit();fs.rmdirSync(frame.path);stack.pop();
  }
}
function consumeLeasedTree(root:string,admit:()=>void):void{
  boundedRemoveTree(root,admit,'.mutation-lock-leases');
  admit();const directory=fs.opendirSync(root);try{for(;;){admit();const entry=directory.readSync();if(!entry)break;if(entry.name!=='.mutation-lock-leases')throw new CsoError('SNAPSHOT_RACE','Private retention tree changed during bounded cleanup');}}finally{directory.closeSync();}
  // Only the helper's fixed-size lease protocol remains. Consuming it with the
  // directory preserves the exact-release invariant without an unbounded walk.
  admit();fs.rmSync(root,{recursive:true,force:true});
}

function repairBundleExpiry(dir:string,run:string,now:number,runExpired:boolean,admit:()=>void):boolean{
  admit();const bundles=join(dir,'bundles');if(!fs.existsSync(bundles))return false;
  admit();
  const stat=fs.lstatSync(bundles);if(stat.isSymbolicLink()||!stat.isDirectory())throw new CsoError('UNSAFE_PATH','Repair bundle archive is not a private directory');
  let retained=false,remaining=0;admit();const directory=fs.opendirSync(bundles);
  try{for(;;){
    admit();const entry=directory.readSync();if(!entry)break;const name=entry.name;
    const match=name.match(/^([a-f0-9]{32})\.json$/);if(!match){if(runExpired)boundedRemoveTree(join(bundles,name),admit);else remaining++;continue;}
    admit();
    const value=readJson(join(bundles,name)) as Record<string,any>,id=match[1],created=Date.parse(value?.createdAt),expires=Date.parse(value?.expiresAt);
    if(value?.schemaVersion!==3||value?.id!==id||value?.runId!==run||value?.verification?.id!==id||value?.verification?.runId!==run||value?.verification?.createdAt!==value.createdAt||
      !Number.isFinite(created)||new Date(created).toISOString()!==value.createdAt||!Number.isFinite(expires)||value.expiresAt!==new Date(created+30*86400_000).toISOString())
      throw new CsoError('INCOMPATIBLE_INPUT','Repair bundle retention identity is invalid');
    if(expires<=now){admit();fs.unlinkSync(join(bundles,name));}else{retained=true;remaining++;}
  }}finally{directory.closeSync();}
  if(!remaining){admit();fs.rmdirSync(bundles);}
  return retained;
}

function cleanupRun(dir:string,run:string,now:number,pinned:boolean,admit:()=>void):void{
  admit();
  let lease:HeldRunLease;
  try{lease=acquireRunLease(dir);}catch(error){if(error instanceof CsoError&&error.code==='INSUFFICIENT_CAPACITY')return;throw error;}
  let releasePath=lease.path,consumed=false;
  try{
    if(hasPendingWatchdogCleanup(dir,admit))return;
    const created=Number(run.split('-')[0]),runExpired=now-created>30*86400_000,retainedBundle=repairBundleExpiry(dir,run,now,runExpired,admit);
    admit();const ephemeral=fs.existsSync(join(dir,EPHEMERAL_REPLAY));
    if(ephemeral||(runExpired&&!pinned&&!retainedBundle)){
      admit();const before=fs.lstatSync(dir),tomb=join(dirname(dir),`.retired-${run}-${randomBytes(16).toString('hex')}`);fs.renameSync(dir,tomb);releasePath=join(tomb,'.mutation-lock-leases',basename(lease.path));admit();const after=fs.lstatSync(tomb);
      if(before.dev!==after.dev||before.ino!==after.ino)throw new CsoError('SNAPSHOT_RACE','Expired run changed while it was retired');
      // The retired name is outside the public run namespace. Consume the
      // exclusive lease with the tree so no release/delete gap can admit a
      // second helper against the same directory.
      consumeLeasedTree(tomb,admit);consumed=true;return;
    }
    if(now-created>7*86400_000)for(const p of ['snapshot','readable'])boundedRemoveTree(join(dir,p),admit);
    if(runExpired)for(const p of ['reviews','replays','dependency-closures','scanner-outcomes','verification-attempts'])boundedRemoveTree(join(dir,p),admit);
  }finally{if(!consumed)releaseRunLease(lease,releasePath);}
}
function cleanupRetiredRun(dir:string,admit:()=>void):void{
  admit();
  let lease:HeldRunLease;try{lease=acquireRunLease(dir);}catch(error){if(error instanceof CsoError&&error.code==='INSUFFICIENT_CAPACITY')return;throw error;}
  let consumed=false;try{if(hasPendingWatchdogCleanup(dir,admit))return;consumeLeasedTree(dir,admit);consumed=true;}finally{if(!consumed)releaseRunLease(lease);}
}
export interface RetentionOptions { deadlineMs?:number; maxEntries?:number }
export interface RetentionResult { complete:boolean; visited:number }
class RetentionBudgetExhausted extends Error {}
export function retention(now = Date.now(),options:RetentionOptions={}): RetentionResult {
  const deadlineMs=options.deadlineMs??Number.MAX_SAFE_INTEGER,maxEntries=options.maxEntries??Number.MAX_SAFE_INTEGER;
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<0||!Number.isSafeInteger(maxEntries)||maxEntries<1)throw new CsoError('INVALID_ARGUMENT','Invalid retention maintenance budget');
  let visited=0;const admit=()=>{if(Date.now()>=deadlineMs||visited>=maxEntries)throw new RetentionBudgetExhausted();visited++;};
  const names=(dir:string,pattern:RegExp):string[]=>{const found:string[]=[];admit();const directory=fs.opendirSync(dir);try{for(;;){admit();const entry=directory.readSync();if(!entry)break;if(pattern.test(entry.name))found.push(entry.name);}}finally{directory.closeSync();}return found;};
  const root = privateRoot();
  const retainedParents=new Set<string>(),repositories:{repo:string;repoDir:string;runs:string[];retired:string[]}[]=[];
  const retainedReport=(repoDir:string,repo:string,run:string):RunReportV3|undefined=>{
    const file=join(repoDir,run,'report.json');
    try{
      admit();
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<=0||stat.size>MAX_STATE_FILE||
        (process.getuid&&stat.uid!==process.getuid())||(process.platform!=='win32'&&(stat.mode&0o077)!==0))return;
      admit();
      const report=JSON.parse(fs.readFileSync(file,'utf8'));
      if(report?.schemaVersion!==3||report.runId!==run||report.repoId!==repo||!Array.isArray(report.coverage)||!Array.isArray(report.findings)||
        !['running','finished','interrupted'].includes(report.status))return;
      return report as RunReportV3;
    }catch(error){if(error instanceof RetentionBudgetExhausted)throw error;return;}
  };
  try{
    for(const repo of names(root,/^[a-f0-9]{24}$/)){
      admit();const repoDir=secureDirectory(join(root,repo)),entries=names(repoDir,/^(?:\d{13}-[a-f0-9]{16}|\.retired-\d{13}-[a-f0-9]{16}-[a-f0-9]{32})$/),runs=entries.filter(x=>/^\d{13}-/.test(x)),retired=entries.filter(x=>x.startsWith('.retired-'));
      repositories.push({repo,repoDir,runs,retired});
    }
    // Discover every live recheck pin before destructive cleanup. An exhausted
    // discovery pass returns without deleting a parent that may still be in use.
    for(const {repo,repoDir,runs} of repositories)for(const run of runs){
      if(now-Number(run.split('-')[0])>30*86400_000)continue;
      const report=retainedReport(repoDir,repo,run),parent=report?.parent as Record<string,unknown>|undefined;
      if(!report||!['running','interrupted'].includes(report.status)||!Number.isFinite(Date.parse(report.deadline))||Date.parse(report.deadline)<=now||
        !parent||typeof parent!=='object'||Array.isArray(parent)||Object.keys(parent).sort().join(',')!=='findingId,kind,runId'||parent.kind!=='recheck'||
        typeof parent.runId!=='string'||!/^\d{13}-[a-f0-9]{16}$/.test(parent.runId)||parent.runId===run||typeof parent.findingId!=='string'||!/^[a-f0-9]{32}$/.test(parent.findingId))continue;
      const original=retainedReport(repoDir,repo,parent.runId);
      if(original?.status==='finished'&&original.findings.some(f=>f.id===parent.findingId))retainedParents.add(`${repo}/${parent.runId}`);
    }
    for (const {repo,repoDir,runs,retired} of repositories) {
      for(const name of retired)cleanupRetiredRun(join(repoDir,name),admit);
      for (const run of runs) {
        admit();const dir = secureDirectory(join(repoDir,run));
        // Every destructive retention decision owns the same exclusive lease as
        // writers and replay. Whole runs are atomically retired before release.
        cleanupRun(dir,run,now,retainedParents.has(`${repo}/${run}`),admit);
      }
    }
    admit();const legacy=join(root,'legacy-imports');
    if(fs.existsSync(legacy)){
      admit();const directory=fs.lstatSync(legacy);if(directory.isSymbolicLink()||!directory.isDirectory())throw new CsoError('UNSAFE_PATH','Legacy report archive is not a private directory');
      for(const name of names(legacy,/^[a-f0-9]{64}\.json$/)){
        admit();const file=join(legacy,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||(process.getuid&&stat.uid!==process.getuid()))throw new CsoError('UNSAFE_PATH','Legacy report archive contains an unsafe artifact');
        admit();
        if(now-stat.mtimeMs>30*86400_000)fs.unlinkSync(file);
      }
    }
    return{complete:true,visited};
  }catch(error){
    if(error instanceof RetentionBudgetExhausted)return{complete:false,visited};
    throw error;
  }
}
