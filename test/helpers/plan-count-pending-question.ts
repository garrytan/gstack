/** Pending native AUQ identity only; answers and coverage always come from JSONL. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NativePlanQuestion, NativePlanQuestionCall, PlanCountTranscript } from './plan-count-transcript';

const MAX_BYTES = 128 * 1024;
const MAX_IDS = 128;
const REASONS = ['invalid_event', 'input_overflow', 'stdin_timeout', 'record_error', 'concurrent_pending',
  'conflicting_replay', 'record_overflow', 'lock_conflict', 'hook_error', 'unknown'] as const;
type RecorderReason = typeof REASONS[number];
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const quote = (v: string) => `'${(process.platform === 'win32' ? v.replaceAll('\\', '/') : v).replaceAll("'", "'\\''")}'`;
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));

function questions(value: unknown): value is NativePlanQuestion[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(q =>
    object(q) && keysOnly(q, ['header', 'question', 'options', 'multiSelect']) &&
    typeof q.header === 'string' && q.header.trim() && typeof q.question === 'string' && q.question.trim() &&
    (q.multiSelect === undefined || typeof q.multiSelect === 'boolean') &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every((o: unknown) => object(o) && keysOnly(o, ['label', 'description']) &&
      typeof o.label === 'string' && o.label.trim() && (o.description === undefined || typeof o.description === 'string')) &&
    new Set(q.options.map((o: {label:string}) => o.label)).size === q.options.length) &&
    new Set(value.map(q => q.header)).size === value.length && new Set(value.map(q => q.question)).size === value.length;
}

/** One real parent JSONL, inside the owned config; never a subagent or symlink. */
function scopedTranscript(file: unknown, configDir: string, session: string): file is string {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const projects = path.join(configDir, 'projects');
  const rel = path.relative(projects, file).split(path.sep);
  if (rel.length !== 2 || !rel[0] || rel[0] === '..' || rel[0] === '.' || rel[1] !== `${session}.jsonl`) return false;
  try {
    return fs.lstatSync(file).isFile() && !fs.lstatSync(projects).isSymbolicLink() &&
      !fs.lstatSync(path.dirname(file)).isSymbolicLink() &&
      fs.realpathSync(file) === path.join(fs.realpathSync(configDir), 'projects', ...rel);
  } catch { return false; }
}

interface Pending {
  sessionId: string; toolUseId: string; transcriptPath: string; timestamp: string; questions: NativePlanQuestion[];
}
interface State {
  version: 1; cwd: string; configDir: string; sessionId?: string; seenIds: string[]; pending: Pending | null;
}

function readState(file: string, cwd: string, configDir: string): State {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('invalid recorder file');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(s) || s.version !== 1 || s.cwd !== cwd || s.configDir !== configDir ||
      (s.sessionId !== undefined && !identifier(s.sessionId)) || !Array.isArray(s.seenIds) ||
      s.seenIds.length > MAX_IDS || !s.seenIds.every(identifier) || new Set(s.seenIds).size !== s.seenIds.length ||
      (s.pending !== null && (!object(s.pending) || !identifier(s.pending.sessionId) ||
        s.pending.sessionId !== s.sessionId || !identifier(s.pending.toolUseId) ||
        !s.seenIds.includes(s.pending.toolUseId) || !questions(s.pending.questions) ||
        typeof s.pending.timestamp !== 'string' || !scopedTranscript(s.pending.transcriptPath, configDir, s.pending.sessionId)))) {
    throw Error('invalid recorder state');
  }
  return s as State;
}

export function createPendingQuestionRecorder(cwd: string, configDir: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pending-question-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({version:1, cwd, configDir, seenIds:[], pending:null}) + '\n', {mode:0o600});
  const command = [process.execPath, import.meta.path, '--record', file, cwd, configDir].map(quote).join(' ');
  const hook = {matcher:'^AskUserQuestion$', hooks:[{type:'command', command, timeout:5}]};
  return {file, hooks:{PreToolUse:[hook], PostToolUse:[hook], PostToolUseFailure:[hook]},
    dispose: () => fs.rmSync(dir, {recursive:true, force:true})};
}

/** Malformed/ambiguous owned input stays closed; later replay cannot revive it. */
function poison(file: string, reason: RecorderReason) {
  try { fs.writeFileSync(file + '.invalid', JSON.stringify({reason})+'\n', {mode:0o600, flag:'wx'}); } catch { /* already invalid or disposed */ }
}

/** Content-free diagnostic survives in caller snapshots even after close removes the recorder. */
export function pendingQuestionRecorderStatus(file: string | undefined, cwd: string, configDir: string | null):
  {status:'disabled'|'missing'|'busy'|'idle'|'pending'|'invalid'; reason?:RecorderReason} {
  if (!file || !configDir) return {status:'disabled'};
  try {
    if (fs.existsSync(file+'.invalid')) {
      const stat = fs.lstatSync(file+'.invalid');
      const reason = stat.isFile() && stat.size <= 1024 ? JSON.parse(fs.readFileSync(file+'.invalid','utf8')).reason : 'unknown';
      return {status:'invalid', reason:REASONS.includes(reason) ? reason : 'unknown'};
    }
    if (fs.existsSync(file+'.lock')) return {status:'busy'};
    if (!fs.existsSync(file)) return {status:'missing'};
    return {status:readState(file,cwd,configDir).pending ? 'pending' : 'idle'};
  } catch { return {status:'invalid',reason:'record_error'}; }
}

/** Silent observation: no approval, answers, input rewrite, or model context. */
export function recordPendingQuestion(input: string, file: string, cwd: string, configDir: string): void {
  let lock: number | undefined;
  let reason: RecorderReason = 'input_overflow';
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    if (Buffer.byteLength(input) > MAX_BYTES) throw Error('oversized hook input');
    reason = 'invalid_event';
    const e = JSON.parse(input);
    // Foreign and sidechain events cannot cancel or supply the parent request.
    if (object(e) && (e.agent_id !== undefined || (typeof e.cwd === 'string' && e.cwd !== cwd))) return;
    if (fs.existsSync(file + '.invalid')) return;
    reason = 'lock_conflict';
    lock = fs.openSync(file + '.lock', 'wx', 0o600);
    reason = 'record_error';
    const old = readState(file, cwd, configDir);
    reason = 'invalid_event';
    if (!object(e) || e.cwd !== cwd || !['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(e.hook_event_name) ||
        e.tool_name !== 'AskUserQuestion' || !identifier(e.session_id) || !identifier(e.tool_use_id) ||
        !scopedTranscript(e.transcript_path, configDir, e.session_id) ||
        !object(e.tool_input) || !keysOnly(e.tool_input, ['questions']) || !questions(e.tool_input.questions)) {
      throw Error('invalid owned hook event');
    }
    if (old.sessionId !== undefined && old.sessionId !== e.session_id) return;
    const state: State = {...old, sessionId:e.session_id};
    const pending = old.pending;
    if (e.hook_event_name === 'PreToolUse') {
      if (old.seenIds.includes(e.tool_use_id)) {
        if (pending?.toolUseId === e.tool_use_id && JSON.stringify(pending.questions) !== JSON.stringify(e.tool_input.questions)) {
          reason = 'conflicting_replay';
          throw Error('conflicting replay');
        }
        return;
      }
      if (pending) { reason = 'concurrent_pending'; throw Error('concurrent pending questions'); }
      state.pending = {sessionId:e.session_id, toolUseId:e.tool_use_id, transcriptPath:e.transcript_path,
        timestamp:new Date().toISOString(), questions:e.tool_input.questions};
    } else {
      // A late result cannot clear another request. Remember completion even
      // if its Pre was never observed, so replay cannot reopen that old ID.
      if (pending?.toolUseId === e.tool_use_id) state.pending = null;
    }
    if (!state.seenIds.includes(e.tool_use_id)) state.seenIds = [...state.seenIds, e.tool_use_id];
    const serialized = JSON.stringify(state) + '\n';
    reason = 'record_overflow';
    if (state.seenIds.length > MAX_IDS || Buffer.byteLength(serialized) > MAX_BYTES) throw Error('recorder overflow');
    reason = 'record_error';
    fs.writeFileSync(temporary, serialized, {mode:0o600, flag:'wx'});
    fs.renameSync(temporary, file);
  } catch { poison(file, reason); }
  finally {
    try { fs.rmSync(temporary, {force:true}); } catch { /* no evidence */ }
    if (lock !== undefined) {
      try { fs.closeSync(lock); fs.unlinkSync(file + '.lock'); } catch { poison(file, 'record_error'); }
    }
  }
}

/** Pending-only source. A published JSONL call, including failure, always wins. */
export function readPendingQuestion(file: string | undefined, cwd: string, configDir: string | null,
  startedAt: number, transcript: PlanCountTranscript,
): (NativePlanQuestionCall & {source:'pre_tool_use'}) | undefined {
  if (!file || !configDir || transcript.status !== 'ready' || !Number.isFinite(startedAt)) return undefined;
  try {
    if (fs.existsSync(file + '.invalid') || fs.existsSync(file + '.lock')) return undefined;
    const p = readState(file, cwd, configDir).pending;
    if (!p) return undefined;
    const time = Date.parse(p.timestamp);
    const sessions = new Set([...transcript.calls.map(c => c.sessionId), ...transcript.assistantMessages.map(m => m.sessionId)]);
    if (sessions.size !== 1 || !sessions.has(p.sessionId) || !Number.isFinite(time) || time < startedAt || time > Date.now() ||
        transcript.calls.some(c => c.sessionId === p.sessionId && c.toolUseId === p.toolUseId)) return undefined;
    if (!transcript.calls.length && !transcript.assistantMessages.some(m => m.sessionId === p.sessionId && m.text.trim() &&
        Number.isFinite(Date.parse(m.timestamp)) && Date.parse(m.timestamp) >= startedAt && Date.parse(m.timestamp) <= time)) return undefined;
    return {sessionId:p.sessionId, toolUseId:p.toolUseId, questions:p.questions, answered:false, failed:false, source:'pre_tool_use'};
  } catch { return undefined; }
}

if (import.meta.main && process.argv[2] === '--record') {
  const [file, cwd, configDir] = process.argv.slice(3);
  if (file && cwd && configDir) {
    const timer = setTimeout(() => { poison(file, 'stdin_timeout'); process.exit(0); }, 4000);
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of Bun.stdin.stream()) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) { poison(file, 'input_overflow'); process.exit(0); }
        chunks.push(chunk);
      }
      recordPendingQuestion(Buffer.concat(chunks).toString('utf8'), file, cwd, configDir);
    } catch { poison(file, 'hook_error'); }
    finally { clearTimeout(timer); }
  }
}
