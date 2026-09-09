/** Content-free native file-permission identity for disposable count fixtures. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanCountTranscript } from './plan-count-transcript';

const MAX_RECORD_BYTES = 64 * 1024;
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
      completedIds: same && Array.isArray(old.completedIds) ? old.completedIds : [],
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
      if (e.hook_event_name === 'PostToolUse') {
        state.completedId = id;
        // Polling may miss automatically permitted edits between two menus.
        // Keep each exact success, bounded by the same 128-request limit.
        if (!state.completedIds.includes(id)) state.completedIds.push(id);
      }
    }
    fs.writeFileSync(file+'.tmp',JSON.stringify(state)+'\n',{mode:0o600});
    fs.renameSync(file+'.tmp',file);
  } catch { try { fs.rmSync(file,{force:true}); } catch {} }
}

/** A long diff can crop its path header; the native access choice repeats the directory. */
function croppedEditTarget(screen: string): string | undefined {
  const text = screen.replace(/\r+\n?/g, '\n');
  // Require actual diff rows above the native footer, never a quoted AUQ.
  if (!/^\s*\d+\s+[ +\-]?/.test(text) || /[☐□]|^\s*(?:>|`{3}|~{3})/m.test(text)) return undefined;
  const prompt = [...text.matchAll(/^ {0,3}Do you want to make this edit to ([^\n?\/\\]+)\?[ \t]*\n([\s\S]*)$/gm)].at(-1);
  if (!prompt || (text.slice(0, prompt.index).match(/^\s*\d+\s+/gm)?.length ?? 0) < 2) return undefined;
  // The unselected option supplies path identity only. Input remains one-time Yes.
  const choices = /^ {0,3}❯[ \t]*1\.[ \t]*Yes[ \t]*\n\s*2\.[ \t]*Yes,\s+and\s+switch\s+to\s+accept\s+edits\s+\(auto-approve\s+file\s+edits\s+and\s+common\s+file\s+commands\)\s+for\s+this\s+session;\s+Yes,\s+and\s+always\s+allow\s+access\s+to\s+([^\r\n]+?)\s+for\s+this\s+session(?:\s*\(shift\+tab\))?\s*\n\s*3\.[ \t]*No[ \t]*\n\s*Esc to cancel [·•] Tab to amend\s*$/.exec(prompt[2]!);
  const directory = choices?.[1]?.trim();
  if (!directory || !path.isAbsolute(directory)) return undefined;
  return path.join(directory, prompt[1]!.trim());
}

/** Undefined leaves other permissions alone; null keeps this report pane waiting. */
export function currentFilePermissionEpoch(file: string | undefined, expected: string | undefined,
  cwd: string, config: string | null, startedAt: number, transcript: PlanCountTranscript,
  screen: string): FilePermissionEpoch | null | undefined {
  if (!file || !expected || !config) return undefined;
  const panel = [...screen.matchAll(/(?:^|\n) {0,3}(?:Edit|Write) file[ \t]*\n {0,3}([^\n]+)\n/g)].at(-1);
  const target = panel ? path.resolve(cwd,panel[1]!.trim()) : croppedEditTarget(screen);
  if (target !== expected) {
    // A foreign path with this report's basename cannot fall back to a stale
    // owned grant. An incomplete owned menu also waits for full path identity.
    const prompt = [...screen.matchAll(/^ {0,3}Do you want to make this edit to ([^\n?\/\\]+)\?[ \t]*$/gm)].at(-1);
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
