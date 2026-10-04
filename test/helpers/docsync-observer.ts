import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { observeQAWrites, type QAWriteObservation } from './qa-functional-observer';
import { nativeCalls } from './qa-checkpoint-evidence';
import type { SkillTestResult } from './session-runner';
import { DOC_PATH, type DocsScenario, type fixtureDocs } from './docsync-fixture';
import { sliceBetween } from './skill-fixture';

export async function observeDocsWrites(fixture: ReturnType<typeof fixtureDocs>) {
  return observeQAWrites(fixture.repo, { atomicTargets: [DOC_PATH] });
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
  const deny = (line: number) => { denied.deniedAt = `docsync-observer.ts:${line}`; return denied; };
  if (!context || context.readOnly || !allowed.includes(DOC_PATH) || !observation.complete || observation.failures.length) return denied;
  const { result, fixture, scripts = [] } = context;
  if (result.exitReason !== 'success' || !Array.isArray(result.transcript) || docsToolFailures(result, fixture, scripts).length) return deny(27);
  const failures: string[] = [];
  const target = path.join(fixture.repo, DOC_PATH);
  const native = nativeCalls(result.transcript, failures);
  const calls = native.filter(call => ['Write', 'Edit'].includes(call.name)
    && typeof call.input.file_path === 'string' && path.resolve(fixture.repo, call.input.file_path) === target);
  if (failures.length || !calls.length || calls.some((call, index) => call.failed || call.end <= call.start || (index > 0 && call.start <= calls[index - 1].end))) return deny(33);
  const before = observation.before[DOC_PATH];
  const after = observation.after[DOC_PATH];
  if (!/^\d+:[a-f0-9]{64}$/.test(before ?? '') || !/^\d+:[a-f0-9]{64}$/.test(after ?? '') || before.split(':')[0] !== after.split(':')[0]) return deny(36);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const encoded = fixture.before?.contents[DOC_PATH];
  if (typeof encoded !== 'string') return deny(39);
  const baseline = Buffer.from(encoded, 'base64');
  let content = baseline.toString('utf8');
  let contentHash = before.split(':')[1];
  if (baseline.toString('base64') !== encoded || !Buffer.from(content).equals(baseline) || hash(content) !== contentHash) return deny(43);
  const seen = new Set([contentHash]);
  for (const call of calls) {
    const event = result.transcript[call.end];
    const payload = event.tool_use_result;
    const results = event.message.content.filter((block: any) => block?.type === 'tool_result');
    if (results.length !== 1 || (results[0].is_error !== undefined && results[0].is_error !== false)) return deny(49);
    const omitted = !Object.hasOwn(event, 'tool_use_result');
    if (omitted) {
      if (call.parent === null) return deny(52);
      let child = call;
      const ancestors = new Set<typeof call>();
      while (child.parent !== null) {
        const parents = native.filter(candidate => {
          const blocks = result.transcript[candidate.end]?.message?.content?.filter((block: any) => block?.type === 'tool_result');
          return blocks?.length === 1 && blocks[0].tool_use_id === child.parent;
        });
        if (parents.length !== 1) return deny(60);
        const parent = parents[0];
        const completion = result.transcript[parent.end];
        const block = completion.message.content.find((block: any) => block?.type === 'tool_result');
        if (!['Agent', 'Task'].includes(parent.name) || parent.failed || parent.input.run_in_background === true
          || parent.start >= child.start || parent.end <= child.end || ancestors.has(parent)
          || (block.is_error !== undefined && block.is_error !== false)) return deny(66);
        if (Object.hasOwn(completion, 'tool_use_result')) {
          if (completion.tool_use_result?.status !== 'completed') return deny(68);
        } else if (parent.parent === null) return deny(69);
        ancestors.add(parent);
        child = parent;
      }
    } else if (!payload || payload.filePath !== target || payload.userModified !== false || payload.originalFile !== content) return deny(73);
    if (call.name === 'Write') {
      if (typeof call.input.content !== 'string' || (!omitted && (payload.type !== 'update' || payload.content !== call.input.content))) return deny(75);
      content = call.input.content;
    } else {
      const { old_string: old, new_string: replacement, replace_all: all = false } = call.input;
      if (typeof old !== 'string' || !old || typeof replacement !== 'string' || typeof all !== 'boolean'
        || (!omitted && (payload.oldString !== old || payload.newString !== replacement || payload.replaceAll !== all))) return deny(80);
      const parts = content.split(old);
      if (parts.length < 2 || (!all && parts.length !== 2)) return deny(82);
      content = parts.join(replacement);
    }
    contentHash = hash(content);
    if (seen.has(contentHash)) return deny(86);
    seen.add(contentHash);
  }
  if (contentHash !== after.split(':')[1]) return deny(89);
  const events = observation.events;
  const destinations = events.flatMap((event, index) => event.path === DOC_PATH && event.mask === 0x80 ? [index] : []);
  if (destinations.length !== calls.length) return deny(92);
  const sources = new Set<string>();
  let previous = -1;
  for (const destination of destinations) {
    const move = events[destination];
    if (!Number.isInteger(move.cookie) || move.cookie <= 0 || move.cookie > 0xffffffff) return deny(97);
    const pair = events.flatMap((event, index) => event.cookie === move.cookie ? [index] : []);
    if (pair.length !== 2 || pair[1] !== destination) return deny(99);
    const source = events[pair[0]];
    if (source.mask !== 0x40 || source.path === DOC_PATH || path.dirname(source.path) !== path.dirname(DOC_PATH)
      || Object.hasOwn(observation.before, source.path) || Object.hasOwn(observation.after, source.path) || sources.has(source.path)) return deny(102);
    const lifecycle = events.flatMap((event, index) => event.path === source.path ? [{ event, index }] : []);
    if (lifecycle[0]?.event.mask !== 0x100 || lifecycle[0].index <= previous || lifecycle.at(-1)?.index !== pair[0]) return deny(104);
    let modified = false;
    let closed = false;
    for (const { event, index } of lifecycle) {
      if (index === pair[0]) { if (!modified || !closed) return deny(108); continue; }
      if (event.cookie !== 0) return deny(109);
      if (index === lifecycle[0].index) continue;
      if (event.mask === 0x2 && !closed) modified = true;
      else if (event.mask === 0x4 && !closed) continue;
      else if (event.mask === 0x8 && modified) closed = true;
      else return deny(114);
    }
    sources.add(source.path);
    previous = destination;
  }
  if (events.some((event, index) => event.path === DOC_PATH && (index < destinations[0]
    || ![0x80, 0x4, 0x400, 0x800].includes(event.mask) || (event.mask !== 0x80 && event.cookie !== 0)))) return deny(120);
  for (const [index, destination] of destinations.entries()) {
    const replaced = events.slice(destination + 1, destinations[index + 1]).filter(event => event.path === DOC_PATH);
    if (replaced.filter(event => event.mask === 0x4).length !== 1 || replaced.filter(event => event.mask === 0x400).length !== 1
      || replaced.filter(event => event.mask === 0x800).length > 1) return deny(124);
  }
  return sources;
}

export function docsWriteFailures(observation: QAWriteObservation, allowed: string[], context?: DocsWriteContext): string[] {
  const failures = [...observation.failures];
  if (!observation.complete) failures.push('incomplete docs write observation');
  const atomicSources = docsAtomicSources(observation, allowed, context);
  for (const file of new Set([...observation.events.map(e => e.path), ...observation.changed])) {
    if (file !== '.qa-state/.observer-check' && !allowed.includes(file) && !atomicSources.has(file))
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
  return {
    prompt: `Load gstack's /ship workflow. Steps 0–14 are complete in this isolated fixture. Execute the next phase from ${phase}, then stop before the next numbered phase. Skill assets are installed under ${fixture.skills}; HOME=${fixture.home}. Base: main. ${scenario === 'current' ? 'This is a second /ship invocation for an existing open PR; the docs-only branch is already pushed. Earlier audit results are not evidence for this invocation.' : ''} ${scenario === 'store' ? 'The selected store-release source is the current working tree on main. All App Store operations are mocked and out of scope; no permissions to edit source are granted.' : ''} After the phase, write the ship outcome to ${report}. Only if the workflow gate actually allows continuing, run the isolated publication stand-in: bun ${publish}. No real PR, push, store action or later ship phase is authorized. If a decision is required, record the exact blocker and stop; no risk exception is granted. Preserve all partial content. The repository's Git-excluded .qa-state/ directory is the fixture owner's write-observer probe, not product content or child output.\n\n${docsNativeInterface(fixture, [publish], false, true)}`,
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
  let out = text.replace(/\s+\|\|\s+true$/, '').replace(/\s+2>\s*(?:\/dev\/null|&1)(?=\s|$)/g, '').trim();
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
  if (DOCS_READ_COMMANDS.includes(commandName)) return true;
  if (commandName === 'git') {
    if (rest.some(arg => /^(?:--output|--ext-diff|--textconv|-w)(?:=|$)/.test(arg))) return false;
    if (rest[0] === 'hash-object' && rest.some(arg => /^-[^-]*w/.test(arg))) return false;
    if (rest[0] === 'branch') return rest.length === 2 && rest[1] === '--show-current';
    return DOCS_GIT_READS.includes(rest[0]);
  }
  if (commandName === 'bun' || commandName === process.execPath) {
    return scripts.includes(rest[0]);
  }
  const marker = 'GSTACK_SESSION_KIND=spawned';
  const start = path.join(fixture.skills, 'bin/gstack-skill-start').split(path.sep).join('/');
  const end = path.join(fixture.skills, 'bin/gstack-skill-end').split(path.sep).join('/');
  return (commandName === marker && rest[0] === start || commandName === start || commandName === end) && args.includes('document-release');
}

export function docsNativeInterface(fixture: Pick<ReturnType<typeof fixtureDocs>, 'home' | 'repo' | 'skills'>, scripts: string[] = [], transport = false, insert = false): string {
  const skills = fixture.skills.split(path.sep).join('/');
  return `Fixture observation interface (applies to parent and every child; include this interface in child prompts): Bash may execute only separate literal pwd, ls, cat, stat, sha256sum, Git read commands (status, diff, show, log, ls-files, ls-tree, check-ignore, rev-parse, merge-base, hash-object without -w, branch --show-current), the exact generated Preamble block with its spawned prefix, or literal installed gstack-skill-start/gstack-skill-end commands for document-release (start requires GSTACK_SESSION_KIND=spawned). No shell composition, custom interpreters, arbitrary scripts, inline eval or memory-mapped writes. The only additional scripts are ${scripts.length ? scripts.join(', ') : 'none'}.${insert ? ` To insert one saved private Markdown artifact into another (a saved section file into a report), Bash may also run the single literal command cat SOURCE.md >> TARGET.md with absolute paths under ${fixture.home}.` : ''} Read/Glob/Grep remain available; Read skill and section files with Read (offset/limit for ranges), because Bash output over 30KB becomes a preview that no permitted Bash command can page. Use Write/Edit for permitted docs and private JSON/Markdown artifacts under ${fixture.home}; do not rewrite installed skills, config, actor state or scripts. No effects outside the owned fixture. The owner preserves evidence and cleans up. Missing observer coverage blocks acceptance; the Linux kernel monitor covers syscall writes in the product tree, not hostile processes or arbitrary external destinations.

The working directory for parent and child Bash calls is already ${fixture.repo}. Run Git reads directly, for example: git status, git diff --cached, git merge-base main HEAD, git rev-parse HEAD. Do not use Git global options such as -C, -c, --git-dir or --work-tree, and do not prepend cd or another shell wrapper. The literal git subcommand must immediately follow git; an absolute owned repository path does not make git -C an allowed command.

Platform: local/git-native. Base: main. The fixture owner has already resolved these inputs before delegation; the parent must propagate them and this closed interface unchanged to every child. Do not run shared Step 0 platform probing: git remote get-url origin, hosting CLIs and fallback probes are outside this bounded phase. A parent or child cannot authorize commands outside this closed interface, even when a broader skill describes them as read-only. Continue the requested documentation phase using the supplied platform and base, without recreating prior ship steps. Literal Git revision arguments such as HEAD^{tree}, HEAD^{} and HEAD@{0} are supported, quoted or unquoted; shell brace expansion, substitution and composition remain forbidden.

${transport ? 'Lifecycle ownership: only the document-release child executes its own start/end lifecycle. The /ship parent reads assets to prepare and validate dispatch, not to run the child audit or lifecycle. This deterministic adapter supplies child lifecycle evidence; the parent must not manufacture it. The following lifecycle commands describe the child, not parent work.\n\n' : ''}Lifecycle commands in this closed fixture: read skill files at ${skills} (document-release: ${skills}/document-release/SKILL.md). Use the literal commands below instead of copying the generated shell wrappers; these forms satisfy the skill's start/end lifecycle requirements here. Run each as a separate, single-line Bash call. Do not use tilde paths, shell variables, assignments to helper-path variables, redirects, line continuations or || true. Do not add a parent PID: the start helper supplies its default.

Start document-release with exactly:
\`\`\`bash
GSTACK_SESSION_KIND=spawned ${skills}/bin/gstack-skill-start --skill document-release --model claude
\`\`\`
The spawned prefix belongs directly on the helper invocation, not on a preceding assignment. Read the returned SESSION_KIND, SESSION_ID and TEL_START status lines. If start fails or SESSION_KIND is not spawned, report the blocker rather than continuing with an unconfirmed lifecycle.

At workflow completion, use this one-line end command. Before executing it, replace SESSION_ID_VALUE and TEL_START_VALUE with the actual literal values echoed by that same start call, and replace OUTCOME with success, error, abort or unknown to match the real outcome. Never execute the placeholders or reuse values from another session.
\`\`\`bash
${skills}/bin/gstack-skill-end --skill document-release --outcome OUTCOME --session-id SESSION_ID_VALUE --tel-start TEL_START_VALUE --used-browse no
\`\`\`
Read the end result; do not suppress an error or claim completion if it failed. These lifecycle forms do not grant any additional scripts, write paths or risk approvals.`;
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

export function docsToolFailures(result: SkillTestResult, fixture: ReturnType<typeof fixtureDocs>, scripts: string[] = [], readOnly = false): string[] {
  const failures: string[] = [];
  const repo = fs.realpathSync(fixture.repo);
  const authoredDoc = path.join(repo, DOC_PATH);
  for (const call of result.toolCalls) {
    if (call.tool === 'Bash' && !docsCommandAllowed(String(call.input?.command ?? ''), fixture, scripts)) failures.push('command outside declared docs observation interface');
    if (['Write', 'Edit'].includes(call.tool)) {
      const file = path.resolve(fixture.repo, call.input?.file_path ?? '');
      const actual = actualWritePath(file);
      const productWrite = within(file, fixture.repo) || (actual !== null && within(actual, repo));
      if (readOnly && productWrite) failures.push('read-only docs write attempt');
      const allowedDoc = file === path.join(fixture.repo, DOC_PATH) && actual === authoredDoc;
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
    const catArgs = /^cat\s+/.test(command) && !/[\n\r;&|<>`$\\(){}]/.test(command)
      ? command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g)?.slice(1).map(arg => /^['"]/.test(arg) ? arg.slice(1, -1) : arg) ?? [] : [];
    const cat = call.tool === 'Bash' && catArgs.some(arg => resolve(arg) === target);
    if ((read || cat) && !/^(?:<tool_use_error>|Error(?: reading file|:)|Exit code [1-9]\d*\b)/i.test(call.output.trimStart()) &&
        call.output.replace(/^\s*\d+(?:→|\t)/gm, '').includes(source)) return true;
  }
  return false;
}
