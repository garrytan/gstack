#!/usr/bin/env bun
/** A native parent publication barrier at Autoplan's exact Read boundaries. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { extractImplementationPlan, checkPhaseImplementation, acceptedBlocks } from '../../bin/gstack-autoplan-snapshot';
import { autoplanPhaseCompletions } from '../../lib/autoplan-phase-publication';
import { readOwnedClaudePublicTranscript, type ClaudeParentPublicEvent } from '../../lib/claude-public-transcript';

const PHASES = ['ceo', 'design', 'dx', 'eng', 'tasks'] as const;
type Phase = typeof PHASES[number];
type Event = ClaudeParentPublicEvent;
type Use = Event & { kind: 'use' };
const number: Record<Phase, number> = { ceo: 1, design: 2, dx: 2.5, eng: 3, tasks: 4 };
const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const ownPath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
class BoundaryError extends Error {}
const fail = (reason: string): never => { throw new BoundaryError(reason); };
export interface PublicationHookInput {
  hook_event_name: 'PreToolUse'; session_id: string; transcript_path: string; cwd: string;
  tool_name: string; tool_use_id: string; tool_input: Record<string, unknown>; agent_id?: string | null;
}
export type PublicationDecision = { allow: true } | { allow: false; reason: string };
interface Invocation { activePlan: string; restorePath: string; originalSha256: string; start: number }

/** Stable, bounded regular bytes; links never establish an artifact identity. */
function read(file: string, immutable = false): string {
  if (!ownPath(file) || fs.realpathSync(file) !== file) fail('Artifact path is unavailable or aliased.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 32n * 1024n * 1024n ||
        (immutable && process.platform !== 'win32' && (before.mode & 0o222n) !== 0n)) fail('Artifact is not immutable bounded data.');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.size !== current.size ||
        before.mtimeNs !== current.mtimeNs || before.size !== BigInt(bytes.length)) fail('Artifact changed during read.');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('Artifact is not complete UTF-8.');
    return text;
  } finally { fs.closeSync(fd); }
}

function phaseName(file: unknown, cwd: string): Phase | undefined {
  if (typeof file !== 'string') return;
  const requested = path.resolve(cwd, file);
  const name = /^((?:ceo|design|dx|eng)-phase|tasks-aggregator)\.md$/.exec(path.basename(requested));
  if (!name || path.basename(path.dirname(requested)) !== 'sections' ||
      path.basename(path.dirname(path.dirname(requested))) !== 'autoplan') return;
  return (name[1] === 'tasks-aggregator' ? 'tasks' : name[1]!.split('-')[0]) as Phase;
}

function driver(file: unknown, cwd: string, root: string): Phase | undefined {
  const phase = phaseName(file, cwd);
  if (!phase) return;
  const requested = path.resolve(cwd, file as string);
  const canonical = path.join(root, 'autoplan', 'sections', path.basename(requested));
  if (fs.realpathSync(requested) !== canonical || fs.realpathSync(canonical) !== canonical)
    fail('Autoplan phase entry belongs to a different or unavailable installation. Restore this invocation’s hook installation before retrying.');
  return phase;
}

interface Consumer { phase: Phase; content?: string; kind: 'Read' | 'Agent' }
function artifactName(file: unknown, cwd: string, includeClose = false): Phase | undefined {
  if (typeof file !== 'string') return;
  const requested = path.resolve(cwd, file), base = path.basename(requested);
  const match = /^autoplan-(ceo|design|dx|eng)-.+$/.exec(path.basename(path.dirname(requested)));
  if (!match || !['methodology.md', 'methodology.json', 'native-prompt.md', 'snapshot.json',
    'source-implementation.md', `${match[1]}-implementation.md`, ...(includeClose ? ['close-packet.md'] : [])].includes(base)) return;
  return match[1] as Phase;
}
function candidate(use: { name?: string; input?: Record<string, unknown> }, cwd: string): boolean {
  return use.name === 'Read' ? !!(phaseName(use.input?.file_path, cwd) || artifactName(use.input?.file_path, cwd)) :
    use.name === 'Agent' && typeof use.input?.prompt === 'string' &&
      /^You are the independent (CEO|DESIGN|DX|ENG) reviewer for this phase\.\n/.test(use.input.prompt);
}
function methodology(file: string, phase: Phase, init: Invocation) {
  const directory = path.dirname(file);
  if (path.basename(file) !== 'methodology.md' || path.dirname(directory) !== path.dirname(init.restorePath) ||
      !path.basename(directory).startsWith(`autoplan-${phase}-methodology-`)) fail('Methodology belongs to a different invocation.');
  const content = read(file, true), manifestBytes = read(path.join(directory, 'methodology.json'), true);
  const manifest = JSON.parse(manifestBytes);
  if (!object(manifest) || manifest.phase !== phase || manifest.restorePath !== init.restorePath ||
      manifest.restoreSha256 !== init.originalSha256 || manifest.methodologyPath !== file ||
      manifest.sha256 !== hash(content) || manifest.bytes !== Buffer.byteLength(content) ||
      manifest.lines !== content.split('\n').length) fail('Methodology identity does not match this invocation.');
  return { content, manifest, manifestBytes };
}
function snapshot(directory: string, phase: Phase, init: Invocation) {
  if (path.dirname(directory) !== path.dirname(init.restorePath) ||
      !path.basename(directory).startsWith(`autoplan-${phase}-`)) fail('Native phase snapshot belongs to a different invocation.');
  const manifest = JSON.parse(read(path.join(directory, 'snapshot.json'), true));
  if (!object(manifest) || manifest.schemaVersion !== 2 || manifest.phase !== phase || manifest.activePlan !== init.activePlan ||
      manifest.snapshotPath !== path.join(directory, `${phase}-implementation.md`) ||
      manifest.sourceSnapshotPath !== path.join(directory, 'source-implementation.md') ||
      manifest.nativePromptPath !== path.join(directory, 'native-prompt.md') || !object(manifest.methodology))
    fail('Native phase snapshot does not match this active plan.');
  const implementation = read(manifest.snapshotPath, true), source = read(manifest.sourceSnapshotPath, true);
  const native = read(manifest.nativePromptPath, true), m = methodology(manifest.methodology.methodologyPath, phase, init);
  if (manifest.sha256 !== hash(implementation) || manifest.sourceSha256 !== hash(source) ||
      manifest.sourceBytes !== Buffer.byteLength(source) || manifest.nativePromptSha256 !== hash(native) ||
      manifest.nativePromptBytes !== Buffer.byteLength(native) || manifest.nativePromptLines !== native.split('\n').length ||
      manifest.methodology.manifestSha256 !== hash(m.manifestBytes) || manifest.methodology.sha256 !== hash(m.content) ||
      manifest.methodology.bytes !== Buffer.byteLength(m.content) || manifest.methodology.lines !== m.content.split('\n').length)
    fail('Native phase snapshot bytes are unavailable or changed.');
  return manifest;
}
function consumption(use: { name?: string; input?: Record<string, unknown> }, cwd: string, root: string,
  init: Invocation, includeClose = false): Consumer | undefined {
  if (use.name === 'Read') {
    const direct = driver(use.input?.file_path, cwd, root);
    if (direct) return { phase: direct, kind: 'Read', content: read(fs.realpathSync(path.resolve(cwd, use.input!.file_path as string))) };
    const phase = artifactName(use.input?.file_path, cwd, includeClose);
    if (!phase) return;
    const file = path.resolve(cwd, use.input!.file_path as string), base = path.basename(file);
    if (base === 'methodology.md' || base === 'methodology.json') {
      const m = methodology(path.join(path.dirname(file), 'methodology.md'), phase, init);
      return { phase, kind: 'Read', content: base === 'methodology.md' ? m.content : m.manifestBytes };
    }
    snapshot(path.dirname(file), phase, init);
    if (base === 'close-packet.md') closePacket(file, phase, init, false);
    return { phase, kind: 'Read', content: read(file, true) };
  }
  if (use.name !== 'Agent' || typeof use.input?.prompt !== 'string') return;
  const prompt = use.input.prompt, phase = /^You are the independent (CEO|DESIGN|DX|ENG) reviewer for this phase\.\n/.exec(prompt)?.[1]?.toLowerCase() as Phase | undefined;
  if (!phase) return;
  const file = JSON.parse(/^Read file: ("[^\n]+")$/m.exec(prompt)?.[1] ?? 'null');
  if (!ownPath(file) || path.basename(file) !== 'native-prompt.md') fail('Native phase dispatch is not bound to its immutable input.');
  const manifest = snapshot(path.dirname(file), phase, init);
  if (manifest.nativePromptPath !== file || manifest.nativeDispatchPrompt !== prompt)
    fail('Native phase dispatch differs from its exact immutable snapshot.');
  return { phase, kind: 'Agent' };
}

/** The early test detector uses these same artifact checks, with its owned public events. */
export function boundAutoplanPhaseConsumption(events: Event[], use: Use, cwd: string, root: string): Consumer | undefined {
  if (!candidate(use, cwd)) return;
  return consumption(use, cwd, root, invocation(events.filter(e => e.order < use.order), root));
}

function textResult(event: Event): string | undefined {
  if (event.kind !== 'result' || event.isError !== false) return;
  if (typeof event.content === 'string') return event.content;
  if (Array.isArray(event.content) && event.content.length === 1 && event.content[0]?.type === 'text' &&
      typeof event.content[0].text === 'string') return event.content[0].text;
}

/** Authenticate the existing direct-create result; this does not prove its shell command's origin. */
function checkpointResult(result: Event, entered: Event[], init: Invocation): { phase: Phase; path: string } | undefined {
  const use = entered.find(e => e.kind === 'use' && e.toolUseId === result.toolUseId);
  if (result.kind !== 'result' || use?.name !== 'Bash' || use.order >= result.order) return;
  const text = textResult(result);
  if (text === undefined) return;
  const output = JSON.parse(text);
  if (!object(output) || !['ceo', 'design', 'dx', 'eng'].includes(output.phase) ||
      !ownPath(output.snapshotPath) || typeof output.nativePrompt !== 'string' || !object(output.baselineEdits)) return;
  const { nativePrompt, baselineEdits, ...identity } = output;
  const manifest = snapshot(path.dirname(output.snapshotPath), output.phase, init);
  if (!isDeepStrictEqual(identity, manifest) || nativePrompt !== read(manifest.nativePromptPath, true) ||
      baselineEdits.record !== `<!-- autoplan-baseline-edits:${output.phase} ${JSON.stringify({ sourceSha256: manifest.sourceSha256, replacements: [] })} -->` ||
      typeof baselineEdits.instructions !== 'string') return;
  return { phase: output.phase, path: output.snapshotPath };
}

/** Only the documented literal init argv, optionally after literal cd. No shell evaluation. */
function initArguments(command: unknown, root: string): string[] | undefined {
  if (typeof command !== 'string') return;
  const literal = String.raw`(?:"[^"\n\r$\x60\\]*"|'[^'\n\r]*'|[^\s"'\\$\x60;&|<>]+)`;
  const normalized = command.replace(/\\\r?\n/g, ' ');
  const match = new RegExp(String.raw`^\s*(?:cd\s+${literal}\s*(?:\n|&&)\s*)?(?:bun|${literal}/bun)\s+(${literal})\s+init\s+(${literal})\s+(${literal})\s+(${literal})\s*$`).exec(normalized);
  if (!match) return;
  const args = match.slice(1).map(x => /^["']/.test(x!) ? x!.slice(1, -1) : x!);
  if (!args.every(ownPath) || fs.realpathSync(args[0]!) !== path.join(root, 'bin', 'gstack-autoplan-snapshot.ts')) return;
  return args.slice(1);
}

function invocation(events: Event[], root: string): Invocation {
  let bound: Invocation | undefined;
  let chosen: Record<string, any> | undefined;
  for (const use of events) {
    if (use.kind !== 'use' || use.name !== 'Bash') continue;
    const args = initArguments(use.input?.command, root);
    if (!args) continue;
    const results = events.filter(x => x.kind === 'result' && x.toolUseId === use.toolUseId && x.order > use.order);
    if (results.length !== 1) fail('Autoplan initialization acknowledgment is unavailable or ambiguous.');
    const text = textResult(results[0]!);
    if (text === undefined) fail('Autoplan initialization did not succeed. Complete the existing init step first.');
    const result = JSON.parse(text);
    if (!object(result) || result.sourcePlan !== fs.realpathSync(args[0]!) || result.activePlan !== args[1] ||
        result.restorePath !== args[2] || typeof result.reused !== 'boolean' || !positive(result.originalBytes) ||
        !/^[a-f0-9]{64}$/.test(result.originalSha256)) fail('Autoplan initialization does not match the successful native request.');
    if (result.reused && bound?.activePlan === result.activePlan && bound.restorePath === result.restorePath) continue;
    chosen = result;
    bound = { activePlan: result.activePlan, restorePath: result.restorePath,
      originalSha256: result.originalSha256, start: results[0]!.order };
  }
  if (!chosen || !bound) fail('Autoplan invocation evidence is unavailable. Complete the existing snapshot init step before phase entry.');
  const restore = read(bound.restorePath, true), active = read(bound.activePlan);
  const reference = JSON.stringify(bound.restorePath).replace(/--/g, '\\u002d\\u002d');
  if (hash(restore) !== bound.originalSha256 || Buffer.byteLength(restore) !== chosen.originalBytes ||
      !active.startsWith(`<!-- /autoplan restore point: ${reference} -->\n`) || bound.activePlan === bound.restorePath)
    fail('Autoplan initialization artifacts do not match this parent invocation.');
  return bound;
}

/** A cache ACK reuses only an earlier native range whose bytes are still exact. */
export function autoplanReadRange(use: Use, result: Event, content: string, history: Event[] = []): { start: number; end: number } | undefined {
  while (true) {
    if (use.name !== 'Read' || result.kind !== 'result' || result.toolUseId !== use.toolUseId ||
        result.sessionId !== use.sessionId || result.isError !== false || result.order <= use.order || !object(result.file)) return;
    if (textResult(result) !== 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.' ||
        !isDeepStrictEqual(result.file, { filePath: use.input?.file_path })) break;
    // Pinned native dedup requires the same offset/limit and a non-truncated prior
    // Read. Seeded-context notices without that native delivery supply no range.
    const prior = history.filter((e): e is Use => e.kind === 'use' && e.name === 'Read' &&
      e.sessionId === use.sessionId && e.order < use.order && e.input?.file_path === use.input?.file_path).at(-1);
    if (!prior || (prior.input?.offset ?? 1) !== (use.input?.offset ?? 1) || prior.input?.limit !== use.input?.limit) return;
    const sameRecord = (a: Event, b: Event) => isDeepStrictEqual({ ...a, order: 0 }, { ...b, order: 0 });
    const uses = history.filter((e): e is Use => e.kind === 'use' && e.sessionId === prior.sessionId && e.toolUseId === prior.toolUseId);
    const replies = history.filter(e => e.kind === 'result' && e.sessionId === prior.sessionId && e.toolUseId === prior.toolUseId);
    // The detector permits identical replayed records; conflicting native use
    // or result payloads never establish a cache witness. The guard stays stricter.
    if (uses.some(e => !sameRecord(e, prior)) || !replies.length || replies.some(e => !sameRecord(e, replies[0]!)) ||
        replies[0]!.order >= use.order) return;
    use = uses[0]!; result = replies[0]!;
  }
  const f = result.file, lines = content.split('\n');
  if (f.filePath !== use.input?.file_path || typeof f.content !== 'string' || !positive(f.startLine) || !positive(f.numLines) ||
      f.totalLines !== lines.length || f.startLine + f.numLines - 1 > lines.length || (use.input?.offset ?? 1) !== f.startLine ||
      (use.input?.limit !== undefined && (!positive(use.input.limit) || f.numLines > use.input.limit)) ||
      f.content !== lines.slice(f.startLine - 1, f.startLine - 1 + f.numLines).join('\n')) return;
  return { start: f.startLine, end: f.startLine + f.numLines - 1 };
}

function closePacket(file: string, phase: Phase, init: Invocation, current = true): string {
  const directory = path.dirname(file), stateRoot = path.dirname(init.restorePath);
  if (path.basename(file) !== 'close-packet.md' || path.dirname(directory) !== stateRoot ||
      !path.basename(directory).startsWith(`autoplan-${phase}-`)) fail('Close packet does not belong to the current phase.');
  const content = read(file, true), binding = JSON.parse(/^Binding: (.+)$/m.exec(content)?.[1] ?? 'null');
  const snapshot = JSON.parse(read(path.join(directory, 'snapshot.json'), true));
  if (!object(binding) || binding.phase !== phase || binding.activePlan !== init.activePlan ||
      binding.reviewInputPath !== path.join(directory, `${phase}-implementation.md`) ||
      binding.report?.number !== String(number[phase]) || snapshot.schemaVersion !== 2 || snapshot.phase !== phase ||
      snapshot.activePlan !== init.activePlan || snapshot.snapshotPath !== binding.reviewInputPath ||
      snapshot.sha256 !== binding.reviewInputSha256 || snapshot.sourceSha256 !== binding.sourceSha256 ||
      hash(read(binding.reviewInputPath, true)) !== binding.reviewInputSha256 ||
      snapshot.sourceSnapshotPath !== path.join(directory, 'source-implementation.md') ||
      hash(read(snapshot.sourceSnapshotPath, true)) !== binding.sourceSha256 ||
      (current && hash(extractImplementationPlan(read(init.activePlan))) !== binding.sourceSha256))
    fail('Close packet no longer matches the current phase input. Finish the existing close procedure with a fresh packet.');
  const checkpoint = binding.checkpointPath;
  if (!ownPath(checkpoint) || path.dirname(path.dirname(checkpoint)) !== stateRoot ||
      !path.basename(path.dirname(checkpoint)).startsWith(`autoplan-${phase}-`) || path.basename(checkpoint) !== `${phase}-implementation.md`)
    fail('Close checkpoint is foreign.');
  const prior = JSON.parse(read(path.join(path.dirname(checkpoint), 'snapshot.json'), true));
  if (prior.phase !== phase || prior.activePlan !== init.activePlan || prior.snapshotPath !== checkpoint ||
      prior.sha256 !== hash(read(checkpoint, true))) fail('Close checkpoint identity is unavailable.');
  const methodology = snapshot.methodology;
  if (!object(methodology) || !ownPath(methodology.methodologyPath) ||
      path.dirname(path.dirname(methodology.methodologyPath)) !== stateRoot ||
      !path.basename(path.dirname(methodology.methodologyPath)).startsWith(`autoplan-${phase}-`)) fail('Close methodology is foreign.');
  const manifestBytes = read(path.join(path.dirname(methodology.methodologyPath), 'methodology.json'), true);
  const manifest = JSON.parse(manifestBytes);
  if (hash(manifestBytes) !== methodology.manifestSha256 || manifest.phase !== phase ||
      manifest.restorePath !== init.restorePath || manifest.restoreSha256 !== init.originalSha256 ||
      manifest.methodologyPath !== methodology.methodologyPath || manifest.sha256 !== methodology.sha256 ||
      hash(read(methodology.methodologyPath, true)) !== methodology.sha256) fail('Close methodology belongs to a different invocation.');
  if (current) checkPhaseImplementation(phase, init.activePlan, checkpoint,
    prior.sourceSha256 === binding.sourceSha256 ? 'unchanged' : 'changed');
  return content;
}

/** A skill hook survives end_turn; unrelated human intervals are never phase evidence. */
function disarmed(events: Event[], root: string): boolean {
  const human = events.filter(e => e.kind === 'user_turn').at(-1);
  return !!human && !human.autoplan && events.some(e => e.kind === 'end_turn' && e.order < human.order) &&
    !events.some(e => e.kind === 'use' && e.name === 'Bash' && e.order > human.order && initArguments(e.input?.command, root));
}

/** Only exact reversible successful Edits can establish a report-only change. */
function verifyCloseEdits(events: Event[], closeOrder: number, init: Invocation): void {
  const edits = events.filter((e): e is Use => e.kind === 'use' && e.order > closeOrder &&
    ['Write', 'Edit'].includes(e.name ?? '') && e.input?.file_path === init.activePlan);
  if (!edits.length) return;
  const current = read(init.activePlan);
  let prior = current;
  for (const use of edits.toReversed()) {
    const results = events.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
    if (results.length !== 1) fail('An active-plan mutation is pending after the close Read. Wait for its result, then verify the current close input.');
    if (results[0]!.isError === true) continue;
    const input = use.input;
    if (results[0]!.isError !== false || use.name !== 'Edit' || !object(input) ||
        typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string' ||
        !input.new_string || (input.replace_all !== undefined && input.replace_all !== false))
      fail('Post-close mutation history cannot be reconstructed exactly. Repeat the existing close procedure.');
    const at = prior.indexOf(input.new_string);
    if (at < 0 || prior.indexOf(input.new_string, at + input.new_string.length) !== -1)
      fail('Post-close Edit history is ambiguous or incomplete. Repeat the existing close procedure.');
    const before = prior.slice(0, at) + input.old_string + prior.slice(at + input.new_string.length);
    if (before.indexOf(input.old_string) !== at || before.indexOf(input.old_string, at + input.old_string.length) !== -1)
      fail('Post-close Edit history does not match its unique native old_string. Repeat the existing close procedure.');
    prior = before;
  }
  const requirements = (plan: string) => {
    const implementation = extractImplementationPlan(plan), at = plan.indexOf(implementation);
    if (at < 0 || plan.indexOf(implementation, at + implementation.length) !== -1)
      fail('Review-record position is ambiguous. Repeat the existing close procedure.');
    return [...acceptedBlocks(plan.slice(at + implementation.length))].map(([phase, block]) => [phase, block.raw]);
  };
  if (extractImplementationPlan(prior) !== extractImplementationPlan(current) ||
      !isDeepStrictEqual(requirements(prior), requirements(current)))
    fail('Implementation or accepted requirements changed after the close Read. Repeat the existing close procedure.');
}

function requirePublication(phase: Phase, entryOrder: number, entered: Event[], init: Invocation, current: boolean, checkpoint?: string): void {
  const closeReads = entered.filter((e): e is Use => e.kind === 'use' && e.name === 'Read' && e.order >= entryOrder &&
    ownPath(e.input?.file_path) && path.basename(e.input.file_path) === 'close-packet.md' &&
    path.dirname(path.dirname(e.input.file_path)) === path.dirname(init.restorePath) &&
    path.basename(path.dirname(e.input.file_path)).startsWith(`autoplan-${phase}-`));
  if (!closeReads.length) fail(`Finish the existing Phase ${number[phase]} close procedure and Read its complete current close packet before entering the next phase.`);
  const latestPath = closeReads.at(-1)!.input!.file_path as string;
  const content = closePacket(latestPath, phase, init, current), covered = new Set<number>();
  if (checkpoint && JSON.parse(/^Binding: (.+)$/m.exec(content)![1]!).checkpointPath !== checkpoint)
    fail(`The Phase ${number[phase]} close packet belongs to an earlier checkpoint. Complete the current phase's close procedure with its fixed checkpoint.`);
  let closeOrder = -1;
  for (const use of closeReads.filter(e => e.input?.file_path === latestPath)) {
    const results = entered.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
    if (results.length !== 1) continue;
    const range = autoplanReadRange(use, results[0]!, content, entered);
    if (!range) continue;
    for (let line = range.start; line <= range.end; line++) covered.add(line);
    closeOrder = Math.max(closeOrder, results[0]!.order);
  }
  if (covered.size !== content.split('\n').length) fail(`Read every line of the current Phase ${number[phase]} close packet successfully before entering the next phase.`);
  const pending = entered.some(e => e.kind === 'use' && e.order > closeOrder && ['Write', 'Edit'].includes(e.name ?? '') &&
    e.input?.file_path === init.activePlan && !entered.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId));
  if (pending) fail('An active-plan mutation is pending after the close Read. Wait for its result, then verify the current close input.');
  if (current) verifyCloseEdits(entered, closeOrder, init);
  const messages = entered.filter((e): e is Event & { kind: 'message' } => e.kind === 'message' && e.order > closeOrder);
  const hits = autoplanPhaseCompletions({ status: 'ready', calls: [], assistantMessages: messages }, 0);
  if (!hits.some(hit => hit.phase === number[phase])) fail(`Publish the filled Phase ${number[phase]} report as your own parent assistant text now, then retry the same phase-entry tool. The close packet or a saved report does not publish it.`);
}

/** Ordered public events only. This does not judge review content or create a report. */
export function evaluateAutoplanPublication(input: PublicationHookInput, root: string, events: Event[]): PublicationDecision {
  return evaluatePublication(input, root, events, false);
}

function evaluatePublication(input: PublicationHookInput, root: string, events: Event[], pendingRead: boolean): PublicationDecision {
  try {
    const requested = { name: input.tool_name, input: input.tool_input };
    if (!candidate(requested, input.cwd) || input.agent_id) return { allow: true };
    if (!events.length || events.some((e, i) => e.sessionId !== input.session_id || !Number.isSafeInteger(e.order) ||
        (i > 0 && e.order <= events[i - 1]!.order))) fail('Native parent event order is unavailable. Retry this phase-entry tool after the journal is available.');
    const identities = new Set<string>();
    for (const event of events) if (event.kind === 'use' || event.kind === 'result') {
      const identity = `${event.kind}:${event.toolUseId}`;
      if (identities.has(identity)) fail('Native tool identity is ambiguous. Restore the current parent evidence before retrying.');
      identities.add(identity);
    }
    const current = events.filter(e => e.kind === 'use' && e.toolUseId === input.tool_use_id);
    if (pendingRead ? input.tool_name !== 'Read' || events.some(e =>
      (e.kind === 'use' || e.kind === 'result') && e.toolUseId === input.tool_use_id) :
      current.length !== 1 || current[0]!.kind !== 'use' || current[0]!.name !== input.tool_name ||
        !isDeepStrictEqual(current[0]!.input, input.tool_input)) fail('Current native phase-entry identity is unavailable. Retry this phase-entry tool after the journal is available.');
    const before = pendingRead ? events : events.filter(e => e.order < current[0]!.order);
    // Pinned Claude retains skill hooks after end_turn. Only an authenticated
    // later human request can release the old invocation; tool results and
    // compaction never do. A native slash or an actual init re-arms the guard.
    const human = before.filter(e => e.kind === 'user_turn').at(-1);
    if (disarmed(before, root)) {
      if (pendingRead) fail('Current native phase-entry identity is unavailable after this invocation ended.');
      return { allow: true };
    }
    if (human?.autoplan && !before.some(e => e.kind === 'use' && e.name === 'Bash' && e.order > human.order &&
        initArguments(e.input?.command, root))) fail('This Autoplan invocation needs its own successful init before phase entry.');
    const init = invocation(before, root);
    const entered = before.filter(e => e.order > init.start && !disarmed(before.filter(prior => prior.order < e.order), root));
    const target = consumption(requested, input.cwd, root, init)!.phase;
    let phase: Phase | undefined, entryOrder = init.start, checkpoint: string | undefined;
    const seenCheckpoints = new Set<string>(), preparedCheckpoints = new Map<Phase, string>();
    for (const use of entered) {
      if (use.kind === 'result') {
        let created: ReturnType<typeof checkpointResult>;
        try { created = checkpointResult(use, entered, init); } catch { continue; }
        if (!created || seenCheckpoints.has(created.path)) continue;
        seenCheckpoints.add(created.path);
        if (phase && number[created.phase] < number[phase]) {
          // A fresh checkpoint reopens an affected phase after a later phase.
          // Historical Reads and reflected create results do not reopen it.
          phase = created.phase; entryOrder = use.order; checkpoint = created.path;
        } else if (phase === created.phase) {
          // CEO's later voice snapshot does not replace its Step-0 checkpoint.
          checkpoint ??= created.path;
        } else if (!preparedCheckpoints.has(created.phase)) preparedCheckpoints.set(created.phase, created.path);
        continue;
      }
      if (use.kind !== 'use' || !['Read', 'Agent'].includes(use.name ?? '')) continue;
      const results = entered.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
      if (results.length !== 1 || results[0]!.isError !== false || results[0]!.order <= use.order) continue;
      let next: Consumer | undefined;
      try { next = consumption(use, input.cwd, root, init, true); } catch { continue; }
      if (!next || (next.kind === 'Read' && !autoplanReadRange(use, results[0]!, next.content!, before))) continue;
      if (!phase || number[next.phase] > number[phase]) {
        // An unguarded earlier delivery cannot erase its predecessor's missing
        // publication. Recovery still uses that predecessor's existing close.
        if (phase) try { requirePublication(phase, entryOrder, entered.filter(e => e.order < use.order), init, false, checkpoint); }
        catch { continue; }
        phase = next.phase; entryOrder = use.order;
        checkpoint = preparedCheckpoints.get(phase); preparedCheckpoints.delete(phase);
      }
    }
    const pendingEntry = entered.some(e => e.kind === 'use' && candidate(e, input.cwd) &&
      !entered.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId));
    if (pendingEntry) fail('A prior phase-entry tool is still pending. Retry after its native result before requesting another phase.');
    // A streamed tool may reach PreToolUse before its journal record. The
    // native input can revisit a phase already proven by prior owned ACKs;
    // it cannot establish a phase, a publication, or a synthetic current use.
    if (pendingRead && (!phase || number[target] > number[phase]))
      fail('Current native phase-entry identity is required before entering a new phase.');
    if (!phase) {
      if (target !== 'ceo') fail('Read the current Phase 1 CEO entry successfully before entering a later phase.');
      return { allow: true };
    }
    if (number[target] <= number[phase]) return { allow: true };
    requirePublication(phase, entryOrder, entered, init, true, checkpoint);
    return { allow: true };
  } catch (error) {
    return { allow: false, reason: error instanceof BoundaryError
      ? error.message : 'Autoplan phase evidence is unavailable or changed. Restore the current invocation evidence and retry this phase-entry tool.' };
  }
}

export function publicationHookOutput(decision: PublicationDecision): object {
  return decision.allow ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `[autoplan] ${decision.reason}` } };
}

/** Claude's pending tool record can flush after hook entry; wait only for that identity. */
export async function runPublicationHook(value: unknown, root: string): Promise<object> {
  try {
    if (!object(value) || value.hook_event_name !== 'PreToolUse' || typeof value.tool_name !== 'string') fail('Invalid native hook input.');
    if (!['Read', 'Agent'].includes(value.tool_name) || value.agent_id) return {};
    if (!ownPath(value.cwd) || !ownPath(value.transcript_path) || typeof value.session_id !== 'string' ||
        typeof value.tool_use_id !== 'string' || !object(value.tool_input)) fail('Native parent hook identity is unavailable.');
    const input = value as PublicationHookInput;
    if (!candidate({ name: input.tool_name, input: input.tool_input }, input.cwd)) return {};
    // Native hooks override this environment value with the session's project
    // root. Bash cd changes input.cwd, not the journal's original ownership.
    const projectCwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
    if (!ownPath(projectCwd)) fail('Native parent project directory is unavailable.');
    const deadline = performance.now() + 2_000;
    do {
      const snapshot = readOwnedClaudePublicTranscript(input.transcript_path, projectCwd, input.session_id);
      if (snapshot.transcript.status === 'ready') {
        if (snapshot.events.some(e => e.kind === 'use' && e.toolUseId === input.tool_use_id))
          return publicationHookOutput(evaluateAutoplanPublication(input, root, snapshot.events));
        if (input.tool_name === 'Read' && evaluatePublication(input, root, snapshot.events, true).allow)
          return {};
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (performance.now() < deadline);
    fail('Native parent evidence has not reached the journal yet. Retry this phase-entry tool; no missing-publication conclusion has been made.');
  } catch (error) {
    return publicationHookOutput({ allow: false, reason: error instanceof BoundaryError
      ? error.message : 'Hook installation or native evidence is unavailable. Restore this Autoplan installation before retrying.' });
  }
}

if (import.meta.main) {
  let output: object;
  try {
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const bytes = await Bun.stdin.text();
    if (Buffer.byteLength(bytes) > 64 * 1024) fail('Native hook input exceeds its bound.');
    output = await runPublicationHook(JSON.parse(bytes), root);
  } catch { output = publicationHookOutput({ allow: false, reason: 'Publication hook could not load its native input. Restore the hook and retry.' }); }
  process.stdout.write(JSON.stringify(output) + '\n');
}
