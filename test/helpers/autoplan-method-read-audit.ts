/** Exact parent tool-delivery audit; neither preparation nor a claimed range is a Read. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { NativePublicToolEvent } from './plan-count-transcript';

export interface MethodologyReadBinding {
  phase: string;
  path: string;
  sha256: string;
  bytes: number;
  content: string;
  lines: number;
}
export interface AutoplanMethodReadAudit {
  phase: string;
  sessionId: string;
  dispatchToolUseId: string;
  at: string;
  passed: boolean;
  methodologyPath?: string;
  sha256?: string;
  ranges: Array<{ startLine: number; endLine: number; toolUseId: string }>;
  missing: Array<{ startLine: number; endLine: number }>;
  error?: string;
}
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);
const identity = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const phaseOf = (prompt: string) => /^You are the independent (CEO|DESIGN|DX|ENG) reviewer for this phase\.\n/.exec(prompt)?.[1]?.toLowerCase();

/** Paths come from the actual dispatch but may only resolve inside this fixture's owned roots. */
export function loadAutoplanMethodologyBinding(prompt: string, ownedRoots: string[]): MethodologyReadBinding {
  const phase = phaseOf(prompt);
  const pathLine = /^Read file: ("[^\n]+")$/m.exec(prompt)?.[1];
  if (!phase || !pathLine) throw new Error('Unrecognized native phase dispatch');
  const nativePath: unknown = JSON.parse(pathLine);
  const roots = ownedRoots.map(root => realpathSync(root));
  const read = (path: unknown): Buffer => {
    if (typeof path !== 'string' || realpathSync(path) !== path ||
        !roots.some(root => path.startsWith(root + sep))) throw new Error('Artifact outside owned fixture roots or aliased');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o444)) throw new Error('Artifact is not immutable bounded regular data');
    return readFileSync(path);
  };
  if (typeof nativePath !== 'string' || basename(nativePath) !== 'native-prompt.md' ||
      !basename(dirname(nativePath)).startsWith(`autoplan-${phase}-`)) throw new Error('Foreign phase native input');
  const native = read(nativePath);
  const snapshot = JSON.parse(read(join(dirname(nativePath), 'snapshot.json')).toString('utf8'));
  if (snapshot.schemaVersion !== 2 || snapshot.phase !== phase || snapshot.nativePromptPath !== nativePath ||
      snapshot.nativeDispatchPrompt !== prompt || snapshot.nativePromptSha256 !== hash(native) ||
      snapshot.nativePromptBytes !== native.length || snapshot.nativePromptLines !== native.toString('utf8').split('\n').length ||
      !object(snapshot.methodology)) throw new Error('Dispatch does not match immutable snapshot');
  const identity = snapshot.methodology;
  if (typeof identity.methodologyPath !== 'string' || basename(identity.methodologyPath) !== 'methodology.md' ||
      !basename(dirname(identity.methodologyPath)).startsWith(`autoplan-${phase}-`)) throw new Error('Foreign methodology identity');
  const content = read(identity.methodologyPath);
  const manifestBytes = read(join(dirname(identity.methodologyPath), 'methodology.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (hash(manifestBytes) !== identity.manifestSha256 || manifest.phase !== phase ||
      manifest.methodologyPath !== identity.methodologyPath || hash(content) !== identity.sha256 ||
      manifest.sha256 !== identity.sha256 || content.length !== identity.bytes || manifest.bytes !== identity.bytes ||
      content.toString('utf8').split('\n').length !== identity.lines || manifest.lines !== identity.lines) {
    throw new Error('Methodology bytes do not match dispatched snapshot');
  }
  return { phase, path: identity.methodologyPath, content: content.toString('utf8'),
    sha256: identity.sha256, bytes: identity.bytes, lines: identity.lines };
}

/**
 * The caller supplies only public records from its existing owned parent transcript reader.
 * Bind session + tool ID, actual request/result order, exact path and every delivered line.
 * A child Read, error, self-report, future result or plausible hash alone supplies no coverage.
 */
export function auditAutoplanMethodReads(
  events: NativePublicToolEvent[],
  bindingFor: (prompt: string) => MethodologyReadBinding,
): AutoplanMethodReadAudit[] {
  const audits: AutoplanMethodReadAudit[] = [];
  for (let dispatchIndex = 0; dispatchIndex < events.length; dispatchIndex++) {
    const dispatch = events[dispatchIndex]!;
    if (dispatch.kind !== 'use' || dispatch.name !== 'Agent' || typeof dispatch.input?.prompt !== 'string') continue;
    const phase = phaseOf(dispatch.input.prompt);
    if (!phase) continue;
    const audit: AutoplanMethodReadAudit = { phase, sessionId: dispatch.sessionId,
      dispatchToolUseId: dispatch.toolUseId, at: dispatch.timestamp, passed: false, ranges: [], missing: [] };
    audits.push(audit);
    try {
      const dispatchTime = Date.parse(dispatch.timestamp);
      if (!identity(dispatch.sessionId) || !identity(dispatch.toolUseId) || !Number.isFinite(dispatchTime)) {
        throw new Error('Invalid native dispatch identity or timestamp');
      }
      const binding = bindingFor(dispatch.input.prompt);
      if (binding.phase !== phase || !integer(binding.lines) || binding.lines > 1_000_000 ||
          hash(binding.content) !== binding.sha256 || Buffer.byteLength(binding.content) !== binding.bytes ||
          binding.content.split('\n').length !== binding.lines) throw new Error('Invalid methodology binding');
      audit.methodologyPath = binding.path; audit.sha256 = binding.sha256;
      const lines = binding.content.split('\n');
      const covered = new Set<number>();
      const requests = new Map<string, NativePublicToolEvent>();
      const results = new Map<string, string>();
      for (const event of events.slice(0, dispatchIndex)) {
        if (event.sessionId !== dispatch.sessionId || !identity(event.toolUseId) ||
            !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) > dispatchTime) continue;
        if (event.kind === 'use') {
          const old = requests.get(event.toolUseId);
          if (old && JSON.stringify(old) !== JSON.stringify(event)) throw new Error('Conflicting native tool identity');
          requests.set(event.toolUseId, event); continue;
        }
        const request = requests.get(event.toolUseId);
        if (!request || request.name !== 'Read' || request.input?.file_path !== binding.path ||
            Date.parse(request.timestamp) > Date.parse(event.timestamp)) continue;
        const signature = JSON.stringify({ file: event.file, isError: event.isError });
        const previous = results.get(event.toolUseId);
        if (previous !== undefined && previous !== signature) throw new Error('Conflicting native Read results');
        results.set(event.toolUseId, signature);
        const file = event.file;
        if (event.isError || !object(file) || file.filePath !== binding.path || typeof file.content !== 'string' ||
            !integer(file.startLine) || !integer(file.numLines) || file.totalLines !== binding.lines ||
            file.startLine + file.numLines - 1 > binding.lines) continue;
        const offset = request.input?.offset ?? 1;
        const limit = request.input?.limit;
        if (offset !== file.startLine || (limit !== undefined && (!integer(limit) || file.numLines > limit))) continue;
        const expected = lines.slice(file.startLine - 1, file.startLine - 1 + file.numLines).join('\n');
        if (file.content !== expected) continue;
        if (previous !== undefined) continue;
        const end = file.startLine + file.numLines - 1;
        audit.ranges.push({ startLine: file.startLine, endLine: end, toolUseId: event.toolUseId });
        for (let line = file.startLine; line <= end; line++) covered.add(line);
      }
      for (let line = 1; line <= binding.lines; line++) {
        if (covered.has(line)) continue;
        const startLine = line;
        while (line < binding.lines && !covered.has(line + 1)) line++;
        audit.missing.push({ startLine, endLine: line });
      }
      audit.passed = audit.missing.length === 0;
      if (!audit.passed) audit.error = 'Incomplete successful parent methodology Read content before native dispatch';
    } catch (error) { audit.error = String(error); }
  }
  return audits;
}
