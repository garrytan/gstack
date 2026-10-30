/**
 * claude-usage — the Claude Code meter for the /ship budget (GSTA-152 D1). A
 * live-session reader beside lib/claude-journal-records.ts (record identity and
 * ownership) and lib/claude-public-transcript.ts (question metadata): it only
 * sums `message.usage`. A session is bound explicitly, by `--session <id>` or by
 * a nonce the agent echoed once (zero or several matching journals refuse).
 * Its journal, its subagent journals (`<session>/subagents/*.jsonl`) and the
 * journals of headless children the handoff recorded all count. Each API call
 * is counted once per (message.id, requestId) at the maximum of each usage
 * field, which folds streaming duplicates and the copies a compaction or fork
 * writes into another journal; compaction summaries carry no charge. Reads are
 * incremental from a stored offset, guarded by a hash of the file's first
 * bytes: a rewritten journal is read again from the start.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const;
const PREFIX_BYTES = 4096;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ClaudeMeterState {
  schema_version: 1;
  config_dir: string;
  sessions: string[];
  files: Record<string, { offset: number; prefix_len: number; prefix: string }>;
  keys: Record<string, number[]>;
  last_key: string | null;
}

export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');

function projectDirs(configDir: string): string[] {
  const projects = path.join(configDir, 'projects');
  try { return fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(projects, d.name)); }
  catch { return []; }
}

/** Journals named for a session id, across project directories. */
export function sessionJournals(configDir: string, session: string): string[] {
  if (!SESSION.test(session)) return [];
  return projectDirs(configDir).map(d => path.join(d, `${session}.jsonl`)).filter(f => fs.existsSync(f));
}

/** Sessions whose journal contains the nonce; the caller refuses unless exactly one matches. */
export function nonceSessions(configDir: string, nonce: string): string[] {
  if (!/^[A-Za-z0-9_-]{8,}$/.test(nonce)) return [];
  const found = new Set<string>();
  for (const dir of projectDirs(configDir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl') || !SESSION.test(name.slice(0, -6))) continue;
      if (fs.readFileSync(path.join(dir, name), 'utf8').includes(nonce)) found.add(name.slice(0, -6));
    }
  }
  return [...found];
}

/** A session's own journal first, then its subagent journals. */
export function sessionFiles(configDir: string, session: string): string[] {
  return sessionJournals(configDir, session).flatMap(main => {
    const sub = path.join(path.dirname(main), session, 'subagents');
    let extra: string[] = [];
    try { extra = fs.readdirSync(sub).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(sub, n)); } catch {}
    return [main, ...extra];
  });
}

export function newMeterState(configDir: string, sessions: string[]): ClaudeMeterState {
  return { schema_version: 1, config_dir: configDir, sessions: [...sessions], files: {}, keys: {}, last_key: null };
}

function prefixHash(fd: number, length: number): string {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, buf.length, 0);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function absorb(state: ClaudeMeterState, line: string, isRoot: boolean): void {
  if (!line.includes('"usage"')) return;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return; }
  if (rec?.type !== 'assistant' || rec.isCompactSummary || typeof rec.message?.usage !== 'object' || rec.message.usage === null) return;
  const key = `${rec.message.id ?? rec.uuid}|${rec.requestId ?? ''}`;
  const prev = state.keys[key] ?? [0, 0, 0, 0];
  state.keys[key] = FIELDS.map((f, i) => Math.max(prev[i]!, Number.isFinite(rec.message.usage[f]) ? Number(rec.message.usage[f]) : 0));
  if (isRoot && !rec.isSidechain) state.last_key = key;
}

/** Read new complete lines of one file; false when the file was rewritten under us. */
function readIncrement(state: ClaudeMeterState, file: string, isRoot: boolean): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const seen = state.files[file];
    if (seen && (size < seen.offset || prefixHash(fd, seen.prefix_len) !== seen.prefix)) return false;
    const start = seen?.offset ?? 0;
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a) + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) if (line) absorb(state, line, isRoot);
    const prefixLen = Math.min(PREFIX_BYTES, size);
    state.files[file] = { offset: start + end, prefix_len: prefixLen, prefix: prefixHash(fd, prefixLen) };
    return true;
  } finally { fs.closeSync(fd); }
}

const total = (v: number[] | undefined) => (v ?? []).reduce((s, n) => s + n, 0);

/** The meter reading: every charge of the bound sessions, and the last root call's charge. */
export function readClaudeUsage(state: ClaudeMeterState): { total: number; lastCall: number | null; files: number } {
  const files = state.sessions.flatMap((s, i) => sessionFiles(state.config_dir, s).map((f, j) => ({ f, root: i === 0 && j === 0 })));
  for (const { f, root } of files) {
    if (readIncrement(state, f, root)) continue;
    state.files = {};
    state.keys = {};
    state.last_key = null;
    for (const again of files) readIncrement(state, again.f, again.root);
    break;
  }
  const sum = Object.values(state.keys).reduce((s, v) => s + total(v), 0);
  return { total: sum, lastCall: state.last_key ? total(state.keys[state.last_key]) : null, files: files.length };
}

export function loadMeterState(file: string): ClaudeMeterState | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeMeterState; } catch { return undefined; }
}

export function saveMeterState(file: string, state: ClaudeMeterState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
