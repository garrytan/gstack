import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setupQuestionHookScope, assertQuestionHookScope, type QuestionHookScope } from './plan-skill-question-hook-scope';

const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EVENTS = 256;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item) {
  return object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const parseJsonBytes = (bytes: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

interface Binding {
  schemaVersion: 1;
  nonce: string;
  sessionId: string;
  configDir: string;
  cwd: string;
}
declare const sourceBrand: unique symbol;
/** Created by setup only. Callers must not construct or alter the descriptor. */
export type QuestionEventSource = Readonly<Binding & {
  directory: string;
  bindingSha256: string;
  settingsSha256: string;
  [sourceBrand]: true;
}>;
export interface QuestionEventCall {
  id: string;
  toolName: 'AskUserQuestion';
  input: Record<string, unknown>;
  cwd: string;
}
export interface QuestionCompletionEventCall {
  id: string;
  capturedAtMs: number;
  toolName: 'AskUserQuestion';
  input: Record<string, unknown>;
  response: Record<string, unknown>;
  cwd: string;
}
export interface BashEventCall {
  id: string;
  capturedAtMs: number;
  toolName: 'Bash';
  input: Record<string, unknown>;
  cwd: string;
}
export interface BashCompletionEventCall extends BashEventCall {
  hookEventName: 'PostToolUse' | 'PostToolUseFailure';
  response: Record<string, unknown>;
}
export interface ExitPlanModeEventCall {
  id: string;
  toolName: 'ExitPlanMode';
  input: Record<string, unknown>;
  cwd: string;
}
export interface PermissionRequestEventCall {
  /** Observer identity only: PermissionRequest supplies no native tool_use_id. */
  requestId: string;
  capturedAtMs: number;
  toolName: 'Write' | 'Edit';
  input: Record<string, unknown>;
  cwd: string;
}
export interface BashPermissionRequestEventCall extends Omit<PermissionRequestEventCall, 'toolName'> {
  toolName: 'Bash';
}
export interface WebFetchPermissionRequestEventCall extends Omit<PermissionRequestEventCall, 'toolName'> {
  toolName: 'WebFetch';
}
export interface FileCompletionEventCall {
  id: string;
  capturedAtMs: number;
  toolName: 'Write' | 'Edit';
  input: Record<string, unknown>;
  response: Record<string, unknown>;
  cwd: string;
}
type EventRecord = Binding & {
  transcriptFile: string;
  input: Record<string, unknown>;
} & ({ hookEventName: 'PreToolUse'; toolName: 'AskUserQuestion' | 'ExitPlanMode'; id: string }
  | { hookEventName: 'PreToolUse'; toolName: 'Bash'; id: string; capturedAtMs: number }
  | { hookEventName: 'PostToolUse' | 'PostToolUseFailure'; toolName: 'Bash'; id: string; capturedAtMs: number; response: Record<string, unknown> }
  | { hookEventName: 'PermissionRequest'; toolName: 'Write' | 'Edit' | 'Bash' | 'WebFetch'; requestId: string; capturedAtMs: number }
  | { hookEventName: 'PostToolUse'; toolName: 'Write' | 'Edit' | 'AskUserQuestion'; id: string; capturedAtMs: number; response: Record<string, unknown> });
const eventId = (event: EventRecord): string => event.hookEventName === 'PermissionRequest' ? event.requestId
  : (event.hookEventName === 'PostToolUse' || event.hookEventName === 'PostToolUseFailure')
    && (event.toolName === 'AskUserQuestion' || event.toolName === 'Bash')
    ? `${event.hookEventName}:${event.toolName}:${event.id}` : event.id;

export function webFetchInput(input: Record<string, unknown>): input is { url: string; prompt: string } {
  if (typeof input.url !== 'string' || typeof input.prompt !== 'string' || !input.prompt.trim()
    || Object.keys(input).some(key => key !== 'url' && key !== 'prompt')) return false;
  try {
    const url = new URL(input.url);
    return /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function bashInput(input: Record<string, unknown>): boolean {
  return typeof input.command === 'string' && !!input.command.trim()
    && (input.description === undefined || typeof input.description === 'string');
}

// Pinned native Bash data. A background dispatch resolves the invocation, not
// the command/process. Preserve that metadata and never invent an exit code.
function bashResponse(event: unknown, response: unknown): response is Record<string, unknown> {
  if (!object(response)) return false;
  if (event === 'PostToolUseFailure') return typeof response.error === 'string' && !!response.error
    && typeof response.is_interrupt === 'boolean'
    && Object.keys(response).every(key => ['error', 'is_interrupt'].includes(key));
  if (event !== 'PostToolUse' || typeof response.stdout !== 'string' || typeof response.stderr !== 'string'
    || typeof response.interrupted !== 'boolean') return false;
  const strings = ['rawOutputPath', 'backgroundTaskId', 'backgroundCwdHint', 'returnCodeInterpretation',
    'persistedOutputPath', 'staleReadFileStateHint', 'ghRateLimitHint'];
  const booleans = ['isImage', 'backgroundedByUser', 'backgroundedByTurnAbort', 'backgroundedToDeliverMessage',
    'dangerouslyDisableSandbox', 'noOutputExpected'];
  const numbers = ['timedOutAfterMs', 'persistedOutputSize'];
  return Object.keys(response).every(key => ['stdout', 'stderr', 'interrupted', ...strings, ...booleans,
    ...numbers, 'backgroundEndsWithFinalResponse', 'structuredContent', 'gitOperation'].includes(key))
    && strings.every(key => response[key] === undefined || typeof response[key] === 'string')
    && booleans.every(key => response[key] === undefined || typeof response[key] === 'boolean')
    && numbers.every(key => response[key] === undefined || typeof response[key] === 'number' && Number.isFinite(response[key]))
    && (response.backgroundEndsWithFinalResponse === undefined || response.backgroundEndsWithFinalResponse === true)
    && (response.structuredContent === undefined || Array.isArray(response.structuredContent))
    && (response.gitOperation === undefined || object(response.gitOperation));
}

// Native successful Write/Edit output schemas, not a tool-result text guess.
// Preserve the whole response; the CLI can normalize edit text internally.
function fileResponse(tool: unknown, input: Record<string, unknown>, response: unknown): response is Record<string, unknown> {
  if (!object(response) || typeof input.file_path !== 'string' || !path.isAbsolute(input.file_path)
    || response.filePath !== input.file_path || !Array.isArray(response.structuredPatch)
    || !(response.originalFile === null || typeof response.originalFile === 'string')) return false;
  if (tool === 'Write') return typeof input.content === 'string' && typeof response.content === 'string'
    && ['create', 'update'].includes(response.type as string)
    && (response.userModified === undefined || typeof response.userModified === 'boolean');
  return tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string'
    && (input.replace_all === undefined || typeof input.replace_all === 'boolean')
    && typeof response.oldString === 'string' && typeof response.newString === 'string'
    && typeof response.userModified === 'boolean' && typeof response.replaceAll === 'boolean';
}

// Pinned CLI AUQ data, not rendered prose. Only complete offered single-choice
// answers qualify: idle, follow-up, freeform and annotated changes do not.
function questionResponse(input: Record<string, unknown>, response: unknown): response is Record<string, unknown> {
  if (!object(response) || Object.keys(response).some(key => !['questions', 'answers', 'annotations'].includes(key))
    || !Array.isArray(input.questions) || !Array.isArray(response.questions)
    || canonical(input.questions) !== canonical(response.questions) || !object(response.answers)) return false;
  const questions = input.questions;
  if (questions.length < 1 || questions.length > 4 || questions.some(q => !object(q)
    || typeof q.question !== 'string' || !q.question.trim() || typeof q.header !== 'string' || !q.header.trim()
    || !(q.multiSelect === undefined || q.multiSelect === false) || q.kind !== undefined && q.kind !== 'choice'
    || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
    || q.options.some(o => !object(o) || typeof o.label !== 'string' || !o.label.trim() || typeof o.description !== 'string'))) return false;
  const names = questions.map(q => q.question as string);
  if (new Set(names).size !== names.length || Object.keys(response.answers).length !== names.length
    || names.some(name => !Object.hasOwn(response.answers as object, name))) return false;
  for (const q of questions) {
    const options = q.options as Record<string, unknown>[];
    if ((response.answers as Record<string, unknown>)[q.question as string] === '(notes only)'
      || new Set(options.map(o => o.label)).size !== options.length
      || !options.some(o => o.label === (response.answers as Record<string, unknown>)[q.question as string])) return false;
  }
  if (input.answers !== undefined && canonical(input.answers) !== canonical(response.answers)) return false;
  if (input.annotations !== undefined && canonical(input.annotations) !== canonical(response.annotations)) return false;
  if (input.response || input.afkTimeoutMs || input.followUp) return false;
  if (response.annotations !== undefined) {
    if (!object(response.annotations) || Object.keys(response.annotations).some(name => !names.includes(name))) return false;
    for (const [name, annotation] of Object.entries(response.annotations)) {
      const q = questions.find(q => q.question === name)!;
      const option = (q.options as Record<string, unknown>[]).find(o => o.label === (response.answers as Record<string, unknown>)[name])!;
      if (!object(annotation) || Object.keys(annotation).some(key => !['preview', 'notes'].includes(key))
        || annotation.notes !== undefined && annotation.notes !== ''
        || annotation.preview !== undefined && annotation.preview !== option.preview) return false;
    }
  }
  return true;
}

function canonicalDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory
    || !fs.lstatSync(directory).isDirectory()) {
    throw new Error('Question event directory must be an owned real absolute directory');
  }
  // The caller's parent may be an OS alias (/var -> /private/var on macOS).
  // The directory itself must remain a real directory, never a leaf symlink.
  return fs.realpathSync(directory);
}
function realDirectory(directory: string): void {
  if (canonicalDirectory(directory) !== directory) throw new Error('Question event directory is no longer canonical');
}
function readRegular(file: string, limit: number): Buffer {
  // Reject FIFOs after opening without waiting for a writer to connect.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid or oversized question event file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) return bytes.subarray(0, length);
      length += read;
      if (length > limit) throw new Error('Question event grew beyond its bound');
    }
  } finally { fs.closeSync(fd); }
}

const observedEvents = new WeakMap<QuestionEventSource, Map<string, string>>();
const hookScopes = new WeakMap<QuestionEventSource, QuestionHookScope>();
function validateBinding(binding: unknown): asserts binding is Binding {
  if (!object(binding) || binding.schemaVersion !== 1 || typeof binding.nonce !== 'string'
    || !/^[a-f0-9]{64}$/.test(binding.nonce) || typeof binding.sessionId !== 'string' || !UUID.test(binding.sessionId)
    || typeof binding.configDir !== 'string' || typeof binding.cwd !== 'string') throw new Error('Invalid question event binding');
  realDirectory(binding.configDir);
  realDirectory(binding.cwd);
}
function transcriptPathAllowed(file: unknown, binding: Binding): file is string {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) return false;
  const parts = path.relative(path.join(binding.configDir, 'projects'), file).split(path.sep);
  if (parts.length !== 2 || !parts[0] || parts[0] === '..' || parts[1] !== `${binding.sessionId}.jsonl`) return false;
  // Canonicalize only the caller's config prefix. Paths below that boundary
  // cannot borrow ownership through a projects, project or transcript symlink.
  for (const directory of [path.join(binding.configDir, 'projects'), path.dirname(file)]) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) realDirectory(directory);
  }
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return !stat || stat.isFile();
}
function expectedTranscript(file: string, configDir: string, binding: Binding): string {
  for (const prefix of [configDir, binding.configDir]) {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) break;
    const relative = path.relative(prefix, file);
    const parts = relative.split(path.sep);
    if (parts.length !== 3 || parts[0] !== 'projects' || !parts[1] || parts[1] === '..') continue;
    const candidate = path.join(binding.configDir, relative);
    if (transcriptPathAllowed(candidate, binding)) return candidate;
  }
  throw new Error('Expected native transcript is outside this question event source');
}

/** Installs only an additional, silent observer setting. It neither replaces
 * product settings nor changes permission decisions. The launcher must control
 * other matching mutators; this descriptor never claims effective hook isolation.
 */
export function setupQuestionEventSource(opts: {
  configDir: string; cwd: string; sessionId: string; rootDir?: string;
}): { source: QuestionEventSource; settingsPath: string } {
  const binding: Binding = { schemaVersion: 1, nonce: randomBytes(32).toString('hex'),
    sessionId: opts.sessionId, configDir: canonicalDirectory(opts.configDir), cwd: canonicalDirectory(opts.cwd) };
  validateBinding(binding);
  const root = canonicalDirectory(opts.rootDir ?? path.dirname(opts.configDir));
  const scope = setupQuestionHookScope({ configDir: binding.configDir, cwd: binding.cwd });
  const directory = fs.mkdtempSync(path.join(root, 'question-events-'));
  fs.chmodSync(directory, 0o700);
  const bindingPath = path.join(directory, 'binding.json');
  const settingsPath = path.join(directory, 'settings.json');
  try {
    fs.mkdirSync(path.join(directory, 'events'), { mode: 0o700 });
    const bindingBytes = JSON.stringify(binding) + '\n';
    fs.writeFileSync(bindingPath, bindingBytes, { flag: 'wx', mode: 0o600 });
    const command = [process.execPath, import.meta.path, '--record-question-event', bindingPath, binding.nonce].map(quote).join(' ');
    const settingsBytes = JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: '^(AskUserQuestion|ExitPlanMode|Bash)$', hooks: [{ type: 'command', command, timeout: 5 }] }],
      PermissionRequest: [{ matcher: '^(Write|Edit|Bash|WebFetch)$', hooks: [{ type: 'command', command, timeout: 5 }] }],
      PostToolUse: [{ matcher: '^(Write|Edit|AskUserQuestion|Bash)$', hooks: [{ type: 'command', command, timeout: 5 }] }],
      PostToolUseFailure: [{ matcher: '^Bash$', hooks: [{ type: 'command', command, timeout: 5 }] }],
    } }) + '\n';
    fs.writeFileSync(settingsPath, settingsBytes, { flag: 'wx', mode: 0o600 });
    const source = Object.freeze({ ...binding, directory,
      bindingSha256: sha(bindingBytes), settingsSha256: sha(settingsBytes) }) as QuestionEventSource;
    observedEvents.set(source, new Map());
    hookScopes.set(source, scope);
    return { source, settingsPath };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function atomicPublish(directory: string, name: string, contents: string): boolean {
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  try {
    try { fs.linkSync(temporary, path.join(directory, name)); }
    catch (error: any) { if (error?.code === 'EEXIST') return false; throw error; }
    return true;
  } finally { fs.unlinkSync(temporary); }
}

function eventFromInput(value: unknown, binding: Binding): EventRecord | null {
  if (!object(value)) throw new Error('Malformed native question hook input');
  // A subagent can inherit the hook setting. It must never become a main call.
  if (value.session_id !== binding.sessionId || Object.hasOwn(value, 'agent_id')) return null;
  if (value.cwd !== binding.cwd || !transcriptPathAllowed(value.transcript_path, binding)
    || !object(value.tool_input)) throw new Error('Native question hook ownership or input mismatch');
  // Invocation validation belongs to the shared reader. Completion data below
  // is schema-checked here, then matched to the exact invocation by that reader.
  if (value.hook_event_name === 'PreToolUse' && (value.tool_name === 'AskUserQuestion' || value.tool_name === 'ExitPlanMode')
    && typeof value.tool_use_id === 'string' && value.tool_use_id.trim() && value.tool_use_id.length <= 256) {
    return { ...binding, hookEventName: 'PreToolUse', toolName: value.tool_name,
      transcriptFile: value.transcript_path, id: value.tool_use_id, input: value.tool_input };
  }
  if (value.tool_name === 'Bash' && typeof value.tool_use_id === 'string'
    && value.tool_use_id.trim() && value.tool_use_id.length <= 256 && bashInput(value.tool_input)) {
    const base = { ...binding, toolName: 'Bash' as const, transcriptFile: value.transcript_path,
      id: value.tool_use_id, capturedAtMs: Date.now(), input: value.tool_input };
    if (value.hook_event_name === 'PreToolUse') return { ...base, hookEventName: 'PreToolUse' };
    const response = value.hook_event_name === 'PostToolUseFailure'
      ? { error: value.error, is_interrupt: value.is_interrupt } : value.tool_response;
    if ((value.hook_event_name === 'PostToolUseFailure' && !Object.hasOwn(value, 'tool_response')
      || value.hook_event_name === 'PostToolUse' && !Object.hasOwn(value, 'error') && value.is_error !== true)
      && bashResponse(value.hook_event_name, response)) return { ...base, hookEventName: value.hook_event_name, response };
  }
  if (value.hook_event_name === 'PermissionRequest' && (value.tool_name === 'Write' || value.tool_name === 'Edit' || value.tool_name === 'Bash' && bashInput(value.tool_input)
    || value.tool_name === 'WebFetch' && webFetchInput(value.tool_input))) {
    // Each hook emission is a distinct request observation. The payload cannot
    // provide this identity, and it must never masquerade as a native tool ID.
    return { ...binding, hookEventName: 'PermissionRequest', toolName: value.tool_name,
      transcriptFile: value.transcript_path, requestId: randomUUID(), capturedAtMs: Date.now(), input: value.tool_input };
  }
  if (value.hook_event_name === 'PostToolUse' && value.tool_name === 'AskUserQuestion'
    && typeof value.tool_use_id === 'string' && value.tool_use_id.trim() && value.tool_use_id.length <= 256
    && !Object.hasOwn(value, 'error') && value.is_error !== true && questionResponse(value.tool_input, value.tool_response)) {
    return { ...binding, hookEventName: 'PostToolUse', toolName: 'AskUserQuestion',
      transcriptFile: value.transcript_path, id: value.tool_use_id, capturedAtMs: Date.now(),
      input: value.tool_input, response: value.tool_response };
  }
  if (value.hook_event_name === 'PostToolUse' && (value.tool_name === 'Write' || value.tool_name === 'Edit')
    && typeof value.tool_use_id === 'string' && value.tool_use_id.trim() && value.tool_use_id.length <= 256
    && fileResponse(value.tool_name, value.tool_input, value.tool_response)) {
    return { ...binding, hookEventName: 'PostToolUse', toolName: value.tool_name,
      transcriptFile: value.transcript_path, id: value.tool_use_id, capturedAtMs: Date.now(),
      input: value.tool_input, response: value.tool_response };
  }
  throw new Error('Native question hook event or tool mismatch');
}

async function recordQuestionEvent(bindingPath: string, nonce: string): Promise<void> {
  let directory: string | undefined;
  let binding: Binding | undefined;
  try {
    if (!path.isAbsolute(bindingPath) || path.basename(bindingPath) !== 'binding.json') return;
    const parent = path.dirname(bindingPath);
    realDirectory(parent);
    const candidate = parseJsonBytes(readRegular(bindingPath, MAX_EVENT_BYTES));
    validateBinding(candidate);
    if (nonce !== candidate.nonce) return;
    binding = candidate;
    directory = path.join(parent, 'events');
    realDirectory(directory);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_EVENT_BYTES) throw new Error('Native question hook input exceeds the byte bound');
      chunks.push(bytes);
    }
    const event = eventFromInput(parseJsonBytes(Buffer.concat(chunks)), binding);
    if (!event) return;
    const body = canonical(event) + '\n';
    if (Buffer.byteLength(body) > MAX_EVENT_BYTES) throw new Error('Native question event exceeds the byte bound');
    const name = sha(eventId(event)) + '.json';
    if (!atomicPublish(directory, name, body)) {
      const existing = parseJsonBytes(readRegular(path.join(directory, name), MAX_EVENT_BYTES));
      // Repeated identical completion delivery retains the first immutable
      // observation time; it cannot create a second answer or change payload.
      const repeated = (event.toolName === 'Bash' || event.hookEventName === 'PostToolUse' && event.toolName === 'AskUserQuestion')
        && object(existing) ? { ...event, capturedAtMs: existing.capturedAtMs } : event;
      if (canonical(existing) !== canonical(repeated)) throw new Error('Conflicting native question event for an existing tool ID');
    }
  } catch (error) {
    // Observer failures never deny the tool or inject model/UI text. The
    // harness reader fails closed on the retained error instead.
    if (directory && binding) {
      try { atomicPublish(directory, 'error.json', JSON.stringify({ schemaVersion: 1, nonce: binding.nonce,
        error: error instanceof Error ? error.message : 'Question event capture failed' }) + '\n'); } catch { /* no valid new event */ }
    }
  }
}

function readCapturedEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): (QuestionEventCall | QuestionCompletionEventCall | BashEventCall | BashCompletionEventCall | ExitPlanModeEventCall | PermissionRequestEventCall | BashPermissionRequestEventCall | WebFetchPermissionRequestEventCall | FileCompletionEventCall)[] {
  if (expected.configDir === null || canonicalDirectory(expected.configDir) !== source.configDir
    || expected.sessionId !== source.sessionId) throw new Error('Question event source belongs to another session');
  const scope = hookScopes.get(source);
  if (!scope) throw new Error('Question event source was not created by this launcher');
  assertQuestionHookScope(scope);
  realDirectory(source.directory);
  const bindingBytes = readRegular(path.join(source.directory, 'binding.json'), MAX_EVENT_BYTES);
  const settingsBytes = readRegular(path.join(source.directory, 'settings.json'), MAX_EVENT_BYTES);
  if (sha(bindingBytes) !== source.bindingSha256 || sha(settingsBytes) !== source.settingsSha256) throw new Error('Question event binding or settings changed');
  const binding = parseJsonBytes(bindingBytes);
  validateBinding(binding);
  if (binding.nonce !== source.nonce || binding.sessionId !== source.sessionId
    || binding.configDir !== source.configDir || binding.cwd !== source.cwd) throw new Error('Question event descriptor differs from its binding');
  const directory = path.join(source.directory, 'events');
  realDirectory(directory);
  const files = fs.readdirSync(directory).sort();
  if (files.includes('error.json')) throw new Error('Native question event capture failed; inspect the retained error.json');
  if (files.length > MAX_EVENTS) throw new Error('Native question event inventory exceeds its bound');
  // In-flight temporary bytes cannot authorize any question.
  if (files.some(file => /^\.pending-[a-f0-9-]+$/.test(file))) return [];
  if (files.some(file => !/^[a-f0-9]{64}\.json$/.test(file))) throw new Error('Unexpected native question event file');
  if (expected.transcriptFile === null) return [];
  const transcriptFile = expectedTranscript(expected.transcriptFile, expected.configDir, binding);
  let total = 0;
  const calls: (QuestionEventCall | QuestionCompletionEventCall | BashEventCall | BashCompletionEventCall | ExitPlanModeEventCall | PermissionRequestEventCall | BashPermissionRequestEventCall | WebFetchPermissionRequestEventCall | FileCompletionEventCall)[] = [];
  const observed = observedEvents.get(source);
  if (!observed) throw new Error('Question event source was not created by this launcher');
  if ([...observed.keys()].some(file => !files.includes(file))) throw new Error('Previously observed native question event disappeared');
  for (const file of files) {
    const bytes = readRegular(path.join(directory, file), MAX_EVENT_BYTES);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Native question event bytes exceed their total bound');
    if (!bytes.length || bytes.at(-1) !== 10) throw new Error('Incomplete native question event');
    const event = parseJsonBytes(bytes);
    if (!object(event) || event.schemaVersion !== 1 || event.nonce !== binding.nonce
      || event.sessionId !== binding.sessionId || event.configDir !== binding.configDir || event.cwd !== binding.cwd
      || event.transcriptFile !== transcriptFile || !object(event.input)) throw new Error('Native question event identity or input changed');
    const native = event.hookEventName === 'PreToolUse' && (event.toolName === 'AskUserQuestion' || event.toolName === 'ExitPlanMode')
      && typeof event.id === 'string' && !!event.id.trim() && event.id.length <= 256;
    const timed = typeof event.capturedAtMs === 'number' && Number.isSafeInteger(event.capturedAtMs)
      && event.capturedAtMs > 0 && event.capturedAtMs <= 8_640_000_000_000_000;
    const bash = event.hookEventName === 'PreToolUse' && event.toolName === 'Bash'
      && typeof event.id === 'string' && !!event.id.trim() && event.id.length <= 256 && timed && bashInput(event.input);
    const bashCompletion = event.toolName === 'Bash' && typeof event.id === 'string'
      && !!event.id.trim() && event.id.length <= 256 && timed && bashInput(event.input)
      && bashResponse(event.hookEventName, event.response);
    const permission = event.hookEventName === 'PermissionRequest' && (event.toolName === 'Write' || event.toolName === 'Edit' || event.toolName === 'Bash' && bashInput(event.input)
      || event.toolName === 'WebFetch' && webFetchInput(event.input))
      && typeof event.requestId === 'string' && UUID.test(event.requestId) && timed;
    const completion = event.hookEventName === 'PostToolUse' && typeof event.id === 'string'
      && !!event.id.trim() && event.id.length <= 256 && timed && fileResponse(event.toolName, event.input, event.response);
    const questionCompletion = event.hookEventName === 'PostToolUse' && event.toolName === 'AskUserQuestion'
      && typeof event.id === 'string' && !!event.id.trim() && event.id.length <= 256 && timed
      && questionResponse(event.input, event.response);
    const identityKey = permission ? 'requestId' : 'id';
    if ((!native && !bash && !bashCompletion && !permission && !completion && !questionCompletion) || file !== sha(eventId(event as EventRecord)) + '.json'
      || Object.keys(event).some(key => !['schemaVersion', 'nonce', 'sessionId', 'configDir', 'cwd', 'hookEventName', 'toolName', 'transcriptFile', identityKey, 'input', ...(permission || completion || questionCompletion || bash || bashCompletion ? ['capturedAtMs'] : []), ...(completion || questionCompletion || bashCompletion ? ['response'] : [])].includes(key))) throw new Error('Native question event identity or input changed');
    const hash = sha(bytes);
    if (observed.has(file) && observed.get(file) !== hash) throw new Error('Previously observed native question event changed');
    observed.set(file, hash);
    if (native) calls.push({ id: event.id as string, toolName: event.toolName as 'AskUserQuestion' | 'ExitPlanMode', input: event.input, cwd: event.cwd });
    else if (bash) calls.push({ id: event.id as string, capturedAtMs: event.capturedAtMs as number,
      toolName: 'Bash', input: event.input, cwd: event.cwd });
    else if (bashCompletion) calls.push({ id: event.id as string, capturedAtMs: event.capturedAtMs as number,
      toolName: 'Bash', hookEventName: event.hookEventName as 'PostToolUse' | 'PostToolUseFailure',
      input: event.input, response: event.response as Record<string, unknown>, cwd: event.cwd });
    else if (questionCompletion) calls.push({ id: event.id as string, capturedAtMs: event.capturedAtMs as number,
      toolName: 'AskUserQuestion', input: event.input, response: event.response as Record<string, unknown>, cwd: event.cwd });
    else if (completion) calls.push({ id: event.id as string, capturedAtMs: event.capturedAtMs as number,
      toolName: event.toolName as 'Write' | 'Edit', input: event.input, response: event.response as Record<string, unknown>, cwd: event.cwd });
    else calls.push({ requestId: event.requestId as string, capturedAtMs: event.capturedAtMs as number,
      toolName: event.toolName as 'Write' | 'Edit' | 'Bash' | 'WebFetch', input: event.input, cwd: event.cwd });
  }
  return calls;
}

/** Pending native AUQ invocation evidence only. Never reads or fabricates a result. */
export function readQuestionEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): QuestionEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is QuestionEventCall => call.toolName === 'AskUserQuestion' && !('response' in call));
}

/** Successful native offered-choice response; must still match its exact pre-hook input. */
export function readQuestionCompletionEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): QuestionCompletionEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is QuestionCompletionEventCall =>
    call.toolName === 'AskUserQuestion' && 'response' in call);
}

/** Native Bash execution input; it never grants a permission by itself. */
export function readBashEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): BashEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is BashEventCall => call.toolName === 'Bash' && !('response' in call) && !('requestId' in call));
}

/** Native invocation resolution, including failure or background dispatch. */
export function readBashCompletionEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): BashCompletionEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is BashCompletionEventCall => call.toolName === 'Bash' && 'response' in call);
}

/** Pending native ExitPlanMode only: no approval, result or AUQ authority. */
export function readExitPlanModeEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): ExitPlanModeEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is ExitPlanModeEventCall => call.toolName === 'ExitPlanMode');
}

/** Post-PreToolUse permission requests. requestId is never a native ID or ACK. */
export function readPermissionRequestEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): PermissionRequestEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is PermissionRequestEventCall => 'requestId' in call && (call.toolName === 'Write' || call.toolName === 'Edit'));
}

/** Post-PreToolUse Bash permission input; observer UUID supplies no native ID. */
export function readBashPermissionRequestEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): BashPermissionRequestEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is BashPermissionRequestEventCall => 'requestId' in call && call.toolName === 'Bash');
}


/** Effective Fetch input only; native transcript identity and result remain required. */
export function readWebFetchPermissionRequestEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): WebFetchPermissionRequestEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is WebFetchPermissionRequestEventCall =>
    'requestId' in call && call.toolName === 'WebFetch');
}

/** Successful native execution, not a grant or an AUQ/ExitPlanMode result. */
export function readFileCompletionEvents(source: QuestionEventSource, expected: {
  configDir: string | null; sessionId: string; transcriptFile: string | null;
}): FileCompletionEventCall[] {
  return readCapturedEvents(source, expected).filter((call): call is FileCompletionEventCall => 'response' in call && (call.toolName === 'Write' || call.toolName === 'Edit'));
}

if (import.meta.main && process.argv.length === 5 && process.argv[2] === '--record-question-event') {
  // No top-level await: consumers may synchronously require this helper.
  // Reading CLI stdin keeps its own process alive until publication completes.
  void recordQuestionEvent(process.argv[3]!, process.argv[4]!).catch(() => {});
}
