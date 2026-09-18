/** Bounded CEO dual-dispatch evidence from the SDK parent stream, never source prose. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { loadAutoplanMethodologyBinding } from './autoplan-method-read-audit';
import { claudeOutsideExecutions } from './outside-voice-evidence';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : '';
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const parent = (event: any) => event?.parent_tool_use_id == null && event?.agentId == null && (event?.isSidechain == null || event?.isSidechain === false);
// These are delivered executable blocks, not a shell interpreter. Only blank
// lines, indentation and full-line comments may differ; branch/order/args stay exact.
// The outside matcher also recognizes bounded stop-only availability rechecks.
const code = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
function block(source: string, needle: string): string {
  const blocks = [...source.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)].map(match => match[1]!);
  const found = blocks.filter(value => value.includes(needle));
  if (found.length !== 1) throw Error('Ambiguous or missing actual Autoplan command contract');
  return found[0]!;
}
export function loadAutoplanDualCommandContract(root: string) {
  return { probe: block(readFileSync(join(root, 'autoplan/SKILL.md'), 'utf8'), 'echo "CODEX_MODE: $_CODEX_MODE"'),
    outside: block(readFileSync(join(root, 'autoplan/sections/ceo-phase.md'), 'utf8'), '_gstack_codex_timeout_wrapper 600 codex exec') };
}
export interface AutoplanDualEvidenceOptions {
  ownedRoots: string[];
  cwd: string;
  activePlan: string;
  methodologySha256: string;
  commands: { probe: string; outside: string };
}
interface Call { id: string; name: string; input: Record<string, any>; order: number;
  result?: { order: number; content: string; error: boolean }; }
export interface AutoplanDualEvidence {
  claudeVoiceFired: boolean;
  codexVoiceFired: boolean;
  codexAttempted: boolean;
  codexUnavailable: boolean;
  reviewDispatched: boolean;
  nativeToolUseId?: string;
  outsideToolUseId?: string;
  failedOutsideToolUseId?: string;
  probeToolUseId?: string;
  probeMode?: string;
  snapshotSha256?: string;
  reasons: string[];
}
/** Keep only public parent tool requests/results; private blocks are not copied or serialized. */
export function autoplanDualVoiceEvidence(transcript: unknown[], options: AutoplanDualEvidenceOptions): AutoplanDualEvidence {
  const result: AutoplanDualEvidence = { claudeVoiceFired: false, codexVoiceFired: false, codexAttempted: false,
    codexUnavailable: false, reviewDispatched: false, reasons: [] };
  const roots = options.ownedRoots.map(root => realpathSync(root));
  const owned = (file: unknown, immutable = false): file is string => {
    if (typeof file !== 'string' || !isAbsolute(file) || resolve(file) !== file || !roots.some(root => file.startsWith(root + sep))) return false;
    try {
      const existing = existsSync(file) ? file : dirname(file);
      if (realpathSync(existing) !== existing) return false;
      if (immutable) {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || process.platform !== 'win32' && (stat.mode & 0o777) !== 0o444) return false;
      }
      return true;
    } catch { return false; }
  };
  const calls = new Map<string, Call>();
  const publicStream: any[] = [];
  let session: string | undefined;
  let order = 0;
  for (const item of transcript) {
    if (!object(item) || !parent(item)) continue;
    const id = item.session_id;
    if (typeof id !== 'string' || !id || item.sessionId != null && item.sessionId !== id) continue;
    if (!session && item.type === 'assistant') session = id;
    if (id !== session) continue;
    // Native background status fields are public execution metadata. Preserve
    // only the existing collector's recognized notification shape.
    if (item.type === 'system' && item.subtype === 'task_notification') {
      publicStream.push({ type: item.type, subtype: item.subtype, session_id: id,
        task_id: item.task_id, tool_use_id: item.tool_use_id, output_file: item.output_file,
        status: item.status, summary: item.summary });
    }
    if (item.type === 'attachment' && item.attachment?.type === 'queued_command' &&
        item.attachment.commandMode === 'task-notification' && typeof item.attachment.prompt === 'string') {
      publicStream.push({ type: item.type, session_id: id, attachment: { type: 'queued_command',
        commandMode: 'task-notification', prompt: item.attachment.prompt } });
    }
    if (!['assistant', 'user'].includes(item.type) || !Array.isArray(item.message?.content)) continue;
    for (const part of item.message.content) {
      order++;
      if (item.type === 'assistant' && part?.type === 'tool_use' && typeof part.id === 'string' && part.id &&
          typeof part.name === 'string' && object(part.input)) {
        const call = { id: part.id, name: part.name, input: part.input, order };
        const previous = calls.get(part.id);
        if (previous) {
          if (previous.name !== call.name || JSON.stringify(previous.input) !== JSON.stringify(call.input)) {
            result.reasons.push('Conflicting parent request identity'); return result;
          }
          continue;
        }
        calls.set(call.id, call);
        publicStream.push({ type: 'assistant', session_id: id, message: { content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] } });
      } else if (item.type === 'user' && part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const call = calls.get(part.tool_use_id);
        if (!call) continue;
        const delivered = { order, content: text(part.content), error: part.is_error === true };
        if (call.result && (call.result.content !== delivered.content || call.result.error !== delivered.error)) {
          result.reasons.push('Conflicting parent result identity'); return result;
        }
        call.result ??= delivered;
        publicStream.push({ type: 'user', session_id: id, message: { content: [{ type: 'tool_result', tool_use_id: call.id,
          content: delivered.content, is_error: delivered.error }] } });
      }
    }
  }
  const canonical = (command: string, expected: string, readiness = false) => {
    // A literal fixture cd is shared by the probe and outside command.
    const prefix = new RegExp('^cd (?:' + [options.cwd, '"' + options.cwd + '"', "'" + options.cwd + "'"]
      .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?: \&\&|;)?\\n');
    const actual = code(command.replace(prefix, '')), contract = code(expected);
    if (actual === contract) return true;
    if (!readiness) return false;
    // At dispatch, a fresh availability check may precede or follow the exact
    // host guard. The execution body, host guard and their order remain exact.
    // These finite stop-only forms are not a general shell normalizer.
    const boundary = contract.indexOf('\n_REPO_ROOT=');
    if (boundary < 0 || contract.indexOf('\n_REPO_ROOT=', boundary + 1) >= 0) return false;
    const harness = contract.slice(0, boundary), body = contract.slice(boundary);
    if (!actual.endsWith(body)) return false;
    const edges = actual.slice(0, -body.length).split(harness);
    if (edges.length !== 2) return false;
    if (edges[0] && !edges[0].endsWith('\n') || edges[1] && !edges[1].startsWith('\n')) return false;
    const assignments = code(options.commands.probe).split('\n').filter(line => line.startsWith('_CODEX_CFG='));
    if (assignments.length !== 1) return false;
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const separator = '(?:;[ \\t]*|\\n)';
    const stop = (mode: string) => {
      const literal = `(?:'CODEX_MODE: ${mode}[A-Za-z0-9 .,:_()/=-]*'|"CODEX_MODE: ${mode}[A-Za-z0-9 .,:_()/=-]*")`;
      return `(?:echo ${literal}(?: >&2)?${separator}\\s*)?exit (?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])`;
    };
    const condition = '\\[ "\\$_CODEX_CFG" =?= (?:"disabled"|\'disabled\'|disabled) \\]';
    const cli = 'command -v codex >/dev/null 2>&1';
    const guard = (condition: string, operator: string, mode: string, negated = false) => {
      const exit = stop(mode);
      return `(?:${condition} ${operator} \\{\\s*${exit}${separator}\\s*\\}|if ${negated ? '! ' : ''}${condition}; then\\s*${exit}${separator}\\s*fi)`;
    };
    const config = new RegExp('^' + escaped(assignments[0]!) + '\\n' + guard(condition, '&&', 'disabled') + '(?:\\n|$)');
    const available = new RegExp('^' + guard(cli, '\\|\\|', 'not_installed', true) + '(?:\\n|$)');
    const seen = new Set<string>();
    for (const edge of edges) {
      let remaining = edge.trim();
      while (remaining) {
        const match = config.exec(remaining) ?? available.exec(remaining);
        if (!match) return false;
        const kind = match[0].startsWith(assignments[0]!) ? 'config' : 'cli';
        if (seen.has(kind)) return false;
        seen.add(kind); remaining = remaining.slice(match[0].length).trim();
      }
    }
    return seen.size > 0;
  };
  for (const call of calls.values()) {
    if (call.name !== 'Bash' || typeof call.input.command !== 'string' || !canonical(call.input.command, options.commands.probe)) continue;
    result.probeToolUseId = call.id; delete result.probeMode;
    if (!call.result || call.result.error) continue;
    const modes = [...call.result.content.matchAll(/^CODEX_MODE: ([a-z_]+)\r?$/gm)];
    if (modes.length !== 1 || !call.result.content.trimEnd().endsWith(modes[0]![0])) continue;
    result.probeToolUseId = call.id; result.probeMode = modes[0]![1];
  }
  const native: Array<{ call: Call; snapshot: any; content: string }> = [];
  for (const call of calls.values()) {
    if (call.name !== 'Agent' || typeof call.input.prompt !== 'string' || !call.result || call.result.error) continue;
    try {
      const method = loadAutoplanMethodologyBinding(call.input.prompt, roots);
      if (method.phase !== 'ceo' || method.sha256 !== options.methodologySha256) continue;
      const nativePath = JSON.parse(/^Read file: ("[^\n]+")$/m.exec(call.input.prompt)![1]!);
      const snapshot = JSON.parse(readFileSync(join(dirname(nativePath), 'snapshot.json'), 'utf8'));
      if (!owned(options.activePlan) || snapshot.activePlan !== options.activePlan ||
          !owned(snapshot.snapshotPath, true)) continue;
      const content = readFileSync(snapshot.snapshotPath, 'utf8');
      if (sha(content) !== snapshot.sha256 ||
          !readFileSync(nativePath, 'utf8').includes(content)) continue;
      if (!/^Async agent launched successfully\./.test(call.result.content) &&
          !new RegExp('^INPUT: ceo ' + snapshot.sha256 + '(?:\\r?\\n|$)').test(call.result.content.trimStart())) continue;
      native.push({ call, snapshot, content });
    } catch { /* Unowned, spec-only, foreign-phase and forged snapshots earn no voice credit. */ }
  }
  for (const entry of native) {
    result.claudeVoiceFired = result.reviewDispatched = true;
    result.nativeToolUseId = entry.call.id; result.snapshotSha256 = entry.snapshot.sha256;
    for (const outside of calls.values()) {
      if (outside.name !== 'Bash' || typeof outside.input.command !== 'string' || !outside.result ||
          outside.order <= entry.call.result!.order) continue;
      const writes = [...calls.values()].filter(call => call.name === 'Write' && call.result && !call.result.error &&
        call.result.order < outside.order && typeof call.input.content === 'string' && owned(call.input.file_path));
      for (const write of writes) {
        const file = write.input.file_path;
        if (!write.input.content.includes(entry.content) ||
            !write.input.content.includes('You are a CEO/founder advisor reviewing a development plan.') ||
            !write.input.content.includes('File: ' + entry.snapshot.snapshotPath)) continue;
        // A later write/edit of this prepared prompt invalidates the old payload.
        if ([...calls.values()].some(call => call.order > write.order && call.order < outside.order &&
            ['Write', 'Edit'].includes(call.name) && call.input.file_path === file)) continue;
        const command = options.commands.outside.replace("'<prepared-prompt-file>'", "'" + file + "'");
        if (/[\r\n\0']/.test(file) || !canonical(outside.input.command, command, true)) continue;
        const otherIdenticalCalls = new Set([...calls.values()].filter(call => call.id !== outside.id &&
          call.name === 'Bash' && call.input.command === outside.input.command).map(call => call.id));
        const thisExecution = publicStream.filter(event => !event.message?.content?.some((part: any) =>
          otherIdenticalCalls.has(part.id ?? part.tool_use_id)));
        for (const execution of claudeOutsideExecutions(thisExecution)) {
          if (execution.command !== outside.input.command) continue;
          if (execution.succeeded && /^OUTSIDE_STATUS: completed provider=codex host=claude$/m.test(execution.output)) {
            result.codexAttempted = result.codexVoiceFired = true; result.outsideToolUseId = outside.id;
          } else if (!execution.background && !execution.succeeded && outside.result.error &&
              /^(?:Codex outside review unavailable: execution failed; missing coverage\. Check the provider diagnosis above\.|Outside review unavailable: (?:empty response|review refused|missing review completion recommendation); missing coverage\.)$/m.test(execution.output)) {
            // These finite diagnostics occur only after the exact generated
            // command reaches Codex or its review validator. They prove an
            // attempted voice, never a completed review or comparison.
            result.codexAttempted = result.codexUnavailable = true;
            result.failedOutsideToolUseId = outside.id;
          }
        }
      }
    }
  }
  result.codexUnavailable ||= result.claudeVoiceFired && ['not_installed', 'not_authed', 'broken_install', 'model_unusable'].includes(result.probeMode ?? '');
  if (!result.claudeVoiceFired) result.reasons.push('No acknowledged current CEO phase dispatch');
  if (!result.codexVoiceFired && !result.codexUnavailable) result.reasons.push('No acknowledged outside execution or actual unavailable probe result');
  return result;
}
