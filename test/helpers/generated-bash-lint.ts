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
 *  - free-text-placeholder: a `<placeholder>` the model fills in, anywhere
 *    in a command (any command, any quoting: double, single, unquoted, or a
 *    heredoc body, quoted or not). Free text (bodies, titles, messages, error
 *    output, reviewer or diff text) reaches a command only as the contents of
 *    a `mktemp` file the agent writes with its file-write tool (`--body-file`,
 *    `-F body=@file`). Only identifier placeholders on IDENTIFIER_PLACEHOLDERS
 *    may appear, each with the grammar the skill applies before use; their
 *    grammars exclude every shell metacharacter.
 *
 * The lexer understands single/double quotes, `$(...)`, backticks, comments
 * and heredoc bodies; it is not a full shell parser.
 */

import { IDENTIFIER_PLACEHOLDERS } from './placeholder-allowlist';

export { IDENTIFIER_PLACEHOLDERS };
export interface LintFinding { rule: 'tilde-in-quotes' | 'mktemp-template' | 'unguarded-var' | 'free-text-placeholder'; line: number; detail: string }

interface VarRef { name: string; op: string }
interface Word { raw: string; own: string; vars: VarRef[]; line: number }
interface Heredoc { body: string; line: number; quoted: boolean }
interface Command { words: Word[]; next: string; line: number }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'case', 'esac', 'in']);
/** Always set by the environment the shell starts in. */
const AMBIENT = new Set(['HOME', 'PWD', 'OLDPWD', 'PATH', 'USER', 'SHELL']);
/** A model-filled `<placeholder>`; `<name@host>` is a literal mail address (commit trailers). */
const MAIL = /^<[^<>\s@]+@[^<>\s@]+>$/;

function lex(src: string, findings: LintFinding[], heredocBodies: Heredoc[] = []): Command[] {
  const commands: Command[] = [];
  let i = 0;
  let line = 1;
  let words: Word[] = [];
  let word: Word | null = null;
  let cmdLine = 1;
  const heredocs: Array<{ delim: string; strip: boolean; quoted: boolean }> = [];

  const endWord = () => { if (word) { words.push(word); word = null; } };
  const endCommand = (next: string) => {
    endWord();
    if (words.length) commands.push({ words, next, line: cmdLine });
    words = [];
    cmdLine = line;
  };
  const cur = () => (word ??= { raw: '', own: '', vars: [], line });
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
    const nestedDocs: Heredoc[] = [];
    const nested = lex(inner, findings, nestedDocs);
    for (const c of nested) commands.push({ ...c, line: c.line + startLine - 1 });
    for (const h of nestedDocs) heredocBodies.push({ ...h, line: h.line + startLine - 1 });
    cur().raw += `$(${inner})`;
    cur().own += '$()';
  };

  const add = (w: Word, text: string) => { w.raw += text; w.own += text; };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      endCommand('\n');
      i++; line++;
      for (const h of heredocs.splice(0)) {
        const bodyLine = line;
        const body: string[] = [];
        while (i < src.length) {
          const eol = src.indexOf('\n', i);
          const text = src.slice(i, eol < 0 ? src.length : eol);
          i = eol < 0 ? src.length : eol + 1; line++;
          if ((h.strip ? text.replace(/^\t+/, '') : text).trim() === h.delim) break;
          body.push(text);
        }
        heredocBodies.push({ body: body.join('\n'), line: bodyLine, quoted: h.quoted });
      }
      cmdLine = line;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && !word) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { endWord(); line++; i += 2; continue; }
    if (c === '\\') { add(cur(), src.slice(i, i + 2)); i += 2; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const text = src.slice(i, end < 0 ? src.length : end + 1);
      line += (text.match(/\n/g) ?? []).length;
      add(cur(), text); i = end < 0 ? src.length : end + 1; continue;
    }
    if (c === '"') {
      const w = cur();
      add(w, '"'); i++;
      if (src.startsWith('~/', i)) findings.push({ rule: 'tilde-in-quotes', line, detail: src.slice(i - 1, src.indexOf('"', i) + 1) });
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { add(w, src.slice(i, i + 2)); i += 2; continue; }
        if (src.startsWith('$(', i) && !src.startsWith('$((', i)) { substitution(); continue; }
        if (src[i] === '$') readVar(true);
        if (src[i] === '\n') line++;
        add(w, src[i]); i++;
      }
      add(w, '"'); i++;
      continue;
    }
    if (src.startsWith('$((', i)) { i += 3; add(cur(), `$((${skipBalanced('(', ')')})`); continue; }
    if (src.startsWith('$(', i)) { substitution(); continue; }
    if (c === '$') { readVar(false); add(cur(), c); i++; continue; }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      add(cur(), src.slice(i, end < 0 ? src.length : end + 1));
      i = end < 0 ? src.length : end + 1; continue;
    }
    const hd = src.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (hd) { heredocs.push({ delim: hd[3], strip: hd[1] === '-', quoted: hd[2] !== '' }); endWord(); i += hd[0].length; continue; }
    const op = src.slice(i).match(/^(\|\||&&|;;|[;&|()])/);
    if (op) { endCommand(op[1]); i += op[1].length; continue; }
    add(cur(), c); i++;
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

/**
 * Placeholders in `text` that are not allowed there: free text anywhere, and
 * `quoted` identifiers outside quotes. `inQuotes` is the context the text
 * starts in (a heredoc body).
 */
function freeText(text: string, inQuotes = false): string[] {
  const out: string[] = [];
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q !== "'" && c === '\\') { i++; continue; }
    if (q === null && (c === "'" || c === '"')) { q = c; continue; }
    if (q !== null && c === q) { q = null; continue; }
    if (c !== '<') continue;
    const m = text.slice(i).match(/^<[A-Za-z][^<>\n]*>/);
    if (!m) continue;
    const p = m[0];
    i += p.length - 1;
    if (MAIL.test(p)) continue;
    const entry = Object.hasOwn(IDENTIFIER_PLACEHOLDERS, p) ? IDENTIFIER_PLACEHOLDERS[p] : undefined;
    if (!entry || (entry.quoted && q === null && !inQuotes)) out.push(entry ? `${p} (unquoted)` : p);
  }
  return out;
}

export function lintFence(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const heredocs: Heredoc[] = [];
  const commands = lex(body, findings, heredocs);
  for (const h of heredocs) {
    for (const p of freeText(h.body, h.quoted)) findings.push({ rule: 'free-text-placeholder', line: h.line, detail: `${p} in a heredoc body` });
  }
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
    for (const p of freeText(cmd.words.map(w => w.own).join(' '))) findings.push({ rule: 'free-text-placeholder', line: cmd.line, detail: `${p} in: ${cmd.words.map(x => x.raw).join(' ').replace(/\s+/g, ' ')}` });
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
