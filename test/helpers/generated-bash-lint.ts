/**
 * Quote-aware lint for generated bash fences (INV-3).
 *
 * Rules (each fence is linted on its own, because hosts may run every fence
 * in a fresh shell):
 *  - tilde-in-quotes: a word inside double quotes that starts with `~/` never
 *    expands (`"~/.claude/..."` is a relative path that does not exist).
 *  - mktemp-template: `mktemp` with no template, or a literal `/tmp/` template,
 *    ignores `$TMPDIR` (sandboxed macOS sessions cannot write `/tmp`).
 *  - unguarded-var: `cd`, `rm -r*`, `mv` or `git -C` on a variable that this
 *    fence never assigned. In a fresh shell it is empty: `cd ""` stays put and
 *    the next command runs in the user's project. Write `${VAR:?message}`, and
 *    for `cd` also handle failure (`cd -- "${VAR:?...}" || exit 1`).
 *  - untrusted-in-quotes: a `<placeholder>` the model fills with reviewer,
 *    diff or error text, inside a double-quoted body/title/message argument
 *    of gh, glab, git or curl. In double quotes the shell runs every backtick
 *    span in that text (#3046). Pass it through a quoted heredoc into a
 *    variable and expand the variable instead.
 *
 * The lexer understands single/double quotes, `$(...)`, backticks, comments
 * and heredoc bodies; it is not a full shell parser.
 */

export interface LintFinding { rule: 'tilde-in-quotes' | 'mktemp-template' | 'unguarded-var' | 'untrusted-in-quotes'; line: number; detail: string }

interface VarRef { name: string; op: string }
interface Word { raw: string; vars: VarRef[]; line: number }
interface Command { words: Word[]; next: string; line: number }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'case', 'esac', 'in']);
/** Always set by the environment the shell starts in. */
const AMBIENT = new Set(['HOME', 'PWD', 'OLDPWD', 'PATH', 'USER', 'SHELL']);
/** Commands that publish free text, and the flags that carry it. */
const TEXT_SINKS = new Set(['gh', 'glab', 'git', 'curl']);
const TEXT_FLAGS = /^(?:-f|-F|--field|--raw-field|--body|-b|--title|-t|-m|--message|-d|--data|--description|--notes)$/;
const TEXT_FIELD = /^(?:body|title|message|description|notes)=/;
const QUOTED_PLACEHOLDER = /"[^"]*<[A-Za-z][^<>"\n]*>[^"]*"/;

function lex(src: string, findings: LintFinding[]): Command[] {
  const commands: Command[] = [];
  let i = 0;
  let line = 1;
  let words: Word[] = [];
  let word: Word | null = null;
  let cmdLine = 1;
  const heredocs: Array<{ delim: string; strip: boolean }> = [];

  const endWord = () => { if (word) { words.push(word); word = null; } };
  const endCommand = (next: string) => {
    endWord();
    if (words.length) commands.push({ words, next, line: cmdLine });
    words = [];
    cmdLine = line;
  };
  const cur = () => (word ??= { raw: '', vars: [], line });
  const readVar = (quoted: boolean) => {
    // at '$'
    const w = cur();
    const rest = src.slice(i);
    let m = rest.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[?=+-])?/);
    if (m) { w.vars.push({ name: m[1], op: m[2] ?? '' }); }
    else if ((m = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/))) { w.vars.push({ name: m[1], op: '' }); }
    void quoted;
  };
  const skipBalanced = (open: string, close: string): string => {
    // i at the char after `open`; returns inner text and leaves i after the matching close
    let depth = 1;
    const start = i;
    let q: string | null = null;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') line++;
      if (q) {
        if (c === '\\' && q === '"') { i += 2; continue; }
        if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === '\\') { i += 2; continue; }
      else if (c === open) depth++;
      else if (c === close && --depth === 0) { i++; return src.slice(start, i - 1); }
      i++;
    }
    return src.slice(start);
  };
  const substitution = () => {
    // at '$(' (not '$((')
    const startLine = line;
    i += 2;
    const inner = skipBalanced('(', ')');
    const nested = lex(inner, findings);
    for (const c of nested) commands.push({ ...c, line: c.line + startLine - 1 });
    cur().raw += `$(${inner})`;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      endCommand('\n');
      i++; line++;
      for (const h of heredocs.splice(0)) {
        while (i < src.length) {
          const eol = src.indexOf('\n', i);
          const text = src.slice(i, eol < 0 ? src.length : eol);
          i = eol < 0 ? src.length : eol + 1; line++;
          if ((h.strip ? text.replace(/^\t+/, '') : text).trim() === h.delim) break;
        }
      }
      cmdLine = line;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && !word) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\') { cur().raw += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const text = src.slice(i, end < 0 ? src.length : end + 1);
      line += (text.match(/\n/g) ?? []).length;
      cur().raw += text; i = end < 0 ? src.length : end + 1; continue;
    }
    if (c === '"') {
      const w = cur();
      w.raw += '"'; i++;
      if (src.startsWith('~/', i)) findings.push({ rule: 'tilde-in-quotes', line, detail: src.slice(i - 1, src.indexOf('"', i) + 1) });
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { w.raw += src.slice(i, i + 2); i += 2; continue; }
        if (src.startsWith('$(', i) && !src.startsWith('$((', i)) { substitution(); continue; }
        if (src[i] === '$') readVar(true);
        if (src[i] === '\n') line++;
        w.raw += src[i]; i++;
      }
      w.raw += '"'; i++;
      continue;
    }
    if (src.startsWith('$((', i)) { i += 3; cur().raw += `$((${skipBalanced('(', ')')})`; continue; }
    if (src.startsWith('$(', i)) { substitution(); continue; }
    if (c === '$') { readVar(false); cur().raw += c; i++; continue; }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      cur().raw += src.slice(i, end < 0 ? src.length : end + 1);
      i = end < 0 ? src.length : end + 1; continue;
    }
    const hd = src.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (hd) { heredocs.push({ delim: hd[3], strip: hd[1] === '-' }); endWord(); i += hd[0].length; continue; }
    const op = src.slice(i).match(/^(\|\||&&|;;|[;&|()])/);
    if (op) { endCommand(op[1]); i += op[1].length; continue; }
    cur().raw += c; i++;
  }
  endCommand('');
  return commands;
}

/** Variables a command assigns, or guards with `${VAR:?}` / `${VAR:=}` / `${VAR:-}`. */
function assignedBy(cmd: Command): string[] {
  const out: string[] = [];
  const words = cmd.words;
  let k = 0;
  for (; k < words.length; k++) {
    if (RESERVED.has(words[k].raw)) continue;
    const m = words[k].raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) break;
    out.push(m[1]);
  }
  const name = words[k]?.raw;
  if (name && ['export', 'local', 'declare', 'readonly', 'typeset', 'read', 'unset'].includes(name)) {
    for (const w of words.slice(k + 1)) {
      const m = w.raw.match(/^([A-Za-z_][A-Za-z0-9_]*)(=|$)/);
      if (m && name !== 'unset') out.push(m[1]);
    }
  }
  if (name === 'for' && words[k + 1] && NAME.test(words[k + 1].raw)) out.push(words[k + 1].raw);
  for (const w of words) for (const v of w.vars) if (/^:?[?=]$/.test(v.op)) out.push(v.name);
  return out;
}

function commandName(cmd: Command): number {
  let k = 0;
  while (k < cmd.words.length && (RESERVED.has(cmd.words[k].raw) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.words[k].raw))) k++;
  return k;
}

export function lintFence(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const commands = lex(body, findings);
  const assigned = new Set<string>();
  for (const cmd of commands) {
    const k = commandName(cmd);
    const name = cmd.words[k]?.raw;
    const args = cmd.words.slice(k + 1);
    if (name === 'mktemp') {
      const operands = args.filter(w => !w.raw.startsWith('-') && !/^\d*[<>]/.test(w.raw));
      const template = operands.at(-1)?.raw.replace(/^["']|["']$/g, '');
      if (!template || template.startsWith('/tmp/')) findings.push({ rule: 'mktemp-template', line: cmd.line, detail: cmd.words.map(w => w.raw).join(' ') });
    }
    if (name && TEXT_SINKS.has(name)) {
      args.forEach((w, n) => {
        const carriesText = TEXT_FIELD.test(w.raw) || TEXT_FLAGS.test(args[n - 1]?.raw ?? '');
        const quotedHeredoc = /^"\$\(cat <<-?\s*'[A-Za-z_][A-Za-z0-9_]*'/.test(w.raw);
        if (carriesText && !quotedHeredoc && QUOTED_PLACEHOLDER.test(w.raw.replace(/<[^<>\s"]+@[^<>\s"]+>/g, ''))) findings.push({ rule: 'untrusted-in-quotes', line: cmd.line, detail: `${name} ... ${args[n - 1]?.raw ?? ''} ${w.raw}`.replace(/\s+/g, ' ') });
      });
    }
    const recursiveRm = name === 'rm' && args.some(w => /^-[A-Za-z]*[rR]/.test(w.raw));
    const gitC = name === 'git' && args[0]?.raw === '-C';
    if (name === 'cd' || name === 'mv' || recursiveRm || gitC) {
      const targets = gitC ? [args[1]].filter(Boolean) : args.filter(w => !/^-/.test(w.raw) && !/^\d*[<>]/.test(w.raw));
      for (const w of targets) {
        for (const v of w.vars) {
          if (assigned.has(v.name) || AMBIENT.has(v.name) || /^:?-$/.test(v.op)) continue;
          const guarded = /^:\?$/.test(v.op);
          const handled = name !== 'cd' || cmd.next === '||' || cmd.next === '&&';
          if (!guarded || !handled) {
            findings.push({ rule: 'unguarded-var', line: cmd.line, detail: `${cmd.words.map(x => x.raw).join(' ')} (${v.name} is not assigned in this fence)` });
          }
        }
      }
    }
    for (const v of assignedBy(cmd)) assigned.add(v);
  }
  return findings;
}

/** Replace angle-bracket placeholders (`<branch-name>`) the model substitutes, so `bash -n` sees valid words. */
export function normalizePlaceholders(body: string): string {
  return body.replace(/<[A-Za-z][^<>\n]*>/g, 'PLACEHOLDER');
}
