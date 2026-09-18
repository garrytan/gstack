import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { CsoError, SnapshotManifest, SnapshotEntry, SnapshotPathIdentity, canonical, sha256, relativePath, snapshotOriginalIdentity, snapshotPathHandle, snapshotPathId, MAX_OUTPUT } from './contracts';
import { childEnvironment, executable, git, redact, runProcess } from './process';
import { secureDirectory, writeHelperJson, writeJson } from './state';
import { scan } from '../redact-engine';
import { atomicWriteSync } from '../fs-atomic';

const NO_READ_COMPONENTS=new Set(['.git','.hg','.svn','node_modules','.venv','venv','__pycache__','.bundle','.cache','.context','.gstack']);
const OMIT_COMPONENTS=new Set([...NO_READ_COMPONENTS,'.claude','.agents','.codex','.cursor']);
function containsDirectory(path:string,components:Set<string>,sequences:string[][]=[]):boolean{
  const parts=path.split('/');if(parts.slice(0,-1).some(part=>components.has(part)))return true;
  return sequences.some(sequence=>parts.slice(0,-1).some((_,index)=>sequence.every((part,offset)=>parts[index+offset]===part)));
}
function noReadPath(path:string):boolean{return containsDirectory(path,NO_READ_COMPONENTS,[['vendor','bundle']]);}
function omittedPath(path:string):boolean{return containsDirectory(path,OMIT_COMPONENTS,[['vendor','bundle'],['.github','agents']]);}
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|pip\.conf|credentials(?:\.yml(?:\.enc)?)?|master\.key|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key)|AGENTS\.md|CLAUDE\.md|GEMINI\.md|bunfig\.toml)$/i;
const SOURCE_LIMIT=64*1024*1024;
const SNAPSHOT_ENTRY_LIMIT=100_000;
const GIT_POINTER_LIMIT=8192;
export interface SnapshotCaptureLimits { deadlineMs?:number; maxEntries?:number }

type BoundPathIdentity={path:string;kind:'directory'|'file';dev:number;ino:number;mode:number;size:number;mtimeMs:number;ctimeMs:number;contentHash?:string};
type RepositoryIdentity={root:BoundPathIdentity;metadata:BoundPathIdentity[]};
function boundPath(path:string,label:string,maxBytes=GIT_POINTER_LIMIT):{identity:BoundPathIdentity;content?:string}{
  let named:fs.Stats;try{named=fs.lstatSync(path);}catch{throw new CsoError('SNAPSHOT_RACE',`${label} disappeared during snapshot capture`);}
  if(named.isSymbolicLink())throw new CsoError('UNSAFE_PATH',`${label} cannot be a symlink`);
  if(named.isDirectory())return{identity:{path,kind:'directory',dev:named.dev,ino:named.ino,mode:named.mode,size:named.size,mtimeMs:named.mtimeMs,ctimeMs:named.ctimeMs}};
  if(!named.isFile()||named.nlink!==1||named.size>maxBytes)throw new CsoError('UNSAFE_PATH',`${label} must be a bounded regular file or directory`);
  let fd:number|undefined;try{
    fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));const opened=fs.fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==named.dev||opened.ino!==named.ino||opened.mode!==named.mode||opened.size!==named.size)throw new CsoError('SNAPSHOT_RACE',`${label} changed before it could be read`);
    const buffer=Buffer.alloc(maxBytes+1);let bytes=0,count=0;while(bytes<buffer.length&&(count=fs.readSync(fd,buffer,bytes,buffer.length-bytes,null))>0)bytes+=count;
    const after=fs.fstatSync(fd),current=fs.lstatSync(path);if(bytes>maxBytes)throw new CsoError('UNSAFE_PATH',`${label} exceeds its bounded size limit`);
    if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1||current.dev!==opened.dev||current.ino!==opened.ino||current.mode!==opened.mode||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw new CsoError('SNAPSHOT_RACE',`${label} changed while it was read`);
    const body=buffer.subarray(0,bytes);return{identity:{path,kind:'file',dev:after.dev,ino:after.ino,mode:after.mode,size:after.size,mtimeMs:after.mtimeMs,ctimeMs:after.ctimeMs,contentHash:sha256(body)},content:body.toString('utf8')};
  }catch(error){if(error instanceof CsoError)throw error;const code=(error as NodeJS.ErrnoException).code;if(['ELOOP','ENOENT','ENOTDIR','ENXIO'].includes(code??''))throw new CsoError('SNAPSHOT_RACE',`${label} changed before it could be opened`);throw new CsoError('UNSAFE_PATH',`${label} could not be read as a bounded regular file`);}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function sameIdentity(expected:BoundPathIdentity,current:BoundPathIdentity):boolean{return expected.path===current.path&&expected.kind===current.kind&&expected.dev===current.dev&&expected.ino===current.ino&&expected.mode===current.mode&&expected.size===current.size&&expected.mtimeMs===current.mtimeMs&&expected.ctimeMs===current.ctimeMs&&expected.contentHash===current.contentHash;}
function repositoryIdentity(repo:string):RepositoryIdentity{
  const root=boundPath(repo,'Audited repository root').identity;if(root.kind!=='directory')throw new CsoError('MISSING_INPUT','Audited repository root is not a directory');
  const markerPath=join(repo,'.git'),marker=boundPath(markerPath,'Repository .git marker'),metadata=[marker.identity];let gitDir:string;
  if(marker.identity.kind==='directory')gitDir=fs.realpathSync(markerPath);
  else{const value=marker.content??'',match=value.match(/^gitdir:\s*(.+?)\s*$/);if(!match||value.includes('\0')||value.split(/\r?\n/).filter(Boolean).length!==1)throw new CsoError('UNSAFE_PATH','Repository .git pointer is invalid');gitDir=fs.realpathSync(resolve(dirname(markerPath),match[1]));}
  const gitDirIdentity=boundPath(gitDir,'Repository Git directory').identity;if(gitDirIdentity.kind!=='directory')throw new CsoError('UNSAFE_PATH','Repository Git directory is not a directory');metadata.push(gitDirIdentity);
  const commonMarker=join(gitDir,'commondir');let commonDir=gitDir;
  if(fs.existsSync(commonMarker)){const marker=boundPath(commonMarker,'Repository common Git directory pointer');if(marker.identity.kind!=='file')throw new CsoError('UNSAFE_PATH','Repository common Git directory pointer is invalid');metadata.push(marker.identity);const value=(marker.content??'').trim();if(!value||value.includes('\0')||value.includes('\n')||value.includes('\r'))throw new CsoError('UNSAFE_PATH','Repository common Git directory pointer is invalid');commonDir=fs.realpathSync(resolve(gitDir,value));}
  const commonIdentity=boundPath(commonDir,'Repository common Git directory').identity;if(commonIdentity.kind!=='directory')throw new CsoError('UNSAFE_PATH','Repository common Git directory is not a directory');metadata.push(commonIdentity);
  const unique=[...new Map(metadata.map(item=>[item.path,item])).values()];const identity={root,metadata:unique};assertRepositoryIdentity(identity);return identity;
}
function assertRepositoryIdentity(expected:RepositoryIdentity):void{
  const compare=(item:BoundPathIdentity,label:string)=>{const current=boundPath(item.path,label,item.kind==='file'?Math.max(GIT_POINTER_LIMIT,item.size):GIT_POINTER_LIMIT).identity;if(!sameIdentity(item,current))throw new CsoError('SNAPSHOT_RACE',`${label} changed during snapshot capture`);};
  compare(expected.root,'Audited repository root');for(const item of expected.metadata)compare(item,'Repository Git metadata identity');compare(expected.root,'Audited repository root');
}
function snapshotAdmission(limits:SnapshotCaptureLimits={}){
  const deadlineMs=limits.deadlineMs??Date.now()+9*60_000,maxEntries=Math.min(limits.maxEntries??SNAPSHOT_ENTRY_LIMIT,SNAPSHOT_ENTRY_LIMIT);
  if(!Number.isSafeInteger(deadlineMs)||!Number.isSafeInteger(maxEntries)||maxEntries<1)throw new CsoError('INVALID_ARGUMENT','Invalid snapshot admission limits');
  const time=()=>{if(Date.now()>=deadlineMs)throw new CsoError('DEADLINE','Snapshot capture exhausted the investigation budget before a report could be created');};
  const count=(entries:number)=>{if(entries>maxEntries)throw new CsoError('MISSING_INPUT',`Source tree exceeds the ${maxEntries}-entry snapshot admission limit`);};
  return{time,count};
}
export function exclusion(path: string): string | undefined {
  if (omittedPath(path)) return 'host dependencies, metadata, state, or agent configuration';
  if (SECRET_FILE.test(path)) return 'credential or execution configuration';
}
export function containedFile(root: string, path: string): string {
  const rel = relativePath(path), full = join(root,rel); let cursor = root;
  for (const part of rel.split('/')) {
    cursor = join(cursor,part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new CsoError('UNSAFE_PATH',`Symlink is not an execution input: ${rel}`);
    } catch (error) {
      if (error instanceof CsoError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!full.startsWith(root + sep)) throw new CsoError('UNSAFE_PATH','Path escaped snapshot');
  return full;
}
type DirectoryIdentity={path:string;dev:number;ino:number;mode:number};
function inside(root:string,candidate:string):boolean{const relation=relative(root,candidate);return relation===''||(relation!=='..'&&!relation.startsWith(`..${sep}`)&&!isAbsolute(relation));}
function directoryIdentities(root:string,path:string):DirectoryIdentity[]{
  const rel=relativePath(path),parts=rel.split('/'),identities:DirectoryIdentity[]=[];let cursor=root;
  for(const part of ['',...parts.slice(0,-1)]){
    if(part)cursor=join(cursor,part);
    let stat:fs.Stats;try{stat=fs.lstatSync(cursor);}catch{throw new CsoError('SNAPSHOT_RACE',`Source ancestor changed while opening: ${rel}`);}
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new CsoError('UNSAFE_PATH',`Symlink or non-directory source ancestor: ${rel}`);
    identities.push({path:cursor,dev:stat.dev,ino:stat.ino,mode:stat.mode});
  }
  return identities;
}
function assertDirectoryIdentities(identities:DirectoryIdentity[],path:string):void{
  for(const expected of identities){let current:fs.Stats;try{current=fs.lstatSync(expected.path);}catch{throw new CsoError('SNAPSHOT_RACE',`Source ancestor changed while reading: ${path}`);}
    if(current.isSymbolicLink()||!current.isDirectory()||current.dev!==expected.dev||current.ino!==expected.ino||current.mode!==expected.mode)throw new CsoError('SNAPSHOT_RACE',`Source ancestor changed while reading: ${path}`);
  }
}
/** Validate the resolved inode after open so an ancestor-symlink swap cannot escape root. */
export function assertOpenedFileContained(root:string,full:string,fd:number,opened:fs.Stats):void{
  if(process.platform==='linux'){
    let actual:string,current:fs.Stats;try{actual=fs.readlinkSync(`/proc/self/fd/${fd}`);current=fs.fstatSync(fd);}catch{throw new CsoError('SNAPSHOT_RACE','Opened source identity could not be resolved');}
    if(current.nlink!==1||current.dev!==opened.dev||current.ino!==opened.ino||current.mode!==opened.mode)throw new CsoError('SNAPSHOT_RACE','Opened source identity changed during containment validation');
    if(!isAbsolute(actual)||!inside(root,actual))throw new CsoError('UNSAFE_PATH','Opened source escaped the audited root');
    return;
  }
  let resolved:string,current:fs.Stats;try{resolved=fs.realpathSync(full);current=fs.lstatSync(resolved);}catch{throw new CsoError('SNAPSHOT_RACE','Opened source identity changed during containment validation');}
  if(!inside(root,resolved))throw new CsoError('UNSAFE_PATH','Opened source escaped the audited root');
  if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1||current.dev!==opened.dev||current.ino!==opened.ino||current.mode!==opened.mode||current.size!==opened.size)throw new CsoError('SNAPSHOT_RACE','Opened source identity changed during containment validation');
}
function readStable(root: string, path: string, maxBytes=MAX_OUTPUT): {data:Buffer; mode:number} {
  const ancestors=directoryIdentities(root,path),full = containedFile(root,path), named=fs.lstatSync(full);
  // Prove the pathname is a regular single-link file before open. Opening a
  // FIFO or device merely to discover its type can block or trigger host I/O.
  if(named.isSymbolicLink()||!named.isFile()||named.nlink!==1)throw new CsoError('UNSAFE_PATH',`Special or hard-linked source file: ${path}`);
  let fd:number;try{fd=fs.openSync(full,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0) | (fs.constants.O_NONBLOCK??0));}catch(error){const code=(error as NodeJS.ErrnoException).code;if(['ELOOP','ENOENT','ENOTDIR','ENXIO'].includes(code??''))throw new CsoError('SNAPSHOT_RACE',`Source changed before it could be opened: ${path}`);throw new CsoError('UNSAFE_PATH',`Source could not be opened as a regular file: ${path}`);}
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev!==named.dev || before.ino!==named.ino || before.mode!==named.mode || before.size!==named.size) throw new CsoError('UNSAFE_PATH',`Special or hard-linked source file: ${path}`);
    assertOpenedFileContained(root,full,fd,before);assertDirectoryIdentities(ancestors,path);
    if (before.size > maxBytes) throw new CsoError('MISSING_INPUT',`Source file exceeds the ${maxBytes}-byte snapshot admission limit: ${path}`);
    const buffer=Buffer.alloc(Math.min(maxBytes+1,before.size+1));let bytes=0,count=0;while(bytes<buffer.length&&(count=fs.readSync(fd,buffer,bytes,buffer.length-bytes,null))>0)bytes+=count;const data=buffer.subarray(0,bytes),after = fs.fstatSync(fd), current = fs.lstatSync(full);
    if (!current.isFile()||current.nlink!==1||before.ino !== current.ino || before.dev !== current.dev || before.mode!==current.mode || before.size !== after.size || before.size!==bytes || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new CsoError('SNAPSHOT_RACE',`Source changed while reading: ${path}`);
    assertOpenedFileContained(root,full,fd,after);assertDirectoryIdentities(ancestors,path);
    return {data,mode:before.mode & 0o777};
  } finally { fs.closeSync(fd); }
}
async function resolveHeadCommit(repo:string,home:string):Promise<string|undefined>{
  try{return(await git(repo,['rev-parse','--verify','HEAD^{commit}'],home)).trim();}
  catch(error){
    // A symbolic HEAD whose target does not exist is the normal unborn-branch
    // state. A detached/malformed HEAD or a ref to a non-commit remains an
    // input error instead of being silently treated as an empty history.
    try{await git(repo,['symbolic-ref','--quiet','HEAD'],home);}catch{throw error;}
    try{await git(repo,['rev-parse','--verify','HEAD'],home);}catch{return undefined;}
    throw error;
  }
}
async function paths(repo: string, home: string,headCommit:string|undefined,admission:ReturnType<typeof snapshotAdmission>): Promise<string[]> {
  // The index omits staged deletions. Union the pinned HEAD tree so every
  // tracked deletion is represented even when no comparison base was asked
  // for, while still collecting nonignored untracked source.
  admission.time();const [working,head]=await Promise.all([
    git(repo,['ls-files','--cached','--others','--exclude-standard','-z'],home),
    headCommit?git(repo,['ls-tree','-r','-z','--name-only','--full-tree',headCommit,'--'],home):Promise.resolve(''),
  ]),seen=new Set<string>();admission.time();
  for(const data of [working,head])for(const value of data.split('\0')){admission.time();if(!value)continue;seen.add(relativePath(value));admission.count(seen.size);}
  const result=[...seen].sort();admission.time();return result;
}
async function rejectSpecialFiles(repo:string,home:string,admission:ReturnType<typeof snapshotAdmission>):Promise<void>{
  // Git intentionally omits untracked FIFOs and devices from ls-files. Walk
  // pathnames without opening payloads, then ask Git which special names are
  // ignored so a nonignored FIFO cannot silently disappear from the snapshot.
  admission.time();const ignoredRaw=await git(repo,['ls-files','--others','--ignored','--exclude-standard','--directory','-z'],home),ignoredDirectories=new Set<string>();admission.time();
  for(const value of ignoredRaw.split('\0')){admission.time();if(!value)continue;ignoredDirectories.add(relativePath(value.replace(/\/$/,'')));admission.count(ignoredDirectories.size);}
  const ignoredDirectory=(path:string)=>{let candidate=path;for(;;){if(ignoredDirectories.has(candidate))return true;const slash=candidate.lastIndexOf('/');if(slash<0)return false;candidate=candidate.slice(0,slash);}};
  const special:string[]=[];let visited=0;
  const walk=(at:string,prefix='')=>{const directory=fs.opendirSync(at);try{let item:fs.Dirent|null;while((item=directory.readSync())!==null){
    admission.time();const path=relativePath(prefix?`${prefix}/${item.name}`:item.name);if(noReadPath(path)||ignoredDirectory(path))continue;admission.count(++visited);
    const full=join(at,item.name),stat=fs.lstatSync(full);if(stat.isDirectory()){walk(full,path);continue;}if(!stat.isFile())special.push(path);
  }}finally{directory.closeSync();}};walk(repo);
  if(!special.length)return;
  const nullPath=process.platform==='win32'?'NUL':'/dev/null',result=await runProcess(executable('git'),['--no-optional-locks','-c','core.fsmonitor=false','-c',`core.hooksPath=${nullPath}`,'-c',`core.attributesFile=${nullPath}`,'-c','core.pager=cat','-C',repo,'check-ignore','--no-index','-z','--stdin'],{cwd:home,env:childEnvironment(home),raw:true,input:`${special.join('\0')}\0`,timeoutMs:15_000});
  if(![0,1].includes(result.code)||result.timedOut||result.truncated)throw new CsoError('MISSING_INPUT','Could not determine whether special source paths are ignored');
  admission.time();const ignored=new Set(result.stdout.split('\0').filter(Boolean).map(relativePath)),unsafe=special.find(path=>!ignored.has(path));
  if(unsafe)throw new CsoError('UNSAFE_PATH',`Symlink or special source file: ${unsafe}`);
}
export async function capture(repo: string, runDir: string, base?: string, requiredAncestor?:string, limits:SnapshotCaptureLimits={}): Promise<SnapshotManifest> {
  repo = fs.realpathSync(repo);
  const state=fs.realpathSync(runDir),relation=relative(repo,state);if(relation===''||(!relation.startsWith(`..${sep}`)&&relation!=='..'&&!isAbsolute(relation)))throw new CsoError('UNSAFE_PATH','Security state must be outside the audited repository');
  const repository=repositoryIdentity(repo),home = secureDirectory(join(runDir,'home')), snapshot = secureDirectory(join(runDir,'snapshot')), readable = secureDirectory(join(runDir,'readable')),admission=snapshotAdmission(limits),guard=()=>{admission.time();assertRepositoryIdentity(repository);};
  try {
  const entries: SnapshotEntry[] = [], gitHashes=new Map<string,string>(), gitModes=new Map<string,string>(), sensitiveEvidence:any[]=[], absentPaths=new Set<string>(); let total = 0;guard();
  const objectFormat=(await git(repo,['rev-parse','--show-object-format'],home)).trim();guard();
  if(!['sha1','sha256'].includes(objectFormat))throw new CsoError('INCOMPATIBLE_INPUT','Unsupported Git object format');
  const headCommit = await resolveHeadCommit(repo,home);guard();
  const list = await paths(repo,home,headCommit,admission);guard();await rejectSpecialFiles(repo,home,admission);guard();
  const manifest: SnapshotManifest = {version:3,root:repo,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400_000).toISOString(),entries,...(headCommit?{headCommit}:{}),originalHash:'',executionHash:''};
  if (base) {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(base) || base.startsWith('-')) throw new CsoError('INVALID_ARGUMENT','Invalid comparison base');
    manifest.baseCommit = (await git(repo,['rev-parse','--verify',`${base}^{commit}`],home)).trim();guard();
  }
    for (const path of list) {
      guard();
      try{fs.lstatSync(join(repo,path));}catch(error:any){if(error?.code==='ENOENT'){absentPaths.add(path);continue;}throw error;} // tracked deletions are represented by absence and the diff manifest
      // Host dependency trees aren't copied or read. Their omission is still explicit.
      if (noReadPath(path)) {
        const stat = fs.lstatSync(containedFile(repo,path));
        if (stat.isSymbolicLink() || !stat.isFile()) throw new CsoError('UNSAFE_PATH',`Special source input: ${path}`);
        gitModes.set(path,(stat.mode&0o111)?'100755':'100644');
        const reason=exclusion(path)??'host dependency input';
        entries.push({path,pathId:snapshotPathId(repo,path),originalHash:'not-read',bytes:stat.size,mode:stat.mode & 0o777,transformation:`excluded: ${reason}`});guard();continue;
      }
      const {data,mode} = readStable(repo,path,SOURCE_LIMIT); total += data.length;
      guard();
      if (total > SOURCE_LIMIT) throw new CsoError('MISSING_INPUT','Source exceeds the 64 MiB snapshot admission limit');
      const entry: SnapshotEntry = {path,pathId:snapshotPathId(repo,path),originalHash:sha256(data),bytes:data.length,mode}; entries.push(entry);
      gitHashes.set(path,createHash(objectFormat).update(`blob ${data.length}\0`).update(data).digest('hex'));
      gitModes.set(path,(mode&0o111)?'100755':'100644');
      if(data.length>MAX_OUTPUT){entry.transformation='withheld: exceeds the 1 MiB redacting-reader limit';continue;}
      let sanitized: string;
      try {
        sanitized = new TextDecoder('utf-8',{fatal:true}).decode(data);
        if (sanitized.includes('\0')) throw new Error('binary');
        const findings=scan(sanitized,{maxBytes:MAX_OUTPUT}).findings;
        if(findings.length)sensitiveEvidence.push({path:snapshotPathHandle(entry.pathId),findings:findings.map(f=>({id:f.id,tier:f.tier,line:f.line,col:f.col}))});
        sanitized = redact(sanitized);
      } catch { entry.transformation = exclusion(path)?`excluded: ${exclusion(path)}; payload withheld because redaction could not safely preserve it`:'withheld: binary or redaction failed'; continue; }
      const out = containedFile(readable,path); secureDirectory(dirname(out)); fs.writeFileSync(out,sanitized,{mode:0o600});
      const reason = exclusion(path);
      if (reason) { entry.transformation = `excluded: ${reason}`; continue; }
      if (sha256(sanitized) !== entry.originalHash) entry.transformation = 'secret spans redacted';
      const target = containedFile(snapshot,path); secureDirectory(dirname(target)); fs.writeFileSync(target,sanitized,{mode});
      // writeFile's creation mode is filtered through the caller's umask. The
      // skill deliberately starts with umask 077, while the manifest binds the
      // original mode because executable bits are part of the application
      // input. Restore the exact recorded mode after creation; the snapshot's
      // owned 0700 ancestors still keep every retained source file private.
      fs.chmodSync(target,mode);
      entry.executionHash = sha256(sanitized);
    }
    const deletedPaths:SnapshotPathIdentity[]=[...absentPaths].sort().map(path=>({path,pathId:snapshotPathId(repo,path)}));if(deletedPaths.length)manifest.deletedPaths=deletedPaths;
    const assertAbsent=()=>{for(const path of absentPaths){admission.time();try{fs.lstatSync(containedFile(repo,path));}catch(error:any){if(error?.code==='ENOENT')continue;throw error;}throw new CsoError('SNAPSHOT_RACE',`Deleted source path reappeared during snapshot capture: ${path}`);}};
    const assertEntriesStable=(message:string)=>{for(const e of entries){guard();if(e.originalHash==='not-read'){const current=fs.lstatSync(containedFile(repo,e.path));if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1||current.size!==e.bytes||(current.mode&0o777)!==e.mode)throw new CsoError('SNAPSHOT_RACE',`${message}: ${e.path}`);}else{const current=readStable(repo,e.path,SOURCE_LIMIT);if(sha256(current.data)!==e.originalHash||current.mode!==e.mode)throw new CsoError('SNAPSHOT_RACE',`${message}: ${e.path}`);}guard();}};
    if (canonical(list) !== canonical(await paths(repo,home,headCommit,admission))) throw new CsoError('SNAPSHOT_RACE','Source file membership changed during snapshot');guard();assertAbsent();assertEntriesStable('Source changed during capture');
    manifest.originalHash = snapshotOriginalIdentity(entries,deletedPaths);
    manifest.executionHash = sha256(canonical(entries.filter(e => e.executionHash).map(e => [e.path,e.executionHash,e.mode])));
    if(manifest.baseCommit){
      const tree=await git(repo,['ls-tree','-r','-z','--full-tree',manifest.baseCommit,'--'],home),baseFiles=new Map<string,{hash:string,mode:string}>();guard();
      for(const row of tree.split('\0').filter(Boolean)){admission.time();const match=row.match(/^(\d+) (?:blob|commit) ([a-f0-9]+)\t(.+)$/s);if(match)baseFiles.set(relativePath(match[3]),{mode:match[1],hash:match[2]});admission.count(baseFiles.size);}
      const differs=(path:string):boolean=>{const baseEntry=baseFiles.get(path),hash=gitHashes.get(path),mode=gitModes.get(path);return !baseEntry||hash!==baseEntry.hash||mode!==baseEntry.mode;};
      manifest.changedPaths=[...new Set([...list.filter(differs),...baseFiles.keys()].filter(path=>differs(path)||!gitModes.has(path)))].sort();
    }
    try{
      if(!headCommit){atomicWriteSync(join(runDir,'history.txt'),'',{mode:0o600});writeJson(join(runDir,'history-status.json'),{status:'captured',range:'unborn HEAD',commits:0,bytes:0});}
      else{
        const range=manifest.baseCommit?`${manifest.baseCommit}..${headCommit}`:headCommit;
        admission.time();const raw=await git(repo,['-c','core.quotePath=false','log','--no-ext-diff','--no-textconv','--max-count=100','--format=commit %H%nAuthor: %an%nDate: %aI%nSubject: %s','--unified=3','-p',range,'--'],home);guard();const safe=redact(raw);
        atomicWriteSync(join(runDir,'history.txt'),safe,{mode:0o600});writeJson(join(runDir,'history-status.json'),{status:'captured',range,commits:'at most 100',bytes:Buffer.byteLength(safe)});
      }
    }catch(error){if(error instanceof CsoError&&['DEADLINE','SNAPSHOT_RACE','UNSAFE_PATH'].includes(error.code))throw error;writeJson(join(runDir,'history-status.json'),{status:'not_assessed',gap:error instanceof CsoError?error.message:'Historical evidence could not be safely retained'});}
    if((await resolveHeadCommit(repo,home))!==headCommit)throw new CsoError('SNAPSHOT_RACE','HEAD changed during snapshot capture');guard();
    if(base&&manifest.baseCommit&&(await git(repo,['rev-parse','--verify',`${base}^{commit}`],home)).trim()!==manifest.baseCommit)throw new CsoError('SNAPSHOT_RACE','Comparison base changed during snapshot capture');guard();
    if(requiredAncestor){
      if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(requiredAncestor))throw new CsoError('INCOMPATIBLE_INPUT','Original audit commit identity is invalid');
      if(!headCommit)throw new CsoError('INCOMPATIBLE_INPUT','Captured current source has no commit descended from the original audit');
      try{await git(repo,['merge-base','--is-ancestor',requiredAncestor,headCommit],home);}
      catch{throw new CsoError('INCOMPATIBLE_INPUT','Captured current source is not a descendant of the original audited commit');}
      guard();
    }
    // Finish with a complete source check. Nothing below this block reads the
    // audited repository, so a late nonignored file or restored deletion cannot
    // fall between the final inventory and manifest publication.
    await rejectSpecialFiles(repo,home,admission);guard();assertEntriesStable('Source changed before snapshot persistence');
    if(canonical(list)!==canonical(await paths(repo,home,headCommit,admission)))throw new CsoError('SNAPSHOT_RACE','Source file membership changed before snapshot persistence');guard();assertAbsent();
    admission.time();writeHelperJson(join(runDir,'sensitive-evidence.json'),sensitiveEvidence);
    // The manifest contains helper-computed identities and source pathnames but
    // never source payloads. Persist it exactly in private state: generic
    // content redaction would silently break the path/hash identity relation.
    const serialized=JSON.stringify(manifest,null,2);if(Buffer.byteLength(serialized)+1>MAX_OUTPUT)throw new CsoError('MISSING_INPUT','Snapshot manifest exceeds the 1 MiB private-state admission limit');atomicWriteSync(join(runDir,'snapshot.json'),serialized+'\n',{mode:0o600}); return manifest;
  } catch(e) {
    fs.rmSync(snapshot,{recursive:true,force:true}); fs.rmSync(readable,{recursive:true,force:true});fs.rmSync(home,{recursive:true,force:true}); throw e;
  }
}
export function assertSnapshot(runDir: string, manifest: SnapshotManifest): void {
  const root=join(runDir,'snapshot');
  if (manifest.version!==3||typeof manifest.root!=='string'||!isAbsolute(manifest.root)||!Array.isArray(manifest.entries)||(manifest.deletedPaths!==undefined&&!Array.isArray(manifest.deletedPaths))||(manifest.headCommit!==undefined&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.headCommit))||(manifest.baseCommit!==undefined&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.baseCommit))||!/^\d{4}-\d\d-\d\dT/.test(manifest.expiresAt)||Date.parse(manifest.expiresAt) <= Date.now() || !fs.existsSync(root)) throw new CsoError('MISSING_INPUT','Retained source expired or invalid; supply source with exactly matching required hashes');
  const rootStat=fs.lstatSync(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||(process.getuid&&rootStat.uid!==process.getuid()))throw new CsoError('UNSAFE_PATH','Retained snapshot root is not a private owned directory');
  const listed=():string[]=>{const out:string[]=[];const walk=(at:string,relativeRoot='')=>{for(const item of fs.readdirSync(at,{withFileTypes:true})){const rel=relativeRoot?`${relativeRoot}/${item.name}`:item.name,full=join(at,item.name),stat=fs.lstatSync(full);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw new CsoError('UNSAFE_PATH',`Special file entered retained snapshot: ${rel}`);if(stat.isDirectory())walk(full,rel);else out.push(relativePath(rel));}};walk(root);return out.sort();};
  const entries=manifest.entries.map(e=>{if(!e||typeof e!=='object')throw new CsoError('INCOMPATIBLE_INPUT','Snapshot manifest contains an invalid entry');const path=relativePath(e.path);if(!/^[a-f0-9]{32}$/.test(e.pathId)||e.pathId!==snapshotPathId(manifest.root,path)||!(/^[a-f0-9]{64}$/.test(e.originalHash)||e.originalHash==='not-read')||!Number.isSafeInteger(e.bytes)||e.bytes<0||!Number.isInteger(e.mode)||e.mode<0||e.mode>0o777||(e.transformation!==undefined&&typeof e.transformation!=='string'))throw new CsoError('INCOMPATIBLE_INPUT','Snapshot manifest contains an invalid source entry');if(e.executionHash!==undefined&&!/^[a-f0-9]{64}$/.test(e.executionHash))throw new CsoError('INCOMPATIBLE_INPUT','Snapshot manifest contains an invalid execution entry');if(e.originalHash==='not-read'&&(e.executionHash!==undefined||!e.transformation))throw new CsoError('INCOMPATIBLE_INPUT','Unread source cannot be represented as an execution input');return{...e,path};});
  const deleted=(manifest.deletedPaths??[]).map(item=>{if(!item||typeof item!=='object'||Object.keys(item).some(key=>!['path','pathId'].includes(key)))throw new CsoError('INCOMPATIBLE_INPUT','Snapshot manifest contains an invalid deleted path');const path=relativePath(item.path);if(!/^[a-f0-9]{32}$/.test(item.pathId)||item.pathId!==snapshotPathId(manifest.root,path))throw new CsoError('INCOMPATIBLE_INPUT','Snapshot manifest contains an invalid deleted path');return{path,pathId:item.pathId};});
  const presentPaths=new Set(entries.map(e=>e.path)),presentIds=new Set(entries.map(e=>e.pathId)),deletedPaths=new Set(deleted.map(item=>item.path)),deletedIds=new Set(deleted.map(item=>item.pathId));
  if(presentPaths.size!==entries.length||presentIds.size!==entries.length||deletedPaths.size!==deleted.length||deletedIds.size!==deleted.length||deleted.some(item=>presentPaths.has(item.path)||presentIds.has(item.pathId))||canonical(deleted.map(item=>item.path))!==canonical([...deletedPaths].sort())||!/^([a-f0-9]{64})$/.test(manifest.originalHash)||snapshotOriginalIdentity(entries,deleted)!==manifest.originalHash)throw new CsoError('INCOMPATIBLE_INPUT','Snapshot original identity is inconsistent');
  if(manifest.changedPaths!==undefined){if(!Array.isArray(manifest.changedPaths))throw new CsoError('INCOMPATIBLE_INPUT','Snapshot changed paths are invalid');const changed=manifest.changedPaths.map(relativePath);if(new Set(changed).size!==changed.length||canonical(changed)!==canonical([...changed].sort()))throw new CsoError('INCOMPATIBLE_INPUT','Snapshot changed paths are invalid');}
  // Capture already records entries in Git's deterministic code-unit path
  // order. Preserve that manifest order here: localeCompare can reorder an
  // uppercase path such as README.md after lowercase source files, producing
  // a different execution identity from the one written at capture time.
  const expected=entries.filter(e=>e.executionHash);
  if(!/^([a-f0-9]{64})$/.test(manifest.executionHash)||sha256(canonical(expected.map(e=>[e.path,e.executionHash,e.mode])))!==manifest.executionHash)throw new CsoError('INCOMPATIBLE_INPUT','Snapshot execution identity is inconsistent');
  const before=listed();if(canonical(before)!==canonical(expected.map(e=>e.path)))throw new CsoError('INCOMPATIBLE_INPUT','Retained snapshot membership changed');
  for (const e of expected) {
    const current=readStable(root,e.path);
    if (sha256(current.data) !== e.executionHash || current.mode!==e.mode) throw new CsoError('INCOMPATIBLE_INPUT',`Retained snapshot changed: ${e.path}`);
  }
  if(canonical(before)!==canonical(listed()))throw new CsoError('SNAPSHOT_RACE','Retained snapshot membership changed during validation');
}
