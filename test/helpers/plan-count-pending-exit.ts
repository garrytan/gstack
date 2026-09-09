/** Read-only pending ExitPlanMode identity for counting evals. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanCountTranscript } from './plan-count-transcript';

const MAX_RECORD_BYTES = 4096;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const shellQuote = (value: string) => `'${(process.platform === 'win32' ? value.replaceAll('\\', '/') : value).replaceAll("'", "'\\''")}'`;

export function createPendingExitRecorder(cwd: string, configDir: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pending-exit-'));
  const file = path.join(dir, 'pending.json');
  const command = [process.execPath, import.meta.path, '--record', file, cwd, configDir].map(shellQuote).join(' ');
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^ExitPlanMode$',
    hooks: [{ type: 'command', command, timeout: 5 }],
  }] } });
  return { file, settings, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function scopedTranscript(file: unknown, configDir: string, session: string): boolean {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.join(configDir, 'projects'), file).split(path.sep);
  return relative.length === 2 && relative[0] !== '..' && relative[0] !== '.' &&
    relative[1] === `${session}.jsonl`;
}

/** No stdout, permission decision, updated input, or model-visible context. */
export function recordPendingExit(input: string, file: string, cwd: string, configDir: string): void {
  try {
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('hook input too large');
    const event = JSON.parse(input);
    // Subagents and other fixtures must never supply this main session's gate.
    if (event?.agent_id !== undefined || event?.cwd !== cwd) return;
    fs.rmSync(file, { force: true });
    if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'ExitPlanMode' ||
        !identifier(event.session_id) || !identifier(event.tool_use_id) ||
        !scopedTranscript(event.transcript_path, configDir, event.session_id)) return;
    const record = { sessionId: event.session_id, toolUseId: event.tool_use_id,
      cwd, transcriptPath: event.transcript_path, timestamp: new Date().toISOString() };
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // A failed recorder cannot turn an earlier gate into current evidence.
    try { fs.rmSync(file, { force: true }); } catch { /* no evidence */ }
  }
}

/** Exact current native gate; ordinary prose or a still-streaming menu is insufficient. */
export function isCurrentPlanApprovalScreen(screen: string): boolean {
  const gate = /(?:^|\n) {0,3}─{5,}[ \t]*\n {0,3}Claude has written up a plan and is ready to execute\. Would you like to proceed\?[ \t]*\n\s*❯[ \t]*1\.[ \t]*Yes, and use auto mode[ \t]*\n[ \t]*2\.[ \t]*Yes, manually approve edits[ \t]*\n[ \t]*3\.[ \t]*Tell Claude what to change[ \t]*(?:\n[ \t]*shift\+tab to approve with this feedback)?\s*$/i.exec(screen) ??
    /(?:^|\n) {0,3}Exit plan mode\?[ \t]*\n(?:[ \t]*\n)* {0,3}Claude wants to exit plan mode[ \t]*\n\s*❯[ \t]*1\.[ \t]*Yes, and switch to default \(ask each time\) for this session[ \t]*\n[ \t]*2\.[ \t]*No\s*$/i.exec(screen);
  if (!gate) return false;
  const before = screen.slice(0, gate.index);
  if (/\b(?:example|sample|template|quote)\b.*[:：]\s*$/i.test(before.trimEnd().split('\n').at(-1) ?? '')) return false;
  let fence: { marker: string; length: number } | undefined;
  for (const line of before.split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!delimiter) continue;
    if (!fence) fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
    else if (delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
  }
  return fence === undefined;
}

/** Adds pending identity only; successful AUQ coverage still comes from JSONL results. */
export function withPendingExit(
  transcript: PlanCountTranscript, file: string | undefined, cwd: string,
  configDir: string | null, startedAt: number, screen: string,
): PlanCountTranscript {
  if (!file || !configDir || transcript.status !== 'ready' || !transcript.calls.length ||
      !isCurrentPlanApprovalScreen(screen)) return transcript;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return transcript;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const time = Date.parse(record.timestamp);
    const sessions = new Set([...transcript.calls.map(call => call.sessionId),
      ...transcript.assistantMessages.map(message => message.sessionId)]);
    if (record.cwd !== cwd || !identifier(record.sessionId) || !identifier(record.toolUseId) ||
        sessions.size !== 1 || !sessions.has(record.sessionId) ||
        !scopedTranscript(record.transcriptPath, configDir, record.sessionId) ||
        !Number.isFinite(time) || time < startedAt || time > Date.now()) return transcript;
    const requests = transcript.planReadyRequests ?? [];
    // A flushed native record, including a failed result, always wins.
    if (requests.some(request => request.sessionId === record.sessionId && request.toolUseId === record.toolUseId)) return transcript;
    return { ...transcript, planReadyRequests: [...requests, {
      sessionId: record.sessionId, toolUseId: record.toolUseId,
      timestamp: record.timestamp, failed: false, source: 'pre_tool_use',
    }] };
  } catch { return transcript; }
}

if (import.meta.main && process.argv[2] === '--record') {
  try {
    const [file, cwd, configDir] = process.argv.slice(3);
    if (file && cwd && configDir) recordPendingExit(await Bun.stdin.text(), file, cwd, configDir);
  } catch { /* observation never changes the native permission outcome */ }
}
