/** Content-free native file-permission identity for disposable count fixtures. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanCountTranscript } from './plan-count-transcript';

const MAX_RECORD_BYTES = 64 * 1024;
export interface FilePermissionEpoch { pendingId: string; completedId: string | null }
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

/** No stdout, permission decision, input rewrite, model context, or file content. */
export function recordFilePermission(input: string, file: string, cwd: string, config: string, expected: string) {
  try {
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw Error('oversized hook');
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
      timestamp };
    if (e.hook_event_name === 'PreToolUse') {
      // Replayed requests, including failed and older completed IDs, never reopen.
      if (state.seenIds.includes(id)) return;
      if (state.seenIds.length >= 128) throw Error('too many file requests');
      state.seenIds.push(id);
      state.pendingId = id;
    } else {
      // An unrelated/late result cannot overwrite the current request epoch.
      if (state.pendingId !== id) return;
      state.pendingId = null;
      if (e.hook_event_name === 'PostToolUse') state.completedId = id;
    }
    fs.writeFileSync(file+'.tmp',JSON.stringify(state)+'\n',{mode:0o600});
    fs.renameSync(file+'.tmp',file);
  } catch { try { fs.rmSync(file,{force:true}); } catch {} }
}

/** Undefined leaves other permissions alone; null keeps this report pane waiting. */
export function currentFilePermissionEpoch(file: string | undefined, expected: string | undefined,
  cwd: string, config: string | null, startedAt: number, transcript: PlanCountTranscript,
  screen: string): FilePermissionEpoch | null | undefined {
  if (!file || !expected || !config) return undefined;
  const panel = [...screen.matchAll(/(?:^|\n) {0,3}(?:Edit|Write) file[ \t]*\n {0,3}([^\n]+)\n/g)].at(-1);
  if (!panel || path.resolve(cwd,panel[1]!.trim()) !== expected) return undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || transcript.status !== 'ready') return null;
    const r = JSON.parse(fs.readFileSync(file,'utf8'));
    const sessions = new Set([...transcript.calls.map(c=>c.sessionId),...transcript.assistantMessages.map(m=>m.sessionId)]);
    const time = Date.parse(r.timestamp);
    const validId = (id: unknown) => typeof id === 'string' && id.startsWith(r.sessionId+':') && identifier(id.slice(r.sessionId.length+1));
    if (r.cwd !== cwd || r.expected !== expected || !identifier(r.sessionId) || sessions.size !== 1 || !sessions.has(r.sessionId) ||
        !scoped(r.transcriptPath,config,r.sessionId) || !Number.isFinite(time) || time < startedAt || time > Date.now() ||
        !validId(r.pendingId) || (r.completedId !== null && !validId(r.completedId)) || r.pendingId === r.completedId) return null;
    return {pendingId:r.pendingId,completedId:r.completedId};
  } catch { return null; }
}

if (import.meta.main && process.argv[2] === '--record') {
  try { const [file,cwd,config,expected] = process.argv.slice(3);
    if (file && cwd && config && expected) recordFilePermission(await Bun.stdin.text(),file,cwd,config,expected);
  } catch { /* silent observation never changes native permission decisions */ }
}
