import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { currentFilePermissionTarget, nativePermissionKey, reserveNativePermissionGrant, type readPlanSkillQuestions, type NativeFilePermissionRequest, type NativePermissionGrant } from './plan-skill-questions';
import type { ClaudePtySession } from './claude-pty-runner';
import { readQuestionEvents, readQuestionCompletionEvents, readBashEvents, readBashCompletionEvents, readBashPermissionRequestEvents, type QuestionEventSource,
  type QuestionEventCall, type QuestionCompletionEventCall, type BashEventCall, type BashCompletionEventCall, type BashPermissionRequestEventCall } from './plan-skill-question-events';

/** The chain may grant file edits in its fixture and native plan directory.
 * The shared reservation still requires the exact owned request and menu;
 * a permission-looking screen alone never authorizes an input. */
export function reserveAutoplanFilePermission(
  native: ReturnType<typeof readPlanSkillQuestions>, visible: string,
  opts: { cwd: string; planDir: string; granted: Set<string>; requests: Map<string, NativePermissionGrant> },
): boolean {
  if (native.pendingBytes || native.ready || native.calls.some(call => call.result === 'pending')) return false;
  const pending = native.permissionRequests.filter(request => request.result === 'pending');
  if (!native.permissionRequestCapture || pending.length !== 1) return false;
  const request = pending[0]!;
  const cwd = fs.realpathSync(opts.cwd);
  if (request.cwd !== cwd) throw new Error('Autoplan file permission cwd differs from its fixture');
  const file = request.input.file_path;
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Autoplan file permission lacks an absolute path');
  const normalized = path.normalize(file);
  const root = [cwd, opts.planDir].find(root => normalized.startsWith(root + path.sep));
  if (!root) throw new Error('Autoplan file permission is outside its fixture and native plan directory');
  // Reject symlink escapes, including a not-yet-created file below a link.
  for (let entry = normalized; entry !== path.dirname(root); entry = path.dirname(entry)) {
    if (fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Autoplan file permission traverses a symlink');
    }
  }
  return reserveNativePermissionGrant(native, visible, opts.granted, opts.requests);
}

/** Recover only a clipped file identity; the existing reservation remains the
 * grant authority. The three fresh paints are finite, not a promise that every
 * possible diff fits. A resize is never a decision or native completion. */
export class AutoplanFilePermissionViewport {
  private owner: NativeFilePermissionRequest | null = null;
  private paints = 0;
  inputMark = -1;
  get active(): boolean { return this.owner !== null; }

  constructor(private readonly opts: {
    session: Pick<ClaudePtySession, 'resizeQuestionViewport' | 'mark'>;
    deadlineAt: number;
    granted: Set<string>;
  }) {}

  /** Called only after the caller's unchanged native/current-screen bracket.
   * true means wait for another sample, never type a permission choice. */
  async advance(native: ReturnType<typeof readPlanSkillQuestions>, frame: { text: string; rawEnd: number }): Promise<boolean> {
    if (!this.owner) return false;
    const owner = native.permissionRequests.find(request => request.requestId === this.owner!.requestId);
    if (!owner || owner.name !== this.owner.name || owner.cwd !== this.owner.cwd
      || owner.capturedAtMs !== this.owner.capturedAtMs || !isDeepStrictEqual(owner.input, this.owner.input)
      || this.owner.nativeToolId != null && owner.nativeToolId !== this.owner.nativeToolId) {
      throw new Error('Autoplan expanded file permission changed ownership or input');
    }
    // A hook can precede transcript persistence. Once linked, retain that ID.
    if (this.owner.nativeToolId == null && owner.nativeToolId != null) this.owner.nativeToolId = owner.nativeToolId;
    if (owner.result === 'error') throw new Error('Autoplan expanded file permission returned an error');
    if (owner.result === 'completed') {
      if (!owner.nativeToolId || !Number.isFinite(owner.nativeResultAtMs)) throw new Error('Autoplan expanded file permission lacks its successful native ACK');
      const restored = await this.opts.session.resizeQuestionViewport!(120, this.opts.deadlineAt);
      if (restored !== null) { this.inputMark = restored; this.owner = null; }
      return true;
    }
    // A queued Bash cannot own this pinned file repaint. The unchanged exact
    // current-card reservation below still decides the sole file grant.
    if (native.permissionRequests.filter(request => request.result === 'pending').length !== 1
      || native.permissionTools.some(tool => tool.id !== owner.nativeToolId && tool.name !== 'Bash')) {
      throw new Error('Ambiguous native permission owner during Autoplan viewport recovery');
    }
    if (native.pendingBytes || frame.rawEnd !== this.opts.session.mark() || frame.rawEnd <= this.inputMark
      || this.opts.granted.has(`request:${owner.requestId}`)) return true;
    try { nativePermissionKey(owner, frame.text); return false; }
    catch (error) {
      if (!this.clipped(owner, frame.text) || this.paints === 3) throw error;
      return this.repaint();
    }
  }

  /** The caller first runs all existing fixture/symlink/owner/grant checks.
   * A clipped identity can also fail disambiguation against a queued Bash;
   * neither error authorizes input before the full file card is recovered. */
  async recover(error: unknown, native: ReturnType<typeof readPlanSkillQuestions>, frame: { text: string; rawEnd: number }): Promise<boolean> {
    const identityError = error instanceof Error && (error.message === 'Visible permission cannot be bound to its pending native command or file path'
      || error.message === 'Ambiguous native permission owner: multiple tools are pending'
        && native.permissionTools.some(tool => tool.name === 'Bash'));
    if (!identityError || this.owner || !this.opts.session.resizeQuestionViewport || frame.rawEnd !== this.opts.session.mark()
      || native.pendingBytes || native.ready || native.calls.some(call => call.result === 'pending')) return false;
    const pending = native.permissionRequests.filter(request => request.result === 'pending');
    const owner = pending[0];
    if (!native.permissionRequestCapture || pending.length !== 1 || !owner
      || native.permissionTools.some(tool => tool.id !== owner.nativeToolId && tool.name !== 'Bash')
      || this.opts.granted.has(`request:${owner.requestId}`) || !this.clipped(owner, frame.text)) return false;
    this.owner = structuredClone(owner);
    this.paints = 0;
    return this.repaint();
  }

  private clipped(owner: NativeFilePermissionRequest, visible: string): boolean {
    const target = currentFilePermissionTarget(visible), file = owner.input.file_path;
    return target !== null && owner.name === (target.operation === 'edit' ? 'Edit' : 'Write')
      && typeof file === 'string' && path.isAbsolute(file)
      && path.basename(target.filePath) === target.filePath && path.basename(file) === target.filePath
      && !/^ (?:Create|Edit|Overwrite) file$/m.test(visible);
  }

  private async repaint(): Promise<boolean> {
    const mark = await this.opts.session.resizeQuestionViewport!(this.paints === 0 ? 240 : this.paints === 1 ? 480 : 960, this.opts.deadlineAt);
    if (mark !== null) { this.inputMark = mark; this.paints++; }
    return true;
  }
}

/** The PTY renders Markdown without stars and may position spaces via ANSI.
 * Keep complete-word bounds and stream order; callers dedupe first observations.
 */
export function observedAutoplanPhases(visible: string): number[] {
  return [...visible.matchAll(/\bPhase\s*(\d+(?:\.\d+)?)\s*complete\b/g)]
    .map(match => Number(match[1]));
}

export interface AutoplanTranscriptObservation {
  file: string | null;
  phases: number[];
  completedLines: number;
  pendingBytes: number;
}

/** Preserve the owned commands needed to investigate a stopped chain before
 * its fixture is deleted. This diagnostic cannot change a phase verdict.
 */
export function retainAutoplanFailure(opts: {
  configDir: string | null; sessionId: string; observation: unknown;
  raw: () => string; visible: () => string; evalDir?: string;
  /** Owned question evidence and the last decoded viewport are bounded; raw history stays hashed. */
  counting?: { native: ReturnType<typeof readPlanSkillQuestions> | null; dialog: string; events?: QuestionEventSource | null;
    frame?: { text: string; rawEnd: number; observedAtMs: number; questionSince: number; viewportInputSince: number } | null };
}): string | null {
  try {
    const raw = opts.raw();
    const visible = opts.visible();
    const native = readOwnedClaudeTranscript(opts.configDir, opts.sessionId);
    const clip = (text: string, limit = 32_768) => ({
      text: text.slice(0, limit), codeUnits: text.length, truncated: text.length > limit,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    const signature = (value: unknown) => {
      const { text: _omitted, ...digest } = clip(JSON.stringify(value) ?? '');
      return { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, ...digest };
    };
    const safeInput = (name: string, input: any) => ({ ...signature(input),
      ...(['Read', 'Write', 'Edit'].includes(name) && typeof input?.file_path === 'string' ? { filePath: input.file_path.slice(0, 4096) } : {}),
    });
    const calls: Array<{ id: string; name: string; input: unknown; timestamp: unknown; cwd: unknown }> = [];
    const results = new Map<string, boolean>();
    for (const row of native.rows) {
      const message = row.message;
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          results.set(block.tool_use_id, block.is_error === true);
        }
        if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use'
          && typeof block.id === 'string' && typeof block.name === 'string') {
          calls.push({ id: block.id, name: block.name, input: block.input ?? null, timestamp: row.timestamp, cwd: row.cwd });
        }
      }
    }
    const pending = calls.filter(call => !results.has(call.id));
    const queue = native.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'queue-operation');
    const state = opts.counting?.native;
    // The failing reader may not have updated state. Preserve current native
    // AUQs and revalidated hook inputs as well as the earlier pending snapshot.
    // These later diagnostic reads never supply an answer or change the error.
    const observedPending = state?.calls.filter(call => call.result === 'pending') ?? [];
    let hookQuestions: QuestionEventCall[] = [];
    let hookCompletions: QuestionCompletionEventCall[] = [];
    let bashInvocations: BashEventCall[] = [];
    let bashCompletions: BashCompletionEventCall[] = [];
    let bashRequests: BashPermissionRequestEventCall[] = [];
    let hookReadError: ReturnType<typeof clip> | null = null;
    if (opts.counting?.events) {
      try { hookQuestions = readQuestionEvents(opts.counting.events, { configDir: opts.configDir,
        sessionId: opts.sessionId, transcriptFile: native.file });
        hookCompletions = readQuestionCompletionEvents(opts.counting.events, { configDir: opts.configDir,
          sessionId: opts.sessionId, transcriptFile: native.file });
        bashInvocations = readBashEvents(opts.counting.events, { configDir: opts.configDir,
          sessionId: opts.sessionId, transcriptFile: native.file });
        bashCompletions = readBashCompletionEvents(opts.counting.events, { configDir: opts.configDir,
          sessionId: opts.sessionId, transcriptFile: native.file });
        bashRequests = readBashPermissionRequestEvents(opts.counting.events, { configDir: opts.configDir,
          sessionId: opts.sessionId, transcriptFile: native.file }); }
      catch (error) { hookReadError = clip(String(error), 1024); }
    }
    const bashCandidateIds = [...new Set([...(state?.permissionTools.filter(tool => tool.name === 'Bash').map(tool => tool.id) ?? []),
      ...bashCompletions.slice().sort((a, b) => b.capturedAtMs - a.capturedAtMs).map(event => event.id),
      ...bashInvocations.slice().sort((a, b) => b.capturedAtMs - a.capturedAtMs).map(event => event.id)])];
    const bashIds = new Set(bashCandidateIds.slice(0, 16));
    const selectedBashRequests = bashRequests.filter(request => bashInvocations.some(invoked => bashIds.has(invoked.id)
      && invoked.cwd === request.cwd && JSON.stringify(invoked.input) === JSON.stringify(request.input)));
    const nativeQuestions = calls.filter(call => call.name === 'AskUserQuestion');
    const candidateIds = [...new Set([...observedPending.slice(-16).map(call => call.id),
      ...hookCompletions.slice().sort((a, b) => b.capturedAtMs - a.capturedAtMs).map(event => event.id),
      ...nativeQuestions.slice().reverse().map(call => call.id), ...hookQuestions.map(call => call.id),
      ...observedPending.map(call => call.id)])];
    const questionIds = new Set(candidateIds.slice(0, 16));
    const questionBlocks: unknown[] = [];
    if (opts.counting) for (const [rowIndex, row] of native.rows.entries()) {
      const message = row.message;
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        const invocation = row.type === 'assistant' && message.role === 'assistant'
          && block?.type === 'tool_use' && block.name === 'AskUserQuestion' && questionIds.has(block.id);
        const result = row.type === 'user' && message.role === 'user'
          && block?.type === 'tool_result' && questionIds.has(block.tool_use_id);
        if (!invocation && !result) continue;
        questionBlocks.push({ rowIndex, type: row.type, stopReason: message.stop_reason ?? null,
          timestamp: typeof row.timestamp === 'string' ? clip(row.timestamp, 256) : null,
          cwd: typeof row.cwd === 'string' ? clip(row.cwd, 4096) : null,
          blockJson: clip(JSON.stringify(block), 65_536),
          ...(result && row.toolUseResult !== undefined ? { toolUseResultJson: clip(JSON.stringify(row.toolUseResult), 65_536) } : {}) });
      }
    }
    const fileTarget = opts.counting ? currentFilePermissionTarget(opts.counting.dialog) : null;
    const counting = opts.counting ? {
      dialog: { ...signature(opts.counting.dialog), currentFileTarget: fileTarget ? { ...fileTarget, filePath: fileTarget.filePath.slice(0, 4096) } : null },
      decodedFrame: opts.counting.frame ? { source: 'last-sampled-current-screen', ...clip(opts.counting.frame.text, 65_536),
        rawEnd: opts.counting.frame.rawEnd, observedAtMs: opts.counting.frame.observedAtMs,
        questionSince: opts.counting.frame.questionSince, viewportInputSince: opts.counting.frame.viewportInputSince } : null,
      nativeObserved: state !== null, permissionRequestCapture: state?.permissionRequestCapture ?? null,
      permissionToolCount: state?.permissionTools.length ?? null,
      permissionTools: state?.permissionTools.slice(-16).map(tool => ({ id: clip(tool.id, 256), name: clip(tool.name, 256),
        cwd: typeof tool.cwd === 'string' ? clip(tool.cwd, 4096) : null, input: safeInput(tool.name, tool.input) })) ?? [],
      permissionRequestCount: state?.permissionRequests.length ?? null,
      permissionRequests: state?.permissionRequests.slice(-16).map(request => ({ requestId: clip(request.requestId, 256),
        nativeToolId: request.nativeToolId?.slice(0, 256) ?? null, name: request.name, result: request.result,
        capturedAtMs: request.capturedAtMs, cwd: clip(request.cwd, 4096), input: safeInput(request.name, request.input) })) ?? [],
      bashEvidence: {
        candidateCount: bashCandidateIds.length, candidatesOmitted: Math.max(0, bashCandidateIds.length - 16),
        chronology: 'Later owned diagnostic reads; no grant or outcome credit. Pending IDs first, then latest native resolution and invocation observations. Background resolution is not command completion.',
        permissionRequestCount: selectedBashRequests.length, permissionRequestsOmitted: Math.max(0, selectedBashRequests.length - 16),
        permissionRequests: selectedBashRequests.slice(-16).map(event => ({ requestId: clip(event.requestId, 256),
          capturedAtMs: event.capturedAtMs, cwd: clip(event.cwd, 4096), inputJson: clip(JSON.stringify(event.input), 65_536) })),
        invocations: bashInvocations.filter(event => bashIds.has(event.id)).map(event => ({ id: clip(event.id, 256),
          capturedAtMs: event.capturedAtMs, cwd: clip(event.cwd, 4096), inputJson: clip(JSON.stringify(event.input), 65_536) })),
        resolutions: bashCompletions.filter(event => bashIds.has(event.id)).map(event => ({ id: clip(event.id, 256),
          hookEventName: event.hookEventName, capturedAtMs: event.capturedAtMs, cwd: clip(event.cwd, 4096),
          inputJson: clip(JSON.stringify(event.input), 65_536), responseJson: clip(JSON.stringify(event.response), 65_536) })),
        hookReadError,
      },
      questionEvidence: {
        count: observedPending.length, omitted: Math.max(0, observedPending.length - 16),
        candidateCount: candidateIds.length, candidatesOmitted: Math.max(0, candidateIds.length - 16),
        chronology: 'Earlier counting snapshot; later owned transcript and hook reads are not atomic. Pending IDs have priority, then latest completion observations, latest native AUQs, and remaining hooks. Completion observations do not grant diagnostic answer credit; hook order is not execution order.',
        observed: observedPending.filter(call => questionIds.has(call.id)).map(call => ({ id: clip(call.id, 256),
          observedResult: call.result, questionsJson: clip(JSON.stringify(call.questions), 65_536),
          resultAtRetention: results.has(call.id) ? results.get(call.id) ? 'error' : 'completed'
            : nativeQuestions.some(nativeCall => nativeCall.id === call.id) ? 'pending' : 'absent' })),
        hookEvents: hookQuestions.filter(event => questionIds.has(event.id)).map(event => ({ id: clip(event.id, 256),
          toolName: event.toolName, cwd: clip(event.cwd, 4096), inputJson: clip(JSON.stringify(event.input), 65_536) })),
        hookCompletionEvents: hookCompletions.filter(event => questionIds.has(event.id)).map(event => ({ id: clip(event.id, 256),
          toolName: event.toolName, capturedAtMs: event.capturedAtMs, cwd: clip(event.cwd, 4096),
          inputJson: clip(JSON.stringify(event.input), 65_536), responseJson: clip(JSON.stringify(event.response), 65_536) })),
        hookReadError,
        nativeBlocks: { count: questionBlocks.length, omitted: Math.max(0, questionBlocks.length - 32), rows: questionBlocks.slice(-32) },
      },
      queueOperations: { count: queue.length, omitted: Math.max(0, queue.length - 16), rows: queue.slice(-16).map(({ row, index }) => ({
        rowIndex: index, operation: typeof row.operation === 'string' ? clip(row.operation, 64) : signature(row.operation),
        content: signature(row.content), uuid: typeof row.uuid === 'string' ? clip(row.uuid, 256) : null,
        timestamp: typeof row.timestamp === 'string' ? clip(row.timestamp, 256) : null,
      })) },
    } : undefined;
    const record = {
      schemaVersion: 1, sessionId: opts.sessionId, capturedAt: new Date().toISOString(),
      nativeFile: native.file, completedLines: native.completedLines, pendingBytes: native.pendingBytes,
      observation: clip(JSON.stringify(opts.observation)),
      calls: calls.slice(-16).map(call => ({ id: clip(call.id, 256), name: clip(call.name, 256),
        timestamp: clip(String(call.timestamp), 256),
        ...(counting ? { input: safeInput(call.name, call.input), cwd: typeof call.cwd === 'string' ? clip(call.cwd, 4096) : null } : { inputJson: clip(JSON.stringify(call.input)) }),
        result: results.has(call.id) ? results.get(call.id) ? 'error' : 'completed' : 'pending' })),
      callCount: calls.length, callsOmitted: Math.max(0, calls.length - 16),
      pendingIds: pending.slice(-64).map(call => clip(call.id, 256)),
      pendingCount: pending.length, pendingIdsOmitted: Math.max(0, pending.length - 64),
      rawTail: { ...(counting ? signature(raw.slice(-65_536)) : clip(raw.slice(-65_536), 65_536)), omittedPrefixCodeUnits: Math.max(0, raw.length - 65_536) }, rawCodeUnits: raw.length,
      visibleTail: { ...(counting ? signature(visible.slice(-65_536)) : clip(visible.slice(-65_536), 65_536)), omittedPrefixCodeUnits: Math.max(0, visible.length - 65_536) }, visibleCodeUnits: visible.length,
      ...(counting ? { counting } : {}),
      limits: counting ? 'Diagnostic only. Selected owned AUQ/Bash hook inputs/results and the last sampled decoded viewport are retained with explicit clipping. The viewport keeps its own observation/input epochs; it is not resampled at retention or proof of current ownership. Other native inputs, queue content and raw/flattened history stay hashed. Native thinking and unrelated/foreign results are omitted. Later evidence cannot change the observation, grant input or establish completion.' : 'Diagnostic only. Pending tools are not proof of a permission prompt or a failed command. Native thinking, signatures and tool results are omitted; clipped command inputs remain incomplete evidence.',
    };
    const evalDir = opts.evalDir ?? process.env.GSTACK_EVAL_DIR;
    if (!evalDir) throw new Error('GSTACK_EVAL_DIR is not configured');
    const category = counting ? 'plan-counting' : 'autoplan-chain';
    const directory = path.join(evalDir, category);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${opts.sessionId}.json`);
    const serialized = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 8_388_608) throw new Error('Autoplan diagnostic exceeds its 8 MiB bound');
    fs.writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
    console.error(`[${category}] failure diagnostic: ${file}`);
    return file;
  } catch (error) {
    try { console.error(`Autoplan failure diagnostic could not be retained: ${String(error).slice(0, 1024)}`); } catch { /* preserve the original outcome */ }
    return null;
  }
}

function announcedAutoplanPhases(text: string): number[] {
  const phases: number[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(?:> ?)?(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const announcement = line.match(/^ {0,3}(?:> ?)?(?:\*\*)?Phase +(\d+(?:\.\d+)?) +complete\.(?:\*\*)?(?:\s|$)/);
    if (announcement) phases.push(Number(announcement[1]));
  }
  return phases;
}

/** Read only the UUID pinned at launch, directly below a project directory.
 * Tool payloads, user messages, and sidechain responses cannot announce phases.
 */
export function readAutoplanTranscript(configDir: string | null, sessionId: string): AutoplanTranscriptObservation {
  const { file, rows, completedLines, pendingBytes } = readOwnedClaudeTranscript(configDir, sessionId);
  const phases: number[] = [];
  for (const row of rows) {
    if (row.type !== 'assistant' || row.message?.role !== 'assistant') continue;
    if (!Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const phase of announcedAutoplanPhases(block.text)) {
        if (!phases.includes(phase)) phases.push(phase);
      }
    }
  }
  return { file, phases, completedLines, pendingBytes };
}

/** Assistant order is authoritative; rendered previews cannot establish order.
 * Match its prefix in the PTY stream, ignoring unrelated earlier tool previews.
 */
export function corroboratedAutoplanPhases(assistantPhases: readonly number[], visible: string): number[] {
  let count = 0;
  for (const phase of observedAutoplanPhases(visible)) {
    if (phase === assistantPhases[count]) count++;
  }
  return assistantPhases.slice(0, count);
}

/** Validate first-observed completion markers in stream order. Poll timestamps
 * cannot establish order: several phases may first appear in the same batch.
 */
export function validateAutoplanPhaseOrder(phases: readonly number[]): void {
  const observed = phases.join(' -> ') || '(none)';
  if (!phases.includes(1) || !phases.includes(3)) {
    throw new Error(`Autoplan requires CEO (1) and Eng (3) completion; observed: ${observed}`);
  }
  if (phases.at(-1) !== 3) {
    throw new Error(`Autoplan Eng (3) must complete last; observed: ${observed}`);
  }
  const expected = [1, 2, 2.5, 3];
  let previous = -1;
  for (const phase of phases) {
    const position = expected.indexOf(phase);
    if (position <= previous) {
      throw new Error(`Autoplan completion order must be CEO (1), optional Design (2), optional DX (2.5), Eng (3); observed: ${observed}`);
    }
    previous = position;
  }
}
