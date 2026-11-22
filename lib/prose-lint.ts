/**
 * prose-lint — the AI tells a regular expression can decide, as a free check
 * over the prose /ship writes: a CHANGELOG entry and a PR body. Ideas from
 * pstack's unslop skill (Lauren Tan, MIT; NOTICE.md); the rule text is
 * gstack's and the word lists are facts. Everything else about voice stays
 * with the reader: this file never judges tone, length or metaphor it cannot
 * match. Fenced code, inline code, URLs, HTML comments and quoted words (someone
 * else's) are never scanned; a fence or comment left open is itself a finding,
 * because the text after it went unread.
 * `bin/gstack-prose-lint` prints one line per finding and a
 * `PROSE_LINT: ok | found=<n> | none` trailer; it gates only when asked
 * (`--gate`), so templates and docs get a report and nothing more.
 */
import * as fs from 'node:fs';
import { spawnSync } from './spawn-sync';
import { addedLines } from './banned-terms';
import { parseChangelog } from './changelog-check';

export type ProseRuleId =
  | 'vocabulary'
  | 'not-just-but'
  | 'metaphor-noun'
  | 'mid-sentence-colon'
  | 'inline-header-list'
  | 'arrow'
  | 'dropped-article'
  | 'unclosed-block';

export interface ProseFinding {
  rule: ProseRuleId;
  file: string;
  line: number;
  /** The matched text, trimmed to 80 characters. */
  match: string;
  /** What to do instead, in one clause. */
  hint: string;
}

export interface ProseLintResult {
  findings: ProseFinding[];
  /** Files that were read. */
  scanned: string[];
  /** Files that had no text to scan (no `[Unreleased]` block, or no added lines). */
  empty: string[];
}

/** Words that mark text as written on autopilot. Replace each with the plain word. */
export const VOCABULARY = [
  'additionally', 'crucial', 'delve', 'delves', 'delving', 'enduring', 'enhance', 'enhances', 'enhanced', 'enhancing',
  'fostering', 'fosters', 'garner', 'garners', 'garnered', 'interplay', 'intricate', 'pivotal', 'showcase', 'showcases',
  'showcasing', 'testament', 'underscores', 'underscored', 'underscoring', 'vibrant',
] as const;

/** Nouns borrowed from engineering or geography to make an ordinary thing sound structural. */
export const METAPHOR_NOUNS: ReadonlyArray<{ word: string; plain: string }> = [
  { word: 'substrate', plain: 'base' },
  { word: 'wedge', plain: 'the thing itself, or "add"' },
  { word: 'locus', plain: 'place' },
  { word: 'vantage', plain: 'view' },
  { word: 'nexus', plain: 'link or center' },
  { word: 'bedrock', plain: 'base' },
  { word: 'modality', plain: 'mode or kind' },
  { word: 'paradigm', plain: 'model or approach' },
  { word: 'gold-plating', plain: 'more than the job needs' },
  { word: 'north star', plain: 'goal' },
  { word: 'flywheel', plain: 'the loop you mean' },
  { word: 'endgame', plain: 'last phase' },
  { word: 'API surface', plain: 'the API, or the exported names' },
  { word: 'evacuate', plain: 'move out' },
];

const VOCABULARY_RE = new RegExp(String.raw`\b(?:${VOCABULARY.join('|')})\b`, 'gi');
const LANDSCAPE_RE = /\b(?:landscape|tapestry)\b(?!\s+(?:mode|orientation|image|photo|print))/gi;
const METAPHOR_RE = new RegExp(String.raw`\b(?:${METAPHOR_NOUNS.map(m => m.word.replace('-', '[- ]')).join('|')})s?\b`, 'gi');
const NOT_JUST_BUT_RE = /(?:\bnot|n['’]t)\s+(?:just|only|merely|simply)\b[^.!?\n]{0,120}?\bbut\b/gi;
/** A sentence of four or more words, a colon, then a lowercase clause: the colon is doing a conjunction's job. */
const MID_COLON_RE = /(?:^[ \t]*(?:(?:[-*+]|\d+\.)[ \t]+)?|[.!?][ \t]+)((?:[A-Za-z][\w'’-]*[ \t,]+){3,}[A-Za-z][\w'’-]*): ([a-z][\w'’-]*(?:[ \t]+[\w'’-]+){2,})/gm;
const INLINE_HEADER_RE = /^\s*(?:[-*+]|\d+\.)\s+\*\*([^*\n]{1,60}?):?\*\*:?\s+(\S+)/;
const ARROW_RE = /(\S{1,80})[ \t]*(→|->|=>|⇒)[ \t]*(\S{1,80})/g;
const SENTENCE_START_RE = /(?:^|[.!?]\s+|^\s*(?:[-*+]|\d+\.)\s+)([A-Z][a-z]+)\s+([a-z]+s)\b(?=\s+[a-z])/gm;
const BARE_NOUNS = new Set([
  'parser', 'user', 'agent', 'reviewer', 'runner', 'command', 'script', 'test', 'file', 'branch', 'build', 'gate',
  'receipt', 'train', 'lane', 'thread', 'model', 'caller', 'server', 'client', 'daemon', 'process', 'worker',
  'function', 'helper', 'hook', 'skill', 'section', 'template', 'body', 'title', 'entry', 'step', 'loop', 'check',
  'linter', 'workflow', 'pipeline', 'job', 'tool', 'flag', 'option', 'config', 'policy', 'rule', 'finding', 'issue',
  'request', 'response', 'result', 'output', 'error', 'warning', 'page', 'button', 'form', 'field', 'input', 'token',
  'key', 'value', 'record', 'row', 'table', 'column', 'query', 'index', 'cache', 'queue', 'message', 'event',
  'handler', 'listener', 'plugin', 'driver', 'module', 'package', 'library', 'dependency', 'version', 'release',
  'commit', 'merge', 'rebase', 'diff', 'patch', 'compiler', 'loader', 'scheduler', 'watcher', 'migration', 'schema',
  'endpoint', 'route', 'controller', 'service', 'container', 'image', 'cluster', 'node', 'deploy', 'install',
  'installer', 'upgrade', 'session', 'browser', 'tab', 'window', 'dialog', 'prompt', 'reply', 'answer', 'question',
]);
/** Verbs that are rarely plural nouns: "Test runs", "Error logs" and "Merge commits" are compound nouns, so runs, logs, calls, checks, passes, builds, counts, records, reports and their kind are left out. */
const VERBS = new Set([
  'rejects', 'refuses', 'accepts', 'emits', 'throws', 'renders', 'resolves', 'retries', 'restarts', 'tells',
  'validates', 'verifies', 'scans', 'lints', 'compiles', 'installs', 'upgrades', 'fetches', 'stamps', 'reheads',
  'owns', 'carries', 'loses', 'parses', 'creates', 'deletes', 'updates', 'handles', 'hides', 'keeps', 'skips',
  'adds', 'removes', 'writes', 'reads', 'prints', 'sends', 'exits', 'fails', 'needs', 'takes', 'uses',
]);
const NUMERIC_SIDE = /^[$£€]?[+-]?\d|^v\d|^CODE$|^URL$|^(?:before|after)$/i;
const LIST_INTRODUCER = /\b(?:examples?|following|these|this|below|measurements?|two|three|four|five|six)$/i;
const trimSide = (s: string) => s.replace(/^[(\[`"'*_]+|[)\]`"'*_,.;:]+$/g, '');

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const pad = (m: string) => ' '.repeat(m.length);

/**
 * Walk the lines once, tracking the fenced-block and HTML-comment state a Markdown
 * renderer would. `inside` is true for a line that is wholly inside a fence or a
 * comment; a line that opens or closes one is reported with the text outside it.
 * A fence closes only on a bare fence line of the same kind and at least its length.
 */
function walkBlocks(text: string, visit: (line: string, inside: boolean, index: number) => void): { kind: 'fence' | 'comment'; line: number } | null {
  let fence: string | null = null;
  let fenceLine = 0, commentLine = 0;
  let comment = false;
  text.split('\n').forEach((raw, i) => {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null;
      return visit(raw, true, i);
    }
    let line = raw;
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) return visit(raw, true, i);
      comment = false;
      line = ' '.repeat(end + 3) + line.slice(end + 3);
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) { fence = open[1]!; fenceLine = i + 1; return visit(raw, true, i); }
    line = line
      .replace(/(`+)([^`\n](?:[^\n]*?[^`\n])?)\1(?!`)/g, (m) => 'CODE' + ' '.repeat(Math.max(0, m.length - 4)))
      .replace(/\]\([^)\s]+\)/g, (m) => ']' + ' '.repeat(m.length - 1))
      .replace(/https?:\/\/(?:(?!-->)\S)+/g, (m) => 'URL' + ' '.repeat(Math.max(0, m.length - 3)));
    const tail = line.lastIndexOf('<!--');
    if (tail >= 0 && line.indexOf('-->', tail) < 0) { comment = true; commentLine = i + 1; line = line.slice(0, tail); }
    visit(line.replace(/<!--[\s\S]*?-->/g, pad), false, i);
  });
  return fence ? { kind: 'fence', line: fenceLine } : comment ? { kind: 'comment', line: commentLine } : null;
}

/** Replace fenced blocks, inline code, links' targets, URLs, HTML comments and quoted words with same-length placeholders so line numbers hold. A fence or comment left open at the end is reported, since everything after it went unread. */
export function maskProse(text: string): { masked: string; unclosed: { kind: 'fence' | 'comment'; line: number } | null } {
  const out: string[] = [];
  const unclosed = walkBlocks(text, (line, inside) => {
    out.push(inside ? '' : line.replace(/(["“])[^"“”\n]{1,400}(["”])/g, pad));
  });
  return { masked: out.join('\n'), unclosed };
}

function excerpt(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '...' : t;
}

/** Lint one text; `file` is only carried into the findings. Lines are 1-based from the text's own start plus `offset`. */
export function lintProse(text: string, file: string, offset = 0): ProseFinding[] {
  const { masked, unclosed } = maskProse(text);
  const lines = masked.split('\n');
  const findings: ProseFinding[] = [];
  const push = (rule: ProseRuleId, line: number, match: string, hint: string) => findings.push({ rule, file, line: line + offset, match: excerpt(match), hint });
  const lineAt = (index: number) => masked.slice(0, index).split('\n').length;
  if (unclosed) push('unclosed-block', unclosed.line, unclosed.kind === 'fence' ? 'fence never closed' : 'HTML comment never closed', 'close it; nothing after it was read');

  lines.forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(VOCABULARY_RE)) push('vocabulary', n, m[0], 'use the plain word');
    for (const m of line.matchAll(LANDSCAPE_RE)) push('vocabulary', n, m[0], 'name the actual set of things');
    for (const m of line.matchAll(METAPHOR_RE)) {
      const row = METAPHOR_NOUNS.find(r => new RegExp(String.raw`^${r.word.replace('-', '[- ]')}s?$`, 'i').test(m[0]));
      push('metaphor-noun', n, m[0], `say "${row?.plain ?? 'the concrete thing'}"`);
    }
    for (const m of line.matchAll(NOT_JUST_BUT_RE)) push('not-just-but', n, m[0], 'state the point once, without the contrast');
    const header = INLINE_HEADER_RE.exec(line);
    if (header) {
      const label = header[1]!.replace(/[*`]/g, '').trim().split(/\s+/)[0]!.toLowerCase().replace(/[^a-z0-9]/g, '');
      const first = header[2]!.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (label && label.length > 2 && label !== 'code' && first === label) push('inline-header-list', n, header[0], 'drop the label or make the line say something the label does not');
    }
    for (const m of line.matchAll(ARROW_RE)) {
      const left = trimSide(m[1]!), right = trimSide(m[3]!);
      if (!left || !right || (NUMERIC_SIDE.test(left) && NUMERIC_SIDE.test(right))) continue;
      push('arrow', n, m[0], 'write the sentence the arrow stands for');
    }
  });
  for (const m of masked.matchAll(MID_COLON_RE)) if (!LIST_INTRODUCER.test(m[1]!)) push('mid-sentence-colon', lineAt(m.index! + m[0].indexOf(':')), `${m[1]!.split(/\s+/).slice(-3).join(' ')}: ${m[2]!.split(/\s+/).slice(0, 3).join(' ')}`, 'end the sentence there, or join the halves with a plain conjunction');
  for (const m of masked.matchAll(SENTENCE_START_RE)) {
    if (BARE_NOUNS.has(m[1]!.toLowerCase()) && VERBS.has(m[2]!)) push('dropped-article', lineAt(m.index! + m[0].indexOf(m[1]!)), `${m[1]} ${m[2]}`, 'start with "the" or "a"');
  }
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** The `## [Unreleased]` block of a CHANGELOG, with the 1-based line its heading sits on; null when there is none. */
export function unreleasedBlock(text: string): { text: string; line: number } | null {
  const section = parseChangelog(text).sections.find(s => s.unreleased);
  if (!section) return null;
  return { text: section.lines.join('\n'), line: section.start + 1 };
}

/** The text with every line outside the named `## ` sections blanked, so line numbers hold; null when none of them is present. */
export function sectionsOnly(text: string, names: string[]): string | null {
  const wanted = new Set(names.map(n => n.trim().toLowerCase()).filter(Boolean));
  const raw = text.split('\n');
  let keep = false, found = false;
  const out: string[] = [];
  walkBlocks(text, (line, inside, i) => {
    const h = inside ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (h) { keep = wanted.has(h[1]!.toLowerCase()); found ||= keep; out.push(''); return; }
    out.push(keep ? raw[i]! : '');
  });
  return found ? out.join('\n') : null;
}

export interface LintFilesOptions {
  /** Scan only each file's `[Unreleased]` CHANGELOG block. */
  unreleased?: boolean;
  /** Scan only the text under these `## ` headings (the sections an author writes in a PR body). */
  sections?: string[];
  /** Scan only the lines the working tree adds to each file since the merge base with this ref (the ref itself when no merge base resolves). */
  base?: string;
}

/** The file's whole text plus the 1-based lines the branch added, so fences and comments around an added line still mask it; `added` is null for an untracked file (read whole) and the result is null when nothing was added. */
export function addedOnly(file: string, base: string): { text: string; added: Set<number> | null } | null {
  const run = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', timeout: 30_000 });
  const text = fs.readFileSync(file, 'utf8');
  if (run(['ls-files', '--error-unmatch', '--', file]).status !== 0) return { text, added: null };
  const mb = run(['merge-base', base, 'HEAD']);
  const since = mb.status === 0 ? mb.stdout.trim() : base;
  const diff = run(['diff', '--unified=0', '--no-color', '--no-ext-diff', since, '--', file]);
  if (diff.status !== 0) throw new Error(`git diff ${since} -- ${file} failed: ${diff.stderr.trim()}`);
  const added = [...addedLines(diff.stdout).values()].flat();
  if (added.length === 0) return null;
  return { text, added: new Set(added.map(l => l.line)) };
}

export function lintFiles(files: string[], opts: LintFilesOptions = {}): ProseLintResult {
  const result: ProseLintResult = { findings: [], scanned: [], empty: [] };
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (opts.base) {
      const added = addedOnly(file, opts.base);
      if (added === null) { result.empty.push(file); continue; }
      result.scanned.push(file);
      result.findings.push(...lintProse(added.text, file).filter(f => !added.added || added.added.has(f.line)));
      continue;
    }
    if (opts.sections) {
      const picked = sectionsOnly(text, opts.sections);
      if (picked === null) { result.empty.push(file); continue; }
      result.scanned.push(file);
      result.findings.push(...lintProse(picked, file));
      continue;
    }
    if (opts.unreleased) {
      const block = unreleasedBlock(text);
      if (!block) { result.empty.push(file); continue; }
      result.scanned.push(file);
      result.findings.push(...lintProse(block.text, file, block.line - 1));
      continue;
    }
    result.scanned.push(file);
    result.findings.push(...lintProse(text, file));
  }
  return result;
}

export function renderProseLint(r: ProseLintResult): string {
  const lines = r.findings.map(f => `PROSE: ${f.file}:${f.line} ${f.rule} "${f.match}" (${f.hint})`);
  const state = r.findings.length ? `found=${r.findings.length}` : r.scanned.length ? 'ok' : 'none';
  lines.push(`PROSE_LINT: ${state} files=${r.scanned.length}${r.empty.length ? ` nothing-to-scan=${r.empty.length}` : ''}`);
  return lines.join('\n') + '\n';
}
