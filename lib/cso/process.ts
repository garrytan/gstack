import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, isAbsolute, delimiter, resolve } from 'node:path';
import { redactFindingSpans } from '../redact-engine';
import { CsoError, MAX_OUTPUT } from './contracts';

const SOURCE_RUNTIME=/^bun(?:\.exe)?$/i.test(basename(process.execPath));
const WINDOWS_GIT=process.platform==='win32'?(process.env.GSTACK_CSO_TRUSTED_GIT||(SOURCE_RUNTIME?Bun.which('git')??'':'')):'';
const WINDOWS_SYSTEM=process.platform==='win32'?join(process.env.SystemRoot||'C:\\Windows','System32'):'';
export const TRUSTED_DIRECTORIES = process.platform === 'win32'
  ? [...new Set([WINDOWS_GIT?dirname(WINDOWS_GIT):'',WINDOWS_SYSTEM].filter(Boolean))]
  : ['/usr/local/bin','/usr/bin','/bin','/opt/homebrew/bin','/usr/local/sbin','/usr/sbin','/sbin'];
export const TRUSTED_PATH = TRUSTED_DIRECTORIES.join(delimiter);
export function executable(name: string): string {
  // Never consult the audited repository's PATH or executable overrides.
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new CsoError('INVALID_ARGUMENT','Invalid executable name');
  if(process.platform==='win32'&&name.toLowerCase()==='git'){
    try{if(!WINDOWS_GIT||!isAbsolute(WINDOWS_GIT)||basename(WINDOWS_GIT).toLowerCase()!=='git.exe')throw new Error();const stat=statSync(WINDOWS_GIT);if(!stat.isFile())throw new Error();return realpathSync(WINDOWS_GIT);}catch{throw new CsoError('TOOL_UNAVAILABLE','git.exe is not the trusted executable bound during gstack setup');}
  }
  for (const directory of TRUSTED_DIRECTORIES) {
    const candidates=process.platform==='win32'?[join(directory,`${name}.exe`),join(directory,`${name}.cmd`),join(directory,name)]:[join(directory,name)];
    for(const p of candidates){
    try { const stat=statSync(p);accessSync(p,constants.X_OK);if(stat.isFile()&&(process.platform==='win32'||(stat.mode&0o111)))return realpathSync(p); } catch {}
    }
  }
  throw new CsoError('TOOL_UNAVAILABLE', `${name} is not installed in a trusted system executable directory`);
}
export function childEnvironment(home: string): Record<string,string> {
  return { PATH: TRUSTED_PATH, HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform==='win32'?'NUL':'/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1' };
}
export function redact(value: string): string {
  // Scan the complete bounded stream, including across write/chunk boundaries.
  const output = redactFindingSpans(value, { maxBytes: MAX_OUTPUT });
  if (output === null) throw new CsoError('REDACTION_FAILED','Payload withheld because redaction could not safely locate every secret');
  return output;
}
const HASH_KEYS=new Set(['planSha256','planHash','originalHash','executionHash','snapshotHash','sourceHash','beforeSha256','afterSha256','patchHash','reviewedPatchHash','harnessHash','fixturesHash','policyHash','auditPolicyHash','originalSourceHash','transformationsHash','archivesHash','inputHash','beforeSourceHash','afterSourceHash','beforeDependencies','afterDependencies','beforeConfiguration','afterConfiguration','requestHash','startPlanHash','testPlanHash','preparationHash','preparedManifestHash','preparedDependencyHash','sourceProjectionHash','executionEnvironmentHash','databaseHash','receiptHash','dependencyClosureHash','closureHash','acquisitionReceiptHash','registryResponseSha256','sha256','versionOutputSha256','isolationPolicyHash','contentSha256','sbomDigest','provenanceDigest','dependencyHash','configurationHash','assertionHash','commandsHash','minimumPassingTestsHash','commandHash','outputHash','observationHash','witnessHash','keyId']);
function safeMetadata(value:string,key:string):boolean{
  if(HASH_KEYS.has(key)&&/^[a-f0-9]{64}$/.test(value))return true;
  if(['id','fingerprint','findingId','verificationId','reproductionAttemptId','artifactId','bundleId','pathId'].includes(key)&&/^[a-f0-9]{32}$/.test(value))return true;
  if(key==='path'&&/^@cso-path\/\/[a-f0-9]{32}$/.test(value))return true;
  if(key==='repoId'&&/^[a-f0-9]{24}$/.test(value))return true;
  if(key==='runId'&&/^\d{13}-[a-f0-9]{16}$/.test(value))return true;
  if(key==='replayId'&&/^\d{13}-[a-f0-9]{16}$/.test(value))return true;
  if(['baseCommit','headCommit'].includes(key)&&/^[a-f0-9]{40,64}$/.test(value))return true;
  if(['createdAt','expiresAt','deadline','at','databaseUpdatedAt','qualifiedAt'].includes(key)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))return true;
  if(key==='nonce'&&/^[a-f0-9]{64}$/.test(value))return true;
  if(key==='publicKey'&&/^[a-f0-9]{88}$/.test(value))return true;
  if(key==='signature'&&/^[a-f0-9]{128}$/.test(value))return true;
  if(key==='image'&&/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value))return true;
  if(key==='integrity'&&/^(?:sha256|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(value))return true;
  return false;
}
function sanitizeJson(value:unknown,key:string,seen:WeakSet<object>,trustedMetadata:boolean):unknown{
  if(typeof value==='string'){
    if(trustedMetadata&&safeMetadata(value,key))return value;
    return redact(value);
  }
  if(value===null||typeof value!=='object')return value;
  if(seen.has(value as object))throw new CsoError('INVALID_SCHEMA','Cyclic JSON cannot be persisted');seen.add(value as object);
  if(Array.isArray(value)){const out=value.map(v=>sanitizeJson(v,key,seen,trustedMetadata));seen.delete(value);return out;}
  const out:Record<string,unknown>=Object.create(null);for(const [k,v] of Object.entries(value as Record<string,unknown>)){
    if(['__proto__','prototype','constructor'].includes(k))throw new CsoError('INVALID_SCHEMA','Unsafe JSON property');out[k]=sanitizeJson(v,k,seen,trustedMetadata);
  }seen.delete(value as object);return out;
}
/** Redact untrusted JSON content. Key names never make an untrusted value exempt. */
export function sanitizeForJson(value:unknown):unknown{return sanitizeJson(value,'',new WeakSet<object>(),false);}
/** Preserve only validated helper identifiers/hashes while redacting all content-bearing fields. */
export function sanitizeHelperForJson(value:unknown):unknown{return sanitizeJson(value,'',new WeakSet<object>(),true);}
export interface ProcessResult { code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; capturedBytes:number }
interface GitConfigIdentity { path:string; exists:boolean; dev?:number; ino?:number; mode?:number; size?:number; mtimeMs?:number; ctimeMs?:number; content?:string }
const GIT_CONFIG_LIMIT=1024*1024;
interface BoundedMetadataFile { dev:number;ino:number;mode:number;nlink:number;size:number;mtimeMs:number;ctimeMs:number;content:string }
function sameMetadataFile(left:BoundedMetadataFile|ReturnType<typeof lstatSync>,right:BoundedMetadataFile|ReturnType<typeof lstatSync>):boolean{
  return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.nlink===right.nlink&&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs;
}
function boundedMetadataFile(path:string,maxBytes:number,label:string,optional=false):BoundedMetadataFile|undefined{
  let before:ReturnType<typeof lstatSync>;
  try{before=lstatSync(path);}catch(error:any){if(optional&&error?.code==='ENOENT')return;throw new CsoError(error?.code==='ENOENT'?'SNAPSHOT_RACE':'UNSAFE_PATH',`${label} is not a bounded regular file`);}
  if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1||before.size>maxBytes)throw new CsoError('UNSAFE_PATH',`${label} is not a bounded regular file`);
  let fd:number|undefined;
  try{
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.size>maxBytes||!sameMetadataFile(before,opened))throw new CsoError('SNAPSHOT_RACE',`${label} changed while it was opened`);
    const buffer=Buffer.alloc(Math.min(maxBytes+1,opened.size+1));let bytes=0,count=0;
    while(bytes<buffer.length&&(count=readSync(fd,buffer,bytes,buffer.length-bytes,null))>0)bytes+=count;
    const final=fstatSync(fd),after=lstatSync(path);
    if(bytes!==opened.size||!final.isFile()||!after.isFile()||after.isSymbolicLink()||!sameMetadataFile(opened,final)||!sameMetadataFile(opened,after))
      throw new CsoError('SNAPSHOT_RACE',`${label} changed while it was read`);
    return{dev:opened.dev,ino:opened.ino,mode:opened.mode,nlink:opened.nlink,size:opened.size,mtimeMs:opened.mtimeMs,ctimeMs:opened.ctimeMs,content:buffer.subarray(0,bytes).toString('utf8')};
  }catch(error:any){
    if(error instanceof CsoError)throw error;
    if(['ENOENT','ELOOP','ENXIO'].includes(error?.code))throw new CsoError('SNAPSHOT_RACE',`${label} changed while it was opened`);
    throw new CsoError('UNSAFE_PATH',`${label} could not be read safely`);
  }finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}
function boundedConfig(path:string):GitConfigIdentity{
  const file=boundedMetadataFile(path,GIT_CONFIG_LIMIT,'Repository Git configuration',true);
  if(!file)return{path,exists:false};
  const {content}=file;
  // There is no process-wide "--no-includes" switch for ordinary Git
  // commands. Reject include directives before spawning Git so repository
  // configuration cannot pull policy or executable settings from elsewhere.
  if(/^\s*\[\s*include(?:if)?(?=[\s."\]])/im.test(content))throw new CsoError('UNSAFE_PATH','Repository Git config includes are not allowed during a security snapshot');
  return{path,exists:true,dev:file.dev,ino:file.ino,mode:file.mode,size:file.size,mtimeMs:file.mtimeMs,ctimeMs:file.ctimeMs,content};
}
function gitDirectories(repo:string):{gitDir:string;commonDir:string}{
  const marker=join(repo,'.git'),stat=lstatSync(marker);let gitDir:string;
  if(stat.isDirectory()&&!stat.isSymbolicLink())gitDir=realpathSync(marker);
  else if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=8192){
    const value=boundedMetadataFile(marker,8192,'Repository .git pointer')!.content,match=value.match(/^gitdir:\s*(.+?)\s*$/);
    if(!match||value.includes('\0')||value.split(/\r?\n/).filter(Boolean).length!==1)throw new CsoError('UNSAFE_PATH','Repository .git pointer is invalid');
    gitDir=realpathSync(resolve(dirname(marker),match[1]));
  }else throw new CsoError('UNSAFE_PATH','Repository .git metadata is not a regular directory or worktree pointer');
  const commonMarker=join(gitDir,'commondir'),commonFile=boundedMetadataFile(commonMarker,8192,'Repository common Git directory pointer',true);let commonDir=gitDir;
  if(commonFile){
    const value=commonFile.content.trim();
    if(!value||value.includes('\0')||value.includes('\n')||value.includes('\r'))throw new CsoError('UNSAFE_PATH','Repository common Git directory pointer is invalid');
    commonDir=realpathSync(resolve(gitDir,value));
  }
  return{gitDir,commonDir};
}
function gitConfigIdentities(repo:string):GitConfigIdentity[]{
  const {gitDir,commonDir}=gitDirectories(repo);
  // extensions.worktreeConfig makes config.worktree active in both linked and
  // main worktrees. Bind even its absence so it cannot appear after inspection
  // and feed Git an unchecked include or executable setting.
  return [join(commonDir,'config'),join(gitDir,'config.worktree')].map(boundedConfig);
}
function assertGitConfigIdentities(expected:GitConfigIdentity[]):void{
  for(const item of expected){
    const current=boundedConfig(item.path);
    if(current.exists!==item.exists||current.dev!==item.dev||current.ino!==item.ino||current.mode!==item.mode||current.size!==item.size||current.mtimeMs!==item.mtimeMs||current.ctimeMs!==item.ctimeMs||current.content!==item.content)
      throw new CsoError('SNAPSHOT_RACE','Repository Git configuration changed during a metadata operation');
  }
}
function hardenGit(file:string,args:string[]):{args:string[];configs?:GitConfigIdentity[]}{
  if(!/^(?:git|git\.exe)$/i.test(basename(file)))return{args};
  let trusted:string;try{trusted=executable('git');}catch{return{args};}
  if(realpathSync(file)!==trusted)return{args};
  const positions=args.flatMap((value,index)=>value==='-C'?[index]:[]);
  if(positions.length!==1||positions[0]+1>=args.length)throw new CsoError('INVALID_ARGUMENT','CSO Git operations require exactly one audited working directory');
  const position=positions[0],requested=args[position+1];
  if(!isAbsolute(requested))throw new CsoError('INVALID_ARGUMENT','CSO Git operations require an absolute audited working directory');
  const repo=realpathSync(requested),stat=statSync(repo);
  if(!stat.isDirectory())throw new CsoError('MISSING_INPUT','Audited Git working directory is not a directory');
  const configs=gitConfigIdentities(repo),nullPath=process.platform==='win32'?'NUL':'/dev/null';
  const prefix=args.slice(0,position),command=args.slice(position+2);
  return{configs,args:[...prefix,
    '--no-replace-objects',
    '-c','core.fsmonitor=false','-c',`core.hooksPath=${nullPath}`,'-c',`core.attributesFile=${nullPath}`,
    '-c',`core.excludesFile=${nullPath}`,'-c','core.ignoreCase=false','-c','core.precomposeUnicode=false',
    '-c','core.untrackedCache=false','-c',`include.path=${nullPath}`,'-c','core.pager=cat',
    '-C',repo,`--work-tree=${repo}`,...command]};
}
export async function runProcess(file: string, args: string[], opts: {
  cwd: string; env: Record<string,string>; timeoutMs?: number; maxBytes?: number; input?: string;
  raw?: boolean; // Only for inert Git framing or private helper/Docker control JSON that is validated before use. Never print or persist raw results.
}): Promise<ProcessResult> {
  if (!isAbsolute(file) || !isAbsolute(opts.cwd) || !existsSync(opts.cwd)) throw new CsoError('INVALID_ARGUMENT','Children require absolute executables and an existing trusted working directory');
  if (!args.every(a => typeof a === 'string' && !a.includes('\0'))) throw new CsoError('INVALID_ARGUMENT','Invalid child argument');
  const hardened=hardenGit(file,args);args=hardened.args;
  const cap = Math.min(opts.maxBytes ?? MAX_OUTPUT, MAX_OUTPUT);
  return new Promise((resolve,reject) => {
    const child = spawn(file,args,{cwd:opts.cwd,env:opts.env,stdio:['pipe','pipe','pipe'],detached:process.platform !== 'win32'});
    const out: Buffer[] = [], err: Buffer[] = [], ordered:Buffer[]=[]; let bytes = 0, timedOut = false, truncated = false;
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid,'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1,Math.min(opts.timeoutMs ?? 30_000,300_000)));
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > cap) { truncated = true; kill(); return; }
      target.push(chunk);ordered.push(chunk);
    };
    child.stdout.on('data',capture(out)); child.stderr.on('data',capture(err));
    child.on('error',() => { clearTimeout(timer); reject(new CsoError('TOOL_UNAVAILABLE','Trusted child process could not start')); });
    child.on('close',code => {
      clearTimeout(timer);
      try {
        if(hardened.configs)assertGitConfigIdentities(hardened.configs);
        // Never expose a truncated tail: it might be the beginning of a secret.
        const stdout = truncated ? '[output withheld: size limit]' : Buffer.concat(out).toString('utf8');
        const stderr = truncated ? '' : Buffer.concat(err).toString('utf8');
        if(opts.raw){resolve({code:code ?? -1,stdout,stderr,timedOut,truncated,capturedBytes:bytes});return;}
        // A token may be split across stdout/stderr. Stream ordering is not
        // recoverable here, so scan both concatenation orders and withhold both
        // channels when either reveals a cross-stream sensitive span.
        const forward=stdout+stderr,reverse=stderr+stdout,chronological=Buffer.concat(ordered).toString('utf8');
        if([stdout,stderr,forward,reverse,chronological].some(value=>redact(value)!==value)){
          resolve({code:code ?? -1,stdout:'[sensitive process output redacted]',stderr:'',timedOut,truncated,capturedBytes:bytes});return;
        }
        resolve({code:code ?? -1,stdout,stderr,timedOut,truncated,capturedBytes:bytes});
      } catch (e) { reject(e); }
    });
    child.stdin.on('error',() => {}); child.stdin.end(opts.input);
  });
}
export async function git(repo: string, args: string[], home: string): Promise<string> {
  const result = await runProcess(executable('git'),['--no-optional-locks','-C',repo,...args],
    {cwd:home,env:childEnvironment(home),raw:true,timeoutMs:15_000});
  if (result.code || result.timedOut || result.truncated) {
    // Git stderr and argv can contain repository paths, refs, and configured
    // content. Name only the fixed helper-owned operation and bounded process
    // outcome so native failures are actionable without exposing either.
    const knownOperations=new Set(['rev-parse','symbolic-ref','ls-files','ls-tree','log','merge-base']),operation=args.find(value=>knownOperations.has(value))??'metadata',
      phase=operation==='rev-parse'&&args.includes('--show-object-format')?'object-format':operation==='rev-parse'&&args.includes('--is-inside-work-tree')?'worktree-probe':operation,
      reason=/not a git repository|outside repository/i.test(result.stderr)?'repository unavailable':/dubious ownership/i.test(result.stderr)?'repository ownership rejected':/(?:bad|invalid|unable to read).*config|config (?:error|file)/i.test(result.stderr)?'configuration rejected':/unknown option|unknown switch|unrecognized option|usage:/i.test(result.stderr)?'unsupported invocation':/(?:cannot|could not|unable to) (?:chdir|change directory)|no such file or directory/i.test(result.stderr)?'path unavailable':'request rejected',
      outcome=result.timedOut?'timed out':result.truncated?'exceeded the output limit':`exited ${result.code}`;
    throw new CsoError('MISSING_INPUT',`Could not read bounded Git metadata: ${phase} ${outcome} (${reason}); source may not be a Git repository`);
  }
  return result.stdout;
}
