/** Completed parent file delivery and seeded coverage-diagram evidence. */
import { posix, win32 } from 'node:path';
import type { SkillTestResult } from './session-runner';

export interface CoverageAuditFiles {
  cwd: string;
  source: { path: string; content: string };
  tests: { path: string; content: string };
}
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const normalized = (text: string) => text.replace(/\r\n?/g, '\n').trim();
const outputText = (output: unknown): string => typeof output === 'string' ? output
  : Array.isArray(output) && output.every(b => object(b) && b.type === 'text' && typeof b.text === 'string')
    ? output.map(b => b.text).join('\n') : '';
const literal = (token: string): string | undefined => {
  if (/^'[^']*'$/.test(token) || /^"[^"$`\\]*"$/.test(token)) return token.slice(1, -1);
  return /^[^\s'"$`\\;|&<>]+$/.test(token) ? token : undefined;
};
// Recorded transcripts may come from another OS. Resolve their paths in the
// recorded cwd's namespace, retaining the canonical and containment checks.
const evidencePaths = (cwd: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) ? win32 : posix;

type Paths = typeof posix;
interface Owned { path: string; content: string }
/** One displayed stdout unit: a literal echo, a complete owned file or unknown neighboring output. */
type Piece = { kind: 'label'; text: string } | ({ kind: 'owned' } & Owned) | { kind: 'unknown'; min: number; max: number };
interface ShellScope { cwd: string; path: Paths; owned: Owned[] }

/** Words and the && ; || | operators of a single-line command. Quotes stay in
 * their word; expansion, substitution, redirection (except discarded stderr),
 * grouping, comments, heredocs and background jobs are unsupported. */
function shellWords(command: unknown): string[] | undefined {
  if (typeof command !== 'string' || command.length > 16384 || /[\r\n]/.test(command)) return undefined;
  const words: string[] = [];
  let word = '', quote = '', open = false;
  const flush = () => { if (open) words.push(word); word = ''; open = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (quote === '"' && /[`$]/.test(char)) return undefined;
      // Double-quoted \. and \| stay literal grep characters; the closed grep
      // grammars below are the only stages that may contain backslashes.
      if (char === '\\' && quote === '"' && !/[.|]/.test(command[index + 1] ?? '')) return undefined;
      word += char; if (char === quote) quote = '';
    } else if (char === "'" || char === '"') { quote = char; word += char; open = true; }
    else if (char === ' ' || char === '\t') flush();
    else if (char === ';') { flush(); words.push(';'); }
    else if (char === '&') {
      if (command[index + 1] !== '&') return undefined;
      flush(); words.push('&&'); index++;
    } else if (char === '|') {
      flush(); if (command[index + 1] === '|') { words.push('||'); index++; } else words.push('|');
    } else if (char === '>' && word === '2' && command.startsWith('>/dev/null', index) && /^(?:[\s;|&]|$)/.test(command.slice(index + 10, index + 11))) {
      word += '>/dev/null'; index += 9;
    } else if (/[`$\\#<>(){}]/.test(char)) return undefined;
    else { word += char; open = true; }
  }
  if (quote) return undefined;
  flush();
  return words;
}

/** A literal file operand inside the recorded cwd, resolved in its namespace. */
function scopedFile(token: string | undefined, scope: ShellScope): string | undefined {
  const value = token === undefined ? undefined : literal(token);
  if (!value || value.startsWith('-') || value.split(/[\\/]/).includes('..')) return undefined;
  const resolved = scope.path.resolve(scope.cwd, value), relative = scope.path.relative(scope.cwd, resolved);
  return !relative || relative.startsWith('..') || scope.path.isAbsolute(relative) ? undefined : resolved;
}

const unbounded = Number.POSITIVE_INFINITY;
const unknown = (min = 0, max = unbounded): Piece => ({ kind: 'unknown', min, max });
const ownedLines = (content: string) => content.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');

/** Closed read-only display stages. Owned bytes come only from bare cat/sed. */
function stagePieces(stage: string[], scope: ShellScope, alone: boolean): Piece[] | undefined {
  const discarded = stage.includes('2>/dev/null');
  const words = stage.filter(word => word !== '2>/dev/null');
  const [name, ...args] = words, text = words.join(' ');
  if (!name || (discarded && name === 'echo')) return undefined;
  // Backslashes are data only in these closed grep/awk display patterns.
  const grepRange = /^grep\s+-n(?:\s+-i)?(?:\s+-B\d{1,4})?(?:\s+-A\d{1,4})?\s+(?:"(?:[^"\\$`]|\\[|.])*"|'(?:[^'\\$`]|\\[|.])*')\s+(.+)$/.exec(text);
  // One or more literal file operands (the tokens after the quoted pattern), none of them an option.
  const grepOperands = grepRange ? words.slice(words.findIndex((word, index) => index > 0 && /^["']/.test(word)) + 1) : [];
  const displayGrep = grepOperands.length > 0 && grepOperands.every(operand => literal(operand) !== undefined && !literal(operand)!.startsWith('-'));
  const awkRange = /^awk\s+'\/(?:[^/\\]|\\[./|])*\/,\/(?:[^/\\]|\\[./|])*\/'\s+(.+)$/.exec(text)
    ?? /^awk\s+'\/(?:[^/\\]|\\[./|])*\/\{f=1\} f&&\/(?:[^/\\]|\\[./|])*\/\{exit\} f'\s+(.+)$/.exec(text);
  const displayAwk = Boolean(awkRange && literal(awkRange[1]!) && !literal(awkRange[1]!)!.startsWith('-'));
  if (text.includes('\\') && !/^grep\s+-(?:E|cE)\s+'[^']*'(?:\s+[^\\]*)?$/.test(text) && !displayGrep && !displayAwk) return undefined;
  if (name === 'echo') {
    const values = args.map(arg => literal(arg));
    if (values.some(value => value === undefined)) return undefined;
    // Only -n/-e/-E spellings are echo options; -n output is unknown, escapes are unsupported.
    if (values[0] === '-n') return [unknown(0, 1)];
    if (/^-[neE]+$/.test(values[0] ?? '')) return undefined;
    const label = values.join(' ');
    // An echo can never reproduce owned file lines in place of a read.
    if (scope.owned.some(file => ownedLines(file.content).some(line => line.trim().length >= 12 && label.includes(line.trim())))) return undefined;
    return [args.some(arg => /^[~]|[*?[]/.test(arg) && !/^['"]/.test(arg)) ? unknown(1, 1) : { kind: 'label', text: label }];
  }
  if (name === 'cat') {
    if (!args.length && !alone) return [unknown()];
    const operands = args.slice(args[0] === '-n' ? 1 : 0);
    if (operands[0] === '--') operands.shift();
    const files = operands.map(operand => scopedFile(operand, scope));
    if (!files.length || files.some(file => file === undefined)) return undefined;
    if (discarded || !alone) return [unknown()];
    // A non-owned context file is unknown output of at least one line.
    return files.map(file => {
      const owned = scope.owned.find(candidate => candidate.path === file);
      return owned ? { kind: 'owned', ...owned } : unknown(1);
    });
  }
  if (name === 'sed') {
    if (text === "sed 's/^/TESTFILES:/'") return [unknown()];
    const range = /^sed -n (?:'(\d+)(?:,(\d+))?p'|"(\d+)(?:,(\d+))?p"|(\d+)(?:,(\d+))?p) (\S+)$/.exec(text);
    const file = range ? scopedFile(range[7], scope) : undefined;
    if (!range || !file) return undefined;
    const first = Number(range[1] ?? range[3] ?? range[5]), last = Number(range[2] ?? range[4] ?? range[6] ?? first);
    const owned = scope.owned.find(candidate => candidate.path === file);
    if (alone && !discarded && owned && first === 1 && last >= ownedLines(owned.content).length) return [{ kind: 'owned', ...owned }];
    return [unknown(0, Math.max(0, last - first + 1))];
  }
  if (name === 'head') {
    if (args.includes('-c')) return [unknown()];
    const count = /(?:^| )-(?:n ?)?(\d+)(?: |$)/.exec(args.join(' '));
    return [unknown(0, count ? Number(count[1]) : 10)];
  }
  if (name === 'git') {
    if (text === 'git ls-files') return [unknown()];
    // Display-only: literal revisions and the observed display flag, in any
    // order, then optional literal in-cwd pathspecs after --. Quoted or other
    // options may write files or invoke helpers; :magic pathspecs stay out.
    const [command, ...rest] = args, split = rest.indexOf('--');
    const options = split < 0 ? rest : rest.slice(0, split), pathspecs = split < 0 ? [] : rest.slice(split + 1);
    if ((command !== 'log' && command !== 'diff') || pathspecs.some(spec => literal(spec)?.startsWith(':') || !scopedFile(spec, scope)) ||
        !options.every(token => token === (command === 'log' ? '--oneline' : '--stat') ||
          (command === 'log' && /^-[1-9]\d{0,4}$/.test(token)) || /^[A-Za-z0-9_][A-Za-z0-9_./~^-]*$/.test(token))) return undefined;
    return [unknown()];
  }
  if (name === 'grep' || name === 'ls') return [unknown()];
  if (text === 'pwd' || text === 'wc -l') return [unknown(1, 1)];
  if (name === 'wc' && args[0] === '-l' && args.length > 1) {
    // One count line per literal in-cwd file, plus a total for several.
    if (args.slice(1).some(operand => !scopedFile(operand, scope))) return undefined;
    const lines = args.length - 1 + (args.length > 2 ? 1 : 0);
    return [unknown(lines, lines)];
  }
  if (/^\[ -f [A-Za-z0-9_.\/-]+ \]$/.test(text)) return [unknown(0, 0)];
  if (displayAwk) return [unknown()];
  return undefined;
}

/** The ordered stdout pieces of a closed read-only list, or undefined. */
function commandPieces(command: unknown, scope: ShellScope): Piece[] | undefined {
  const words = shellWords(command);
  if (!words?.length) return undefined;
  const lists: string[][][] = [[[]]], separators: string[] = [];
  for (const word of words) {
    if (word === '|') lists.at(-1)!.push([]);
    else if (word === '&&' || word === ';' || word === '||') { separators.push(word); lists.push([[]]); }
    else lists.at(-1)!.at(-1)!.push(word);
  }
  if (lists.some(pipeline => pipeline.some(stage => !stage.length))) return undefined;
  // One leading assertion of the recorded cwd, followed by one uniform list.
  // `cd CWD;` runs the list whether or not cd succeeds, exactly like an all-;
  // list, so only it may precede an && chain. Other mixes (`cd CWD && A; B`)
  // could run later relative reads elsewhere and stay unsupported.
  if (lists[0]!.length === 1 && lists[0]![0]![0] === 'cd') {
    const [, target, ...rest] = lists[0]![0]!;
    const [assertion, ...chain] = separators, kinds = new Set(chain.filter(separator => separator !== '||'));
    if (rest.length || target === undefined || literal(target) !== scope.cwd || lists.length < 2 || assertion === '||' ||
        kinds.size > 1 || (assertion !== ';' && kinds.size && !kinds.has(assertion!))) return undefined;
    lists.shift(); separators.shift();
  }
  const pieces: Piece[] = [];
  for (let index = 0; index < lists.length; index++) {
    const pipeline = lists[index]!;
    if (separators[index] === '||') {
      // cat FILE 2>/dev/null || echo LITERAL reports an optional file's absence.
      const fallback = lists[index + 1];
      if (pipeline.length !== 1 || pipeline[0]![0] !== 'cat' || !pipeline[0]!.includes('2>/dev/null') ||
          fallback?.length !== 1 || fallback[0]!.length !== 2 || fallback[0]![0] !== 'echo' ||
          literal(fallback[0]![1]!) === undefined || fallback[0]![1]!.includes('\\') ||
          !stagePieces(pipeline[0]!, scope, true)) return undefined;
      pieces.push(unknown());
      index++;
      if (separators[index] === '||') return undefined;
      continue;
    }
    if (pipeline.some(stage => stage[0] === 'cd')) return undefined;
    const staged = pipeline.map(stage => stagePieces(stage, scope, pipeline.length === 1));
    if (staged.some(stage => !stage)) return undefined;
    if (pipeline.length === 1) { pieces.push(...staged[0]!); continue; }
    // A pipeline prints only its last stage's output, bounded by that stage.
    const [tail, extra] = staged.at(-1)!;
    pieces.push(unknown(pipeline.at(-1)!.join(' ') === 'wc -l' ? 1 : 0, !extra && tail?.kind === 'unknown' ? tail.max : unbounded));
  }
  return pieces;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** cat prints each line once; -n adds a numeric gutter (a final empty numbered line is tolerated). */
function pieceSource(piece: Exclude<Piece, { kind: 'unknown' }>): string {
  if (piece.kind === 'label') return escaped(piece.text) + '\n';
  const content = piece.content.replace(/\r\n?/g, '\n');
  return ownedLines(content).map(line => String.raw`(?: *\d+\t)?` + escaped(line)).join('\n') +
    (content.endsWith('\n') ? String.raw`\n(?: *\d+\t\n)?` : '');
}

/** Match a run of known pieces exactly at offset, as one pattern so optional gutters can backtrack. */
function matchRun(run: Exclude<Piece, { kind: 'unknown' }>[], out: string, offset: number) {
  const pattern = new RegExp(run.map(pieceSource).join(''), 'y');
  pattern.lastIndex = offset;
  const match = pattern.exec(out);
  return match ? { end: offset + match[0].length, credited: run.flatMap(piece => piece.kind === 'owned' ? [piece.path] : []) } : undefined;
}

/**
 * Owned files whose complete bytes occupy exactly the stdout position their
 * cat/sed produces. Literal echo labels and owned reads are known output;
 * neighboring displays are unknown. A run after unknown output starts at a
 * label (or, after exact-count output, at that line). Its slot is counted
 * from the end, so neighboring lines equal to the label may only precede it,
 * and a second complete copy of the run anywhere after the cursor voids the
 * credit. Every later run must still appear in order.
 */
function shellReads(command: unknown, output: unknown, scope: ShellScope): Set<string> {
  const credited = new Set<string>();
  const pieces = commandPieces(command, scope);
  const text = outputText(output).replace(/\r\n?/g, '\n');
  if (!pieces || text.length > 4 * 1024 * 1024) return credited;
  // Native Bash results are trimmed: leading blank lines of the first run and
  // trailing newlines may be absent. Restore them as empty lines only.
  const lead = pieces[0]!.kind === 'unknown' ? 0 : 8, out = '\n'.repeat(lead) + text + '\n'.repeat(8);
  const fullLines = (label: string) => [...out.matchAll(new RegExp(String.raw`(?<=^|\n)${escaped(label)}\n`, 'g'))].map(match => match.index!);
  const anywhere = (label: string) => [...out.matchAll(new RegExp(String.raw`(?=${escaped(label)}\n)`, 'g'))].map(match => match.index!);
  let cursor = 0, min = 0, max = 0, pending = false;
  for (let index = 0; index < pieces.length;) {
    const piece = pieces[index]!;
    if (piece.kind === 'unknown') { min += piece.min; max += piece.max; pending = true; index++; continue; }
    const first = index;
    while (index < pieces.length && pieces[index]!.kind !== 'unknown') index++;
    const run = pieces.slice(first, index) as Exclude<Piece, { kind: 'unknown' }>[];
    const owns = run.some(item => item.kind === 'owned');
    let starts = cursor === 0 && !pending ? Array.from({ length: lead + 1 }, (_, k) => k) : [cursor];
    let rivals: number[] = [];
    if (pending) {
      const blanks = run.findIndex(item => item.kind !== 'label' || item.text.trim());
      const anchor = run[blanks];
      // Bare echo separators after unknown output print blank lines only: they
      // anchor nothing and credit nothing, so they extend the unknown span.
      if (!anchor) { min += run.length; max += run.length; continue; }
      if (anchor.kind !== 'label') {
        // Output of an exact line count (wc -l over literal in-cwd files, pwd)
        // places the next run exactly that many lines after the cursor.
        if (min !== max) return new Set();
        let start = cursor;
        for (let line = 0; line < min; line++) {
          const end = out.indexOf('\n', start);
          if (end < 0) return new Set();
          start = end + 1;
        }
        starts = [start];
      } else {
        let found = anywhere(anchor.text);
        if (owns) {
          // Each same-text echo prints one full line. Exactly that many copies
          // means no neighboring output holds one, so the ordinal copy is ours.
          const same = (item: Piece) => item.kind === 'label' && item.text === anchor.text;
          found = fullLines(anchor.text);
          const expected = pieces.filter(same).length;
          if (found.length < expected) return new Set();
          // Extra copies are neighbouring lines equal to the label. Count the
          // slot from the end so earlier unknown output cannot relocate it,
          // and (below) refuse when any other copy also carries the run.
          if (found.length > expected) rivals = found.map(start => start - blanks);
          found = [found[found.length - pieces.slice(first + blanks).filter(same).length]!];
        }
        starts = found.map(start => start - blanks)
          .filter(start => start >= cursor && out.slice(start, start + blanks) === '\n'.repeat(blanks));
      }
    }
    // Unknown output directly before a credited run must fit its line bounds.
    const matched = starts.map(start => {
      const lines = out.slice(cursor, start).split('\n').length - 1;
      return !owns || !pending || (lines >= min && lines <= max) ? matchRun(run, out, start) : undefined;
    }).find(Boolean);
    if (!matched) return new Set();
    if (rivals.some(start => start >= cursor && start !== starts[0] && matchRun(run, out, start))) return new Set();
    matched.credited.forEach(file => credited.add(file));
    cursor = matched.end; min = max = 0; pending = false;
  }
  return credited;
}

function delivered(output: unknown, expected: string): boolean {
  const text = outputText(output);
  const body = normalized(expected);
  if (!body || text.length > 4 * 1024 * 1024) return false;
  if (normalized(text).includes(body)) return true;
  // Native Read gutters use N→ (or a tab); retain actual code indentation and
  // require the entire contiguous file, not filenames.
  return normalized(text.replace(/^ *\d+(?:\t|→)/gm, '')).includes(body);
}

export function coverageAuditReadEvidence(transcript: unknown[], files: CoverageAuditFiles): { sourceRead: boolean; testsRead: boolean } {
  const path = evidencePaths(files.cwd);
  const found = { sourceRead: false, testsRead: false };
  if (!path.isAbsolute(files.cwd) || path.resolve(files.cwd) !== files.cwd || files.source.path === files.tests.path ||
      [files.source, files.tests].some(f => {
        const relative = path.relative(files.cwd, f.path);
        return !path.isAbsolute(f.path) || path.resolve(f.path) !== f.path || !relative || relative === '..' ||
          relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !normalized(f.content);
      })) return found;
  const init = transcript.filter((e): e is Record<string, any> =>
    object(e) && e.type === 'system' && e.subtype === 'init' && e.cwd === files.cwd);
  if (init.length !== 1 || typeof init[0].session_id !== 'string' || !init[0].session_id) return found;
  const session = init[0].session_id,
    uses = new Map<string, { name: string; input: Record<string, any> } | null>(),
    results = new Set<string>();
  for (const e of transcript.slice(transcript.indexOf(init[0]) + 1)) {
    if (!object(e) || e.session_id !== session || (e.parent_tool_use_id !== null && e.parent_tool_use_id !== undefined) ||
        !object(e.message) || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (!object(b)) continue;
      // Any repeated native id is a conflict, even on an event that could not
      // itself supply evidence (wrong role or input shape).
      if (e.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string') {
        if (uses.has(b.id)) return { sourceRead: false, testsRead: false };
        uses.set(b.id, e.message.role === 'assistant' && object(b.input) ? { name: b.name, input: b.input } : null);
      } else if (e.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (results.has(b.tool_use_id)) return { sourceRead: false, testsRead: false };
        results.add(b.tool_use_id);
        const u = e.message.role === 'user' ? uses.get(b.tool_use_id) : undefined;
        if (!u || (b.is_error !== undefined && b.is_error !== false)) continue;
        const credited = u.name === 'Bash' ? shellReads(u.input.command, b.content, { cwd: files.cwd, path, owned: [files.source, files.tests] }) : undefined;
        for (const [key, file] of [['sourceRead', files.source], ['testsRead', files.tests]] as const) {
          if (u.name === 'Read' ? typeof u.input.file_path === 'string' &&
              path.resolve(files.cwd, u.input.file_path) === file.path && delivered(b.content, file.content)
            : u.name === 'Bash' && credited?.has(file.path)) found[key] = true;
        }
      }
    }
  }
  return found;
}
const exampleDiagram = (line: string) => /^(?:example|sample|illustration)\b/i.test(line.trim().replace(/^[#*]+\s*/, ''));
/** Top-level ASCII, optionally fenced; an outer source/example fence owns its body. */
function diagramBlocks(output: string): string[][] {
  const blocks: string[][] = [];
  let outside: string[] = [];
  let fence: { char: string; length: number; allowed: boolean; lines: string[] } | undefined;
  for (const line of output.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        if (fence.allowed) blocks.push(fence.lines);
        fence = undefined;
      } else fence.lines.push(line);
    } else if (marker) {
      if (outside.length) blocks.push(outside);
      fence = { char: marker[1]![0]!, length: marker[1]!.length,
        allowed: /^(?:text|ascii|plaintext)?$/.test(marker[2]!.trim()) && !outside.some(exampleDiagram), lines: [] };
      outside = [];
    } else outside.push(line);
  }
  if (outside.length) blocks.push(outside);
  return blocks.filter(lines => {
    const firstRow = lines.findIndex(line => treeRow(line) !== undefined);
    return firstRow >= 0 && !lines.slice(0, firstRow).some(exampleDiagram);
  });
}

function treeRow(line: string): { depth: number; text: string } | undefined {
  const match = /^([ |│]*)(?:[├└]─+►?|[+|]-+)\s+(.+)$/.exec(line);
  if (!match) {
    // Unindented function roots own following branch rows. Other function
    // roots also end a subtree, so a sibling cannot lend a coverage marker.
    return /^[A-Za-z_$][A-Za-z0-9_$]*\([^()\n]*\)(?:[\t ]+.*)?$/.test(line)
      ? { depth: -1, text: line } : undefined;
  }
  // A parallel USER FLOWS column cannot supply CODE PATHS coverage markers.
  // That column starts at a tree glyph, its wrapped-row rail (│) or a [+] group.
  return { depth: match[1]!.length, text: match[2]!.split(/ {3,}(?=[├└│|+]|\[\+\])/, 1)[0]! };
}

const coverageMapCaption = String.raw`[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+[\t ]+[—–-][\t ]+(?:test[\t ]+)?coverage[\t ]+map`;

function diagramLegend(lines: string[], firstRow: number): Map<string, boolean> {
  const meanings = new Map<string, boolean>();
  const pair = String.raw`\[([✓✔✗✘])\][\t ]+(TESTED|COVERED|GAP|UNTESTED)`;
  const legend = new RegExp(String.raw`^${pair}[\t |,;]+${pair}$`, 'i');
  const bareKey = new RegExp(String.raw`${pair}.*\[[✓✔✗✘]\]`, 'i');
  for (const [index, original] of lines.entries()) {
    // Footer keys govern this same block too; tree and annotation markers
    // describe paths. A bare pair remains a declaration even when indented.
    if (index >= firstRow && (treeRow(original) || (!/\bLegend\b/i.test(original) && !bareKey.test(original)))) continue;
    // Decorative branch keys and an explicit GAP explanation do not change
    // the two coverage meanings. All other qualifiers keep the closed grammar.
    const line = original.replace(/[\t ]+[─-]+►?[\t ]+branch$/i, '')
      .replace(/(\[[✓✔✗✘]\][\t ]+(?:GAP|UNTESTED))[\t ]+\((?:no test|GAP)\)$/i, '$1')
      .replace(/(\[[✓✔✗✘]\][\t ]+COVERED)[\t ]+by a test\b/gi, '$1')
      .replace(/(\[[✓✔✗✘]\][\t ]+(?:GAP|UNTESTED))[\t ]+[—–-][\t ]+no test exercises this path$/i, '$1');
    const start = line.search(/\[[✓✔✗✘]\]/);
    if (start < 0) continue;
    if (/^\s*>|["“”]|\b(?:not|no|never|example|sample|false|incorrect|hypothetical)\b/i.test(line)) return new Map();
    // Only a legend label or a literal file's coverage-map caption may precede
    // the pair. Arbitrary prose must not be discarded into an affirmative key.
    const prefix = line.slice(0, start).trim();
    if (prefix && !new RegExp(String.raw`^(?:Legend:?|${coverageMapCaption})$`, 'i').test(prefix)) return new Map();
    const match = legend.exec(line.slice(start).trim());
    if (!match || match[1] === match[3]) return new Map();
    const entries = [[match[1]!, /^(?:TESTED|COVERED)$/i.test(match[2]!)],
      [match[3]!, /^(?:TESTED|COVERED)$/i.test(match[4]!)]] as const;
    if (entries[0][1] === entries[1][1]) return new Map();
    for (const [symbol, covered] of entries) {
      if (meanings.has(symbol) && meanings.get(symbol) !== covered) return new Map();
      meanings.set(symbol, covered);
    }
  }
  return currentDiagramLegend(lines) ? meanings : new Map();
}

/** Text markers need an explicit, current legend in this same diagram block. */
function diagramWordLegend(lines: string[]): Map<string, boolean> | undefined {
  const declarations = lines.filter(line => /^\s*Legend\b/i.test(line) && /\[\s*(?:OK|GAP)\s*\]/i.test(line));
  if (!declarations.length) return undefined;
  const meanings = new Map<string, boolean>();
  const pair = String.raw`\[\s*(OK|GAP)\s*\]\s+(covered|tested|no test|untested)`;
  const form = new RegExp(String.raw`^\s*Legend:?\s+${pair}(?:\s+[|,;]?\s*|[|,;]\s*)${pair}\s*$`, 'i');
  // A single coverage key may coexist with the documented quality keys.
  // Consume those complete clauses too: an extracted status inside arbitrary
  // qualifiers cannot define an unconditional coverage meaning.
  const separator = String.raw`(?:\s+[|,;]?\s*|[|,;]\s*)`;
  const quality = String.raw`(?:★★★\s+(?:edges\s*\+\s*errors|behavior\s*\+\s*edge\s*\+\s*error)|★★\s+happy path(?: only)?|★\s+smoke(?: check)?|\[→E2E\]\s+(?:(?:recommend|needs)\s+)?integration test)`;
  const single = new RegExp(String.raw`^\s*Legend:?\s+(?:${quality}${separator})*${pair}(?:${separator}${quality})*\s*$`, 'i');
  for (const line of declarations) {
    const match = form.exec(line);
    const singleMatch = !match && single.exec(line);
    if ((!match && !singleMatch) || (match && match[1]!.toUpperCase() === match[3]!.toUpperCase())) return new Map();
    const entries = match ? [[match[1]!, match[2]!], [match[3]!, match[4]!]]
      : [[singleMatch![1]!, singleMatch![2]!]];
    for (const [name, description] of entries) {
      const key = name.toUpperCase(), covered = /^(?:covered|tested)$/i.test(description);
      if ((key === 'OK') !== covered || (meanings.has(key) && meanings.get(key) !== covered)) return new Map();
      meanings.set(key, covered);
    }
  }
  if (lines.some(line => /^\s*(?:Correction:\s*)?(?:This|The|That)\s+legend\s+(?:is|has been)\s+['"‘’“”`]*(?:withdrawn|superseded|cancelled|canceled|rejected|retracted|not current|no longer current)\b/i.test(line))) return new Map();
  return meanings;
}

function currentDiagramLegend(lines: string[]): boolean {
  const status = '(?:withdrawn|superseded|cancelled|canceled|rejected|retracted|incorrect|hypothetical|proposed|optional|not current|no longer current)';
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    const owner = '(?:this|the|that) legend (?:is|has been) ';
    const scalar = new RegExp(`((?:^|[.!?;]\\s+)[\\t ]*(?:Correction:\\s*)?${owner})["“'‘\x60](${status})["”'’\x60]`, 'gi');
    const current = line.replace(/\*\*/g, '').replace(scalar, '$1$2').replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’|`[^`\n]*`/g, '');
    if (exampleDiagram(current) || /^\s*(?:Source|Quoted(?: source)?|Historical(?: note| assessment)?|Hypothetical|Example|If approved)\s*:/i.test(current) ||
        new RegExp(`(?:^|[.!?;]\\s+)[\\t ]*(?:Correction:\\s*)?${owner}${status}\\b`, 'i').test(current) ||
        /(?:^|[.!?;]\s+)[\t ]*(?:this|the|that) legend (?:applies|will apply) (?:only )?(?:if|once|when) approved\b/i.test(current)) return false;
  }
  return true;
}

/** Checkbox states are meaningful only under a current key in this block. */
function diagramCheckboxLegend(lines: string[]): Map<string, boolean> | undefined {
  const heading = String.raw`(?:Legend:?|${coverageMapCaption})`;
  const declaration = new RegExp(String.raw`^\s*(?:Legend\b|${coverageMapCaption}\b)`, 'i');
  const declarations = lines.filter(line => declaration.test(line) && /\[[x# ]\]/i.test(line));
  if (!declarations.length) return undefined;
  const pair = String.raw`\[([x# ])\]\s+(covered(?: by an existing test)?|tested|no test(?: reaches this path)?|untested|GAP)`;
  const form = new RegExp(String.raw`^\s*${heading}\s+${pair}(?:\s+[|,;]?\s*|[|,;]\s*)${pair}\s*$`, 'i');
  const meanings = new Map<string, boolean>();
  for (const original of declarations) {
    const line = original.replace(/[\t ]+[─-] happy path[\t ]+✗ negative path$/i, '');
    const match = form.exec(line);
    if (!match || match[1]!.toLowerCase() === match[3]!.toLowerCase()) return new Map();
    for (const [symbol, description] of [[match[1]!, match[2]!], [match[3]!, match[4]!]]) {
      const key = symbol.toLowerCase(), covered = /^(?:covered|tested)\b/i.test(description);
      if ((key === 'x' || key === '#') !== covered || (meanings.has(key) && meanings.get(key) !== covered)) return new Map();
      meanings.set(key, covered);
    }
  }
  return currentDiagramLegend(lines) ? meanings : new Map();
}

function seededDiagram(output: string): boolean {
  for (const lines of diagramBlocks(output)) {
    const rows = lines.map(treeRow);
    // A coverage marker aligned beneath a branch's label continues that row.
    // Stop at prose or another branch; a distant parallel column cannot lend it.
    let owner = -1;
    for (let i = 0; i < lines.length; i++) {
      if (rows[i]) { owner = i; continue; }
      const continuation = /^([ |│]+)(\[[✓✔✗✘xX# ]\].*)$/.exec(lines[i]!);
      if (owner >= 0 && continuation && [4, 6, 8].includes(continuation[1]!.length - rows[owner]!.depth))
        rows[owner]!.text += ' ' + continuation[2]!;
      else if (!/^[ |│]*$/.test(lines[i]!)) owner = -1;
    }
    const legend = diagramLegend(lines, rows.findIndex(row => row !== undefined));
    const wordLegend = diagramWordLegend(lines);
    const checkboxLegend = diagramCheckboxLegend(lines);
    if (rows.some(row => row && /\[[x# ]\]/i.test(row.text)) && checkboxLegend?.size !== 2) continue;
    const marker = String.raw`(?:\[[✓✔✗✘xX# ]\]|\[\s*(?:OK|GAP)\s*\])`;
    const marked = (line: string) => /\[[✓✔✗✘xX# ]\]|\[\s*OK\s*\]/i.test(line) ||
      (wordLegend !== undefined && /\[\s*GAP\s*\]/i.test(line));
    const symbolMeans = (line: string, covered: boolean) => {
      if (new RegExp(String.raw`\b(?:not|never)\s+${marker}|(?:${marker}|\b(?:marker|symbol))\s+(?:is|are)\s+(?:false|incorrect|wrong)\b`, 'i').test(line)) return false;
      // A status correction [covered]→[gap] carries only its final marker.
      // Unrelated contradictory markers cannot supply both coverage states.
      const corrected = line.replace(new RegExp(marker + String.raw`[\t ]*(?:→|->)[\t ]*(?=` + marker + ')', 'gi'), '');
      const states = [...corrected.matchAll(/\[([✓✔✗✘])\]|\[\s*(OK|GAP)\s*\]|\[([x# ])\]/gi)]
        .map(match => match[1] ? legend.get(match[1]) : match[2] ? wordLegend?.get(match[2].toUpperCase()) : checkboxLegend?.get(match[3]!.toLowerCase()));
      return states.includes(covered) && !states.includes(!covered);
    };
    const payment = rows.findIndex(row => row && /^processPayment\b/.test(row.text));
    const refund = rows.findIndex(row => row && /^refundPayment\b/.test(row.text));
    if (payment < 0 || refund < 0) continue;
    const subtree = (index: number): string[] => {
      const texts = [rows[index]!.text], depth = rows[index]!.depth;
      for (let i = index + 1; i < rows.length; i++) {
        const row = rows[i];
        if (row && row.depth <= depth) break;
        if (row) texts.push(row.text);
      }
      return texts;
    };
    const covered = subtree(payment).some(line =>
      (marked(line) ? symbolMeans(line, true) :
       /(?:\bTESTED\b|\bCOVERED\b)/i.test(line) || (/✓/.test(line) && (legend.get('✓') ?? true))) && /happy|success|valid|USD/i.test(line) &&
      !/untested|(?:not|never)\s+(?:yet\s+)?(?:tested|covered)|no\s+test/i.test(line));
    const missing = subtree(refund).some(line =>
      (marked(line) ? symbolMeans(line, false) : /(?:\[GAP\]|✗\s*GAP|\bUNTESTED\b)/i.test(line)) &&
      !/\b(?:not|never)\s+(?:\[)?(?:untested|gap)\b|\b(?:untested|gap)\]?\s+(?:is|are)\s+(?:false|incorrect|wrong)\b|\bno\s+(?:coverage\s+)?gaps?\b|\b(?:fully|completely)\s+(?:tested|covered)\b/i.test(line));
    if (covered && missing) return true;
  }
  return false;
}
/**
 * The requested closing coverage summary: the last JSON object in the output
 * with string arrays "tested" and "untested". Quoted lines and objects under
 * an example/sample heading do not count. processPayment must be tested and
 * refundPayment untested, each in one list only.
 */
export function coverageSummaryClassifiesSeed(output: string): boolean {
  const lines = output.split('\n');
  let summary: { tested: string[]; untested: string[] } | undefined;
  for (const match of output.matchAll(/\{[^{}]*"tested"[^{}]*\}/g)) {
    const before = output.slice(0, match.index!);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    const lineIndex = before.split('\n').length - 1;
    const heading = lines.slice(Math.max(0, lineIndex - 3), lineIndex).join('\n');
    if (/^\s*>/.test(line) || /^(?:[#*\s]*)(?:example|sample|illustration)\b/im.test(heading)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(match[0]); } catch { continue; }
    const value = parsed as { tested?: unknown; untested?: unknown };
    if (!Array.isArray(value.tested) || !Array.isArray(value.untested) ||
        ![...value.tested, ...value.untested].every(item => typeof item === 'string')) continue;
    summary = { tested: value.tested as string[], untested: value.untested as string[] };
  }
  if (!summary) return false;
  const names = (list: string[], name: string) => list.some(item => new RegExp(`\\b${name}\\b`).test(item));
  return names(summary.tested, 'processPayment') && !names(summary.untested, 'processPayment') &&
    names(summary.untested, 'refundPayment') && !names(summary.tested, 'refundPayment');
}

export function coverageAuditVerdict(
  result: Pick<SkillTestResult, 'exitReason' | 'browseErrors' | 'output' | 'transcript'>,
  files: CoverageAuditFiles,
) {
  const reads = coverageAuditReadEvidence(Array.isArray(result.transcript) ? result.transcript : [], files);
  // The closing summary states the outcome directly. The diagram grammar stays
  // as a fallback so stored runs that predate the summary keep their verdicts.
  const summary = typeof result.output === 'string' && coverageSummaryClassifiesSeed(result.output);
  const diagram = typeof result.output === 'string' && (summary || seededDiagram(result.output)),
    failures: string[] = [];
  if (result.exitReason !== 'success') failures.push('capture did not complete successfully');
  if (result.browseErrors.length) failures.push('capture reported tool errors');
  if (!reads.sourceRead) failures.push('missing successful source-file read');
  if (!reads.testsRead) failures.push('missing successful test-file read');
  if (!diagram) failures.push('missing seeded covered-payment/refund-gap diagram');
  return { ...reads, diagram, passed: failures.length === 0, failures };
}
