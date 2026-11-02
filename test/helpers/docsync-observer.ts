import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { observeQAWrites, type QAWriteObservation } from './qa-functional-observer';
import { nativeCalls } from './qa-checkpoint-evidence';
import type { SkillTestResult } from './session-runner';
import { DOC_PATH, type DocsScenario, type fixtureDocs } from './docsync-fixture';
import { docsNativeInterface, DOCS_AUDIT_RECORD, DOCS_AUDIT_RECORD_PATHS, DOCS_AUDIT_RESET, DOCS_TMP_EXCLUDE, docsCapsCommand } from './docsync-interface';
import { sliceBetween } from './skill-fixture';
import { readOnlyCommandAllowed } from './read-only-commands';

export { docsNativeInterface };

export async function observeDocsWrites(fixture: ReturnType<typeof fixtureDocs>) {
  return observeQAWrites(fixture.repo, { atomicTargets: [DOC_PATH, DOCS_AUDIT_RECORD] });
}

/** Temp files the Write/Edit tool renamed onto the receipt record (`<record>.tmp.<pid>.<12 hex>`): created, written and closed
 *  under the record's directory, then moved onto the record by a cookie-paired MOVED_FROM/MOVED_TO, and not left behind. */
function docsRecordSources(observation: QAWriteObservation): Set<string> {
  const sources = new Set<string>();
  const events = observation.events;
  for (const [index, event] of events.entries()) {
    if (event.path !== DOCS_AUDIT_RECORD || event.mask !== 0x80 || !Number.isInteger(event.cookie) || event.cookie <= 0) continue;
    const pair = events.flatMap((candidate, at) => candidate.cookie === event.cookie ? [at] : []);
    if (pair.length !== 2 || pair[1] !== index) continue;
    const source = events[pair[0]];
    if (source.mask !== 0x40 || !source.path.startsWith(DOCS_AUDIT_RECORD + '.tmp.') || !/^\.tmp\.[1-9]\d*\.[0-9a-f]{12}$/.test(source.path.slice(DOCS_AUDIT_RECORD.length))
      || Object.hasOwn(observation.before, source.path) || Object.hasOwn(observation.after, source.path) || observation.changed.includes(source.path)) continue;
    const lifecycle = events.filter(candidate => candidate.path === source.path);
    if (lifecycle.at(-1) !== source || lifecycle.some(candidate => candidate !== source && (candidate.cookie !== 0 || ![0x100, 0x2, 0x4, 0x8].includes(candidate.mask)))) continue;
    sources.add(source.path);
  }
  return sources;
}

type DocsWriteContext = {
  result: SkillTestResult;
  fixture: ReturnType<typeof fixtureDocs>;
  scripts?: string[];
  readOnly?: boolean;
};

/** Atomic temp files proven to be native replacements of DOC_PATH; `deniedAt` names the first unmet check. */
function docsAtomicSources(observation: QAWriteObservation, allowed: string[], context?: DocsWriteContext): Set<string> & { deniedAt?: string } {
  const denied: Set<string> & { deniedAt?: string } = new Set<string>();
  const deny = (line: number, cause?: string[]) => { denied.deniedAt = `docsync-observer.ts:${line}${cause?.length ? ` (${[...new Set(cause)].join('; ')})` : ''}`; return denied; };
  if (!context || context.readOnly || !allowed.includes(DOC_PATH) || !observation.complete || observation.failures.length) return denied;
  const { result, fixture, scripts = [] } = context;
  if (result.exitReason !== 'success' || !Array.isArray(result.transcript)) return deny(27);
  const toolFailures = docsToolFailures(result, fixture, scripts);
  if (toolFailures.length) return deny(29, toolFailures);
  const failures: string[] = [];
  const target = path.join(fixture.repo, DOC_PATH);
  const native = nativeCalls(result.transcript, failures);
  const calls = native.filter(call => ['Write', 'Edit'].includes(call.name)
    && typeof call.input.file_path === 'string' && path.resolve(fixture.repo, call.input.file_path) === target);
  if (failures.length || !calls.length || calls.some((call, index) => call.failed || call.end <= call.start || (index > 0 && call.start <= calls[index - 1].end))) return deny(35);
  const before = observation.before[DOC_PATH];
  const after = observation.after[DOC_PATH];
  if (!/^\d+:[a-f0-9]{64}$/.test(before ?? '') || !/^\d+:[a-f0-9]{64}$/.test(after ?? '') || before.split(':')[0] !== after.split(':')[0]) return deny(38);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const encoded = fixture.before?.contents[DOC_PATH];
  if (typeof encoded !== 'string') return deny(41);
  const baseline = Buffer.from(encoded, 'base64');
  let content = baseline.toString('utf8');
  let contentHash = before.split(':')[1];
  if (baseline.toString('base64') !== encoded || !Buffer.from(content).equals(baseline) || hash(content) !== contentHash) return deny(45);
  const seen = new Set([contentHash]);
  for (const call of calls) {
    const event = result.transcript[call.end];
    const payload = event.tool_use_result;
    const results = event.message.content.filter((block: any) => block?.type === 'tool_result');
    if (results.length !== 1 || (results[0].is_error !== undefined && results[0].is_error !== false)) return deny(51);
    const omitted = !Object.hasOwn(event, 'tool_use_result');
    if (omitted) {
      if (call.parent === null) return deny(54);
      let child = call;
      const ancestors = new Set<typeof call>();
      while (child.parent !== null) {
        const parents = native.filter(candidate => {
          const blocks = result.transcript[candidate.end]?.message?.content?.filter((block: any) => block?.type === 'tool_result');
          return blocks?.length === 1 && blocks[0].tool_use_id === child.parent;
        });
        if (parents.length !== 1) return deny(62);
        const parent = parents[0];
        const completion = result.transcript[parent.end];
        const block = completion.message.content.find((block: any) => block?.type === 'tool_result');
        if (!['Agent', 'Task'].includes(parent.name) || parent.failed || parent.input.run_in_background === true
          || parent.start >= child.start || parent.end <= child.end || ancestors.has(parent)
          || (block.is_error !== undefined && block.is_error !== false)) return deny(68);
        if (Object.hasOwn(completion, 'tool_use_result')) {
          if (completion.tool_use_result?.status !== 'completed') return deny(70);
        } else if (parent.parent === null) return deny(71);
        ancestors.add(parent);
        child = parent;
      }
    } else if (!payload || payload.filePath !== target || payload.userModified !== false || payload.originalFile !== content) return deny(75);
    if (call.name === 'Write') {
      if (typeof call.input.content !== 'string' || (!omitted && (payload.type !== 'update' || payload.content !== call.input.content))) return deny(77);
      content = call.input.content;
    } else {
      const { old_string: old, new_string: replacement, replace_all: all = false } = call.input;
      if (typeof old !== 'string' || !old || typeof replacement !== 'string' || typeof all !== 'boolean'
        || (!omitted && (payload.oldString !== old || payload.newString !== replacement || payload.replaceAll !== all))) return deny(82);
      const parts = content.split(old);
      if (parts.length < 2 || (!all && parts.length !== 2)) return deny(84);
      content = parts.join(replacement);
    }
    contentHash = hash(content);
    if (seen.has(contentHash)) return deny(88);
    seen.add(contentHash);
  }
  if (contentHash !== after.split(':')[1]) return deny(91);
  const events = observation.events;
  const destinations = events.flatMap((event, index) => event.path === DOC_PATH && event.mask === 0x80 ? [index] : []);
  if (destinations.length !== calls.length) return deny(94);
  const sources = new Set<string>();
  let previous = -1;
  for (const destination of destinations) {
    const move = events[destination];
    if (!Number.isInteger(move.cookie) || move.cookie <= 0 || move.cookie > 0xffffffff) return deny(99);
    const pair = events.flatMap((event, index) => event.cookie === move.cookie ? [index] : []);
    if (pair.length !== 2 || pair[1] !== destination) return deny(101);
    const source = events[pair[0]];
    if (source.mask !== 0x40 || source.path === DOC_PATH || path.dirname(source.path) !== path.dirname(DOC_PATH)
      || Object.hasOwn(observation.before, source.path) || Object.hasOwn(observation.after, source.path) || sources.has(source.path)) return deny(104);
    const lifecycle = events.flatMap((event, index) => event.path === source.path ? [{ event, index }] : []);
    if (lifecycle[0]?.event.mask !== 0x100 || lifecycle[0].index <= previous || lifecycle.at(-1)?.index !== pair[0]) return deny(106);
    let modified = false;
    let closed = false;
    for (const { event, index } of lifecycle) {
      if (index === pair[0]) { if (!modified || !closed) return deny(110); continue; }
      if (event.cookie !== 0) return deny(111);
      if (index === lifecycle[0].index) continue;
      if (event.mask === 0x2 && !closed) modified = true;
      else if (event.mask === 0x4 && !closed) continue;
      else if (event.mask === 0x8 && modified) closed = true;
      else return deny(116);
    }
    sources.add(source.path);
    previous = destination;
  }
  if (events.some((event, index) => event.path === DOC_PATH && (index < destinations[0]
    || ![0x80, 0x4, 0x400, 0x800].includes(event.mask) || (event.mask !== 0x80 && event.cookie !== 0)))) return deny(122);
  for (const [index, destination] of destinations.entries()) {
    const replaced = events.slice(destination + 1, destinations[index + 1]).filter(event => event.path === DOC_PATH);
    if (replaced.filter(event => event.mask === 0x4).length !== 1 || replaced.filter(event => event.mask === 0x400).length !== 1
      || replaced.filter(event => event.mask === 0x800).length > 1) return deny(126);
  }
  return sources;
}

export function docsWriteFailures(observation: QAWriteObservation, allowed: string[], context?: DocsWriteContext): string[] {
  const failures = [...observation.failures];
  if (!observation.complete) failures.push('incomplete docs write observation');
  const atomicSources = docsAtomicSources(observation, allowed, context);
  const recordSources = docsRecordSources(observation);
  for (const file of new Set([...observation.events.map(e => e.path), ...observation.changed])) {
    if (file !== '.qa-state/.observer-check' && !allowed.includes(file) && !DOCS_AUDIT_RECORD_PATHS.includes(file) && !atomicSources.has(file) && !recordSources.has(file))
      failures.push(`forbidden docs write: ${file}${atomicSources.deniedAt && path.dirname(file) === path.dirname(DOC_PATH) ? ` (atomic replacement unproven at ${atomicSources.deniedAt})` : ''}`);
    if (allowed.includes(file) && observation.before[file] && observation.after[file] &&
        observation.before[file].split(':')[0] !== observation.after[file].split(':')[0]) failures.push(`document mode changed: ${file}`);
  }
  return failures;
}

export function docsPreambleCommands(fixture: ReturnType<typeof fixtureDocs>): string[] {
  const source = fs.readFileSync(path.join(fixture.skills, 'document-release/SKILL.md'), 'utf8');
  const generated = fs.readFileSync(path.join(process.env.DOCSYNC_GENERATED_ROOT || path.resolve(import.meta.dir, '../..'),
    'document-release/SKILL.md'), 'utf8');
  const [command, expected] = [source, generated].map(text => {
    if ((text.match(/^## Preamble \(run first\)[ \t]*\r?$/gm) ?? []).length !== 1) return undefined;
    return /^## Preamble \(run first\)[ \t]*\r?\n(?:[ \t]*\r?\n)*```bash[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m.exec(text)?.[1];
  });
  if (!command || command !== expected) return [];
  return [command, command.replace(/(^|\n)("\$_SS" --skill|[^\s"]*\/gstack-skill-start --skill)/, '$1GSTACK_SESSION_KIND=spawned $2')];
}

export function docsShipPhase(skeleton: string, prBody: string, scenario: DocsScenario, storePointer: string): string {
  if (scenario === 'store') return storePointer;
  return `${sliceBetween(skeleton, '## Step 14.5: Documentation audit (every ship)', '## Step 15: Commit')}\n\n${sliceBetween(prBody, '## Documentation', '## Test plan')}`;
}

type DocsSessionOptionsInput = {
  fixture: ReturnType<typeof fixtureDocs>;
  phase: string;
  report: string;
  publish: string;
  scenario: DocsScenario;
  testName: string;
  runId: string;
  timeout: number;
};

export function docsSessionOptions(input: DocsSessionOptionsInput): Parameters<typeof import('./session-runner').runSkillTest>[0] {
  const { fixture, phase, report, publish, scenario, testName, runId, timeout } = input;
  // The parent names this file in child prompts instead of retyping the interface (A1: ~30-40 s of generation).
  const interfaceFile = path.join(fixture.home, 'fixture-interface.md');
  const observation = docsNativeInterface(fixture, [publish], false, true, interfaceFile);
  fs.writeFileSync(interfaceFile, `${observation}\n`, { mode: 0o600 });
  return {
    prompt: `Load gstack's /ship workflow. Steps 0–14 are complete in this isolated fixture. Execute the next phase from ${phase}, then stop before the next numbered phase. Skill assets are installed under ${fixture.skills}; HOME=${fixture.home}. Base: main. ${scenario === 'current' ? 'This is a second /ship invocation for an existing open PR; the docs-only branch is already pushed. Earlier audit results are not evidence for this invocation.' : ''} ${scenario === 'store' ? 'The selected store-release source is the current working tree on main. All App Store operations are mocked and out of scope; no permissions to edit source are granted.' : ''} After the phase, write the ship outcome to ${report}. Only if the workflow gate actually allows continuing, run the isolated publication stand-in: bun ${publish}. No real PR, push, store action or later ship phase is authorized. If a decision is required, record the exact blocker and stop; no risk exception is granted. Preserve all partial content. The repository's Git-excluded .qa-state/ directory is the fixture owner's write-observer probe, not product content or child output.\n\n${observation}`,
    workingDirectory: fixture.repo,
    maxTurns: 30,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'Task'],
    timeout,
    env: fixture.env,
    testName,
    runId,
  };
}

export function docsBoundedStageInterface(fixture: ReturnType<typeof fixtureDocs>): string {
  return `Read and continue the supplied invocation record at ${fixture.invocation}. Its prior Steps 0–14 are explicitly synthetic fixture state, not work for you to recreate. Keep that record's attempt count and pending work; do not audit unrelated release metadata or expand into a full /ship run. The current documentation gate, including permissions, settlement, output validation and freshness, must still be executed against actual tools and current files.

Private artifact filenames must end in .json, .md or .markdown; .txt and .log filenames are not supported. This is a filename restriction, not just a description of the content. Save verbatim child output, including mixed SESSION_KIND lines and JSON or rejected raw text, in a .md file without changing its bytes or reconstructing JSON. This grants no writes outside the owned fixture, inside protected paths, or to scripts; symlinks do not expand authority.

Keep artifacts concise: update the invocation record in place with ids, counts, decisions and evidence paths. Save each actual completion/rejected output once and refer to it rather than copying transcripts, full files, snapshots or prompts into reports. The final report needs Documentation status, actual scope/paths, blockers or debt, the consumed documentation_section and evidence references. Preserve all consumed evidence; omit repeated narration. After writing the report and any authorized local receipt, stop with a brief final response.`;
}

const DOCS_READ_COMMANDS = ['pwd', 'ls', 'cat', 'sha256sum', 'stat'];
const DOCS_GIT_READS = ['status', 'diff', 'show', 'log', 'ls-files', 'ls-tree', 'check-ignore', 'rev-parse', 'merge-base', 'hash-object'];
const DOCS_DESCRIBE_FLAGS = /^(?:--tags|--always|--exact-match|--abbrev=\d+)$/;
const DOCS_BRANCH_LIST_FLAGS = /^(?:-[arlv]+|--(?:all|remotes|list|verbose|show-current|no-color|no-abbrev))$/;
const DOCS_SAFE_GIT_CONFIG = /^(?:core\.pager=cat|core\.quotepath=(?:true|false|on|off)|color\.[a-z.]+=(?:true|false|never|always|auto))$/i;

/**
 * Remove wrappers that cannot change what a read-only command does: a leading
 * `cd <fixture repo> &&`, `2>/dev/null`, a trailing `|| true`, and Git global
 * options that only point at the fixture repo or switch off paging/colour.
 * Returns null when a Git global option could change behaviour.
 */
function unwrapHarmlessRead(text: string, fixture: ReturnType<typeof fixtureDocs>): string | null {
  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');
  const sameRepo = (value: string) => {
    try { return fs.realpathSync(unquote(value)) === fs.realpathSync(fixture.repo); } catch { return false; }
  };
  let out = text.replace(/\s*;$/, '').replace(/\s+\|\|\s+true$/, '').replace(/\s+2>\s*(?:\/dev\/null|&1)(?=\s|$)/g, '').trim();
  const cd = /^cd\s+('[^']*'|"[^"]*"|\S+)\s+&&\s+/.exec(out);
  if (cd && sameRepo(cd[1]!)) out = out.slice(cd[0].length);
  const globals = /^git((?:\s+(?:--no-pager|-C\s+(?:'[^']*'|"[^"]*"|\S+)|-c\s+(?:'[^']*'|"[^"]*"|\S+)))+)(?=\s)/.exec(out);
  if (!globals) return out;
  for (const option of globals[1]!.matchAll(/(--no-pager)|-C\s+('[^']*'|"[^"]*"|\S+)|-c\s+('[^']*'|"[^"]*"|\S+)/g)) {
    if (option[2] !== undefined && !sameRepo(option[2])) return null;
    if (option[3] !== undefined && !DOCS_SAFE_GIT_CONFIG.test(unquote(option[3]))) return null;
  }
  return 'git' + out.slice(globals[0].length);
}

export function docsCommandAllowed(command: string, fixture: ReturnType<typeof fixtureDocs>, scripts: string[] = []): boolean {
  const text = command.trim();
  if (docsPreambleCommands(fixture).some(block => block.trim() === text)) return true;
  // The section prints the cap gate with the ~/.claude/skills/gstack prefix; in the fixture HOME is fixture.home, so that form names the same installed binary.
  if (text === DOCS_TMP_EXCLUDE || text === DOCS_AUDIT_RESET || text === docsCapsCommand(fixture.skills.split(path.sep).join('/')) ||
    (text === docsCapsCommand('~/.claude/skills/gstack') && fixture.skills === path.join(fixture.home, '.claude/skills/gstack'))) return true;
  if (readOnlyCommandAllowed(text, docsReadOnlyScope(fixture)) || docsComposedReadAllowed(text, fixture)) return true;
  const insert = /^cat (['"]?)([^\s'"]+)\1 >> (['"]?)([^\s'"]+)\3$/.exec(text);
  if (insert) return [insert[2], insert[4]].every(file => path.isAbsolute(file) && /\.md$/i.test(file) &&
    !/[\x00-\x1f\x7f;&|<>`$\\()*?\[\]{}~#]/.test(file) && docsPrivateArtifact(file, fixture, scripts));
  // Harmless wrappers are accepted on read-only commands only; lifecycle and
  // script calls must stay literal so their failures are not suppressed.
  const unwrapped = unwrapHarmlessRead(text, fixture);
  if (unwrapped !== text) {
    if (unwrapped === null || !literalDocsCommandAllowed(unwrapped, fixture, [])) return false;
    const name = unwrapped.split(/\s+/)[0]!;
    return DOCS_READ_COMMANDS.includes(name) || name === 'git';
  }
  return literalDocsCommandAllowed(text, fixture, scripts);
}

const DOCS_LOOP_WORD = /^[A-Za-z0-9_./@%+,:=-]+$/;

/** Unquoted ;, &&, || and | split a line into commands; null for an unterminated quote. */
function docsTopLevelSegments(text: string): { start: number; end: number; op: string }[] | null {
  const segments: { start: number; end: number; op: string }[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    const op = text.startsWith('&&', i) || text.startsWith('||', i) ? text.slice(i, i + 2) : c === ';' || c === '|' ? c : '';
    if (!op) continue;
    segments.push({ start, end: i, op });
    start = i + op.length;
    i += op.length - 1;
  }
  if (quote) return null;
  segments.push({ start, end: text.length, op: '' });
  return segments;
}

/**
 * Each unquoted `for <var> in <words>; do <body>; done` in a line, replaced by its
 * passes (the body once per word, the variable substituted). Null when a loop is
 * not a plain loop over literal words: a lowercase variable, words without quotes,
 * globs or $, no other variable in the body and no nested loop.
 */
function docsUnrollLoops(text: string): string | null {
  const segments = docsTopLevelSegments(text);
  if (!segments) return text;
  let out = '';
  let copied = 0;
  for (let i = 0; i < segments.length; i++) {
    const head = text.slice(segments[i]!.start, segments[i]!.end).trim();
    if (!/^for(?:\s|$)/.test(head)) continue;
    const loop = /^for\s+([a-z][a-z0-9]*)\s+in\s+(\S.*)$/.exec(head);
    const close = segments.findIndex((segment, index) => index > i + 1 && text.slice(segment.start, segment.end).trim() === 'done');
    const opening = segments[i + 1] && /^\s*do\s+/.exec(text.slice(segments[i + 1]!.start, segments[i + 1]!.end));
    if (!loop || segments[i]!.op !== ';' || !opening || close < 0 || segments[close - 1]!.op !== ';') return null;
    const body = text.slice(segments[i + 1]!.start + opening[0].length, segments[close - 1]!.end).trim();
    const words = loop[2]!.trim().split(/\s+/);
    const reference = new RegExp(`\\$(?:\\{${loop[1]}\\}|${loop[1]}(?![A-Za-z0-9_]))`, 'g');
    if (!words.every(word => DOCS_LOOP_WORD.test(word)) || body.replace(reference, '').includes('$') || /(?:^|[;&|]\s*)for\s/.test(body)) return null;
    out += text.slice(copied, segments[i]!.start) + words.map(word => body.replace(reference, word)).join('; ');
    copied = segments[close]!.end;
    i = close;
  }
  return out + text.slice(copied);
}

/**
 * A read-only line the shared grammar cannot see whole: loops are checked as
 * their unrolled passes, and each declared Git read or installed candidate
 * --help joined to grammar reads (never after a cd, never fed by a pipe) is
 * checked literally and then stands in the line as a neutral read for the grammar.
 * The candidate's --help prints its usage and returns before it touches Git or a
 * file (bin/gstack-docs-candidate main), so joining it reads nothing more (gates
 * 40600731931 and 40627127462, screen 40558235014: the parent ended a line of reads with it).
 * A declared read command given --help prints its own usage instead of reading, and its
 * operands stay checked as reads (screens 40822033640 and 40815828320, gate 40809051510:
 * the parent joined `cat <candidate> --help 2>&1 | head -N`, which printed cat's usage).
 */
function docsComposedReadAllowed(text: string, fixture: ReturnType<typeof fixtureDocs>): boolean {
  const line = docsUnrollLoops(text);
  if (line === null) return false;
  if (line !== text && readOnlyCommandAllowed(line, docsReadOnlyScope(fixture))) return true;
  const segments = docsTopLevelSegments(line);
  if (!segments) return false;
  const candidate = path.join(fixture.skills, 'bin/gstack-docs-candidate').split(path.sep).join('/');
  const commands = segments.map(segment => line.slice(segment.start, segment.end).trim());
  const readHelp = (command: string) => DOCS_READ_COMMANDS.includes(command.split(/\s+/)[0]!) && /\s--help(?:\s|$)/.test(command);
  const declared = commands.flatMap((command, index) => /^git(?:\s|$)/.test(command) || command.startsWith(`${candidate} `) || readHelp(command) ? [index] : []);
  if (!declared.length || commands.some(command => /^cd(?:\s|$)/.test(command))) return false;
  let neutral = line;
  for (const index of declared.reverse()) {
    const read = unwrapHarmlessRead(commands[index]!, fixture);
    const help = read !== null && /^(?:(?:snapshot|compare) )?--help$/.test(read.slice(candidate.length + 1));
    if (segments[index - 1]?.op === '|' || read === null || !(/^git\s/.test(read) || (read.startsWith(`${candidate} `) && help) || readHelp(read))
      || !literalDocsCommandAllowed(read, fixture, [])) return false;
    neutral = `${neutral.slice(0, segments[index]!.start)} pwd ${neutral.slice(segments[index]!.end)}`;
  }
  return readOnlyCommandAllowed(neutral, docsReadOnlyScope(fixture));
}

/** The shared read-only grammar inside the owned fixture home; private actor state and every Claude config file but settings.json (.claude.json holds the API key) stay unreadable. */
function docsReadOnlyScope(fixture: ReturnType<typeof fixtureDocs>) {
  const config = actualWritePath(fixture.env.CLAUDE_CONFIG_DIR);
  return { root: fixture.home, cwd: fixture.repo,
    deny: (file: string) => path.basename(file) === 'actor-state.json' ||
      (config !== null && within(file, config) && file !== config && file !== path.join(config, 'settings.json')) };
}

/** A literal read operand resolves (symlinks included) inside the fixture home and outside its denied paths. */
function docsReadablePath(arg: string, fixture: ReturnType<typeof fixtureDocs>): boolean {
  const raw = path.isAbsolute(arg) ? arg : fixture.repo + path.sep + arg;
  let actual: string | null;
  try { actual = fs.realpathSync.native(raw); } catch { actual = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(arg) ? null : actualWritePath(path.resolve(raw)); }
  return actual !== null && within(actual, fs.realpathSync(fixture.home)) && !docsReadOnlyScope(fixture).deny(actual);
}

function literalDocsCommandAllowed(text: string, fixture: ReturnType<typeof fixtureDocs>, scripts: string[]): boolean {
  if (/[\x00-\x08\x0a-\x1f\x7f;&|<>`$\\()]/.test(text)) return false;
  const args: string[] = [];
  const literal = /(?:'([^']*)'|"([^"]*)"|([^\s'"]+))(?:[ \t]+|$)/y;
  while (literal.lastIndex < text.length) {
    const token = literal.exec(text);
    if (!token) return false;
    const value = token[1] ?? token[2] ?? token[3];
    if (token[3] !== undefined && (/[*?\[#]/.test(value) || value.startsWith('~') || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(value))) return false;
    args.push(value);
  }
  if (!args.length) return false;
  const [commandName, ...rest] = args;
  if (args.some((arg, index) => /[{}]/.test(arg) && (commandName !== 'git' || index < 2 ||
      /[{}]/.test(arg.replace(/(?:\^|@)\{[^{}]*\}/g, ''))))) return false;
  if (args.some(arg => path.basename(arg) === 'actor-state.json') &&
      !((commandName === 'bun' || commandName === process.execPath) && scripts.includes(rest[0]))) return false;
  if (DOCS_READ_COMMANDS.includes(commandName)) return rest.every(arg => arg.startsWith('-') || docsReadablePath(arg, fixture));
  if (commandName === 'git') {
    if (rest.some(arg => /^(?:--output|--ext-diff|--textconv|-w)(?:=|$)/.test(arg))) return false;
    if (rest[0] === 'hash-object' && rest.some(arg => /^-[^-]*w/.test(arg))) return false;
    // A branch listing reads refs (gates 40458489644 and 40477638211: the parent oriented with `git branch -a`);
    // an operand or any other option creates, moves, deletes or retargets a branch.
    if (rest[0] === 'branch') return rest.slice(1).every(arg => DOCS_BRANCH_LIST_FLAGS.test(arg));
    // A tag listing reads refs the same way (gate 40643690306: the parent ended a line of reads with `git tag`);
    // an operand or any other option creates, deletes, signs or verifies a tag.
    if (rest[0] === 'tag') return rest.slice(1).every(arg => arg === '-l' || arg === '--list');
    if (rest[0] === 'describe') {
      const operands = rest.slice(1).filter(arg => !DOCS_DESCRIBE_FLAGS.test(arg));
      return operands.length <= 1 && operands.every(arg => !arg.startsWith('-'));
    }
    return DOCS_GIT_READS.includes(rest[0]);
  }
  if (commandName === 'bun' || commandName === process.execPath) {
    return scripts.includes(rest[0]);
  }
  const candidate = path.join(fixture.skills, 'bin/gstack-docs-candidate').split(path.sep).join('/');
  if (commandName === candidate) {
    const privateJson = (file: string | undefined) => !!file && path.isAbsolute(file) && /\.json$/i.test(file) && docsPrivateArtifact(file, fixture, scripts);
    if (rest.length === 1 && rest[0] === '--help') return true;
    if (rest.length === 2 && (rest[0] === 'snapshot' || rest[0] === 'compare') && rest[1] === '--help') return true;
    if (rest[0] === 'compare') return rest.length === 2 && privateJson(rest[1]);
    if (rest[0] !== 'snapshot' || rest.length % 2 !== 1) return false;
    const flags = rest.slice(1).filter((_, i) => i % 2 === 0);
    const out = rest.slice(1).filter((_, i) => i % 2 === 1)[flags.indexOf('--out')];
    return flags.every(flag => ['--out', '--audit-id', '--mode', '--base', '--select', '--docs'].includes(flag)) &&
      flags.filter(flag => flag === '--out').length === 1 && privateJson(out);
  }
  const marker = 'GSTACK_SESSION_KIND=spawned';
  const start = path.join(fixture.skills, 'bin/gstack-skill-start').split(path.sep).join('/');
  const end = path.join(fixture.skills, 'bin/gstack-skill-end').split(path.sep).join('/');
  if ((commandName === start || commandName === end) && rest.length === 1 && rest[0] === '--help') return true;
  if (commandName === marker && rest.length === 2 && rest[0] === start && rest[1] === '--help') return true;
  return (commandName === marker && rest[0] === start || commandName === start || commandName === end) && args.includes('document-release');
}

function within(file: string, root: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

function actualWritePath(file: string): string | null {
  let ancestor = file;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor) && !fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  try {
    return path.join(fs.realpathSync(ancestor), ...missing);
  } catch {
    return null;
  }
}

/** True when `file` is a private .json/.md artifact under the fixture home, outside the product tree, protected roots and scripts. */
function docsPrivateArtifact(file: string, fixture: ReturnType<typeof fixtureDocs>, scripts: string[]): boolean {
  const home = fs.realpathSync(fixture.home);
  const repo = fs.realpathSync(fixture.repo);
  const actual = actualWritePath(file);
  const protectedRoots = [fixture.skills, fixture.env.CLAUDE_CONFIG_DIR, fixture.env.GSTACK_HOME,
    path.join(fixture.home, 'remote.git')];
  return actual !== null && within(file, fixture.home) && within(actual, home) &&
    !within(file, fixture.repo) && !within(actual, repo) &&
    /\.(?:json|md|markdown)$/i.test(file) && /\.(?:json|md|markdown)$/i.test(actual) &&
    !protectedRoots.some(root => within(file, root) || within(actual, actualWritePath(root) ?? root)) &&
    !scripts.some(script => file === script || actual === actualWritePath(script)) &&
    path.basename(file) !== 'actor-state.json' && path.basename(actual) !== 'actor-state.json';
}

/**
 * A call to one of Step 14.5's own helpers (the docs candidate or the cap gate; never a lifecycle helper) at a wrong
 * binary path that does not exist exited 127 before anything ran; it is ignored only when the same command at the
 * declared path runs: after the slip for snapshot, compare and the cap gate, whose result the workflow needs, and
 * anywhere in the transcript for --help, which reads nothing the agent still has to recover (gate 40323989742: the
 * parent read the usage at the declared path, mistyped the path on a second --help, then went on; screen 40749421675:
 * the parent typed the cap gate at the shard root, then ran it at the declared path).
 */
function helperNotFound(calls: SkillTestResult['toolCalls'], index: number, fixture: ReturnType<typeof fixtureDocs>, scripts: string[]): boolean {
  const command = String(calls[index].input?.command ?? '').trim();
  const binary = command.split(' ')[0]!;
  const declared = path.join(fixture.skills, 'bin', path.basename(binary)).split(path.sep).join('/');
  if (!/^\/[\w.\/-]+\/gstack-(?:docs-candidate|ship-receipt)$/.test(binary) || binary === declared) return false;
  if (calls[index].output.trimEnd() !== `Exit code 127\n(eval):1: no such file or directory: ${binary}`) return false;
  try {
    fs.lstatSync(binary);
    return false;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
  }
  const retry = declared + command.slice(binary.length);
  const candidates = retry === `${declared} --help` ? calls.filter((_, position) => position !== index) : calls.slice(index + 1);
  return docsCommandAllowed(retry, fixture, scripts) && candidates.some(call =>
    call.tool === 'Bash' && String(call.input?.command ?? '').trim() === retry && !call.output.startsWith('Exit code'));
}

export function docsToolFailures(result: SkillTestResult, fixture: ReturnType<typeof fixtureDocs>, scripts: string[] = [], readOnly = false): string[] {
  const failures: string[] = [];
  const repo = fs.realpathSync(fixture.repo);
  const authoredDoc = path.join(repo, DOC_PATH);
  for (const [index, call] of result.toolCalls.entries()) {
    if (call.tool === 'Bash' && !docsCommandAllowed(String(call.input?.command ?? ''), fixture, scripts) &&
      !helperNotFound(result.toolCalls, index, fixture, scripts)) failures.push('command outside declared docs observation interface');
    if (['Write', 'Edit'].includes(call.tool)) {
      const file = path.resolve(fixture.repo, call.input?.file_path ?? '');
      const actual = actualWritePath(file);
      const productWrite = within(file, fixture.repo) || (actual !== null && within(actual, repo));
      // Step 14.5's receipt record is housekeeping every scenario may write, a read-only audit included; the document stays read-only.
      const recordWrite = file === path.join(fixture.repo, DOCS_AUDIT_RECORD) && actual === path.join(repo, DOCS_AUDIT_RECORD);
      if (readOnly && productWrite && !recordWrite) failures.push('read-only docs write attempt');
      const allowedDoc = (file === path.join(fixture.repo, DOC_PATH) && actual === authoredDoc) || recordWrite;
      if (productWrite && !allowedDoc) {
        failures.push('non-document product write attempt');
      }
      if (!allowedDoc && !docsPrivateArtifact(file, fixture, scripts)) failures.push('write outside docs fixture authority');
    }
    if (call.tool === 'Read' && path.basename(call.input?.file_path ?? '') === 'actor-state.json') failures.push('private actor state was read');
  }
  return failures;
}

export function docsCompletedRead(result: SkillTestResult, file: string, fixture: ReturnType<typeof fixtureDocs>,
  options: { source?: string; beforeFirstEdit?: boolean } = {}): boolean {
  const source = (options.source ?? fs.readFileSync(file, 'utf8')).trim();
  if (!source) return false;
  const target = path.resolve(file);
  const resolve = (p: string) => path.resolve(p.startsWith('~/') ? path.join(fixture.home, p.slice(2)) : path.resolve(fixture.repo, p));
  for (const call of result.toolCalls) {
    if (options.beforeFirstEdit && ['Write', 'Edit'].includes(call.tool) && resolve(call.input?.file_path ?? '') === target) break;
    const read = call.tool === 'Read' && resolve(call.input?.file_path ?? '') === target;
    const command = String(call.input?.command ?? '').trim();
    const literal = /^cat\s+/.test(command) && !/[\n\r;&|<>`$\\(){}]/.test(command);
    const expanded = docsUnrollLoops(command);
    const grammar = !literal && expanded !== null && !/(?:^|[;&|]\s*)cd\s/.test(command)
      && (readOnlyCommandAllowed(command, docsReadOnlyScope(fixture)) || docsComposedReadAllowed(command, fixture));
    const parts = !literal && !grammar ? [] : (expanded ?? command).split(/\s*(?:;|&&|\|\|)\s*/);
    const operands = (part: string) => part.match(/'[^']*'|"[^"]*"|[^\s'"]+/g)?.slice(1).map(arg => /^['"]/.test(arg) ? arg.slice(1, -1) : arg) ?? [];
    const catArgs = parts.filter(part => /^cat\s/.test(part) && !part.includes('|')).flatMap(operands);
    const cat = call.tool === 'Bash' && catArgs.some(arg => resolve(arg) === target);
    if ((read || cat) && !/^(?:<tool_use_error>|Error(?: reading file|:)|Exit code [1-9]\d*\b)/i.test(call.output.trimStart()) &&
        call.output.replace(/^\s*\d+(?:→|\t)/gm, '').includes(source)) return true;
    // A line's exit status is its last command's: when the line's first command cats the file unpiped and the output
    // opens with its full bytes, a later command's failure does not undo that read (screen 40828580338: zsh read the
    // separator `echo ======` as an = command lookup and abandoned the rest of the line after phase.md printed in full).
    const status = /^Exit code [1-9]\d*\n/.exec(call.output.trimStart());
    const lead = cat && /^cat\s/.test(parts[0]!) && !parts[0]!.includes('|') ? operands(parts[0]!).find(arg => !arg.startsWith('-')) : undefined;
    if (status && lead !== undefined && resolve(lead) === target && call.output.trimStart().slice(status[0].length).startsWith(source)) return true;
  }
  return false;
}
