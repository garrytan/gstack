/** Opt-in pending Edit metadata for launcher-owned Autoplan plan artifacts. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownedAutoplanArtifact } from './autoplan-artifact-permission';
import { createAutoplanEditDigest, validAutoplanEditDigest, type AutoplanEditDigest } from './autoplan-artifact-digest';
import type { NativePublicToolEvent } from './plan-count-transcript';

const MAX_BYTES = 64 * 1024, MAX_INPUT = 4 * 1024 * 1024, MAX_IDS = 128;
const reasons = ['invalid_event','record_error','lock_conflict','concurrent_pending','conflicting_replay',
  'record_overflow','input_overflow','stdin_timeout','hook_error'] as const;
type Reason = typeof reasons[number];
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const quote = (v: string) => `'${(process.platform === 'win32' ? v.replaceAll('\\','/') : v).replaceAll("'", "'\\''")}'`;
export interface PendingAutoplanArtifact {
  source:'pre_tool_use'; sessionId:string; toolUseId:string; tool:'Edit'; file:string; timestamp:string; editDigest?:AutoplanEditDigest;
  /** Validated recorder tombstones; exposed only by the published-current opt-in. */
  hookSeenIds?:string[];
}
interface Pending extends PendingAutoplanArtifact { transcriptPath:string }
interface State { version:1; cwd:string; config:string; stateRoot:string; sessionId?:string; seenIds:string[]; pending:Pending|null }

function scopedTranscript(file: unknown, config: string, session: string): file is string {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const rel = path.relative(path.join(config, 'projects'), file).split(path.sep);
  if (rel.length !== 2 || !rel[0] || rel[0] === '..' || rel[0] === '.' || rel[1] !== `${session}.jsonl`) return false;
  try { return fs.lstatSync(file).isFile() && !fs.lstatSync(path.join(config,'projects')).isSymbolicLink() &&
    !fs.lstatSync(path.dirname(file)).isSymbolicLink() &&
    fs.realpathSync(file) === path.join(fs.realpathSync(config),'projects',...rel); } catch { return false; }
}
function readState(file:string, cwd:string, config:string, stateRoot:string): State {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('record');
  const s = JSON.parse(fs.readFileSync(file,'utf8'));
  if (!object(s) || !keys(s,['version','cwd','config','stateRoot','sessionId','seenIds','pending']) || s.version !== 1 ||
      s.cwd !== cwd || s.config !== config || s.stateRoot !== stateRoot || (s.sessionId !== undefined && !id(s.sessionId)) ||
      !Array.isArray(s.seenIds) || s.seenIds.length > MAX_IDS || !s.seenIds.every(id) || new Set(s.seenIds).size !== s.seenIds.length ||
      (s.sessionId === undefined && (s.seenIds.length || s.pending !== null))) throw Error('record');
  const p = s.pending;
  if (p !== null && (!object(p) || !keys(p,['source','sessionId','toolUseId','tool','file','timestamp','transcriptPath','editDigest']) ||
      p.source !== 'pre_tool_use' || p.tool !== 'Edit' || p.sessionId !== s.sessionId || !id(p.toolUseId) || !s.seenIds.includes(p.toolUseId) ||
      (p.editDigest!==undefined && !validAutoplanEditDigest(p.editDigest)) ||
      !scopedTranscript(p.transcriptPath,config,p.sessionId) || !Number.isFinite(Date.parse(p.timestamp)) ||
      !ownedAutoplanArtifact(p.file,{cwd,ownedStateRoot:stateRoot}))) throw Error('record');
  return s as State;
}
function poison(file:string, reason:Reason) {
  try { fs.writeFileSync(file+'.invalid',JSON.stringify({reason})+'\n',{mode:0o600,flag:'wx'}); } catch { /* already invalid or closed */ }
}
export function createAutoplanArtifactRecorder(cwd:string, config:string, stateRoot:string) {
  if (![cwd,config,stateRoot].every(path.isAbsolute) || !fs.lstatSync(stateRoot).isDirectory()) throw Error('owned runtime required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'gstack-autoplan-artifact-')), file = path.join(dir,'state.json');
  fs.writeFileSync(file,JSON.stringify({version:1,cwd,config,stateRoot,seenIds:[],pending:null})+'\n',{mode:0o600});
  const command = [process.execPath,import.meta.path,'--record',file,cwd,config,stateRoot].map(quote).join(' ');
  // Foreign/current file mutations invalidate concurrent owned identity. Only
  // allowlisted Edit requests can become pending; Write supplies no authority.
  const hook = {matcher:'^(Write|Edit)$',hooks:[{type:'command',command,timeout:5}]};
  return {file,hooks:{PreToolUse:[hook],PostToolUse:[hook],PostToolUseFailure:[hook]},
    dispose:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

/** Persists metadata and bounded request digests, never edit text or tool results. */
export function recordAutoplanArtifact(input:string, file:string, cwd:string, config:string, stateRoot:string) {
  let lock:number|undefined, reason:Reason='invalid_event';
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    if (Buffer.byteLength(input)>MAX_INPUT) { reason='input_overflow'; throw Error('input'); }
    const e = JSON.parse(input);
    if (object(e) && (e.agent_id !== undefined || (typeof e.cwd === 'string' && e.cwd !== cwd))) return;
    if (fs.existsSync(file+'.invalid')) return;
    reason='lock_conflict'; lock=fs.openSync(file+'.lock','wx',0o600);
    reason='record_error'; const old=readState(file,cwd,config,stateRoot);
    reason='invalid_event';
    if (!object(e) || e.cwd!==cwd || !['PreToolUse','PostToolUse','PostToolUseFailure'].includes(e.hook_event_name) ||
        !['Write','Edit'].includes(e.tool_name) || !id(e.session_id) || !id(e.tool_use_id) ||
        !scopedTranscript(e.transcript_path,config,e.session_id) || !object(e.tool_input) ||
        typeof e.tool_input.file_path!=='string') throw Error('event');
    if (old.sessionId!==undefined && old.sessionId!==e.session_id) return;
    const previous=old.pending;
    // An unseen completion reveals an unobserved concurrent mutation. It cannot
    // leave an older request current; a known old completion is harmless.
    if (previous && previous.toolUseId!==e.tool_use_id && !old.seenIds.includes(e.tool_use_id)) {
      reason='concurrent_pending'; throw Error('unobserved concurrent mutation');
    }
    if (previous?.toolUseId===e.tool_use_id && (e.tool_name!=='Edit' || previous.file!==e.tool_input.file_path || previous.transcriptPath!==e.transcript_path)) {
      reason='conflicting_replay'; throw Error('identity changed');
    }
    const eligible=e.tool_name==='Edit' && ownedAutoplanArtifact(e.tool_input.file_path,{cwd,ownedStateRoot:stateRoot});
    if (!eligible) {
      if (previous && e.hook_event_name==='PreToolUse') { reason='concurrent_pending'; throw Error('foreign pending'); }
      return;
    }
    const state:State={...old,sessionId:e.session_id};
    if (e.hook_event_name==='PreToolUse') {
      if (old.seenIds.includes(e.tool_use_id)) {
        if (previous?.toolUseId===e.tool_use_id && previous.editDigest) {
          reason='conflicting_replay';
          const digest=typeof e.tool_input.old_string==='string' && typeof e.tool_input.new_string==='string' &&
            (e.tool_input.replace_all===undefined || e.tool_input.replace_all===false)
            ? createAutoplanEditDigest(e.tool_input.file_path,e.tool_input.old_string,e.tool_input.new_string) : undefined;
          if (!digest || JSON.stringify(digest)!==JSON.stringify(previous.editDigest)) throw Error('request changed');
        }
        return;
      }
      if (previous) { reason='concurrent_pending'; throw Error('concurrent'); }
      // Match the published-path edit scope; inspect but never retain content.
      if (typeof e.tool_input.old_string!=='string' || !e.tool_input.old_string || typeof e.tool_input.new_string!=='string' ||
          e.tool_input.new_string===e.tool_input.old_string ||
          (e.tool_input.replace_all!==undefined && e.tool_input.replace_all!==false)) throw Error('edit scope');
      state.pending={source:'pre_tool_use',sessionId:e.session_id,toolUseId:e.tool_use_id,tool:'Edit',file:e.tool_input.file_path,
        timestamp:new Date().toISOString(),transcriptPath:e.transcript_path};
      const digest=createAutoplanEditDigest(e.tool_input.file_path,e.tool_input.old_string,e.tool_input.new_string);
      if (digest) state.pending.editDigest=digest;
    } else if (previous?.toolUseId===e.tool_use_id) state.pending=null;
    // Success/failure hooks clear pending and tombstone the ID, but never
    // supply successful history or phase coverage. Those still require JSONL.
    if (!state.seenIds.includes(e.tool_use_id)) state.seenIds=[...state.seenIds,e.tool_use_id];
    const serialized=JSON.stringify(state)+'\n'; reason='record_overflow';
    if (state.seenIds.length>MAX_IDS || Buffer.byteLength(serialized)>MAX_BYTES) throw Error('record overflow');
    reason='record_error'; fs.writeFileSync(temporary,serialized,{mode:0o600,flag:'wx'}); fs.renameSync(temporary,file);
  } catch { poison(file,reason); }
  finally {
    try { fs.rmSync(temporary,{force:true}); } catch {}
    if (lock!==undefined) { try { fs.closeSync(lock); fs.unlinkSync(file+'.lock'); } catch { poison(file,'record_error'); } }
  }
}

export function autoplanArtifactRecorderStatus(file:string|undefined,cwd:string,config:string|null,stateRoot:string|undefined):
  {status:'disabled'|'missing'|'busy'|'idle'|'pending'|'invalid';reason?:string} {
  if (!file || !config || !stateRoot) return {status:'disabled'};
  try {
    if (fs.existsSync(file+'.invalid')) {
      const stat=fs.lstatSync(file+'.invalid');
      if (!stat.isFile() || stat.size>1024) return {status:'invalid',reason:'record_error'};
      const r=JSON.parse(fs.readFileSync(file+'.invalid','utf8'))?.reason;
      return {status:'invalid',reason:reasons.includes(r) ? r : 'unknown'};
    }
    if (fs.existsSync(file+'.lock')) return {status:'busy'};
    if (!fs.existsSync(file)) return {status:'missing'};
    return {status:readState(file,cwd,config,stateRoot).pending ? 'pending' : 'idle'};
  } catch { return {status:'invalid',reason:'record_error'}; }
}
export function readPendingAutoplanArtifact(file:string|undefined,cwd:string,config:string|null,stateRoot:string|undefined,
  startedAt:number, publicTools:readonly NativePublicToolEvent[], now=Date.now(), allowPublished=false): PendingAutoplanArtifact|undefined {
  if (!file || !config || !stateRoot || !Number.isFinite(startedAt) || !Number.isFinite(now) ||
      autoplanArtifactRecorderStatus(file,cwd,config,stateRoot).status!=='pending') return undefined;
  try {
    const state=readState(file,cwd,config,stateRoot), p=state.pending!;
    const time=Date.parse(p.timestamp), sessions=new Set(publicTools.map(e=>e.sessionId));
    if (sessions.size!==1 || !sessions.has(p.sessionId) || time<startedAt || time>now ||
        (!allowPublished && publicTools.some(e=>e.toolUseId===p.toolUseId))) return undefined;
    const {transcriptPath:_,...pending}=p;
    return allowPublished ? {...pending,hookSeenIds:[...state.seenIds]} : pending;
  } catch { return undefined; }
}
if (import.meta.main && process.argv[2]==='--record') {
  const [file,cwd,config,stateRoot]=process.argv.slice(3);
  if (file && cwd && config && stateRoot) {
    const timer=setTimeout(()=>{poison(file,'stdin_timeout');process.exit(0);},4000);
    try {
      const chunks:Uint8Array[]=[]; let size=0;
      for await (const chunk of Bun.stdin.stream()) {
        size+=chunk.byteLength;
        if (size>MAX_INPUT) { poison(file,'input_overflow');process.exit(0); }
        chunks.push(chunk);
      }
      recordAutoplanArtifact(Buffer.concat(chunks).toString('utf8'),file,cwd,config,stateRoot);
    } catch { poison(file,'hook_error'); }
    finally { clearTimeout(timer); }
  }
}
