/**
 * codex-rollout: Codex CLI's rollout JSONL (the file a Codex hook payload's
 * transcript_path names, under $CODEX_HOME/sessions/) read as the transcript
 * events lib/skill-contract.ts checks (GST-3173). parseTranscript picks this
 * reader by the file's content: a rollout's first record is session_meta.
 *
 * What each Codex record becomes:
 *   - user message: a prompt, or meta when Codex wrote it (environment
 *     context, AGENTS.md, a hook's reason, a subagent notification, an
 *     injected <skill>). An injected gstack-* SKILL.md is also a skill load.
 *   - assistant message: text.
 *   - exec_command / shell call: a Bash tool_use whose command is the shell
 *     line; a command in it that reads a gstack-* SKILL.md under a skills/
 *     directory (cat, sed, head and the like) is also a skill load, unless
 *     the output says that read failed. Reading the same skill again with no
 *     user prompt or other skill load in between (a long SKILL.md read in
 *     chunks) continues the run, so it is not a new load.
 *   - spawn_agent call that started an agent, in any tool namespace: an Agent
 *     dispatch whose prompt is its message. Codex 0.170 answers a started
 *     agent with {"agent_id": ...} (multi_agents) or, when it serves the tool
 *     in its collaboration namespace (multi_agents_v2, as for gpt-6.1-sol),
 *     {"task_name": "/root/<name>"}. One whose output names neither (it
 *     failed, or it has no output) stays a plain spawn_agent call, so it is not
 *     a dispatch.
 *   - any other call: a tool_use under its own name. Call outputs are
 *     tool_results; a shell output that exited non-zero is an error.
 * Records of other types (event_msg, turn_context, reasoning and the rest)
 * are skipped. Throws UnknownShape when a record this reader uses has a shape
 * it does not know, including call arguments that are not a JSON object.
 */
import { UnknownShape, type Transcript, type TranscriptEvent } from './skill-contract';

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const META_PREFIX = /^\s*(?:<(?:environment_context|user_instructions|INSTRUCTIONS|skill|hook_prompt|subagent_notification|turn_aborted|user_shell_command|codex_internal_context|context_window_guidance|image_resize_notice|side_conversation)\b|# AGENTS\.md instructions)/;
const SKILL_INJECTION = /^\s*<skill>\s*<name>[^<]*<\/name>\s*<path>([^<]+)<\/path>/;
const GSTACK_SKILL_FILE = /(?:^|[\\/])skills[\\/](gstack-[A-Za-z0-9][A-Za-z0-9_-]*)[\\/]SKILL\.md$/;
const SHELL_SKILL_READ = /(?:^|[\\/\s'"=])skills[\\/](gstack-[A-Za-z0-9][A-Za-z0-9_-]*)[\\/]SKILL\.md(?=$|[\s'"`;|&)<>])/g;
const READ_PROGRAM = /(?:^|[\s;|&(`'"])(?:cat|sed|head|tail|nl|less|more|bat|awk|Get-Content)(?=\s)/;
const READ_FAILURE = /No such file|cannot open|can't read|cannot access|Permission denied|Is a directory/i;
const SHELL_SEPARATOR = /&&|\|\||[;|\n]/;
const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'local_shell']);
const EXIT_CODE = /(?:^|\n)Process exited with code (\d+)/;

/** Whether text is a Codex rollout: its first JSON object line is a session_meta record. */
export function isCodexRollout(text: string): boolean {
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(raw); } catch { continue; }
    return isObject(rec) && rec.type === 'session_meta' && isObject(rec.payload);
  }
  return false;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => isObject(c) && typeof c.text === 'string').map(c => c.text).join('\n');
}

function args(raw: unknown, line: number): Record<string, any> {
  if (isObject(raw)) return raw;
  let parsed: unknown;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined; } catch { /* reported below */ }
  if (!isObject(parsed)) throw new UnknownShape(`line ${line}: call arguments are not a JSON object`);
  return parsed;
}

function shellLine(input: Record<string, any>): string | null {
  for (const v of [input.cmd, input.command]) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every(p => typeof p === 'string')) return v.join(' ');
  }
  return null;
}

/** The gstack-* skills a shell line's read commands read, in order of appearance. */
function shellSkillReads(line: string): string[] {
  return line.split(SHELL_SEPARATOR).filter(cmd => READ_PROGRAM.test(cmd)).flatMap(cmd => [...cmd.matchAll(SHELL_SKILL_READ)].map(m => m[1]));
}

const readFailed = (output: string | undefined, skill: string) =>
  (output ?? '').split('\n').some(l => READ_FAILURE.test(l) && new RegExp(`skills[\\\\/]${skill}[\\\\/]SKILL\\.md`).test(l));

const exitedNonZero = (output: string | undefined) => {
  const code = output === undefined ? null : EXIT_CODE.exec(output);
  return !!code && code[1] !== '0';
};

const startedAgent = (output: string | undefined) => {
  if (output === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(output);
    return isObject(parsed) && [parsed.agent_id, parsed.task_name].some(id => typeof id === 'string' && id !== '');
  } catch {
    return false;
  }
};

const fromHarness = (payload: Record<string, any>) => {
  const items = payload.internal_chat_message_metadata_passthrough?.content_item_metadata;
  return Array.isArray(items) && items.some(m => isObject(m) && isObject(m.provenance) && m.provenance.type === 'harness');
};

/** The main-thread events of a Codex rollout; see the file header. */
export function parseCodexRollout(text: string): Transcript {
  const records: { line: number; type: string; payload: Record<string, any> }[] = [];
  for (const [idx, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (!isObject(rec) || typeof rec.type !== 'string') continue;
    if ((rec.type === 'session_meta' || rec.type === 'response_item') && !isObject(rec.payload)) {
      throw new UnknownShape(`line ${idx + 1}: ${rec.type} record without a payload object`);
    }
    if (isObject(rec.payload)) records.push({ line: idx + 1, type: rec.type, payload: rec.payload });
  }
  const outputs = new Map<string, string>();
  for (const r of records) {
    const p = r.payload;
    if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string') {
      outputs.set(p.call_id, contentText(isObject(p.output) ? p.output.content : p.output));
    }
  }
  const events: TranscriptEvent[] = [];
  let sessionId: string | null = null;
  let subagent = false;
  let messages = 0;
  let lastLoad: string | null = null;
  for (const { line, type, payload: p } of records) {
    if (type === 'session_meta') {
      if (sessionId === null && typeof p.id === 'string') sessionId = p.id;
      if (isObject(p.source) && 'subagent' in p.source) subagent = true;
      continue;
    }
    if (type !== 'response_item') continue;
    if (p.type === 'message') {
      if (!Array.isArray(p.content)) throw new UnknownShape(`line ${line}: message content is not a list`);
      messages++;
      const body = contentText(p.content);
      if (p.role === 'assistant') {
        if (body) events.push({ kind: 'text', line, text: body });
      } else if (p.role === 'user' && body) {
        const injected = SKILL_INJECTION.exec(body);
        const skill = injected ? GSTACK_SKILL_FILE.exec(injected[1].trim())?.[1] : undefined;
        if (skill) events.push({ kind: 'load', line, skill, via: 'injected' });
        const kind = META_PREFIX.test(body) || fromHarness(p) ? 'meta' : 'prompt';
        if (kind === 'prompt') lastLoad = null;
        if (skill) lastLoad = skill;
        events.push({ kind, line, text: body });
      }
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') {
      const id = String(p.call_id ?? '');
      const input = args(p.type === 'custom_tool_call' ? { input: p.input } : p.arguments, line);
      const command = SHELL_TOOLS.has(p.name) ? shellLine(input) : null;
      if (command !== null) {
        events.push({ kind: 'tool_use', line, id, name: 'Bash', input: { command } });
        for (const skill of shellSkillReads(command)) {
          if (skill === lastLoad || readFailed(outputs.get(id), skill)) continue;
          events.push({ kind: 'load', line, skill, via: 'read' });
          lastLoad = skill;
        }
      } else if (p.name === 'spawn_agent' && startedAgent(outputs.get(id))) {
        const prompt = [input.message, ...(Array.isArray(input.items) ? input.items.map((i: unknown) => (isObject(i) ? i.text : undefined)) : [])]
          .filter(v => typeof v === 'string').join('\n');
        events.push({ kind: 'tool_use', line, id, name: 'Agent', input: { prompt, ...(typeof input.agent_type === 'string' ? { subagent_type: input.agent_type } : {}) } });
      } else {
        events.push({ kind: 'tool_use', line, id, name: p.name, input });
      }
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string') {
      const out = outputs.get(p.call_id) ?? '';
      events.push({ kind: 'tool_result', line, id: p.call_id, text: out, isError: exitedNonZero(out) });
    }
  }
  if (messages === 0) throw new UnknownShape('Codex rollout has no response_item message records');
  return { events, sessionId, format: 'codex', ...(subagent ? { subagent: true } : {}) };
}
