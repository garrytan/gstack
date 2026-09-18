/** Native permission identity and private current Write input for disposable count fixtures. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readPlanCountTranscript, type PlanCountTranscript, type NativePublicToolEvent } from './plan-count-transcript';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_WRITE_INPUT_BYTES = 4 * 1024 * 1024;
export interface FilePermissionEpoch { pendingId: string; completedId: string | null; completedIds?: string[] }
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const quote = (v: string) => `'${(process.platform === 'win32' ? v.replaceAll('\\', '/') : v).replaceAll("'", "'\\''")}'`;
const scoped = (file: unknown, config: string, session: string) => {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const rel = path.relative(path.join(config, 'projects'), file).split(path.sep);
  return rel.length === 2 && rel[0] !== '..' && rel[0] !== '.' && rel[1] === `${session}.jsonl`;
};
export function createFilePermissionRecorder(cwd: string, config: string, expected: string) {
  const relative = path.relative(os.tmpdir(), expected);
  if (!path.isAbsolute(expected) || !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-file-permission-'));
  const file = path.join(dir, 'state.json');
  const command = [process.execPath, import.meta.path, '--record', file, cwd, config, expected].map(quote).join(' ');
  const hook = { matcher: '^(Write|Edit)$', hooks: [{ type: 'command', command, timeout: 5 }] };
  return { file, hooks: { PreToolUse: [hook], PostToolUse: [hook], PostToolUseFailure: [hook] },
    dispose: () => fs.rmSync(dir, {recursive:true,force:true}) };
}

export interface PendingWriteInput {
  source: 'PreToolUse'; toolName: 'Write'; cwd: string; expected: string;
  sessionId: string; transcriptPath: string; pendingId: string; timestamp: string;
  input: { file_path: string; content: string; [key: string]: unknown }; sha256: string;
}

function boundedRegular(file: string, limit: number): Buffer {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.size>limit) throw Error('invalid permission input file');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile()||before.size>limit||before.dev!==stat.dev||before.ino!==stat.ino)
      throw Error('invalid opened permission input');
    const bytes=Buffer.alloc(before.size),length=fs.readSync(fd,bytes,0,bytes.length,0);
    const after=fs.fstatSync(fd),current=fs.lstatSync(file);
    if(length!==before.size||!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||
      after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
      throw Error('permission input changed during read');
    return bytes;
  }finally{fs.closeSync(fd);}
}

/** Authenticated public Write arguments, also used by the existing diagnostic snapshot. */
export function readPendingWriteInput(file: string, expected: string, cwd: string,
  config: string | null, startedAt: number): PendingWriteInput | undefined {
  if(!config) return undefined;
  try {
    const r=JSON.parse(boundedRegular(file,MAX_RECORD_BYTES).toString('utf8'));
    const time=Date.parse(r.timestamp);
    const validId=(id:unknown)=>typeof id==='string'&&id.startsWith(r.sessionId+':')&&identifier(id.slice(r.sessionId.length+1));
    if(r.writeInputConflict===true||r.cwd!==cwd||r.expected!==expected||!identifier(r.sessionId)||!scoped(r.transcriptPath,config,r.sessionId)||
      typeof r.pendingId!=='string'||!r.pendingId.startsWith(r.sessionId+':')||!identifier(r.pendingId.slice(r.sessionId.length+1))||
      !Number.isFinite(time)||time<startedAt||time>Date.now()||r.completedId===r.pendingId||
      !Array.isArray(r.seenIds)||r.seenIds.length>128||!r.seenIds.every(validId)||new Set(r.seenIds).size!==r.seenIds.length||
      r.seenIds.filter((id:unknown)=>id===r.pendingId).length!==1||
      !Array.isArray(r.completedIds)||r.completedIds.length>128||!r.completedIds.every(validId)||
      new Set(r.completedIds).size!==r.completedIds.length||r.completedIds.some((id:string)=>id===r.pendingId||!r.seenIds.includes(id))||
      (r.completedId===null?r.completedIds.length!==0:!validId(r.completedId)||r.completedIds.at(-1)!==r.completedId)||
      typeof r.writeInputSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.writeInputSha256)) return undefined;
    const bytes=boundedRegular(file+'.write.json',MAX_WRITE_INPUT_BYTES);
    if(createHash('sha256').update(bytes).digest('hex')!==r.writeInputSha256) return undefined;
    const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes)) return undefined;
    const w=JSON.parse(text);
    if(w.source!=='PreToolUse'||w.toolName!=='Write'||
      ['cwd','expected','sessionId','transcriptPath','pendingId','timestamp'].some(key=>w[key]!==r[key])||
      !w.input||typeof w.input!=='object'||Array.isArray(w.input)||w.input.file_path!==expected||typeof w.input.content!=='string') return undefined;
    return {...w,sha256:r.writeInputSha256};
  }catch{return undefined;}
}

/** No stdout, permission decision, input rewrite or model context. Metadata stays
 * content-free; only an owned Write gets a bounded private input sibling. */
export function recordFilePermission(input: string, file: string, cwd: string, config: string, expected: string) {
  try {
    if (Buffer.byteLength(input) > MAX_WRITE_INPUT_BYTES) throw Error('oversized hook');
    const e = JSON.parse(input);
    if (e?.agent_id !== undefined || e?.cwd !== cwd) return;
    if (!['PreToolUse','PostToolUse','PostToolUseFailure'].includes(e.hook_event_name) ||
        !['Write','Edit'].includes(e.tool_name) || !identifier(e.session_id) || !identifier(e.tool_use_id) ||
        !scoped(e.transcript_path,config,e.session_id) || e.tool_input?.file_path !== expected) return;
    let old: any = {};
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw Error('invalid record');
      old = JSON.parse(fs.readFileSync(file,'utf8'));
    }
    const id = `${e.session_id}:${e.tool_use_id}`;
    const timestamp = new Date().toISOString();
    const same = old.cwd === cwd && old.expected === expected && old.sessionId === e.session_id;
    const state = { cwd, expected, sessionId: e.session_id, transcriptPath: e.transcript_path,
      seenIds: same && Array.isArray(old.seenIds) ? old.seenIds : [],
      pendingId: same ? old.pendingId ?? null : null,
      completedId: same ? old.completedId ?? null : null,
      completedIds: same && Array.isArray(old.completedIds) ? old.completedIds : [],
      timestamp,
      ...(same && old.overlappingWriteInput === true ? {overlappingWriteInput:true} : {}),
      ...(same && typeof old.writeInputSha256 === 'string' ? {writeInputSha256:old.writeInputSha256} : {}) };
    let clearWriteInput = false;
    if (e.hook_event_name === 'PreToolUse') {
      // Replayed requests, including failed and older completed IDs, never reopen.
      if (state.seenIds.includes(id)) {
        // Identical hook delivery is harmless. A current ID carrying different
        // actual arguments invalidates its witness without reopening that ID.
        if (old.pendingId === id && old.writeInputSha256 &&
            (e.tool_name !== 'Write' || !isDeepStrictEqual(
              readPendingWriteInput(file, expected, cwd, config, 0)?.input, e.tool_input))) {
          old.writeInputConflict = true;
          fs.writeFileSync(file+'.tmp',JSON.stringify(old)+'\n',{mode:0o600});
          fs.renameSync(file+'.tmp',file);
        }
        return;
      }
      if (state.seenIds.length >= 128) throw Error('too many file requests');
      if(state.pendingId) state.overlappingWriteInput=true;
      state.seenIds.push(id);
      state.pendingId = id;
      delete state.writeInputSha256;
      clearWriteInput = true;
      if(e.tool_name==='Write' && typeof e.tool_input.content==='string') {
        const witness={source:'PreToolUse',toolName:'Write',cwd,expected,sessionId:e.session_id,
          transcriptPath:e.transcript_path,pendingId:id,timestamp,input:e.tool_input};
        const bytes=Buffer.from(JSON.stringify(witness)+'\n');
        if(bytes.length>MAX_WRITE_INPUT_BYTES) throw Error('oversized Write input witness');
        const temporary=file+'.write.json.tmp';
        const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
        try{fs.writeFileSync(fd,bytes);}finally{fs.closeSync(fd);}
        fs.renameSync(temporary,file+'.write.json');
        state.writeInputSha256=createHash('sha256').update(bytes).digest('hex');
        clearWriteInput=false;
      }
    } else {
      // An unrelated/late result cannot overwrite the current request epoch.
      if (state.pendingId !== id) return;
      state.pendingId = null;
      delete state.writeInputSha256;
      clearWriteInput = true;
      if (e.hook_event_name === 'PostToolUse') {
        state.completedId = id;
        // Polling may miss automatically permitted edits between two menus.
        // Keep each exact success, bounded by the same 128-request limit.
        if (!state.completedIds.includes(id)) state.completedIds.push(id);
      }
    }
    fs.writeFileSync(file+'.tmp',JSON.stringify(state)+'\n',{mode:0o600});
    fs.renameSync(file+'.tmp',file);
    if(clearWriteInput) fs.rmSync(file+'.write.json',{force:true});
  } catch { try { fs.rmSync(file,{force:true}); } catch {} }
}

/** Complete native cropped Edit geometry; its basename alone grants no ownership. */
function croppedEditPane(screen: string) {
  const text = screen.replace(/\r+\n?/g, '\n');
  // Cropping may begin inside a wrapped added/deleted diff row (four/five-space gutter).
  // Still require numbered rows below and the full native footer; never a quoted AUQ.
  // The heading can be cropped one row earlier, leaving the complete path.
  // Keep it only when the existing menu independently identifies that target.
  const header = /^ {0,3}([^\n]+)\n[╌─━]{3,}[ \t]*\n/.exec(text);
  const headerPath = header?.[1]?.trim();
  const pathOnly = headerPath && (path.isAbsolute(headerPath) || /^\.\.?[/\\]/.test(headerPath));
  // A crop can start on the single native rule immediately above the diff.
  let diff = pathOnly ? text.slice(header![0].length) : text.replace(/^[╌─━]{3,}[ \t]*\n/, '');
  // A crop may start partway through several soft-wrapped pieces of one
  // unchanged source line. Anchor them to the next old-file line number:
  // an added row alone has only a new-file coordinate and cannot do this.
  const nextRow = /^( {0,3}([1-9]\d*) [ -])/m.exec(diff);
  let continuation: { tail: string; nextLine: number } | undefined;
  if (nextRow && nextRow.index > 0 && !/^(?: {0,3}[1-9]\d* [ +\-]| {4,5}[+\-])/.test(diff)) {
    const rows = diff.slice(0, nextRow.index).split('\n').slice(0, -1);
    // Preserve the older single six-space crop. New multirow crops derive
    // their gutter from numeric padding, line-number width and diff marker.
    const gutter = rows.length === 1 && /^ {6}[^+\-\s]/.test(rows[0]!)
      ? 6 : nextRow[1]!.length;
    const tails = rows.map(row => row.startsWith(' '.repeat(gutter)) ? row.slice(gutter) : '');
    if (tails.some(tail => !tail.trim() || /^\s*[+\-]/.test(tail))) return undefined;
    // Intermediate row endings are source bytes: a hard wrap can split between
    // words or inside a whitespace run. Trim only the complete source suffix.
    continuation = { tail: tails.join('').trimEnd(), nextLine: Number(nextRow[2]) };
    diff = diff.slice(nextRow.index);
  }
  if (!/^(?:\s*\d+\s+[ +\-]?| {4,5}[+\-])/.test(diff) || /[☐□]|^\s*(?:>|`{3}|~{3})/m.test(text)) return undefined;
  const prompt = [...text.matchAll(/^ {0,3}Do you want to make this edit to ([^\n?\/\\]+)\?[ \t]*\n([\s\S]*)$/gm)].at(-1);
  if (!prompt || (text.slice(0, prompt.index).match(/^\s*\d+\s+/gm)?.length ?? 0) < 2) return undefined;
  // The unselected option supplies path identity only. Input remains one-time Yes.
  // A redraw can leave this exact keyboard-hint tail on the unselected No row.
  // It does not change the selected one-time Yes or authorize another action.
  const choices = /^ {0,3}❯[ \t]*1\.[ \t]*Yes[ \t]*\n\s*2\.[ \t]*Yes,\s+and\s+switch\s+to\s+accept\s+edits\s+\(auto-approve\s+file\s+edits\s+and\s+common\s+file\s+commands\)\s+for\s+this\s+session(?:;\s+Yes,\s+and\s+always\s+allow\s+access\s+to\s+([^\r\n]+?)\s+for\s+this\s+session)?(?:\s*\(shift\+tab\))?\s*\n\s*3\.[ \t]*No(?:hift\+tab\))?[ \t]*\n\s*Esc to cancel [·•] Tab to amend\s*$/.exec(prompt[2]!);
  const directory = choices?.[1]?.trim();
  if (!choices || (directory !== undefined && !path.isAbsolute(directory))) return undefined;
  return { basename: prompt[1]!.trim(), directory, headerPath: pathOnly ? headerPath : undefined,
    continuation, preview: diff.slice(0, diff.indexOf(prompt[0]!)) };
}

/** Syntax-only opt-in for scoped count/floor callers; never generic grant authority. */
export function isCroppedEditPermissionVisible(screen: string): boolean {
  const pane = croppedEditPane(screen);
  return Boolean(pane && pane.directory === undefined);
}

function croppedEditTarget(screen: string, cwd: string, expected: string): string | undefined {
  const pane = croppedEditPane(screen);
  if (!pane || (pane.directory === undefined && path.dirname(expected) !== cwd)) return undefined;
  const { continuation, headerPath } = pane;
  const target = path.join(pane.directory ?? cwd, pane.basename);
  if (continuation) {
    if (target !== expected) return undefined;
    const nextLine = continuation.nextLine;
    if (!Number.isSafeInteger(nextLine) || nextLine < 2) return undefined;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) return undefined;
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
        // Only the complete source line behind this viewport continuation is
        // needed. Large reports remain eligible without reading past the same
        // 64-KiB cap or treating a truncated line as a complete line ending.
        const bytes = Buffer.alloc(MAX_RECORD_BYTES);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(fd);
        if (length !== Math.min(opened.size, MAX_RECORD_BYTES) || after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return undefined;
        const complete = opened.size <= length ? length : bytes.lastIndexOf(10, length - 1) + 1;
        const prior = bytes.subarray(0, complete).toString('utf8').split(/\r?\n/)[nextLine - 2];
        if (!prior?.trimEnd().endsWith(continuation.tail)) return undefined;
      } finally { fs.closeSync(fd); }
    } catch { return undefined; }
  }
  return !headerPath || path.resolve(cwd, headerPath) === target ? target : undefined;
}

/** Bind either native Create footer to the owned Write when its heading is cropped. */
function croppedCreatePane(screen: string, expected: string): { basename: string; preview: string } | undefined {
  const text=screen.replace(/\r+\n?/g,'\n');
  const pane=/^([\s\S]+)\n[╌─━]{3,}[ \t]*\n {0,3}Do you want to create ([^\n?\/\\]+)\?[ \t]*\n {0,3}❯[ \t]*1\.[ \t]*Yes[ \t]*\n\s*2\.[ \t]*Yes,\s+and\s+switch\s+to\s+accept\s+edits\s+\(auto-approve\s+file\s+edits\s+and\s+common\s+file\s+commands\)\s+for\s+this\s+session(?:;\s+Yes,\s+and\s+always\s+allow\s+access\s+to\s+([^\r\n]+?)\s+for\s+this\s+session)?(?:\s*\(shift\+tab\))?\s*\n\s*3\.[ \t]*No[ \t]*\n\s*Esc to cancel [·•] Tab to amend\s*$/.exec(text);
  if (!pane || /[☐□]|^\s*(?:>|`{3}|~{3})/m.test(pane[1]!)) return undefined;
  // Native option 2 can combine accept-edits with directory access. It remains
  // unselected: its directory must agree, and the pending Write still owns every
  // preview row. Never infer ownership from this optional directory alone.
  const directory=pane[3]?.trim();
  if (directory!==undefined && (!path.isAbsolute(directory)||directory!==path.dirname(expected))) return undefined;
  return {basename:pane[2]!.trim(),preview:pane[1]!};
}

/** Bind every displayed source row to the sole pending native Write, not its basename alone. */
function currentCreatePreview(preview: string, r: any, config: string, cwd: string, startedAt: number, file: string): boolean {
  const pending=new Map<string,NativePublicToolEvent>(), seen=new Map<string,NativePublicToolEvent>();
  const completed=new Set<string>();
  let conflict=false;
  const transcript=readPlanCountTranscript(config,cwd,event=>{
    if (event.sessionId!==r.sessionId) return;
    if(event.kind==='use' && `${event.sessionId}:${event.toolUseId}`===r.pendingId && event.name!=='Write') conflict=true;
    if(event.kind==='use' && (event.name==='Write'||event.name==='Edit')) {
      const prior=seen.get(event.toolUseId);
      if(prior && (prior.name!==event.name||JSON.stringify(prior.input)!==JSON.stringify(event.input))) conflict=true;
      seen.set(event.toolUseId,event);
      if(!completed.has(event.toolUseId)) pending.set(event.toolUseId,event);
    } else if(event.kind==='result') {
      completed.add(event.toolUseId);
      pending.delete(event.toolUseId);
    }
  },r.transcriptPath);
  let event=[...pending.values()][0];
  const witness=r.writeInputSha256 ? readPendingWriteInput(file,r.expected,cwd,config,startedAt) : undefined;
  if(conflict||transcript.status!=='ready'||pending.size>1||
    (r.writeInputSha256 && (!witness||witness.pendingId!==r.pendingId||witness.sha256!==r.writeInputSha256))) return false;
  if(!event) {
    const id=r.pendingId.slice(r.sessionId.length+1);
    // A current PreToolUse witness breaks only the publication delay. A result,
    // an overlapping hook or another native use can never borrow that witness.
    if(!witness||r.overlappingWriteInput||completed.has(id)||seen.has(id)) return false;
    event={sessionId:r.sessionId,toolUseId:id,kind:'use',name:'Write',timestamp:witness.timestamp,input:witness.input};
  } else if(witness && !isDeepStrictEqual(event.input,witness.input)) return false;
  if(event.name!=='Write'||`${event.sessionId}:${event.toolUseId}`!==r.pendingId||event.input?.file_path!==r.expected||
    Date.parse(event.timestamp)<startedAt||typeof event.input.content!=='string'||
    Buffer.byteLength(event.input.content)>MAX_WRITE_INPUT_BYTES) return false;
  const source=event.input.content.split(/\r?\n/), rows=preview.split('\n');
  const numbered:Array<{line:number;text:string}>=[];
  let leading='';
  for(const row of rows) {
    const match=/^ {0,3}([1-9]\d*)(?:[ \t](.*))?$/.exec(row);
    if(match) numbered.push({line:Number(match[1]),text:match[2]??''});
    else if(/^ {5,}\S/.test(row)||/^ {5,}$/.test(row)) {
      if(numbered.length) numbered.at(-1)!.text+=row.trimStart();
      else leading+=row.trimStart();
    } else if(!row.trim() && !numbered.length) continue;
    else return false;
  }
  const compact=(s:string)=>s.replace(/\s/g,'');
  if(numbered.length<2) return false;
  if(leading && !compact(source[numbered[0]!.line-2]??'').endsWith(compact(leading))) return false;
  return numbered.every((row,i)=>Number.isSafeInteger(row.line)&&row.line>0&&row.line<=source.length&&
    (!i||row.line===numbered[i-1]!.line+1)&&compact(row.text)===compact(source[row.line-1]!));
}

/** A cropped in-fixture Edit needs its sole current native request and exact visible diff. */
function currentEditPreview(preview: string, r: any, config: string, cwd: string, startedAt: number): boolean {
  try {
    if (path.dirname(r.expected) !== cwd || fs.realpathSync(cwd) !== cwd || fs.realpathSync(r.expected) !== r.expected ||
        [config, path.dirname(r.transcriptPath), r.transcriptPath].some(p => fs.realpathSync(p) !== p)) return false;
    const pending = new Map<string, NativePublicToolEvent>(), seen = new Map<string, NativePublicToolEvent>();
    const completed = new Set<string>();
    let conflict = false;
    const transcript = readPlanCountTranscript(config, cwd, event => {
      if (event.sessionId !== r.sessionId) return;
      if (event.kind === 'use') {
        if (`${event.sessionId}:${event.toolUseId}` === r.pendingId && event.name !== 'Edit') conflict = true;
        if (!['Write', 'Edit'].includes(event.name ?? '')) return;
        const prior = seen.get(event.toolUseId);
        if (prior && (prior.name !== event.name || !isDeepStrictEqual(prior.input, event.input))) conflict = true;
        seen.set(event.toolUseId, event);
        if (!completed.has(event.toolUseId)) pending.set(event.toolUseId, event);
      } else if (event.kind === 'result') {
        completed.add(event.toolUseId); pending.delete(event.toolUseId);
      }
    }, r.transcriptPath);
    const event = [...pending.values()][0], input = event?.input;
    if (conflict || transcript.status !== 'ready' || pending.size !== 1 || event?.name !== 'Edit' ||
        `${event.sessionId}:${event.toolUseId}` !== r.pendingId || !Number.isFinite(Date.parse(event.timestamp)) ||
        Date.parse(event.timestamp) < startedAt || Date.parse(event.timestamp) > Date.now() ||
        input?.file_path !== r.expected || typeof input.old_string !== 'string' || !input.old_string ||
        typeof input.new_string !== 'string' || (input.replace_all !== undefined && input.replace_all !== false)) return false;
    const bytes = boundedRegular(r.expected, MAX_WRITE_INPUT_BYTES), before = bytes.toString('utf8');
    if (!Buffer.from(before).equals(bytes)) return false;
    const at = before.indexOf(input.old_string);
    if (at < 0 || before.indexOf(input.old_string, at + input.old_string.length) !== -1) return false;
    const after = before.slice(0, at) + input.new_string + before.slice(at + input.old_string.length);
    const oldLines = before.split(/\r?\n/), newLines = after.split(/\r?\n/);
    const firstLine = before.slice(0, at).split(/\r?\n/).length;
    const oldLast = firstLine + input.old_string.split(/\r?\n/).length - 1;
    const newLast = firstLine + input.new_string.split(/\r?\n/).length - 1;
    const rows: Array<{line: number; kind: string; text: string; clipped?: boolean}> = [];
    let leading: {kind: string; text: string} | undefined;
    for (const line of preview.split('\n')) {
      if (!line.trim() || /^[╌─━]{3,}[ \t]*$/.test(line)) continue;
      const numbered = /^ {0,3}([1-9]\d*) ([ +\-])(.*)$/.exec(line);
      if (numbered) {
        if (leading) {
          // A wrapped first row has no coordinate. The next same-kind numbered
          // row anchors its complete visible suffix to the preceding source line.
          if (leading.kind !== numbered[2] || Number(numbered[1]) < 2) return false;
          rows.push({line:Number(numbered[1])-1,...leading,clipped:true}); leading=undefined;
        }
        rows.push({line:Number(numbered[1]),kind:numbered[2]!,text:numbered[3]!}); continue;
      }
      const wrapped = /^ {4,5}([+\-])(.*)$/.exec(line), last = rows.at(-1);
      if (!wrapped) return false;
      if (!last) {
        if (leading && leading.kind !== wrapped[1]) return false;
        leading={kind:wrapped[1]!,text:(leading?.text??'')+wrapped[2]!};
      } else {
        if (wrapped[1] !== last.kind) return false;
        last.text += wrapped[2]!;
      }
    }
    const compact = (value: string) => value.replace(/\s/g, '');
    return !leading && rows.length >= 2 && rows.some(row => row.kind === '+' || row.kind === '-') &&
      rows.every((row, i) => Number.isSafeInteger(row.line) && row.line > 0 &&
        (!i || row.kind === '-' || rows[i-1]!.kind === '-' || row.line === rows[i-1]!.line + 1) &&
        (row.kind === ' ' || (row.line >= firstLine && row.line <= (row.kind === '-' ? oldLast : newLast))) &&
        row.line <= (row.kind === '-' ? oldLines : newLines).length &&
        (row.clipped ? Boolean(compact(row.text)) && compact((row.kind === '-' ? oldLines : newLines)[row.line - 1]!).endsWith(compact(row.text)) :
          compact(row.text) === compact((row.kind === '-' ? oldLines : newLines)[row.line - 1]!)));
  } catch { return false; }
}

/** Undefined leaves other permissions alone; null keeps this report pane waiting. */
export function currentFilePermissionEpoch(file: string | undefined, expected: string | undefined,
  cwd: string, config: string | null, startedAt: number, transcript: PlanCountTranscript,
  screen: string): FilePermissionEpoch | null | undefined {
  if (!file || !expected || !config) return undefined;
  const panel = [...screen.matchAll(/(?:^|\n) {0,3}(?:Create|Edit|Write) file[ \t]*\n {0,3}([^\n]+)\n/g)].at(-1);
  const create = panel ? undefined : croppedCreatePane(screen, expected);
  const edit = panel ? undefined : croppedEditPane(screen);
  const target = panel ? path.resolve(cwd,panel[1]!.trim()) : croppedEditTarget(screen, cwd, expected) ??
    (create?.basename===path.basename(expected) ? expected : undefined);
  if (target !== expected) {
    // A foreign path with this report's basename cannot fall back to a stale
    // owned grant. An incomplete owned menu also waits for full path identity.
    const prompt = [...screen.matchAll(/^ {0,3}Do you want to (?:make this edit to|create) ([^\n?\/\\]+)\?[ \t]*$/gm)].at(-1);
    return (target && path.basename(target) === path.basename(expected)) ||
      prompt?.[1]?.trim() === path.basename(expected) ? null : undefined;
  }
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || transcript.status !== 'ready') return null;
    const r = JSON.parse(fs.readFileSync(file,'utf8'));
    const sessions = new Set([...transcript.calls.map(c=>c.sessionId),...transcript.assistantMessages.map(m=>m.sessionId)]);
    const time = Date.parse(r.timestamp);
    const validId = (id: unknown) => typeof id === 'string' && id.startsWith(r.sessionId+':') && identifier(id.slice(r.sessionId.length+1));
    if (r.cwd !== cwd || r.expected !== expected || !identifier(r.sessionId) || sessions.size !== 1 || !sessions.has(r.sessionId) ||
        !scoped(r.transcriptPath,config,r.sessionId) || !Number.isFinite(time) || time < startedAt || time > Date.now() ||
        !validId(r.pendingId) || (r.completedId !== null && !validId(r.completedId)) || r.pendingId === r.completedId ||
        !Array.isArray(r.seenIds) || r.seenIds.length > 128 || !r.seenIds.every(validId) ||
        new Set(r.seenIds).size !== r.seenIds.length || !r.seenIds.includes(r.pendingId) ||
        !Array.isArray(r.completedIds) || r.completedIds.length > 128 || !r.completedIds.every(validId) ||
        new Set(r.completedIds).size !== r.completedIds.length ||
        r.completedIds.some((id: string) => id === r.pendingId || !r.seenIds.includes(id)) ||
        (r.completedId === null ? r.completedIds.length !== 0 : r.completedIds.at(-1) !== r.completedId)) return null;
    if(create && !currentCreatePreview(create.preview,r,config,cwd,startedAt,file)) return null;
    if(edit && edit.directory === undefined && !currentEditPreview(edit.preview,r,config,cwd,startedAt)) return null;
    return {pendingId:r.pendingId,completedId:r.completedId,completedIds:r.completedIds};
  } catch { return null; }
}

/** Check every owned path before a same-basename block closes the whole menu. */
export function currentFilePermissionBinding<T extends {file: string; expected: string}>(
  bindings: readonly T[], cwd: string, config: string | null, startedAt: number,
  transcript: PlanCountTranscript, screen: string,
): {binding: T; epoch: FilePermissionEpoch} | null | undefined {
  let blocked = false;
  for (const binding of bindings) {
    const epoch = currentFilePermissionEpoch(binding.file, binding.expected, cwd, config, startedAt, transcript, screen);
    if (epoch) return {binding, epoch};
    if (epoch === null) blocked = true;
  }
  return blocked ? null : undefined;
}

if (import.meta.main && process.argv[2] === '--record') {
  try { const [file,cwd,config,expected] = process.argv.slice(3);
    if (file && cwd && config && expected) recordFilePermission(await Bun.stdin.text(),file,cwd,config,expected);
  } catch { /* silent observation never changes native permission decisions */ }
}
