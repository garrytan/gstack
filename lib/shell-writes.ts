/**
 * shell-writes — the repo files a Bash command writes, for the skill contract's
 * check_after_last_edit item (GST-1633). A fix written through the shell (a
 * heredoc into python or cat, sed -i, tee, a > or >> redirect, patch, git apply)
 * is an edit just like an Edit call, so a test run before it does not count.
 *
 * Conservative: a write counts only when its target resolves inside the session
 * directory. Reads, output to stdout, fd duplications (2>&1), /dev paths, targets
 * under another directory (/tmp, ~, ../) and targets named by a variable never
 * count. patch, git apply and xargs sed -i with no visible target count when they
 * run inside the session directory, since they only write the tree they run in.
 */
import * as path from 'path';

const posix = path.posix;
/** Stands in for the session directory when the transcript does not name one. */
const UNKNOWN_DIR = '/\0session';

type Tok = { kind: 'word'; raw: string; value: string } | { kind: 'op'; value: string } | { kind: 'redir'; op: string } | { kind: 'heredoc'; body: string };
export interface ShellCommand { words: string[]; text: string; redirects: { op: string; target: string }[]; heredocs: string[]; cwd: string | null; pipeline: number }

/** The index just past the bracket that closes the one at src[from] (quotes are not tracked). */
function closing(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return j + 1;
  }
  return src.length;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const pending: { delim: string; strip: boolean; at: number }[] = [];
  let raw = '';
  let value = '';
  let inWord = false;
  let i = 0;
  const flush = () => { if (inWord) toks.push({ kind: 'word', raw, value }); raw = ''; value = ''; inWord = false; };
  const take = (end: number, v = src.slice(i, end)) => { raw += src.slice(i, end); value += v; inWord = true; i = end; };
  const bodies = () => {
    const due = pending.splice(0);
    due.forEach((h, n) => {
      const lines: string[] = [];
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const end = nl < 0 ? src.length : nl;
        const line = src.slice(i, end);
        i = end + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      toks.splice(h.at, 0, { kind: 'heredoc', body: lines.join('\n') });
      for (const later of due.slice(n + 1)) later.at++;
    });
  };
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else take(Math.min(i + 2, src.length), src[i + 1] ?? '');
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      take(end < 0 ? src.length : end + 1, src.slice(i + 1, end < 0 ? src.length : end));
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && '"\\$`'.includes(src[j + 1] ?? '')) j++;
        v += src[j];
      }
      take(Math.min(j + 1, src.length), v);
    } else if (rest.startsWith('$(') || rest.startsWith('${')) {
      take(closing(src, i + 1, src[i + 1], src[i + 1] === '(' ? ')' : '}'));
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      take(end < 0 ? src.length : end + 1);
    } else if (rest.startsWith('((') && !inWord) {
      take(closing(src, i, '(', ')'));
      flush();
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\n') {
      flush();
      toks.push({ kind: 'op', value: '\n' });
      i++;
      bodies();
    } else if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else {
      const redir = /^(?:&>>|&>|\d*>>|\d*>&|\d*>\||\d*>|<<<|<<-|<<|\d*<&|\d*<>|\d*<)/.exec(rest);
      const op = /^(?:\|\||&&|\|&|;;|[;|&()])/.exec(rest);
      if (redir && !(inWord && /^\d/.test(redir[0]))) {
        flush();
        i += redir[0].length;
        if (redir[0] === '<<' || redir[0] === '<<-') {
          while (src[i] === ' ' || src[i] === '\t') i++;
          const m = /^(['"])(.*?)\1|^[^\s;&|<>()]+/.exec(src.slice(i));
          pending.push({ delim: m ? (m[2] ?? m[0]).replace(/\\/g, '') : '', strip: redir[0] === '<<-', at: toks.length });
          i += m ? m[0].length : 0;
          continue;
        }
        const dup = /[<>]&$/.test(redir[0]) ? /^\s*(?:\d+|-)/.exec(src.slice(i)) : null;
        if (dup) i += dup[0].length;
        else toks.push({ kind: 'redir', op: redir[0].replace(/^(\d*)>&$/, '&>') });
      } else if (op) {
        flush();
        toks.push({ kind: 'op', value: op[0] });
        i += op[0].length;
      } else {
        take(i + 1);
      }
    }
  }
  flush();
  bodies();
  return toks;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', '{', '}']);
/** Words that run the command after them, with the options of each that take a value. */
const PREFIXES: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S']), sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-U']), command: new Set(), exec: new Set(['-a']),
  nice: new Set(['-n']), nohup: new Set(), time: new Set(), timeout: new Set(['-s', '-k', '--signal', '--kill-after']), xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
};
const SHELLS = /^(?:bash|sh|zsh|dash)$/;
const base = (word: string) => word.split('/').pop() ?? '';

/** The words that run: assignments, reserved words and prefix commands (with their options) removed. */
function program(words: string[]): string[] {
  let w = words;
  for (let guard = 0; guard < 8 && w.length; guard++) {
    while (w.length && (ASSIGN.test(w[0]) || RESERVED.has(w[0]))) w = w.slice(1);
    const valued = PREFIXES[base(w[0] ?? '')];
    if (!valued) break;
    const name = base(w[0]);
    let k = 1;
    while (k < w.length && (w[k].startsWith('-') || ASSIGN.test(w[k]))) k += valued.has(w[k]) ? 2 : 1;
    if (name === 'timeout' && k < w.length) k++;
    w = w.slice(k);
  }
  return w;
}

/** A cd target resolved against the current directory; null when it cannot be known (cd, cd ~, cd -, cd $DIR). */
function changeDir(here: string | null, target: string | undefined): string | null {
  if (!target || /^[~$-]|\$|`/.test(target)) return null;
  if (posix.isAbsolute(target)) return posix.normalize(target);
  return here === null ? null : posix.resolve(here, target);
}

/** The simple commands of a Bash line in order, with heredoc bodies attached, cd tracked and bash -c unwrapped. */
export function shellCommands(line: string, cwd: string | null, depth = 0): ShellCommand[] {
  const out: ShellCommand[] = [];
  const scopes: (string | null)[] = [];
  let here = cwd;
  let pipeline = 0;
  let cur = { words: [] as string[], raws: [] as string[], redirects: [] as ShellCommand['redirects'], heredocs: [] as string[] };
  const end = () => {
    const words = program(cur.words);
    const redirects = words[0] === '[[' ? [] : cur.redirects;
    const cmd: ShellCommand = { words, text: cur.raws.join(' '), redirects, heredocs: cur.heredocs, cwd: here, pipeline };
    cur = { words: [], raws: [], redirects: [], heredocs: [] };
    if (!cmd.words.length && !redirects.length && !cmd.heredocs.length) return;
    const shell = SHELLS.test(base(words[0] ?? '')) && words[1] === '-c' && typeof words[2] === 'string' && depth < 3;
    if (shell) {
      out.push(...shellCommands(words[2], here, depth + 1).map(c => ({ ...c, pipeline })));
      if (redirects.length) out.push({ ...cmd, words: [], text: '' });
      return;
    }
    out.push(cmd);
    if (words[0] === 'cd' || words[0] === 'pushd') here = changeDir(here, words.slice(1).find(w => !w.startsWith('-')) ?? '~');
    else if (words[0] === 'popd') here = null;
  };
  const toks = tokenize(line);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === 'op') {
      end();
      if (t.value !== '|' && t.value !== '|&') pipeline++;
      if (t.value === '(') scopes.push(here);
      else if (t.value === ')' && scopes.length) here = scopes.pop() ?? null;
    } else if (t.kind === 'heredoc') cur.heredocs.push(t.body);
    else if (t.kind === 'redir') {
      const next = toks[k + 1];
      if (next?.kind === 'word') { cur.redirects.push({ op: t.op, target: next.value }); cur.raws.push(`${t.op}${next.raw}`); k++; }
    } else {
      cur.words.push(t.value);
      cur.raws.push(t.raw);
    }
  }
  end();
  return out;
}

/** A path relative to the session directory when it resolves inside it, else null. '' is the directory itself. */
function inside(p: string, cwd: string | null, root: string): string | null {
  if (!p || /^[~$&]|\$|`|^\/dev\/|^[A-Za-z]:[\\/]|^\\/.test(p)) return null;
  const abs = posix.isAbsolute(p) ? posix.normalize(p) : cwd === null ? null : posix.resolve(cwd, p);
  if (abs === null) return null;
  if (abs === root) return '';
  return abs.startsWith(`${root.replace(/\/+$/, '')}/`) ? abs.slice(root.replace(/\/+$/, '').length + 1) : null;
}

const WRITE_REDIRECT = /^(?:\d*>>?|\d*>\||&>>?)$/;
const INTERPRETER = /^(?:python[\d.]*|node|nodejs|ruby|bun|deno)$/;
const CODE_FLAG = /^(?:-c|-e|--eval|eval)$/;
const VALUE_FLAG = /^(?:-m|-W|-X|-r|--require|-I)$/;
const PATH_EXPR = String.raw`((?:pathlib\.)?Path\(\s*[rbuRBU]{0,2}(?:'[^'\n]*'|"[^"\n]*")\s*\)|[rbuRBU]{0,2}(?:'[^'\n]*'|"[^"\n]*")|[A-Za-z_$][\w$]*)`;
const MODE = String.raw`\s*(?:mode\s*=\s*)?[rbuRBU]?['"]([^'"]*)['"]`;
/** Calls that write a file named by their first path argument; the second group, when present, is an open mode. */
const WRITE_CALLS = [
  new RegExp(String.raw`\bopen\(\s*${PATH_EXPR}\s*,${MODE}`, 'g'),
  new RegExp(String.raw`${PATH_EXPR}\s*\.\s*open\(${MODE}`, 'g'),
  new RegExp(String.raw`${PATH_EXPR}\s*\.\s*write_(?:text|bytes)\s*\(`, 'g'),
  new RegExp(String.raw`\b(?:writeFileSync|writeFile|appendFileSync|appendFile|Bun\.write|File\.write|File\.binwrite|Deno\.writeTextFile(?:Sync)?|Deno\.writeFile(?:Sync)?)\s*\(\s*${PATH_EXPR}\s*,`, 'g'),
];
const ASSIGNMENT = new RegExp(String.raw`(?:^|[\s;(])(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*${PATH_EXPR}\s*(?:;|$)`, 'gm');

/** The string literals a path expression can name: a literal, Path(literal), or a variable assigned one of those. */
function literals(expr: string, assigned: Map<string, string[]>): string[] {
  const m = /^(?:(?:pathlib\.)?Path\(\s*)?[rbuRBU]{0,2}(['"])(.*)\1\s*\)?$/.exec(expr.trim());
  if (m) return m[2].includes('{') ? [] : [m[2]];
  return assigned.get(expr.trim()) ?? [];
}

/** The files a script's code writes, by literal path or a variable holding one. */
function codeWrites(code: string): string[] {
  const assigned = new Map<string, string[]>();
  for (const m of code.matchAll(ASSIGNMENT)) {
    const lits = literals(m[2], new Map());
    if (lits.length) assigned.set(m[1], [...(assigned.get(m[1]) ?? []), ...lits]);
  }
  return WRITE_CALLS.flatMap(re => [...code.matchAll(re)].filter(m => m[2] === undefined || /[wax+]/.test(m[2])).flatMap(m => literals(m[1], assigned)));
}

/** The code an interpreter command runs, when the line shows it: an inline -c/-e script, its stdin, or a script this line wrote. */
function interpreterCode(c: ShellCommand, scripts: Map<string, string>): string[] {
  const [, ...args] = c.words;
  let script: string | undefined;
  for (let k = 0; k < args.length; k++) {
    if (CODE_FLAG.test(args[k])) return [args[k + 1] ?? ''];
    if (VALUE_FLAG.test(args[k])) { if (args[k] === '-m') return []; k++; continue; }
    if (!args[k].startsWith('-') || args[k] === '-') { script = args[k]; break; }
  }
  const file = (p: string) => scripts.get(c.cwd === null && !posix.isAbsolute(p) ? '' : posix.resolve(c.cwd ?? '/', p)) ?? '';
  if (script !== undefined && script !== '-') return [file(script)];
  return [...c.heredocs, ...c.redirects.filter(r => r.op === '<<<').map(r => r.target), ...c.redirects.filter(r => r.op === '<').map(r => file(r.target))];
}

/** The +++ paths of a unified diff, with git's a/ b/ prefixes removed. */
const diffTargets = (diff: string) => [...diff.matchAll(/^\+\+\+ (\S+)/gm)].map(m => m[1].replace(/^[ab]\//, '')).filter(p => p !== '/dev/null');

/**
 * The repo files one simple command writes, or null when it writes none. self is false when every write is the
 * command's own output (a redirect or tee), so the command itself can still be the check that follows the write.
 */
export function writeTargets(c: ShellCommand, root: string, scripts: Map<string, string> = new Map()): { files: string[]; self: boolean } | null {
  const files: string[] = [];
  const add = (p: string, cwd = c.cwd) => { const f = inside(p, cwd, root); if (f !== null) files.push(f || '.'); };
  for (const r of c.redirects) if (WRITE_REDIRECT.test(r.op)) add(r.target);
  const [first = '', ...args] = c.words;
  const name = base(first);
  const positional = args.filter(a => !a.startsWith('-'));
  if (name === 'tee') positional.forEach(f => add(f));
  const output = files.length;
  if (name === 'sed' || name === 'gsed' || name === 'perl') {
    let inPlace = false;
    let script = false;
    const rest: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^(?:-e|--expression|-f|--file)$/.test(a)) { script = true; k++; }
      else if (a === '-i' && args[k + 1] === '') { inPlace = true; k++; }
      else if (a.startsWith('--in-place')) inPlace = true;
      else if (/^-[A-Za-z0-9]/.test(a)) {
        const letters = a.slice(1);
        const flags = letters.slice(0, letters.search(name === 'perl' ? /[CdDFImMx]|$/ : /[ef]|$/));
        const at = flags.indexOf('i');
        if (at >= 0 && (name !== 'perl' || !flags.slice(0, at).includes('e'))) inPlace = true;
        if (name === 'perl' && letters.endsWith('e')) { script = true; k++; }
      } else rest.push(a);
    }
    const targets = (script ? rest : rest.slice(1)).filter(f => f !== '{}');
    if (inPlace) targets.length ? targets.forEach(f => add(f)) : add('.');
  } else if (name === 'git') {
    let k = 0;
    let cwd = c.cwd;
    for (; k < args.length && args[k].startsWith('-'); k++) {
      if (args[k] === '-C') cwd = changeDir(cwd, args[++k]);
      else if (args[k] === '-c') k++;
    }
    const sub = args.slice(k + 1);
    const readOnly = sub.includes('--cached') || (sub.some(a => /^--(?:check|stat|numstat|summary)$/.test(a)) && !sub.includes('--apply'));
    if (args[k] === 'apply' && !readOnly) {
      const targets = c.heredocs.flatMap(diffTargets);
      targets.length ? targets.forEach(f => add(f, cwd)) : add('.', cwd);
    }
  } else if (name === 'patch' && !args.some(a => a === '--dry-run' || a === '-C' || a === '--check')) {
    let cwd = c.cwd;
    const named: string[] = [];
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '-d' || args[k] === '--directory') cwd = changeDir(cwd, args[++k]);
      else if (args[k] === '-o' || args[k] === '--output') named.push(args[++k] ?? '');
      else if (/^(?:-i|--input|-B|--prefix|-r|--reject-file|-z|--suffix|-D|--ifdef|-F|--fuzz|-V)$/.test(args[k])) k++;
      else if (!args[k].startsWith('-')) { named.push(args[k]); break; }
    }
    const targets = [...named, ...c.heredocs.flatMap(diffTargets)];
    targets.length ? targets.forEach(f => add(f, cwd)) : add('.', cwd);
  } else if (INTERPRETER.test(name)) {
    interpreterCode(c, scripts).flatMap(codeWrites).forEach(f => add(f));
  }
  return files.length ? { files: [...new Set(files)], self: files.length > output } : null;
}

/**
 * The last repo write in a Bash line: the files it writes and the text of the commands that ran after it, which
 * includes the writer's own pipeline when the write is only its output (`bun test | tee test.log`). Null when the
 * line writes no file inside the session directory. cwd is where the line ran, root the session directory; both
 * null when the transcript does not say, and then only relative targets count.
 */
export function lastBashWrite(line: string, cwd: string | null, root: string | null): { files: string[]; after: string } | null {
  const top = root !== null && posix.isAbsolute(root) ? posix.normalize(root) : UNKNOWN_DIR;
  const here = cwd !== null && posix.isAbsolute(cwd) ? posix.normalize(cwd) : top;
  const cmds = shellCommands(line, here);
  const scripts = new Map<string, string>();
  let last: { at: number; files: string[]; self: boolean } | null = null;
  for (const [at, c] of cmds.entries()) {
    const w = writeTargets(c, top, scripts);
    if (w) last = { at, ...w };
    const body = c.heredocs.join('\n');
    for (const r of c.redirects) if (WRITE_REDIRECT.test(r.op) && c.cwd !== null) scripts.set(posix.resolve(c.cwd, r.target), body);
  }
  if (!last) return null;
  const { at, files, self } = last;
  const start = self ? at + 1 : cmds.findIndex(c => c.pipeline === cmds[at].pipeline);
  return { files, after: cmds.slice(start).map(c => c.text).join('\n') };
}
