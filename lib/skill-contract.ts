/**
 * skill-contract — the skill contract checker (GST-1088, lane A).
 *
 * A targeted skill declares the outputs that must exist before it is done, in
 * its SKILL.md frontmatter (schema frozen in plan-v2):
 *
 *   contract: { version: 1, items: [ { id, kind, ... } ] }
 *
 * checkContract() is a pure function of a Claude Code transcript (the JSONL a
 * hook payload's transcript_path names): the model never self-records. Waivers
 * are read the same way, from the `gstack-skill-contract waive` Bash calls in
 * that transcript, and count as misses for follow. The Stop hook
 * (hosts/claude/hooks/skill-contract-stop-hook.ts) and `gstack-skill-contract`
 * (check, report, waive) are its two callers; evals can reuse `check`.
 * Records live under $GSTACK_STATE_ROOT/skill-contracts/<session id>.json,
 * written atomically. Docs: docs/skill-routing-and-contracts.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteSync } from './fs-atomic';
import { lastBashWrite } from './shell-writes';
import { readFrontmatter, scanInstalledSkills } from './skill-route';
import { resolveStateRoot } from './state-root';

export const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
export const ITEM_KINDS = ['report_labels', 'check_after_last_edit', 'selected_specialists_dispatched', 'agent_dispatch'] as const;
export type ItemKind = typeof ITEM_KINDS[number];
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_ITEMS = 20;

/** Stable exit codes of gstack-skill-contract; each has an anchor in docs/skill-routing-and-contracts.md. */
export const EXIT = { MET: 0, UNMET: 1, USAGE: 2, STATE_ERROR: 3, UNKNOWN_SHAPE: 4, NO_CONTRACT: 5, NOT_LOADED: 6 } as const;
export const STATE_ERROR_DOC = 'docs/skill-routing-and-contracts.md#state-error';

export interface ContractItem {
  id: string;
  kind: ItemKind;
  heading?: string;
  labels?: string[];
  match?: string;
  marker?: string;
  empty_marker?: string;
  fix?: string;
  summary?: string;
}
export interface Contract { version: 1; items: ContractItem[] }

export class StateError extends Error {
  constructor(readonly file: string, readonly why: string) { super(`${file}: ${why}`); }
}
export class UnknownShape extends Error {}

export function stateErrorLine(file: string, why: string): string {
  return `gstack-skill-contract: SKILL_CONTRACT_STATE_ERROR ${file}: ${why}; stop allowed, miss not recorded (see ${STATE_ERROR_DOC})`;
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errText = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `contract:` key and its indented lines, or null when the frontmatter has none. */
export function contractBlock(frontmatter: string): string | null {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex(l => /^contract:/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
  return lines.slice(start, end).join('\n');
}

export function parseContract(frontmatter: string): { contract: Contract } | { error: string } | null {
  const block = contractBlock(frontmatter);
  if (block === null) return null;
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(block);
  } catch (e) {
    return { error: `contract block is not valid YAML (${errText(e)})` };
  }
  return validateContract(isObject(doc) ? doc.contract : undefined);
}

const STRING_FIELDS = ['heading', 'match', 'marker', 'empty_marker', 'fix', 'summary'] as const;
const REGEX_FIELDS = ['match'] as const;

/**
 * Every default matcher string the checker uses, in one table: edit it here. A contract item's own marker or
 * empty_marker replaces its row for that item. Markers are literal text in which a whole-word N is a number.
 */
export const DEFAULT_MATCHERS = {
  /** selected_specialists_dispatched: the selection line. The names are the rest of the line; N = 0 selects none. */
  specialistSelection: 'Dispatching N specialists:',
  /** selected_specialists_dispatched: a line that means no specialist was selected. */
  specialistsSkipped: 'specialists skipped',
  /** Any contract: a line of the turn's final message, starting with this, means the skill ended the run early (met). A final STATUS: BLOCKED does too. */
  earlyExit: 'Nothing to review',
} as const;

/**
 * A marker as a pattern: literal text, case-insensitive, any run of spaces matching any whitespace, and a whole-word
 * N matching a number (the first one captured as count). The names are the rest of that line.
 */
export function markerPattern(marker: string): RegExp {
  const literal = (s: string) => s.split(/\s+/).map(escapeRe).join('\\s+');
  const body = marker.split(/\bN\b/).map(literal).map((s, i) => (i === 0 ? s : `${i === 1 ? '(?<count>\\d+)' : '\\d+'}${s}`)).join('');
  return new RegExp(`${body}\\s*(?<names>[^\\n]*)`, 'i');
}

export function validateContract(raw: unknown): { contract: Contract } | { error: string } {
  if (!isObject(raw)) return { error: 'contract must be a mapping' };
  if (raw.version !== 1) return { error: `contract version ${JSON.stringify(raw.version)} is not supported (expected 1)` };
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > MAX_ITEMS) {
    return { error: `contract items must be a list of 1 to ${MAX_ITEMS} items` };
  }
  const items: ContractItem[] = [];
  for (const [n, item] of raw.items.entries()) {
    if (!isObject(item)) return { error: `items[${n}] must be a mapping` };
    const id = item.id;
    if (typeof id !== 'string' || !ITEM_ID.test(id)) return { error: `items[${n}].id must match ${ITEM_ID}` };
    if (items.some(i => i.id === id)) return { error: `duplicate item id ${id}` };
    if (!(ITEM_KINDS as readonly string[]).includes(item.kind)) {
      return { error: `${id}: unknown kind ${JSON.stringify(item.kind)} (expected one of ${ITEM_KINDS.join(', ')})` };
    }
    const out: ContractItem = { id, kind: item.kind };
    for (const field of STRING_FIELDS) {
      if (item[field] === undefined) continue;
      if (typeof item[field] !== 'string' || !item[field].trim()) return { error: `${id}: ${field} must be a non-empty string` };
      out[field] = item[field].trim();
    }
    for (const field of REGEX_FIELDS) {
      if (out[field] === undefined) continue;
      try { new RegExp(out[field] as string, 'i'); } catch { return { error: `${id}: ${field} is not a valid regular expression` }; }
    }
    if (out.kind === 'report_labels') {
      if (!out.heading) return { error: `${id}: report_labels needs a heading` };
      if (!Array.isArray(item.labels) || !item.labels.length || item.labels.some((l: unknown) => typeof l !== 'string' || !l.trim())) {
        return { error: `${id}: report_labels needs labels, a list of non-empty strings` };
      }
      out.labels = item.labels.map((l: string) => l.trim());
    }
    if (out.kind === 'agent_dispatch' && !out.match) return { error: `${id}: agent_dispatch needs match` };
    if (out.kind === 'agent_dispatch' && out.marker) return { error: `${id}: agent_dispatch takes no marker until the checker can bind a marker to the dispatch it names (GST-1242)` };
    items.push(out);
  }
  return { contract: { version: 1, items } };
}

/** One plain phrase per item, for the routing hint's "Done means" variant. */
export function itemSummary(item: ContractItem): string {
  if (item.summary) return item.summary;
  switch (item.kind) {
    case 'report_labels': return `a ${item.heading} with ${(item.labels ?? []).join(', ')}`;
    case 'check_after_last_edit': return 'a test or repro run after your last edit';
    case 'selected_specialists_dispatched': return 'one Agent dispatch per selected specialist';
    case 'agent_dispatch': return `an Agent dispatch matching /${item.match}/`;
  }
}

export type TranscriptEvent =
  | { kind: 'prompt' | 'meta' | 'text'; line: number; text: string }
  | { kind: 'tool_use'; line: number; id: string; name: string; input: Record<string, any>; cwd?: string }
  | { kind: 'tool_result'; line: number; id: string; text: string; isError: boolean };
/** cwd is the session directory: the first record's working directory, when the transcript names one. */
export interface Transcript { events: TranscriptEvent[]; sessionId: string | null; cwd?: string | null }

const META_PREFIX = /^\s*<(?:local-command-stdout|local-command-stderr|system-reminder|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b/;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => isObject(b) && typeof b.text === 'string').map(b => b.text).join('\n');
}

/**
 * Main-thread events of a Claude Code transcript JSONL. Sidechain (subagent) records are skipped unless
 * includeSidechain is set (a subagent's own agent-<id>.jsonl holds only sidechain records); unparseable lines (a
 * partial last line) are skipped. Throws UnknownShape when the file is not a transcript this parser knows.
 */
export function parseTranscript(text: string, opts: { includeSidechain?: boolean } = {}): Transcript {
  const events: TranscriptEvent[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let lines = 0;
  let objects = 0;
  let messages = 0;
  for (const [idx, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    lines++;
    let rec: unknown;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (!isObject(rec)) continue;
    objects++;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const line = idx + 1;
    if (!isObject(rec.message)) throw new UnknownShape(`line ${line}: ${rec.type} record without a message object`);
    const content = rec.message.content;
    if (typeof content !== 'string' && !Array.isArray(content)) throw new UnknownShape(`line ${line}: message content is neither text nor a block list`);
    messages++;
    if (rec.isSidechain === true && !opts.includeSidechain) continue;
    if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (rec.type === 'assistant') {
        if (block.type === 'text' && typeof block.text === 'string') events.push({ kind: 'text', line, text: block.text });
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          events.push({ kind: 'tool_use', line, id: String(block.id ?? ''), name: block.name, input: isObject(block.input) ? block.input : {}, ...(typeof rec.cwd === 'string' ? { cwd: rec.cwd } : {}) });
        }
      } else if (block.type === 'tool_result') {
        events.push({ kind: 'tool_result', line, id: String(block.tool_use_id ?? ''), text: blockText(block.content), isError: block.is_error === true });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ kind: rec.isMeta === true || META_PREFIX.test(block.text) ? 'meta' : 'prompt', line, text: block.text });
      }
    }
  }
  if (lines > 0 && objects === 0) throw new UnknownShape('no line is a JSON object');
  if (objects > 0 && messages === 0) throw new UnknownShape('no user or assistant message records');
  return { events, sessionId, cwd };
}

/**
 * The transcript with the Stop payload's last_assistant_message as its final text, when the file does not end on it
 * yet: Claude Code can fire Stop before it writes the turn's last message.
 */
export function withFinalMessage(t: Transcript, message: unknown): Transcript {
  if (typeof message !== 'string' || !message.trim()) return t;
  const lastPrompt = t.events.map(e => e.kind).lastIndexOf('prompt');
  const lastText = t.events.slice(lastPrompt + 1).filter(e => e.kind === 'text').pop() as { text: string } | undefined;
  if (lastText?.text.trim() === message.trim()) return t;
  const line = (t.events[t.events.length - 1]?.line ?? 0) + 1;
  return { ...t, events: [...t.events, { kind: 'text', line, text: message }] };
}

export function readTranscriptFile(file: string): string {
  try {
    const size = fs.statSync(file).size;
    if (size > TRANSCRIPT_MAX_BYTES) throw new StateError(file, `transcript is ${size} bytes, over the ${TRANSCRIPT_MAX_BYTES} byte read limit`);
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof StateError) throw e;
    throw new StateError(file, `cannot read transcript (${errText(e)})`);
  }
}

export const canonicalSkill = (name: string) => name.trim().toLowerCase().replace(/^\//, '').replace(/^gstack:/, '');
export function sameSkill(a: string, b: string): boolean {
  const x = canonicalSkill(a);
  const y = canonicalSkill(b);
  return x === y || x === `gstack-${y}` || `gstack-${x}` === y;
}

export interface SkillLoad { skill: string; at: number; line: number; via: 'skill-tool' | 'slash-command' | 'read' }

/** Every skill load in order: a Skill tool call, a typed /command, or a Read of a SKILL.md under a skills/ directory (an installed skill, not a checkout's source). */
export function skillLoads(t: Transcript): SkillLoad[] {
  const loads: SkillLoad[] = [];
  t.events.forEach((e, at) => {
    if (e.kind === 'tool_use' && e.name === 'Skill') {
      const name = e.input.skill ?? e.input.command;
      if (typeof name === 'string' && name.trim()) loads.push({ skill: canonicalSkill(name.split(/\s/)[0]), at, line: e.line, via: 'skill-tool' });
    } else if (e.kind === 'tool_use' && e.name === 'Read' && typeof e.input.file_path === 'string') {
      const m = /(?:^|[\\/])skills[\\/](?:.*[\\/])?([^\\/]+)[\\/]SKILL\.md$/.exec(e.input.file_path);
      if (m) loads.push({ skill: canonicalSkill(m[1]), at, line: e.line, via: 'read' });
    } else if (e.kind === 'prompt') {
      const m = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(e.text);
      if (m) loads.push({ skill: canonicalSkill(m[1]), at, line: e.line, via: 'slash-command' });
    }
  });
  return loads;
}

export const STATUS_RE = /^[ \t>*_-]*(?:\*\*|__)?(?:STATUS|Status)(?:\*\*|__)?[ \t]*(?:\*\*|__)?:[ \t]*(?:\*\*|__)?[ \t]*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/m;
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const AGENT_TOOLS = /^(?:Agent|Task)$/;
const TEST_RUNNER = /^(?:pytest|py\.test|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox|tsc|rake|playwright|cypress)$/i;
const CHECK_SCRIPT = /(?:^|[-_.:])(?:tests?|spec|repro|check|typecheck|verify|lint)(?:[-_.:]|$)/i;
const CHECK_VERB = /^(?:tests?|t|check|verify|spec|vet|clippy|nextest|lint|e2e)$/i;
const SUBCOMMAND_TOOL = /^(?:make|cargo|go|dotnet|swift|mix|bazel|just|dart|flutter|rails|mvn|gradlew?|xcodebuild|bun|npm|pnpm|yarn|deno)$/i;
const RUNS_PROGRAM = /^(?:cargo|go|dotnet|swift)$/i;
const PACKAGE_EXEC = /^(?:npx|bunx|pnpx)$/i;
const INTERPRETER = /^(?:node|python3?|ruby|php|perl|tsx|ts-node)$/i;
const FILE_INTERPRETER = /^(?:bun|deno)$/i;
const COMMAND_WRAPPER = /^(?:bundle|uv|poetry|pipenv|docker|podman|xvfb-run|bash|sh|zsh)$/;
const COMMAND_PREFIX = /^(?:env|sudo|time|nice|timeout|command|exec|\w+=\S*|-\S*|\d+[smh]?)$/;
const SCRIPT_ARG = /[\\/]|\.(?:[cm]?[jt]sx?|py|rb|php|pl|sh)$/;
/** Options whose next word is their value (`make -C web test`, `pnpm --filter app test`, `xcodebuild -scheme App test`). */
const VALUE_FLAG = /^(?:-[CfpwF]|--(?:prefix|filter|cwd|dir|directory|workspace|package|manifest-path|project|file)|-(?:scheme|project|workspace|destination|configuration|target|sdk))$/;
const WRAPPER_DEPTH = 3;
const baseName = (word: string) => word.split(/[\\/]/).pop() ?? '';
const isCheckScript = (word: string) => { const name = baseName(word); return name !== 'test' && CHECK_SCRIPT.test(name); };

/** The words after the program that are not options or option values. */
function positionals(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '--') break;
    if (!words[i].startsWith('-')) out.push(words[i]);
    else if (VALUE_FLAG.test(words[i])) i++;
  }
  return out;
}

/**
 * One command's words (prefixes removed): does it run tests, a check, or a repro? Installs, builds and version probes
 * do not. Wrappers nest at most WRAPPER_DEPTH deep, so a long chain of wrapper words costs linear time, not exponential.
 */
function runsCheck(words: string[], depth = 0): boolean {
  const program = baseName(words[0] ?? '');
  const args = positionals(words);
  if (TEST_RUNNER.test(program) || isCheckScript(words[0] ?? '')) return true;
  if (depth < WRAPPER_DEPTH && PACKAGE_EXEC.test(program)) return runsCheck(words.slice(1).filter(w => !w.startsWith('-')), depth + 1);
  if (COMMAND_WRAPPER.test(program)) return depth < WRAPPER_DEPTH && [1, 2, 3, 4, 5].some(i => i < words.length && runsCheck(words.slice(i), depth + 1));
  if (INTERPRETER.test(program)) return args.length > 0 || words.slice(1).some(w => /^-[ecm]$|^--test$/.test(w));
  if (program === 'curl') return args.some(a => /^https?:\/\/|^localhost|^127\./.test(a));
  if (FILE_INTERPRETER.test(program) && args[0] && SCRIPT_ARG.test(args[0])) return true;
  if (!SUBCOMMAND_TOOL.test(program) || !args[0]) return false;
  const [verb, next] = args;
  if (CHECK_VERB.test(verb) || isCheckScript(verb) || args.some(a => CHECK_VERB.test(a))) return true;
  if (verb === 'run' || verb === 'exec' || verb === 'x') return RUNS_PROGRAM.test(program) || (!!next && (CHECK_VERB.test(next) || isCheckScript(next) || TEST_RUNNER.test(baseName(next)) || SCRIPT_ARG.test(next)));
  return /^(?:yarn|pnpm)$/i.test(program) && TEST_RUNNER.test(verb);
}
const SAFE_SPECIALIST = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

/**
 * A test or repro run: some segment of the command (split on && || ; | and newlines) runs a test runner, a test verb
 * (`npm test`, `go test`, `make check`), a test, check or repro script, or code through an interpreter, directly or
 * behind a wrapper (bundle exec, uv run, docker compose run, xvfb-run, bash). Installs, builds and version probes do not count.
 */
export function isCheckCommand(cmd: string): boolean {
  return cmd.split(/&&|\|\||[;|\n]/).some(segment => {
    const words = segment.trim().replace(/^[({]\s*/, '').split(/\s+/);
    while (words.length > 1 && COMMAND_PREFIX.test(words[0])) words.shift();
    return runsCheck(words);
  });
}
const WAIVE_RE = /gstack-skill-contract["']?\s+waive\s+["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?/;

type ToolUse = Extract<TranscriptEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<TranscriptEvent, { kind: 'tool_result' }>;
const isToolUse = (e: TranscriptEvent): e is ToolUse => e.kind === 'tool_use';
const bashCommand = (e: TranscriptEvent) => (isToolUse(e) && e.name === 'Bash' ? String(e.input.command ?? '') : null);
const agentText = (e: ToolUse) => [e.input.description, e.input.prompt, e.input.subagent_type, e.input.name].filter(v => typeof v === 'string').join('\n');
const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 3)}...` : s).replace(/\s+/g, ' ');

export function labelValue(text: string, label: string): string | null {
  const re = new RegExp(`^[ \\t>*_|-]*(?:\\*\\*|__)?${escapeRe(label)}[ \\t]*(?:\\*\\*|__)?[ \\t]*:[ \\t]*(?:\\*\\*|__)?(.*)$`, 'im');
  const m = re.exec(text);
  return m ? m[1].replace(/(?:\*\*|__)\s*$/, '').replace(/^`+|`+$/g, '').trim() : null;
}

export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return !v || /^\[[^\]]*\]$/.test(v) || /^<[^>]*>$/.test(v) || /^[A-Z_]+(?:\s*\|\s*[A-Z_]+)+$/.test(v) ||
    /^(?:tbd|tba|todo|xxx|fixme|placeholder|\.{2,}|…|-+|—|\?+)$/i.test(v);
}

function parseNames(raw: string): string[] {
  const end = raw.search(/\.\s|\.$|\s(?:Skipped|Gated)\s*:/i);
  return (end < 0 ? raw : raw.slice(0, end)).replace(/\([^)]*\)/g, ' ').split(/,|;|\band\b/)
    .map(n => n.replace(/[[\]()"'`*]/g, '').trim()).filter(n => n && !/^none$/i.test(n));
}

interface ItemCheck { met: boolean; detail: string; fix: string }

function checkItem(item: ContractItem, run: TranscriptEvent[], root: string | null): ItemCheck {
  const texts = run.filter(e => e.kind === 'text').map(e => (e as { text: string }).text);
  const agents = run.filter((e): e is ToolUse => isToolUse(e) && AGENT_TOOLS.test(e.name));
  switch (item.kind) {
    case 'report_labels': {
      const heading = item.heading as string;
      const labels = item.labels ?? [];
      const headingRe = new RegExp(escapeRe(heading), 'i');
      const source = [...texts].reverse().find(t => headingRe.test(t));
      if (!source) return { met: false, detail: `no ${heading} found`, fix: item.fix ?? `print the ${heading} with real values for ${labels.join(', ')}` };
      const after = source.slice(source.search(headingRe));
      const bad = labels.filter(label => { const v = labelValue(after, label); return v === null || isPlaceholder(v); });
      return bad.length
        ? { met: false, detail: `${heading} lacks a real value for ${bad.join(', ')}`, fix: item.fix ?? `fill ${bad.join(', ')} in the ${heading} with real values` }
        : { met: true, detail: `${heading} has all ${labels.length} labels`, fix: '' };
    }
    case 'check_after_last_edit': {
      let lastEdit = -1;
      let edit = '';
      let sameCall = '';
      run.forEach((e, i) => {
        if (!isToolUse(e)) return;
        const cmd = bashCommand(e);
        const write = cmd === null ? null : lastBashWrite(cmd, e.cwd ?? root, root);
        if (write) [lastEdit, edit, sameCall] = [i, `Bash write (${cut(write.files.join(', '), 60)})`, write.after];
        else if (EDIT_TOOLS.test(e.name)) [lastEdit, edit, sameCall] = [i, e.name, ''];
      });
      if (lastEdit < 0) return { met: true, detail: 'no edits since the skill loaded', fix: '' };
      const re = item.match ? new RegExp(item.match, 'i') : null;
      const check = [sameCall || null, ...run.slice(lastEdit + 1).map(bashCommand)].find(cmd => {
        if (!cmd || /gstack-skill-contract/.test(cmd)) return false;
        const bare = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
        return re ? re.test(bare) : isCheckCommand(bare);
      });
      return check
        ? { met: true, detail: `ran "${cut(check)}" after the last edit`, fix: '' }
        : { met: false, detail: `no test or repro command after the last ${edit}`, fix: item.fix ?? 'run the test or repro again after your last edit and show its result' };
    }
    case 'selected_specialists_dispatched': {
      const marker = markerPattern(item.marker ?? DEFAULT_MATCHERS.specialistSelection);
      const empty = markerPattern(item.empty_marker ?? DEFAULT_MATCHERS.specialistsSkipped);
      const bashIds = new Set(run.filter(e => bashCommand(e) !== null).map(e => (e as ToolUse).id));
      const sources = run.filter(e => e.kind === 'text' || (e.kind === 'tool_result' && bashIds.has(e.id))).map(e => (e as { text: string }).text).reverse();
      let names: string[] | null = null;
      for (const src of sources) {
        const m = marker.exec(src);
        const parsed = m ? (m.groups?.count === '0' ? [] : parseNames(m.groups?.names ?? '')) : null;
        if (parsed && parsed.every(n => SAFE_SPECIALIST.test(n))) { names = parsed; break; }
        if (empty.test(src)) { names = []; break; }
      }
      if (names === null) return { met: false, detail: 'no specialist selection line found', fix: item.fix ?? 'print the specialist selection line, then dispatch one Agent per selected specialist' };
      if (!names.length) return { met: true, detail: 'no specialists selected', fix: '' };
      const missing = names.filter(n => {
        const forms = [n, n.replace(/\s+/g, '-'), n.replace(/\s+/g, '_')].map(f => f.toLowerCase());
        return !agents.some(a => forms.some(f => agentText(a).toLowerCase().includes(f)));
      });
      return missing.length
        ? { met: false, detail: `selected ${names.join(', ')}; no Agent dispatch for ${missing.join(', ')}`, fix: item.fix ?? `dispatch an Agent for ${missing.join(', ')}` }
        : { met: true, detail: `dispatched ${names.join(', ')}`, fix: '' };
    }
    case 'agent_dispatch': {
      const re = new RegExp(item.match as string, 'i');
      return agents.some(a => re.test(agentText(a)))
        ? { met: true, detail: `an Agent dispatch matches /${item.match}/`, fix: '' }
        : { met: false, detail: `no Agent dispatch matches /${item.match}/`, fix: item.fix ?? `dispatch the Agent pass matching /${item.match}/` };
    }
  }
}

/** Waivers in a run: item id -> reason, from waive Bash calls whose result (if any) is not an error. */
function waivers(run: TranscriptEvent[], skill: string, results: Map<string, ToolResult>): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of run) {
    const cmd = bashCommand(e);
    const m = cmd === null ? null : WAIVE_RE.exec(cmd);
    if (!m || !cmd) continue;
    const reason = /--reason[= ]\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(cmd);
    const text = reason ? (reason[1] ?? reason[2] ?? reason[3] ?? '').trim() : '';
    const skillFlag = /--skill[= ]\s*["']?([^\s"']+)/.exec(cmd);
    if (!text || (skillFlag && !sameSkill(skillFlag[1], skill)) || results.get((e as ToolUse).id)?.isError) continue;
    out.set(m[1], text);
  }
  return out;
}

export interface ItemResult { id: string; kind: ItemKind; status: 'met' | 'missing' | 'waived'; detail: string; fix: string; reason?: string }
export interface CheckResult {
  skill: string;
  version: 1;
  loaded: boolean;
  load: SkillLoad | null;
  items: ItemResult[];
  missing: string[];
  waived: string[];
  /** every item met or waived: nothing to block on */
  met: boolean;
  /** every item met with no waiver: what follow-rate metrics count */
  follow: boolean;
  statusLine: string | null;
  pendingQuestion: boolean;
  pendingAgents: string[];
}

/**
 * The contract against one run of the skill: from its load (the last one, or the one at loadLine) to its next load.
 * Pure: same transcript, same result.
 */
export function checkContract(t: Transcript, skill: string, contract: Contract, opts: { loadLine?: number } = {}): CheckResult {
  const events = t.events;
  const loads = skillLoads(t).filter(l => sameSkill(l.skill, skill));
  const load = (opts.loadLine === undefined ? loads[loads.length - 1] : loads.find(l => l.line === opts.loadLine)) ?? null;
  const next = load ? loads.find(l => l.at > load.at) : undefined;
  const run = load ? events.slice(load.at + 1, next?.at) : [];
  const results = new Map<string, ToolResult>();
  for (const e of run) if (e.kind === 'tool_result') results.set(e.id, e);
  const waived = load ? waivers(run, skill, results) : new Map<string, string>();
  const { statusLine, pendingQuestion, finalText } = turnEnd(t);
  const exitMarker = new RegExp(`^[ \\t>*_-]*${markerPattern(DEFAULT_MATCHERS.earlyExit).source}`, 'im');
  const endedEarly = !!finalText && run.includes(finalText as TranscriptEvent) && exitMarker.test(finalText.text);
  const earlyExit = !load ? null : statusLine === 'BLOCKED' ? 'STATUS: BLOCKED' : endedEarly ? DEFAULT_MATCHERS.earlyExit : null;
  const items: ItemResult[] = load ? contract.items.map(item => {
    if (earlyExit) return { id: item.id, kind: item.kind, status: 'met', detail: `the skill ended the run early (${earlyExit})`, fix: '' };
    const r = checkItem(item, run, t.cwd ?? null);
    if (r.met) return { id: item.id, kind: item.kind, status: 'met', detail: r.detail, fix: '' };
    const reason = waived.get(item.id);
    return reason ? { id: item.id, kind: item.kind, status: 'waived', detail: r.detail, fix: r.fix, reason } : { id: item.id, kind: item.kind, status: 'missing', detail: r.detail, fix: r.fix };
  }) : [];
  const pendingAgents = run.flatMap((e, i) => {
    if (!isToolUse(e) || !AGENT_TOOLS.test(e.name)) return [];
    const result = results.get(e.id);
    if (!result) return [e.id];
    const resultAt = run.indexOf(result);
    const ids = [e.id, ...[...result.text.matchAll(/\b(?:agent|task)[_ -]?id["']?\s*[:=]\s*["']?([\w-]+)/gi)].map(m => m[1])].filter(Boolean);
    const named = ids.map(id => new RegExp(`(?:^|[^\\w-])${escapeRe(id)}(?:[^\\w-]|$)`));
    const notified = run.slice(resultAt + 1).some(n => n.kind === 'meta' && named.some(re => re.test(n.text)));
    return e.input.run_in_background === true && i < resultAt && !notified ? [e.id] : [];
  });
  const missing = items.filter(i => i.status === 'missing').map(i => i.id);
  const waivedIds = items.filter(i => i.status === 'waived').map(i => i.id);
  return {
    skill, version: 1, loaded: !!load, load, items, missing, waived: waivedIds,
    met: !!load && missing.length === 0, follow: !!load && missing.length === 0 && waivedIds.length === 0,
    statusLine, pendingQuestion, pendingAgents,
  };
}

export interface TurnEnd { statusLine: string | null; pendingQuestion: boolean; finalText?: { text: string } }

/** How the last turn ends: its last text's STATUS line, and whether it waits on the user (NEEDS_CONTEXT, an AskUserQuestion call, or a closing question). */
export function turnEnd(t: Transcript): TurnEnd {
  const lastPrompt = t.events.map(e => e.kind).lastIndexOf('prompt');
  const turn = t.events.slice(lastPrompt + 1).filter(e => e.kind === 'text' || e.kind === 'tool_use');
  const final = turn[turn.length - 1];
  const finalText = [...turn].reverse().find(e => e.kind === 'text') as { text: string } | undefined;
  const statusLine = finalText ? STATUS_RE.exec(finalText.text)?.[1] ?? null : null;
  const lastParagraph = (finalText?.text ?? '').trim().split(/\n\s*\n/).pop() ?? '';
  const pendingQuestion = statusLine === 'NEEDS_CONTEXT' || (final !== undefined && isToolUse(final) && /AskUserQuestion$/.test(final.name)) ||
    (final !== undefined && final.kind === 'text' && /\?[\s*_)"']*$/.test(lastParagraph));
  return { statusLine, pendingQuestion, finalText };
}

/** A final turn: a STATUS line other than NEEDS_CONTEXT, a turn that does not wait on the user, or a session no human answers. sessionKind runs only in the last case. */
export function isFinalTurn(end: Pick<TurnEnd, 'statusLine' | 'pendingQuestion'>, sessionKind: () => string): boolean {
  if (end.statusLine && end.statusLine !== 'NEEDS_CONTEXT') return true;
  if (!end.pendingQuestion) return true;
  const kind = sessionKind();
  return kind === 'headless' || kind === 'unattended';
}

/** The one agent-facing block text (gate rev 2, E1). It never names the off switch: that is for humans, in the docs and setup. */
export function blockMessage(result: CheckResult, bin: string): string {
  const fixes = result.items.filter(i => i.status === 'missing').map(i => `${i.id}: ${i.fix}`).join('; ');
  return `SKILL_CONTRACT_UNMET ${result.skill} (contract v1): missing ${result.missing.join(', ')}. Fix: ${fixes}. ` +
    `If an item truly does not apply, run '${bin.replaceAll("'", "'\\''")}' waive <item> --reason "<why>" (this session only; counted as a miss for follow). This blocks once.`;
}

export type ContractLookup =
  | { skill: string; file: string; contract: Contract }
  | { skill: string; file: string | null; error: string; reason: 'not-found' | 'no-contract' | 'invalid' };

/** The contract of an installed skill (by frontmatter name or directory), or of an explicit SKILL.md. */
export function lookupContract(skill: string, skillsDir: string, skillFile?: string): ContractLookup {
  let file: string | null = skillFile ?? null;
  let frontmatter: string | null = null;
  if (file) {
    try { frontmatter = readFrontmatter(file); } catch (e) { return { skill, file, error: `cannot read ${file} (${errText(e)})`, reason: 'not-found' }; }
  } else {
    const found = scanInstalledSkills(skillsDir).skills.find(s => sameSkill(s.name, skill) || sameSkill(path.basename(path.dirname(s.file)), skill));
    if (found) { file = found.file; frontmatter = found.frontmatter; }
  }
  if (!file) return { skill, file, error: `no installed skill named ${skill} under ${skillsDir}`, reason: 'not-found' };
  const parsed = frontmatter === null ? null : parseContract(frontmatter);
  if (parsed === null) return { skill, file, error: `${file} declares no contract`, reason: 'no-contract' };
  return 'error' in parsed ? { skill, file, error: `${file}: ${parsed.error}`, reason: 'invalid' } : { skill, file, contract: parsed.contract };
}

export type Outcome = 'met' | 'met_waived' | 'blocked' | 'met_after_block' | 'miss' | 'deferred';
/** deferred_agents: the Agent dispatches still running at the last stop the hook let through unchecked; deferred_at: when that set was first seen. */
export interface RunRecord { skill: string; load_line: number; outcome: Outcome; missing: string[]; waived: string[]; blocked_at?: string; deferred_agents?: string[]; deferred_at?: string; updated_at: string }
/** The same Agent dispatches still running this long after the stop that first saw them count as stalled. */
export const AGENT_STALL_MS = 10 * 60 * 1000;
export interface SessionRecord { version: 1; session_id: string; transcript_path: string; runs: Record<string, RunRecord> }

export function recordsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateRoot(env), 'skill-contracts');
}

export function recordPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  if (!safe) throw new StateError(recordsDir(env), 'hook payload has no session_id');
  return path.join(recordsDir(env), `${safe}.json`);
}

export const runKey = (skill: string, load: SkillLoad) => `${canonicalSkill(skill)}@${load.line}`;

export function readRecord(file: string): SessionRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR') return null;
    throw new StateError(file, `cannot read record (${errText(e)})`);
  }
  let rec: unknown;
  try { rec = JSON.parse(text); } catch { throw new StateError(file, 'corrupt record (not JSON)'); }
  if (!isObject(rec) || rec.version !== 1 || typeof rec.session_id !== 'string' || !isObject(rec.runs)) {
    throw new StateError(file, 'corrupt record (unexpected shape)');
  }
  return rec as SessionRecord;
}

export function writeRecord(file: string, rec: SessionRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteSync(file, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    throw new StateError(file, `cannot write record (${errText(e)})`);
  }
}

/**
 * Block at most once per skill run: an unmet contract blocks unless this run was already blocked, which makes it a miss.
 * A run recorded met, met_waived or met_after_block is final: later unrelated turns in the session never reopen it.
 */
export function nextOutcome(prev: RunRecord | undefined, result: CheckResult): { outcome: Outcome; block: boolean } {
  if (prev && (prev.outcome === 'met' || prev.outcome === 'met_waived' || prev.outcome === 'met_after_block')) return { outcome: prev.outcome, block: false };
  if (result.met) return { outcome: prev?.blocked_at ? 'met_after_block' : result.waived.length ? 'met_waived' : 'met', block: false };
  return prev?.blocked_at ? { outcome: 'miss', block: false } : { outcome: 'blocked', block: true };
}

/** Count one unknown transcript shape in $GSTACK_STATE_ROOT/hooks/skill-contract.canary.json; returns the new count, 0 when it cannot be written. */
export function bumpCanary(why: string, env: NodeJS.ProcessEnv = process.env): number {
  try {
    const file = path.join(resolveStateRoot(env), 'hooks', 'skill-contract.canary.json');
    let count = 0;
    try { count = Number(JSON.parse(fs.readFileSync(file, 'utf8')).count) || 0; } catch { /* first one */ }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteSync(file, `${JSON.stringify({ count: count + 1, last_cause: why, updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    return count + 1;
  } catch {
    return 0;
  }
}

export interface ReportRow { session: string; skill: string; outcome: Outcome | 'fixed_after_block'; missing: string[]; waived: string[]; transcript: string }

/** Every recorded run; a run still marked blocked or deferred is re-checked against its transcript when a recheck is given. */
export function reportRows(records: SessionRecord[], recheck?: (rec: SessionRecord, run: RunRecord) => CheckResult | null): ReportRow[] {
  return records.flatMap(rec => Object.values(rec.runs).map(run => {
    const row: ReportRow = { session: rec.session_id, skill: run.skill, outcome: run.outcome, missing: run.missing, waived: run.waived, transcript: rec.transcript_path };
    if ((run.outcome !== 'blocked' && run.outcome !== 'deferred') || !recheck) return row;
    const again = recheck(rec, run);
    if (!again) return row;
    if (!again.met) return { ...row, outcome: 'miss' as const, missing: again.missing, waived: again.waived };
    return { ...row, outcome: run.outcome === 'blocked' ? 'fixed_after_block' as const : 'met' as const, missing: [], waived: again.waived };
  }));
}

/** A miss for follow: blocked and never fixed, stopped again unmet, or met only through a waiver. */
export const isMiss = (row: ReportRow) => row.outcome === 'blocked' || row.outcome === 'miss' || row.waived.length > 0;

export function readAllRecords(env: NodeJS.ProcessEnv = process.env): { records: SessionRecord[]; errors: string[] } {
  const dir = recordsDir(env);
  const records: SessionRecord[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch { return { records, errors }; }
  for (const name of names) {
    try {
      const rec = readRecord(path.join(dir, name));
      if (rec) records.push(rec);
    } catch (e) {
      errors.push(e instanceof StateError ? `${e.file}: ${e.why}` : String(e));
    }
  }
  return { records, errors };
}
