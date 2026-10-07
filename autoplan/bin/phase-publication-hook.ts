#!/usr/bin/env bun
/** A native parent publication barrier at Autoplan's exact Read boundaries. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { extractImplementationPlan, checkPhaseImplementation, acceptedBlocks } from '../../bin/gstack-autoplan-snapshot';
import { autoplanPhaseCompletions } from '../../lib/autoplan-phase-publication';
import { readOwnedClaudePublicTranscript, nativePathSpelling, ownedNativePath, sameNativePath,
  type ClaudeParentPublicEvent, transcriptReadLimit } from '../../lib/claude-public-transcript';
import { resolveStateRoot } from '../../lib/state-root';
import { REASONS, reasonCode, reasonText, type Detail, type ReasonCode } from './guard-reasons';
import { logGuardDecision } from './guard-log';

const PHASES = ['ceo', 'design', 'dx', 'eng', 'tasks'] as const;
type Phase = typeof PHASES[number];
type Event = ClaudeParentPublicEvent;
type Use = Event & { kind: 'use' };
type Tool = Extract<Event, { toolUseId: string }>;
type Turn = Extract<Event, { kind: 'end_turn' | 'user_turn' }>;
const isUse = (e: Event): e is Use => e.kind === 'use';
const number: Record<Phase, number> = { ceo: 1, design: 2, dx: 2.5, eng: 3, tasks: 4 };
const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
/** Fold the native spelling first, then require it to be absolute and already normal (`..` stays rejected). */
const ownPath = (value: unknown): value is string => ownedNativePath(value);
/** One native spelling on both sides of every path compare. */
const samePath = (a: unknown, b: unknown): boolean => sameNativePath(a, b);
/** Claude's Read expands a leading ~ before the tool runs; resolve the same file. */
const requestedPath = (cwd: string, file: string) =>
  nativePathSpelling(path.resolve(cwd, file.replace(/^~(?=[\\/]|$)/, () => os.homedir())));
/** Keys Claude Code's schema parse may drop from the journaled raw input (Agent's fork-subagent gate drops run_in_background). */
export const SCHEMA_STRIPPED: Record<string, readonly string[]> = { Agent: ['run_in_background'] };
/** The reviewer dispatch input the guard accepts; snapshot manifests are unchanged by it. */
export const AGENT_KEYS: readonly string[] = ['prompt', 'description', 'subagent_type', 'run_in_background'];
/** The newest Claude Code release the pinned PTY runs and the schema canary have checked. */
export const CHECKED_CLAUDE_CODE = '2.1.292';
/**
 * Claude records the model's raw input in the journal but hands PreToolUse its
 * schema-parsed form: file_path resolved (C:\x/y becomes C:\x\y) and keys the
 * schema lacks dropped. Compare file_path as the file it names, drop only the
 * documented strips; every other field stays exact.
 */
export const nativeToolInput = (input: unknown, cwd: string, tool?: string): unknown => {
  if (!object(input)) return input;
  const out: Record<string, unknown> = { ...input };
  if (typeof out.file_path === 'string') out.file_path = requestedPath(cwd, out.file_path);
  for (const key of SCHEMA_STRIPPED[tool ?? ''] ?? []) delete out[key];
  return out;
};
const versionParts = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
/** True only for a parseable version above the checked release. */
export function newerThanChecked(version: string | undefined): boolean {
  const a = version && versionParts(version), b = versionParts(CHECKED_CLAUDE_CODE)!;
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
class BoundaryError extends Error {
  constructor(readonly code: string, readonly detail: Detail = {}) { super(code); }
}
function fail(code: ReasonCode | `unrecognized_shape:${string}`, detail?: Detail): never { throw new BoundaryError(code, detail); }
export interface PublicationHookInput {
  hook_event_name: 'PreToolUse'; session_id: string; transcript_path: string; cwd: string;
  tool_name: string; tool_use_id: string; tool_input: Record<string, unknown>; agent_id?: string | null;
}
/** What tests and callers see; the hook runner keeps the code and detail. */
export type PublicationDecision = { allow: true; unverified?: string } | { allow: false; reason: string };
type Decision = { allow: true; unverified?: string; detail?: Detail } | { allow: false; reason: string; code: string; detail?: Detail };
const visible = (d: Decision): PublicationDecision =>
  d.allow ? (d.unverified ? { allow: true, unverified: d.unverified } : { allow: true }) : { allow: false, reason: d.reason };
interface Invocation { activePlan: string; restorePath: string; originalSha256: string; start: number }

/** Stable, bounded regular bytes; links never establish an artifact identity. */
function read(file: string, immutable = false): string {
  if (!ownPath(file) || !samePath(fs.realpathSync(file), file)) fail('snapshot', { cause: 'An artifact path is unavailable or aliased' });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 32n * 1024n * 1024n ||
        (immutable && process.platform !== 'win32' && (before.mode & 0o222n) !== 0n)) fail('snapshot', { cause: 'An artifact is not immutable bounded data' });
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.size !== current.size ||
        before.mtimeNs !== current.mtimeNs || before.size !== BigInt(bytes.length)) fail('snapshot', { cause: 'An artifact changed during read' });
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('snapshot', { cause: 'An artifact is not complete UTF-8' });
    return text;
  } finally { fs.closeSync(fd); }
}

function phaseName(file: unknown, cwd: string): Phase | undefined {
  if (typeof file !== 'string') return;
  const requested = requestedPath(cwd, file);
  const name = /^((?:ceo|design|dx|eng)-phase|tasks-aggregator)\.md$/.exec(path.basename(requested));
  if (!name || path.basename(path.dirname(requested)) !== 'sections' ||
      path.basename(path.dirname(path.dirname(requested))) !== 'autoplan') return;
  return (name[1] === 'tasks-aggregator' ? 'tasks' : name[1]!.split('-')[0]) as Phase;
}

function driver(file: unknown, cwd: string, root: string): Phase | undefined {
  const phase = phaseName(file, cwd);
  if (!phase) return;
  const requested = requestedPath(cwd, file as string), base = path.basename(requested);
  const canonical = path.join(root, 'autoplan', 'sections', base), actual = fs.realpathSync(requested);
  if (samePath(fs.realpathSync(canonical), canonical)) {
    if (samePath(actual, canonical)) return phase;
    // setup serves the gbrain :user render (#2569) from exactly one render root,
    // whose section links point back into it. That render is this installation
    // only at its exact path and only with the install's bytes after that rewrite.
    const render = userRenderRoot();
    if (render && samePath(actual, path.join(render, 'autoplan', 'sections', base)) &&
        read(actual) === renderSectionBase(read(canonical), render)) return phase;
  }
  return fail('foreign_install');
}

/** setup's `${GSTACK_USER_RENDER_DIR:-$GSTACK_STATE_ROOT/render/claude}`, realpath'd. */
function userRenderRoot(): string | undefined {
  const configured = process.env.GSTACK_USER_RENDER_DIR || path.join(resolveStateRoot(), 'render', 'claude');
  try { return fs.realpathSync(path.resolve(nativePathSpelling(configured))); } catch { return; }
}

/** scripts/gen-skill-docs.ts rewriteSectionBase, which writes that render. */
function renderSectionBase(content: string, linkRoot: string): string {
  return content.replace(
    /~\/\.claude\/skills\/gstack\/([^\s)`"'*]+\/sections\/)/g,
    (_m, p1: string) => `${linkRoot}/${p1}`,
  );
}

interface Consumer { phase: Phase; content?: string; kind: 'Read' | 'Agent' }
function artifactName(file: unknown, cwd: string, includeClose = false): Phase | undefined {
  if (typeof file !== 'string') return;
  const requested = requestedPath(cwd, file), base = path.basename(requested);
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
      !path.basename(directory).startsWith(`autoplan-${phase}-methodology-`)) fail('snapshot', { cause: 'Methodology belongs to a different invocation' });
  const content = read(file, true), manifestBytes = read(path.join(directory, 'methodology.json'), true);
  const manifest = JSON.parse(manifestBytes);
  if (!object(manifest) || manifest.phase !== phase || manifest.restorePath !== init.restorePath ||
      manifest.restoreSha256 !== init.originalSha256 || manifest.methodologyPath !== file ||
      manifest.sha256 !== hash(content) || manifest.bytes !== Buffer.byteLength(content) ||
      manifest.lines !== content.split('\n').length) fail('snapshot', { cause: 'Methodology identity does not match this invocation' });
  return { content, manifest, manifestBytes };
}
function snapshot(directory: string, phase: Phase, init: Invocation) {
  if (path.dirname(directory) !== path.dirname(init.restorePath) ||
      !path.basename(directory).startsWith(`autoplan-${phase}-`)) fail('snapshot', { cause: 'Native phase snapshot belongs to a different invocation' });
  const manifest = JSON.parse(read(path.join(directory, 'snapshot.json'), true));
  if (!object(manifest) || manifest.schemaVersion !== 2 || manifest.phase !== phase || manifest.activePlan !== init.activePlan ||
      manifest.snapshotPath !== path.join(directory, `${phase}-implementation.md`) ||
      manifest.sourceSnapshotPath !== path.join(directory, 'source-implementation.md') ||
      manifest.nativePromptPath !== path.join(directory, 'native-prompt.md') || !object(manifest.methodology))
    fail('snapshot', { cause: 'Native phase snapshot does not match this active plan' });
  const implementation = read(manifest.snapshotPath, true), source = read(manifest.sourceSnapshotPath, true);
  const native = read(manifest.nativePromptPath, true), m = methodology(manifest.methodology.methodologyPath, phase, init);
  if (manifest.sha256 !== hash(implementation) || manifest.sourceSha256 !== hash(source) ||
      manifest.sourceBytes !== Buffer.byteLength(source) || manifest.nativePromptSha256 !== hash(native) ||
      manifest.nativePromptBytes !== Buffer.byteLength(native) || manifest.nativePromptLines !== native.split('\n').length ||
      manifest.methodology.manifestSha256 !== hash(m.manifestBytes) || manifest.methodology.sha256 !== hash(m.content) ||
      manifest.methodology.bytes !== Buffer.byteLength(m.content) || manifest.methodology.lines !== m.content.split('\n').length)
    fail('snapshot', { cause: 'Native phase snapshot bytes are unavailable or changed' });
  return manifest;
}
function consumption(use: { name?: string; input?: Record<string, unknown> }, cwd: string, root: string,
  init: Invocation, includeClose = false): Consumer | undefined {
  if (use.name === 'Read') {
    const direct = driver(use.input?.file_path, cwd, root);
    if (direct) return { phase: direct, kind: 'Read', content: read(fs.realpathSync(requestedPath(cwd, use.input!.file_path as string))) };
    const phase = artifactName(use.input?.file_path, cwd, includeClose);
    if (!phase) return;
    const file = requestedPath(cwd, use.input!.file_path as string), base = path.basename(file);
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
  const extra = Object.keys(use.input).filter(key => !AGENT_KEYS.includes(key));
  if (use.input.subagent_type !== undefined && use.input.subagent_type !== 'general-purpose') extra.push('subagent_type');
  if (extra.length) fail('agent_key', { keys: extra.sort() });
  const file = JSON.parse(/^Read file: ("[^\n]+")$/m.exec(prompt)?.[1] ?? 'null');
  if (!ownPath(file) || path.basename(file) !== 'native-prompt.md') fail('snapshot', { cause: 'Native phase dispatch is not bound to its immutable input' });
  const manifest = snapshot(path.dirname(file), phase, init);
  if (manifest.nativePromptPath !== file || manifest.nativeDispatchPrompt !== prompt) fail('dispatch_prompt');
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
  if (result.kind !== 'result') return;
  const use = entered.find((e): e is Use => isUse(e) && e.toolUseId === result.toolUseId);
  if (use?.name !== 'Bash' || use.order >= result.order) return;
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
  // Bash keeps backslashes before ordinary characters in double quotes (e.g.
  // a native Windows path); escapes, substitutions and shell operators stay out.
  const literal = String.raw`(?:"(?:[^"\n\r$\x60\\]|\\[^"$\x60\\\n\r])*"|'[^'\n\r]*'|[^\s"'\\$\x60;&|<>]+)`;
  const normalized = command.replace(/\\\r?\n/g, ' ');
  const match = new RegExp(String.raw`^\s*(?:cd\s+${literal}\s*(?:\n|&&)\s*)?(?:bun|${literal}/bun)\s+(${literal})\s+init\s+(${literal})\s+(${literal})\s+(${literal})\s*$`).exec(normalized);
  if (!match) return;
  const args = match.slice(1).map(x => /^["']/.test(x!) ? x!.slice(1, -1) : x!)
    // Git Bash accepts forward slashes and hands native programs /c/x as C:/x.
    // Fold that spelling only; every canonical-path check still applies.
    .map(x => nativePathSpelling(x, path));
  if (!args.every(ownPath) || !samePath(fs.realpathSync(args[0]!), path.join(root, 'bin', 'gstack-autoplan-snapshot.ts'))) return;
  return args.slice(1);
}

/** Diagnostic only, never binds: a Bash call that ran snapshot init in a shape the guard cannot bind (#3045). */
const UNBINDABLE_INIT = /(?:gstack-autoplan-snapshot|SNAPSHOT_TOOL|\$\{?[A-Z_]+\}?"?)\S*\s+init\s/;

function invocation(events: Event[], root: string): Invocation {
  let bound: Invocation | undefined;
  let chosen: Record<string, any> | undefined;
  let unbindable = false;
  for (const use of events) {
    if (use.kind !== 'use' || use.name !== 'Bash') continue;
    const args = initArguments(use.input?.command, root);
    if (!args) { unbindable ||= typeof use.input?.command === 'string' && UNBINDABLE_INIT.test(use.input.command) && /\.md\b/.test(use.input.command); continue; }
    const results = events.filter(x => x.kind === 'result' && x.toolUseId === use.toolUseId && x.order > use.order);
    if (results.length !== 1) fail('init_mismatch');
    const text = textResult(results[0]!);
    if (text === undefined) fail('init_failed');
    const result = JSON.parse(text);
    if (!object(result) || !samePath(result.sourcePlan, fs.realpathSync(args[0]!)) || !samePath(result.activePlan, args[1]) ||
        !samePath(result.restorePath, args[2]) || typeof result.reused !== 'boolean' || !positive(result.originalBytes) ||
        !/^[a-f0-9]{64}$/.test(result.originalSha256)) fail('init_mismatch');
    if (result.reused && bound && bound.activePlan === result.activePlan && bound.restorePath === result.restorePath) continue;
    chosen = result;
    bound = { activePlan: result.activePlan, restorePath: result.restorePath,
      originalSha256: result.originalSha256, start: results[0]!.order };
  }
  if ((!chosen || !bound) && unbindable) fail('init_unbindable');
  if (!chosen || !bound) fail('init_required');
  const restore = read(bound.restorePath, true), active = read(bound.activePlan);
  const reference = JSON.stringify(bound.restorePath).replace(/--/g, '\\u002d\\u002d');
  if (hash(restore) !== bound.originalSha256 || Buffer.byteLength(restore) !== chosen.originalBytes ||
      // Claude's Edit rewrites a CRLF plan's line endings, including init's LF header line.
      !/^\r?\n/.test(active.slice(`<!-- /autoplan restore point: ${reference} -->`.length)) ||
      !active.startsWith(`<!-- /autoplan restore point: ${reference} -->`) || bound.activePlan === bound.restorePath)
    fail('init_mismatch');
  return bound;
}

/** A cache ACK reuses only an earlier native range whose bytes are still exact. */
export function autoplanReadRange(use: Use, result: Event, content: string, history: Event[] = []): { start: number; end: number } | undefined {
  while (true) {
    if (use.name !== 'Read' || result.kind !== 'result' || result.toolUseId !== use.toolUseId ||
        result.sessionId !== use.sessionId || result.isError !== false || result.order <= use.order || !object(result.file)) return;
    if (textResult(result) !== 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.' ||
        !isDeepStrictEqual(Object.keys(result.file), ['filePath']) || !samePath(result.file.filePath, use.input?.file_path)) break;
    // Pinned native dedup requires the same offset/limit and a non-truncated prior
    // Read. Seeded-context notices without that native delivery supply no range.
    const prior = history.filter((e): e is Use => e.kind === 'use' && e.name === 'Read' &&
      e.sessionId === use.sessionId && e.order < use.order && samePath(e.input?.file_path, use.input?.file_path)).at(-1);
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
  if (!samePath(f.filePath, use.input?.file_path) || typeof f.content !== 'string' || !positive(f.startLine) || !positive(f.numLines) ||
      f.totalLines !== lines.length || f.startLine + f.numLines - 1 > lines.length || (use.input?.offset ?? 1) !== f.startLine ||
      (use.input?.limit !== undefined && (!positive(use.input.limit) || f.numLines > use.input.limit)) ||
      // Claude's Read reports a CRLF line without its CR; nothing else may differ.
      f.content.replace(/\r(?=\n|$)/g, '') !==
        lines.slice(f.startLine - 1, f.startLine - 1 + f.numLines).join('\n').replace(/\r(?=\n|$)/g, '')) return;
  return { start: f.startLine, end: f.startLine + f.numLines - 1 };
}

function closePacket(file: string, phase: Phase, init: Invocation, current = true): string {
  const directory = path.dirname(file), stateRoot = path.dirname(init.restorePath);
  if (path.basename(file) !== 'close-packet.md' || path.dirname(directory) !== stateRoot ||
      !path.basename(directory).startsWith(`autoplan-${phase}-`)) fail('close_stale', { cause: 'The close packet does not belong to the current phase' });
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
    fail('close_stale', { cause: 'The close packet no longer matches the current phase input' });
  const checkpoint = binding.checkpointPath;
  if (!ownPath(checkpoint) || path.dirname(path.dirname(checkpoint)) !== stateRoot ||
      !path.basename(path.dirname(checkpoint)).startsWith(`autoplan-${phase}-`) || path.basename(checkpoint) !== `${phase}-implementation.md`)
    fail('close_stale', { cause: 'The close checkpoint is foreign' });
  const prior = JSON.parse(read(path.join(path.dirname(checkpoint), 'snapshot.json'), true));
  if (prior.phase !== phase || prior.activePlan !== init.activePlan || prior.snapshotPath !== checkpoint ||
      prior.sha256 !== hash(read(checkpoint, true))) fail('close_stale', { cause: 'The close checkpoint identity is unavailable' });
  const methodology = snapshot.methodology;
  if (!object(methodology) || !ownPath(methodology.methodologyPath) ||
      path.dirname(path.dirname(methodology.methodologyPath)) !== stateRoot ||
      !path.basename(path.dirname(methodology.methodologyPath)).startsWith(`autoplan-${phase}-`)) fail('close_stale', { cause: 'The close methodology is foreign' });
  const manifestBytes = read(path.join(path.dirname(methodology.methodologyPath), 'methodology.json'), true);
  const manifest = JSON.parse(manifestBytes);
  if (hash(manifestBytes) !== methodology.manifestSha256 || manifest.phase !== phase ||
      manifest.restorePath !== init.restorePath || manifest.restoreSha256 !== init.originalSha256 ||
      manifest.methodologyPath !== methodology.methodologyPath || manifest.sha256 !== methodology.sha256 ||
      hash(read(methodology.methodologyPath, true)) !== methodology.sha256) fail('close_stale', { cause: 'The close methodology belongs to a different invocation' });
  if (current) try { checkPhaseImplementation(phase, init.activePlan, checkpoint,
    prior.sourceSha256 === binding.sourceSha256 ? 'unchanged' : 'changed'); }
  catch (error) { fail('close_edits', { cause: `The current Implementation plan fails its phase check: ${(error as Error).message}` }); }
  return content;
}

/**
 * A skill hook survives end_turn; unrelated human intervals are never phase
 * evidence. One forward pass: entry i says whether the prefix events[0, i) is
 * disarmed, so the last entry answers for the whole list. An end_turn while a
 * reviewer Agent this session launched in the background has no completion
 * notice does not end the invocation, so a typed turn then does not disarm it.
 */
function disarmedAt(events: Event[], root: string): boolean[] {
  const out: boolean[] = [], launched = new Set<string>(), notified = new Set<string>(), reviewers = new Set<string>();
  let endTurn = false, human: Turn | undefined, endBeforeHuman = false, initAfter = false;
  for (const e of events) {
    out.push(!!human && !human.autoplan && endBeforeHuman && !initAfter);
    if (isUse(e) && e.name === 'Agent' && candidate(e, '')) reviewers.add(e.toolUseId);
    else if (e.kind === 'result' && e.async && reviewers.has(e.toolUseId)) launched.add(e.toolUseId);
    else if (e.kind === 'task_notification') notified.add(e.notifiedToolUseId);
    else if (e.kind === 'end_turn' && ![...launched].some(id => !notified.has(id))) endTurn = true;
    else if (e.kind === 'user_turn') { human = e; endBeforeHuman = endTurn; initAfter = false; }
    else if (human && isUse(e) && e.name === 'Bash' && initArguments(e.input?.command, root)) initAfter = true;
  }
  out.push(!!human && !human.autoplan && endBeforeHuman && !initAfter);
  return out;
}

/** Only exact reversible successful Edits can establish a report-only change. */
function verifyCloseEdits(events: Event[], closeOrder: number, init: Invocation): void {
  const edits = events.filter((e): e is Use => e.kind === 'use' && e.order > closeOrder &&
    ['Write', 'Edit'].includes(e.name ?? '') && samePath(e.input?.file_path, init.activePlan));
  if (!edits.length) return;
  const current = read(init.activePlan);
  let prior = current;
  for (const use of edits.toReversed()) {
    const results = events.filter((e): e is Tool => e.kind === 'result' && e.toolUseId === use.toolUseId);
    if (results.length !== 1) fail('mutation_pending');
    if (results[0]!.isError === true) continue;
    const input = use.input;
    if (results[0]!.isError !== false || use.name !== 'Edit' || !object(input) ||
        typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string' ||
        !input.new_string || (input.replace_all !== undefined && input.replace_all !== false))
      fail('close_edits', { cause: 'Post-close mutation history cannot be reconstructed exactly' });
    const at = prior.indexOf(input.new_string);
    if (at < 0 || prior.indexOf(input.new_string, at + input.new_string.length) !== -1)
      fail('close_edits', { cause: 'Post-close Edit history is ambiguous or incomplete' });
    const before = prior.slice(0, at) + input.old_string + prior.slice(at + input.new_string.length);
    if (before.indexOf(input.old_string) !== at || before.indexOf(input.old_string, at + input.old_string.length) !== -1)
      fail('close_edits', { cause: 'Post-close Edit history does not match its unique native old_string' });
    prior = before;
  }
  const requirements = (plan: string) => {
    const implementation = extractImplementationPlan(plan), at = plan.indexOf(implementation);
    if (at < 0 || plan.indexOf(implementation, at + implementation.length) !== -1)
      fail('close_edits', { cause: 'The review-record position is ambiguous' });
    return [...acceptedBlocks(plan.slice(at + implementation.length))].map(([phase, block]) => [phase, block.raw]);
  };
  if (extractImplementationPlan(prior) !== extractImplementationPlan(current) ||
      !isDeepStrictEqual(requirements(prior), requirements(current)))
    fail('close_edits', { cause: 'The Implementation or accepted requirements changed after the close Read' });
}

/** Both messageIds known and equal; a record without one is its own message. */
const sameMessage = (a: Event, b: Event) => a.messageId !== undefined && a.messageId === b.messageId;
interface Flush { current: Use; journaled: boolean }
function requirePublication(phase: Phase, entryOrder: number, entered: Event[], init: Invocation, current: boolean,
  checkpoint?: string, flush?: Flush): void {
  const native = (e: Event) => e.kind === 'use' && typeof e.input?.file_path === 'string' ? nativePathSpelling(e.input.file_path) : undefined;
  const closeReads = entered.filter((e): e is Use => e.kind === 'use' && e.name === 'Read' && e.order >= entryOrder &&
    ownPath(native(e)) && path.basename(native(e)!) === 'close-packet.md' &&
    samePath(path.dirname(path.dirname(native(e)!)), path.dirname(init.restorePath)) &&
    path.basename(path.dirname(native(e)!)).startsWith(`autoplan-${phase}-`));
  if (!closeReads.length) fail('close_required', { phase: number[phase] });
  const latestPath = native(closeReads.at(-1)!)!;
  const content = closePacket(latestPath, phase, init, current), covered = new Set<number>();
  if (checkpoint && JSON.parse(/^Binding: (.+)$/m.exec(content)![1]!).checkpointPath !== checkpoint)
    fail('close_stale', { cause: `The Phase ${number[phase]} close packet belongs to an earlier checkpoint` });
  let closeOrder = -1;
  for (const use of closeReads.filter(e => native(e) === latestPath)) {
    const results = entered.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
    if (results.length !== 1) continue;
    const range = autoplanReadRange(use, results[0]!, content, entered);
    if (!range) continue;
    for (let line = range.start; line <= range.end; line++) covered.add(line);
    closeOrder = Math.max(closeOrder, results[0]!.order);
  }
  if (covered.size !== content.split('\n').length) fail('close_incomplete', { phase: number[phase] });
  const pending = entered.some(e => e.kind === 'use' && e.order > closeOrder && ['Write', 'Edit'].includes(e.name ?? '') &&
    samePath(e.input?.file_path, init.activePlan) && !entered.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId));
  if (pending) fail('mutation_pending');
  if (current) verifyCloseEdits(entered, closeOrder, init);
  const reports = entered.filter((e): e is Event & { kind: 'message' } => e.kind === 'message' && e.order > closeOrder &&
    autoplanPhaseCompletions({ status: 'ready', calls: [], assistantMessages: [e] }, 0).some(hit => hit.phase === number[phase]));
  if (!reports.length) fail('publication_missing', { phase: number[phase] });
  if (!flush) return;
  // Text in the same assistant message as a guarded call can be invisible to
  // PreToolUse. A report counts only when it is outside the journaled current
  // call's message and a later journaled record (a result or another message)
  // follows it, so the outcome never depends on when Claude Code flushes.
  const later = flush.journaled ? [...entered, flush.current] : entered;
  if (reports.some(r => !(flush.journaled && sameMessage(r, flush.current)) &&
      later.some(e => e.order > r.order && (e.kind === 'result' || !sameMessage(e, r))))) return;
  const repeated = entered.some(e => e.kind === 'result' && e.isError === true && JSON.stringify(e.content ?? '').includes('(code publication_unflushed'));
  fail(repeated ? 'publication_repeat' : 'publication_unflushed', { phase: number[phase] });
}

/** The phase a guarded call enters, from its input alone (no artifact I/O). */
function targetPhase(use: { name?: string; input?: Record<string, unknown> }, cwd: string): Phase | undefined {
  if (use.name === 'Read') return phaseName(use.input?.file_path, cwd) ?? artifactName(use.input?.file_path, cwd);
  if (use.name === 'Agent' && typeof use.input?.prompt === 'string')
    return /^You are the independent (CEO|DESIGN|DX|ENG) reviewer for this phase\.\n/.exec(use.input.prompt)?.[1]?.toLowerCase() as Phase | undefined;
}

/** Journal path: the current call is journaled; its record must match the payload exactly, minus documented strips. */
export const evaluateAutoplanPublication = (input: PublicationHookInput, root: string, events: Event[], claudeVersion?: string) =>
  visible(journalDecision(input, root, events, claudeVersion));
/** Payload path; see payloadDecision. */
export const evaluatePayloadPublication = (input: PublicationHookInput, root: string, events: Event[]) =>
  visible(payloadDecision(input, root, events));
const unguarded = (input: PublicationHookInput) => !candidate({ name: input.tool_name, input: input.tool_input }, input.cwd) || !!input.agent_id;

function journalDecision(input: PublicationHookInput, root: string, events: Event[], claudeVersion?: string): Decision {
  return decideSafely(() => {
    if (unguarded(input)) return { allow: true };
    consistentEvents(input, events);
    const current = events.filter((e): e is Use => isUse(e) && e.toolUseId === input.tool_use_id);
    if (current.length !== 1 || current[0]!.name !== input.tool_name) fail('current_mismatch');
    const journaled = nativeToolInput(current[0]!.input, input.cwd, input.tool_name) as Record<string, unknown>;
    const payload = nativeToolInput(input.tool_input, input.cwd, input.tool_name) as Record<string, unknown>;
    if (!isDeepStrictEqual(journaled, payload)) {
      // A pure strip by a newer Claude Code's schema parse is its doing, not the model's.
      const stripped = Object.keys(journaled).filter(key => !(key in payload));
      if (stripped.length && newerThanChecked(claudeVersion) &&
          isDeepStrictEqual(Object.fromEntries(Object.keys(payload).map(key => [key, journaled[key]])), payload))
        fail('unseen_version', { keys: stripped.sort() });
      fail('current_mismatch');
    }
    return phaseDecision(input, root, events.filter(e => e.order < current[0]!.order), current[0]!, true);
  });
}

/**
 * Payload path: a ready journal lacks the current call (Claude Code had not
 * flushed it). The payload, placed after the last journaled record, stands in
 * for it; the previous phase's report must still be journaled and flushed.
 */
function payloadDecision(input: PublicationHookInput, root: string, events: Event[]): Decision {
  return decideSafely(() => {
    if (unguarded(input)) return { allow: true };
    consistentEvents(input, events);
    if (events.some(e => (e.kind === 'use' || e.kind === 'result') && e.toolUseId === input.tool_use_id)) fail('current_mismatch');
    const last = events.at(-1)!;
    const current: Use = { kind: 'use', sessionId: input.session_id, timestamp: last.timestamp, order: last.order + 1,
      toolUseId: input.tool_use_id, name: input.tool_name, input: input.tool_input };
    // The payload has no messageId; the last journaled assistant message may be this call's.
    const lastMessage = events.findLast(e => e.messageId !== undefined && e.kind !== 'result')?.messageId;
    return phaseDecision(input, root, events, lastMessage ? { ...current, messageId: lastMessage } : current, false);
  });
}

/** ENG-2: a tool still waiting for its result outside the last journaled message means the journal lags more than one message. */
export function journalLagged(events: Event[]): boolean {
  const lastMessage = events.findLast(e => e.messageId !== undefined && e.kind !== 'result')?.messageId;
  return events.some(e => isUse(e) && (e.messageId === undefined || e.messageId !== lastMessage) &&
    !events.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId));
}

function consistentEvents(input: PublicationHookInput, events: Event[]): void {
  if (!events.length || events.some((e, i) => e.sessionId !== input.session_id || !Number.isSafeInteger(e.order) ||
      (i > 0 && e.order <= events[i - 1]!.order))) fail('event_order');
  const identities = new Set<string>();
  for (const event of events) if (event.kind === 'use' || event.kind === 'result') {
    const identity = `${event.kind}:${event.toolUseId}`;
    if (identities.has(identity)) fail('tool_identity');
    identities.add(identity);
  }
}

function decideSafely(work: () => Decision): Decision {
  try { return work(); } catch (error) {
    const code = error instanceof BoundaryError ? error.code : 'evidence';
    const detail = error instanceof BoundaryError ? error.detail : {};
    if (REASONS[reasonCode(code)].disposition === 'unverified') return { allow: true, unverified: code, detail };
    return { allow: false, reason: reasonText(code, detail), code, detail };
  }
}

/** Shared by both paths. `current` is the journaled record or the payload stand-in; `before` precedes it. */
function phaseDecision(input: PublicationHookInput, root: string, before: Event[], current: Use, journaled: boolean): Decision {
  const requested = { name: input.tool_name, input: input.tool_input };
  // Pinned Claude retains skill hooks after end_turn. Only an authenticated
  // later human request can release the old invocation; tool results and
  // compaction never do. A native slash or an actual init re-arms the guard.
  const disarmed = disarmedAt(before, root);
  if (disarmed.at(-1)) return { allow: true };
  const human = before.filter((e): e is Turn => e.kind === 'user_turn').at(-1);
  if (human?.autoplan && !before.some(e => e.kind === 'use' && e.name === 'Bash' && e.order > human.order &&
      initArguments(e.input?.command, root))) fail('init_own');
  const init = invocation(before, root);
  const entered = before.filter((e, i) => e.order > init.start && !disarmed[i]);
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
    if (!isUse(use) || !['Read', 'Agent'].includes(use.name ?? '')) continue;
    const results = entered.filter((e): e is Tool => e.kind === 'result' && e.toolUseId === use.toolUseId);
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
  // One batch rule on both paths: guarded calls in the current call's message
  // that target the same phase are one batch; another phase is never batched.
  const siblings = entered.filter(e => isUse(e) && candidate(e, input.cwd) && sameMessage(e, current));
  if (siblings.some(e => targetPhase(e as Use, input.cwd) !== target)) fail('cross_phase_batch');
  if (entered.some(e => e.kind === 'use' && candidate(e, input.cwd) && !siblings.includes(e) &&
      !entered.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId))) fail('entry_pending');
  if (!phase) {
    if (target !== 'ceo') fail('phase_order');
    return { allow: true };
  }
  if (number[target] <= number[phase]) return { allow: true };
  requirePublication(phase, entryOrder, entered, init, true, checkpoint, { current, journaled });
  return { allow: true };
}

/**
 * A worktree session gets the repository root as CLAUDE_PROJECT_DIR while its
 * journal is rooted in the linked worktree. Only git's own two-way link makes
 * a directory that worktree: <root>/.git/worktrees/<name>/gitdir names
 * <worktree>/.git, and that file names the same admin entry back.
 */
export function linkedWorktrees(projectDir: string): string[] {
  let entries: fs.Dirent[];
  const admin = path.join(projectDir, '.git', 'worktrees');
  try { entries = fs.readdirSync(admin, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory()).slice(0, 256).flatMap(entry => {
    try {
      const link = path.join(admin, entry.name);
      // worktree.useRelativePaths writes each side relative to its own file's directory.
      const forward = /^([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(path.join(link, 'gitdir'), 'utf8'))?.[1];
      if (!forward) return [];
      const gitFile = nativePathSpelling(path.resolve(link, nativePathSpelling(forward)));
      if (path.basename(gitFile) !== '.git' || !fs.lstatSync(gitFile).isFile()) return [];
      const back = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(gitFile, 'utf8'))?.[1];
      if (!back || nativePathSpelling(fs.realpathSync(path.resolve(path.dirname(gitFile), nativePathSpelling(back)))) !==
          nativePathSpelling(fs.realpathSync(link))) return [];
      const worktree = nativePathSpelling(fs.realpathSync(path.dirname(gitFile)));
      return ownPath(worktree) ? [worktree] : [];
    } catch { return []; }
  });
}

export function publicationHookOutput(decision: Decision | PublicationDecision): object {
  return decision.allow ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `[autoplan] ${decision.reason}` } };
}

type OwnedRead = ReturnType<typeof readOwnedClaudePublicTranscript>;
type EvaluationPath = 'journal' | 'payload' | 'none';
const mib = (bytes: number) => { const m = bytes / (1024 * 1024); return `${m >= 10 ? Math.round(m) : Number(m.toPrecision(2))} MiB`; };

/**
 * UC1: Claude Code left this call uncheckable. No permissionDecision, so Claude
 * Code's own permission check still runs; the user sees the warning (stderr and
 * systemMessage), the model is reminded to publish, and the log says unverified.
 */
function unverifiedOutput(code: string, detail: Detail, version: string | undefined, via: EvaluationPath, recordTypes?: string[]): object {
  logGuardDecision({ decision: 'allow', disposition: 'unverified', code, path: via, claudeVersion: version, recordTypes });
  const notice = reasonText(code, detail, version);
  return { systemMessage: `[autoplan] ${notice}`, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
    `[autoplan] ${notice} This call proceeds unverified. Publish each completed phase report as your own parent ` +
    'assistant text, in a message whose only tool call is the Bash no-op `: autoplan-published <phase>`, before entering the next phase.' } };
}

function decided(decision: Decision, via: EvaluationPath, version?: string): object {
  if (decision.allow && decision.unverified) return unverifiedOutput(decision.unverified, decision.detail ?? {}, version, via);
  if (decision.allow) { logGuardDecision({ decision: 'allow', disposition: 'allow', path: via, claudeVersion: version }); return {}; }
  const code = decision.code, disposition = REASONS[reasonCode(code)].disposition as 'fallback' | 'corrective' | 'transient';
  logGuardDecision({ decision: 'deny', disposition, code, path: via, claudeVersion: version,
    unknownKeys: code === 'agent_key' ? decision.detail?.keys : undefined });
  return publicationHookOutput({ allow: false, code, reason: reasonText(code, decision.detail, version) });
}
const denied = (code: ReasonCode, version?: string, detail: Detail = {}, via: EvaluationPath = 'none') =>
  decided({ allow: false, code, reason: '', detail }, via, version);

/** Read every owner the hook accepts (project root, then its linked worktrees). */
function ownedRead(journal: string, owners: string[], sessionId: string): OwnedRead {
  const reads = [readOwnedClaudePublicTranscript(journal, owners[0]!, sessionId)];
  if (reads[0]!.transcript.reason === 'foreign_cwd')
    for (const owner of owners.slice(1)) reads.push(readOwnedClaudePublicTranscript(journal, owner, sessionId));
  return reads.find(r => r.transcript.status === 'ready') ?? reads.find(r => r.transcript.reason !== 'foreign_cwd') ?? reads[0]!;
}

/**
 * A ready journal holding the current call takes the journal path; one that
 * lacks it takes the payload path at once (Claude Code may write the record only
 * with its result). The 2-second window remains for a journal that does not exist
 * yet, a journal lagging more than one message, and the unrecognized-shape double read.
 */
export async function runPublicationHook(value: unknown, root: string): Promise<object> {
  let version: string | undefined;
  try {
    if (!object(value) || value.hook_event_name !== 'PreToolUse' || typeof value.tool_name !== 'string') return denied('hook_input');
    if (!['Read', 'Agent'].includes(value.tool_name) || value.agent_id) return {};
    if (!ownPath(value.cwd) || !ownPath(value.transcript_path) || typeof value.session_id !== 'string' ||
        typeof value.tool_use_id !== 'string' || !object(value.tool_input)) return denied('hook_input');
    const input = value as PublicationHookInput;
    if (!candidate({ name: input.tool_name, input: input.tool_input }, input.cwd)) return {};
    // Native hooks override this environment value with the session's project
    // root. Bash cd changes input.cwd, not the journal's original ownership.
    // On Windows the hook env spells it C:/...; the journal records C:\...
    const projectCwd = nativePathSpelling(process.env.CLAUDE_PROJECT_DIR ?? input.cwd);
    if (!ownPath(projectCwd)) return denied('hook_input');
    const journal = nativePathSpelling(input.transcript_path), owners = [projectCwd, ...linkedWorktrees(projectCwd)];
    const deadline = performance.now() + 2_000;
    let read: OwnedRead, stable: string | undefined;
    for (;;) {
      read = ownedRead(journal, owners, input.session_id);
      version = read.claudeVersion ?? read.diagnostic?.claudeVersion;
      const code = read.transcript.reason, expired = performance.now() >= deadline;
      if (read.transcript.status === 'ready') {
        if (read.events.some(e => e.kind === 'use' && e.toolUseId === input.tool_use_id))
          return decided(journalDecision(input, root, read.events, version), 'journal', version);
        if (!journalLagged(read.events)) return decided(payloadDecision(input, root, read.events), 'payload', version);
        if (expired) return unverifiedOutput('journal_lag', {}, version, 'payload');
      } else if (code === 'too_large') {
        let size: string | undefined;
        try { size = mib(fs.statSync(journal).size); } catch { /* size stays generic */ }
        return unverifiedOutput('too_large', { size, limit: mib(transcriptReadLimit()) }, version, 'none');
      } else if (code && code !== 'changing' && !code.startsWith('unrecognized_shape:')) {
        return denied(code as ReasonCode, version);
      } else if (code?.startsWith('unrecognized_shape:') && read.diagnostic?.complete) {
        if (stable === read.diagnostic.sha256) return unverifiedOutput(code, { cause: code }, version, 'none', read.diagnostic.rootShape);
        stable = read.diagnostic.sha256;
      } else stable = undefined;
      if (expired) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const code = read.transcript.reason;
    // A journal with bytes but no owned records yet: Claude Code has not written an ancestor.
    if (!code && read.diagnostic) return unverifiedOutput('journal_lag', {}, version, 'none');
    return denied(code ? 'changing' : 'journal_missing', version);
  } catch {
    return denied('installation', version);
  }
}

if (import.meta.main) {
  let output: object;
  try {
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const bytes = await Bun.stdin.text();
    output = Buffer.byteLength(bytes) > 64 * 1024 ? denied('hook_input') : await runPublicationHook(JSON.parse(bytes), root);
  } catch { output = denied('hook_input'); }
  const warning = (output as { systemMessage?: string }).systemMessage;
  if (warning) process.stderr.write(`${warning}\n`);
  process.stdout.write(JSON.stringify(output) + '\n');
}
