/**
 * Shared read-only Bash grammar for paid-eval fixtures (GSTA-49).
 *
 * A fixture whose contract is not about which reads happen opts in by also
 * accepting what this grammar accepts and by declaring readOnlyInterfaceText()
 * to its actor. Fixtures whose contract is specifically about which reads
 * happen keep their narrow lists.
 *
 * Accepted: one line of simple commands from READ_TOOLS joined by ;, && or ||,
 * where a | pipe may feed only a STDIN_TOOLS filter (tr only there, with literal
 * sets), plus cd into a directory
 * inside the root. Every path operand, path-valued option and unquoted glob
 * match must resolve physically (symlinks and .. applied) inside the fixture
 * root and outside its denied paths.
 * Stderr may be discarded with 2>/dev/null or merged with 2>&1 after a word.
 * Rejected: every other tool, every other redirect, substitutions, variables, tilde and
 * brace expansion, backgrounding, multi-line input, and the write, exec,
 * symlink-following and output-file options of the listed tools.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ReadOnlyScope = {
  /** Fixture working root: every resolved path must stay inside it. */
  root: string;
  /** Starting directory; defaults to the root and must be inside it. */
  cwd?: string;
  /** Physical paths that must never be read, listed or searched (credentials, private actor state). */
  deny?: (physical: string) => boolean;
};

type Word = { text: string; glob: boolean; quoted: boolean };
type Token = Word | { op: '|' | ';' | '&&' | '||' };

type ToolSpec = {
  /** A whole option word that needs no separate value. */
  flag: RegExp;
  /** An option word that takes the next word as a non-path value. */
  valued?: RegExp;
  /** An option word that takes the next word as a path. */
  pathValued?: RegExp;
  /** An option word carrying a path in capture group 1. */
  pathAttached?: RegExp;
  /** The first operand is a pattern unless a pattern option was given. */
  pattern?: boolean;
  /** Directory operands are searched by content, so the deny scan applies below them. */
  recursive?: (options: string[]) => boolean;
  maxOperands?: number;
  /** Arguments are literal text, never paths: no globs, and no option before the first argument except echo's -n/-e/-E. */
  literal?: boolean;
};

const HEAD_TAIL: ToolSpec = {
  flag: /^(?:-[qvz]+|-\d+|-[nc][+-]?\d+[a-zA-Z]*|--(?:quiet|silent|verbose|zero-terminated)|--(?:lines|bytes)=[+-]?\d+[a-zA-Z]*)$/,
  valued: /^-[nc]$/,
};
const CHECKSUM: ToolSpec = { flag: /^(?:-[btz]+|--(?:binary|text|tag|zero))$/ };

export const READ_TOOLS: Readonly<Record<string, ToolSpec>> = {
  pwd: { flag: /^-[LP]$/, maxOperands: 0 },
  ls: { flag: /^(?:-[aAbBcCdfFgGhiklmnNopqQrRsStuUvwxX1Z]+|--(?:all|almost-all|human-readable|recursive|reverse|size|inode|directory|classify|full-time|group-directories-first|numeric-uid-gid|no-group|color=never|sort=(?:none|size|time|version|extension|name)|time-style=[\w+%:.-]+))$/ },
  wc: { flag: /^(?:-[clmwL]+|--(?:lines|bytes|chars|words|max-line-length|total=(?:auto|always|only|never)))$/ },
  head: HEAD_TAIL,
  tail: HEAD_TAIL,
  cat: { flag: /^(?:-[AbeEnstTuv]+|--(?:number|number-nonblank|show-all|show-ends|show-tabs|show-nonprinting|squeeze-blank))$/ },
  stat: { flag: /^(?:-[Lft]+|-c.+|--(?:dereference|file-system|terse)|--(?:format|printf)=.+)$/, valued: /^-c$/ },
  file: { flag: /^(?:-[bhiLkNr0]+|--(?:brief|mime|mime-type|mime-encoding|dereference|no-dereference|keep-going|raw|no-pad))$/ },
  du: { flag: /^(?:-[abchkmsSxl0]+|-d\d+|--(?:all|apparent-size|bytes|total|human-readable|summarize|separate-dirs|one-file-system|count-links|null|si)|--max-depth=\d+|--exclude=.+)$/, valued: /^-d$/ },
  find: { flag: /^$/ },
  sed: { flag: /^$/ },
  grep: {
    flag: /^(?:-[EFGPiywxvcLlnhHoqsrabIUzZT]+|-[mABC]\d+|--(?:extended-regexp|fixed-strings|basic-regexp|perl-regexp|ignore-case|no-ignore-case|word-regexp|line-regexp|invert-match|count|files-with-matches|files-without-match|line-number|no-filename|with-filename|only-matching|quiet|silent|no-messages|recursive|text|byte-offset|null|null-data|initial-tab|colou?r(?:=(?:never|auto|always))?)|--(?:max-count|after-context|before-context|context)=\d+|--(?:include|exclude|exclude-dir|label|binary-files)=.+|--directories=(?:read|skip|recurse)|--devices=(?:read|skip))$/,
    valued: /^-[mABCdD]$/,
    pathValued: /^-f$/,
    pathAttached: /^(?:-f|--file=)(.+)$/,
    pattern: true,
    recursive: options => options.some((option, index) => /^-[^-]*r/.test(option) || option === '--recursive'
      || option === '--directories=recurse' || (option === '-d' && options[index + 1] === 'recurse')),
  },
  rg: {
    flag: /^(?:-[iSsFwxvclnNHIoqauU0.]+|-[mABCdMj]\d+|--(?:hidden|no-ignore|ignore-case|smart-case|case-sensitive|fixed-strings|word-regexp|line-regexp|invert-match|count|count-matches|files|files-with-matches|files-without-match|line-number|no-line-number|with-filename|no-filename|only-matching|quiet|heading|no-heading|json|vimgrep|unrestricted|text|null|no-messages|stats|column|no-config)|--colou?r=(?:never|auto|always)|--sort=(?:none|path|modified|accessed|created)|--(?:max-count|max-depth|context|after-context|before-context|max-columns|threads)=\d+|--(?:glob|iglob|type|type-not|encoding)=.+)$/,
    valued: /^(?:-[gtTmABCdMjE]|--(?:glob|iglob|type|type-not|max-count|max-depth|context|after-context|before-context|max-columns|threads|encoding|sort))$/,
    pathValued: /^(?:-f|--file)$/,
    pathAttached: /^--file=(.+)$/,
    pattern: true,
    recursive: () => true,
  },
  sort: { flag: /^(?:-[bdfgiMhnRrsuVcCzm]+|-[kt].+|--(?:ignore-leading-blanks|dictionary-order|ignore-case|general-numeric-sort|ignore-nonprinting|month-sort|human-numeric-sort|numeric-sort|random-sort|reverse|stable|unique|version-sort|check|merge|zero-terminated)|--(?:key|field-separator)=.+)$/, valued: /^-[kt]$/ },
  uniq: { flag: /^(?:-[cdDiuz]+|-[fsw]\d+|--(?:count|repeated|unique|ignore-case|zero-terminated)|--(?:skip-fields|skip-chars|check-chars)=\d+)$/, valued: /^-[fsw]$/, maxOperands: 1 },
  cut: { flag: /^(?:-[sz]+|-[bcfd].+|--(?:complement|only-delimited|zero-terminated)|--(?:bytes|characters|fields|delimiter|output-delimiter)=.+)$/, valued: /^-[bcfd]$/ },
  nl: { flag: /^(?:-p|-[bdfhilnsvw].+|--no-renumber|--(?:body-numbering|section-delimiter|footer-numbering|header-numbering|line-increment|join-blank-lines|number-format|number-separator|starting-line-number|number-width)=.+)$/, valued: /^-[bdfhilnsvw]$/ },
  sha256sum: CHECKSUM,
  sha1sum: CHECKSUM,
  sha512sum: CHECKSUM,
  md5sum: CHECKSUM,
  echo: { flag: /^-[neE]+$/, literal: true },
  printf: { flag: /^--$/, literal: true },
  readlink: { flag: /^-[efmnqsvz]+$/ },
  tr: { flag: /^-[cCdst]+$/, maxOperands: 2 },
  realpath: { flag: /^-[eLmPqsz]+$/ },
};

/** Tools that may receive a pipe. Each one only prints what it reads. */
export const STDIN_TOOLS: ReadonlySet<string> = new Set(['wc', 'head', 'tail', 'cat', 'grep', 'rg', 'sort', 'uniq', 'cut', 'nl', 'sha256sum', 'sha1sum', 'sha512sum', 'md5sum', 'sed', 'tr']);

const FIND_FLAGS = new Set(['-print', '-print0', '-prune', '-empty', '-true', '-false', '-a', '-o', '-and', '-or', '-not',
  '-readable', '-writable', '-executable', '-depth', '-nowarn', '-xdev', '-mount', '-quit', '-ls', '(', ')', '!', ',']);
const FIND_VALUES = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-regextype',
  '-type', '-xtype', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-perm',
  '-user', '-group', '-uid', '-gid', '-links', '-inum', '-lname', '-ilname', '-used', '-printf']);
const FIND_PATHS = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);

/** Interface text an opted-in fixture declares to its actor. */
export function readOnlyInterfaceText(root: string): string {
  return `Shared read-only grammar: Bash also accepts pure local reads whose every path, unquoted glob matches included, resolves inside ${root} with no .., symlink or absolute-path escape: ${Object.keys(READ_TOOLS).join(', ')} (find without -exec, -ok, -delete or -fprint*; sed only as -n with a line-range print script such as sed -n 1,200p; no output-file, symlink-following or external-program options; echo and printf with literal arguments only, no printf -v; tr only after a pipe, with -c, -C, -d, -s or -t and one or two literal sets that hold no $, backtick, brace or unquoted glob). An unquoted glob may stand only as a path operand; quote a glob inside an option or pattern (grep -rn word . --include='*.md', find . -name '*.md'), because the shell expands an unquoted one before the command runs. Join only these reads with ;, && or ||, pipe only into ${[...STDIN_TOOLS].join(', ')}, and cd only into a directory inside that root. Redirects other than 2>/dev/null or 2>&1 right after a read's arguments, tee, substitutions, variables, tilde or brace expansion, background jobs, multi-line commands and every other tool stay outside this grammar.`;
}

export function readOnlyCommandAllowed(command: string, scope: ReadOnlyScope): boolean {
  return readOnlyCommandRejection(command, scope) === undefined;
}

/** Why the grammar rejects a command, or undefined for an accepted pure local read. */
export function readOnlyCommandRejection(command: string, scope: ReadOnlyScope): string | undefined {
  const tokens = tokenize(command.trim());
  if (typeof tokens === 'string') return tokens;
  let root: string;
  try { root = fs.realpathSync.native(scope.root); } catch { return 'fixture root does not exist'; }
  const start = physicalPath(path.resolve(scope.root, scope.cwd ?? '.'));
  if (!start || !inside(start, root)) return 'starting directory outside root';
  const context: Context = { root, deny: scope.deny ?? (() => false) };
  let cwds = [start];
  let pipeline: Word[][] = [[]];
  const finish = (): string | undefined => {
    if (pipeline.some(words => !words.length)) return 'empty command';
    if (pipeline.length === 1 && pipeline[0][0].text === 'cd' && !pipeline[0][0].quoted) {
      const targets = cdTargets(pipeline[0], cwds, context);
      if (typeof targets === 'string') return targets;
      cwds = [...new Set([...cwds, ...targets])];
    } else {
      for (const [index, words] of pipeline.entries()) {
        const rejection = commandRejection(words, index > 0, cwds, context);
        if (rejection) return rejection;
      }
    }
    pipeline = [[]];
  };
  for (const [index, token] of tokens.entries()) {
    if (!('op' in token)) { pipeline.at(-1)!.push(token); continue; }
    if (token.op === '|') { pipeline.push([]); continue; }
    if (token.op === ';' && index === tokens.length - 1) break;
    const rejection = finish();
    if (rejection) return rejection;
  }
  return finish();
}

function tokenize(command: string): Token[] | string {
  if (!command) return 'empty command';
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return 'multi-line or control characters';
  const tokens: Token[] = [];
  let word: Word | undefined;
  const end = () => { if (word) tokens.push(word); word = undefined; };
  const append = (text: string, quoted: boolean) => {
    word ??= { text: '', glob: false, quoted: false };
    word.text += text;
    word.quoted ||= quoted;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === ' ' || c === '\t') { end(); continue; }
    if (c === '|' || c === '&' || c === ';') {
      end();
      const pair = command.slice(i, i + 2);
      if (pair === '||' || pair === '&&') { tokens.push({ op: pair }); i++; continue; }
      if (c === '&' || pair === '|&' || pair === ';;') return 'background job or unsupported operator';
      tokens.push({ op: c as '|' | ';' });
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return 'unterminated quote';
      append(command.slice(i + 1, close), true);
      i = close;
      continue;
    }
    if (c === '"') {
      let text = '';
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '$' || command[i] === '`') return 'substitution or variable';
        // Both bash and zsh read \" inside double quotes as one literal quote character (gate 44321344888: the parent
        // grepped for widget.md.tmpl" with "...widget.md.tmpl\""); every other escape there stays rejected.
        if (command[i] === '\\' && command[i + 1] === '"') { text += '"'; i++; continue; }
        if (command[i] === '\\' && /[$`"\\]/.test(command[i + 1] ?? '"')) return 'escape inside double quotes';
        text += command[i];
      }
      if (i >= command.length) return 'unterminated quote';
      append(text, true);
      continue;
    }
    if (c === '\\') {
      const next = command[i + 1];
      if (word || !next || !'()!'.includes(next) || !/^[ \t]?$/.test(command[i + 2] ?? '')) return 'shell escape';
      tokens.push({ text: next, glob: false, quoted: true });
      i++;
      continue;
    }
    if (c === '$' || c === '`') return 'substitution or variable';
    const discard = c === '>' && word?.text === '2' && !word.quoted && tokens.length > 0 && !('op' in tokens.at(-1)!)
      ? /^>(?:\/dev\/null|&1)(?=[ \t;|&]|$)/.exec(command.slice(i)) : null;
    if (discard) { word = undefined; i += discard[0].length - 1; continue; }
    if (c === '>' || c === '<') return 'redirect';
    if ('(){}'.includes(c)) return 'subshell, grouping or brace expansion';
    if (!word && (c === '~' || c === '#')) return 'tilde expansion or comment';
    if (!/[A-Za-z0-9_./:@%+,=^!*?[\]-]/.test(c)) return `unsupported unquoted character ${JSON.stringify(c)}`;
    append(c, false);
    if ('*?['.includes(c)) word!.glob = true;
  }
  end();
  return tokens;
}

type Context = { root: string; deny: (physical: string) => boolean };

function cdTargets(words: Word[], cwds: string[], context: Context): string[] | string {
  if (words.length !== 2 || words[1].glob || words[1].text.startsWith('-')) return 'cd needs exactly one literal directory';
  const targets: string[] = [];
  for (const cwd of cwds) {
    const target = physicalPath(path.isAbsolute(words[1].text) ? words[1].text : `${cwd}/${words[1].text}`);
    if (!target || !inside(target, context.root)) return 'cd outside root';
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) return 'cd target is not a directory';
    targets.push(target);
  }
  return targets;
}

function commandRejection(words: Word[], piped: boolean, cwds: string[], context: Context): string | undefined {
  const [name, ...args] = words;
  if (name.quoted || name.glob) return 'quoted or globbed command name';
  if (name.text === 'cd') return 'cd inside a pipeline';
  const spec = READ_TOOLS[name.text];
  if (!spec) return `unlisted tool: ${name.text}`;
  if (piped && !STDIN_TOOLS.has(name.text)) return `${name.text} cannot read a pipe`;
  if (name.text === 'find') return findRejection(args, cwds, context);
  if (name.text === 'tr') return trRejection(args, piped);
  if (name.text === 'sed') {
    const start = args.findIndex(arg => !/^(?:-n|--quiet|--silent)$/.test(arg.text));
    const [script, ...files] = start < 0 ? [] : args.slice(start);
    if (!script || !/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(script.text) || files.some(file => file.text.startsWith('-')))
      return 'sed takes only -n and a line-range print script';
    return pathsRejection(files, cwds, context, false);
  }
  if (spec.literal) {
    if (args.some(arg => arg.glob)) return 'unquoted glob in literal arguments';
    if (name.text === 'printf' && args[0]?.text.startsWith('-') && args[0].text !== '--') return `unsupported printf option: ${args[0].text}`;
    return undefined;
  }
  const options: string[] = [];
  const operands: Word[] = [];
  const paths: Word[] = [];
  let patternGiven = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOfOptions || !arg.text.startsWith('-') || arg.text === '-') { operands.push(arg); continue; }
    if (arg.text === '--') { endOfOptions = true; continue; }
    if (arg.glob) return `globbed option: ${arg.text}; quote the glob: ${arg.text.replace(/^(--?[^=]+=)?(.*)$/s, "$1'$2'")}`;
    options.push(arg.text);
    const attached = spec.pathAttached?.exec(arg.text);
    if (attached) { paths.push({ text: attached[1], glob: false, quoted: true }); patternGiven = true; continue; }
    const patternOption = spec.pattern && /^(?:-e|--regexp)(?:=.+|.+)?$/.exec(arg.text);
    if (patternOption && arg.text !== '-e' && arg.text !== '--regexp') { patternGiven = true; continue; }
    const takesPath = spec.pathValued?.test(arg.text) ?? false;
    if (takesPath || patternOption || spec.valued?.test(arg.text)) {
      const value = args[++i];
      if (!value) return `missing value for ${arg.text}`;
      if (value.glob) return `unquoted glob in ${arg.text} value`;
      options.push(value.text);
      if (takesPath) paths.push(value);
      if (takesPath || patternOption) patternGiven = true;
      continue;
    }
    if (!spec.flag.test(arg.text)) return `unsupported ${name.text} option: ${arg.text}`;
  }
  if (spec.pattern && !patternGiven) {
    const pattern = operands.shift();
    if (!pattern) return `${name.text} needs a pattern`;
    if (pattern.glob) return 'unquoted glob as a pattern';
  }
  if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return `${name.text} takes at most ${spec.maxOperands} operand(s)`;
  const recursive = spec.recursive?.(options) ?? false;
  if (recursive && !operands.length) operands.push({ text: '.', glob: false, quoted: true });
  return pathsRejection([...operands.filter(operand => operand.text !== '-'), ...paths], cwds, context, recursive);
}

function trRejection(args: Word[], piped: boolean): string | undefined {
  if (!piped) return 'tr reads only a pipe';
  let start = 0;
  while (start < args.length && args[start].text.startsWith('-') && args[start].text.length > 1) {
    if (args[start].text === '--') { start++; break; }
    if (!READ_TOOLS.tr.flag.test(args[start].text)) return `unsupported tr option: ${args[start].text}`;
    start++;
  }
  const sets = args.slice(start);
  if (!sets.length || sets.length > READ_TOOLS.tr.maxOperands!) return 'tr takes one or two literal sets';
  if (sets.some(set => set.glob || /[$`{}]/.test(set.text))) return 'tr sets must be literal';
}

function findRejection(args: Word[], cwds: string[], context: Context): string | undefined {
  let i = args[0]?.text === '-P' ? 1 : 0;
  const paths: Word[] = [];
  for (; i < args.length && !/^[-(!),]/.test(args[i].text); i++) paths.push(args[i]);
  if (!paths.length) paths.push({ text: '.', glob: false, quoted: true });
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg.glob) return `unquoted glob in find expression: ${arg.text}`;
    if (FIND_FLAGS.has(arg.text)) continue;
    if (!FIND_VALUES.has(arg.text) && !FIND_PATHS.has(arg.text)) return `unsupported find primary: ${arg.text}`;
    const value = args[++i];
    if (!value) return `missing value for ${arg.text}`;
    if (value.glob) return `unquoted glob in ${arg.text} value`;
    if (FIND_PATHS.has(arg.text)) paths.push(value);
  }
  return pathsRejection(paths, cwds, context, false);
}

function pathsRejection(words: Word[], cwds: string[], context: Context, recursive: boolean): string | undefined {
  for (const cwd of cwds) {
    for (const word of words) {
      if (!word.text) return 'empty path';
      const candidates = word.glob ? expandGlob(word.text, cwd, context) : [word.text];
      if (typeof candidates === 'string') return candidates;
      for (const candidate of candidates) {
        if (word.glob && candidate.startsWith('-')) return 'glob expands to an option';
        const physical = physicalPath(path.isAbsolute(candidate) ? candidate : `${cwd}/${candidate}`);
        if (!physical || !inside(physical, context.root)) return `path outside root: ${candidate}`;
        if (context.deny(physical)) return `denied path: ${candidate}`;
        if (recursive && deniedBelow(physical, context)) return `recursive search reaches a denied path: ${candidate}`;
      }
    }
  }
}

/** Bash pathname expansion without dotglob, globstar or extglob; a pattern with no match stays literal. */
function expandGlob(pattern: string, cwd: string, context: Context): string[] | string {
  const segments = pattern.split('/');
  if (segments.includes('..')) return 'glob with ..';
  const first = segments.findIndex(segment => /[*?[]/.test(segment));
  const prefix = segments.slice(0, first).join('/');
  const base = physicalPath(pattern.startsWith('/') ? prefix || '/' : `${cwd}/${prefix}`);
  if (!base || !inside(base, context.root)) return `glob outside root: ${pattern}`;
  let matches = [{ shown: prefix, actual: base }];
  for (const segment of segments.slice(first)) {
    const regex = globSegment(segment);
    matches = matches.flatMap(match => {
      const join = (name: string) => ({ shown: match.shown || pattern.startsWith('/') ? `${match.shown}/${name}` : name, actual: path.join(match.actual, name) });
      if (!regex) return segment === '' || fs.lstatSync(path.join(match.actual, segment), { throwIfNoEntry: false }) ? [join(segment)] : [];
      let names: string[];
      try { names = fs.readdirSync(match.actual); } catch { return []; }
      return names.filter(name => regex.test(name) && (segment.startsWith('.') || !name.startsWith('.'))).sort().map(join);
    });
  }
  return matches.length ? matches.map(match => match.shown) : [pattern];
}

function globSegment(segment: string): RegExp | undefined {
  if (!/[*?[]/.test(segment)) return undefined;
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const close = c === '[' ? segment.indexOf(']', i + 2) : -1;
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (close > 0) {
      const body = segment.slice(i + 1, close).replace(/\\/g, '\\\\');
      source += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
      i = close;
    } else source += c.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The kernel's view of a path: symlinks resolved in order and .. applied to the resolved parent. */
function physicalPath(file: string): string | null {
  const parts = file.split('/');
  let current = '/';
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    const entry = fs.lstatSync(next, { throwIfNoEntry: false });
    if (!entry) {
      const rest = parts.slice(index + 1);
      return rest.includes('..') ? null : path.join(next, ...rest);
    }
    if (!entry.isSymbolicLink()) { current = next; continue; }
    try { current = fs.realpathSync.native(next); } catch { return null; }
  }
  return current;
}

function inside(file: string, root: string): boolean {
  return file === root || file.startsWith(root === '/' ? root : root + '/');
}

/** True when a content search below directory would reach a denied path (or the tree is too large to prove it would not). */
function deniedBelow(directory: string, context: Context): boolean {
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return false;
  let budget = 20_000;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return true; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (--budget < 0 || context.deny(child)) return true;
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return false;
}
