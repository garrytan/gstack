/** Completed parent file delivery and seeded coverage-diagram evidence. */
import * as path from 'node:path';
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

/** Closed literal cat/sed forms only; no shell execution or general shell parser. */
function readsFile(command: unknown, file: string, cwd: string, output: unknown, owned: CoverageAuditFiles): boolean {
  if (typeof command !== 'string' || command.length > 16384 || /[\r\n]/.test(command)) return false;
  const parts: string[] = [];
  const separators: string[] = [];
  let part = '', quote = '', andList = false, semicolons = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (quote !== "'" && /[`$]/.test(char)) return false;
      // These escapes remain literal regex characters in double quotes. A
      // neighboring grep may use them; only its closed display form below
      // accepts the backslashes. Shell expansion and escaped quotes stay out.
      if (char === '\\' && quote !== "'" && !/[.|]/.test(command[index + 1] ?? '')) return false;
      part += char; if (char === quote) quote = '';
    }
    else if (char === '\'' || char === '"') { quote = char; part += char; }
    else if (/[`$\\#<{}()]/.test(char)) return false; // Comments, heredocs, functions and grouped execution are unsupported.
    else if (char === ';') { semicolons = true; separators.push(';'); parts.push(part.trim()); part = ''; }
    else if (char === '&') {
      if (command[index + 1] !== '&') return false;
      index++; andList = true; separators.push('&&'); parts.push(part.trim()); part = '';
    }
    else part += char;
  }
  if (quote) return false;
  parts.push(part.trim());
  // A final Git display can hide a failed && prefix. Only the two owned reads
  // with their exact ordered output can establish delivery through this form.
  if (andList && semicolons && separators.at(-1) === ';' && separators.slice(0, -1).every(s => s === '&&') &&
      /^git log --oneline [A-Za-z0-9_][A-Za-z0-9_./~^-]*$/.test(parts.at(-2) ?? '') &&
      /^git diff [A-Za-z0-9_][A-Za-z0-9_./~^-]* --stat$/.test(parts.at(-1) ?? '')) {
    const files = [owned.source, owned.tests], readPaths: string[] = [], prefix: string[] = [];
    for (const segment of parts.slice(0, -2)) {
      const read = /^cat -n (.+)$/.exec(segment), target = read && literal(read[1]!);
      if (target) {
        const known = files.find(f => path.resolve(cwd, target) === f.path);
        if (!known || readPaths.includes(known.path)) return false;
        readPaths.push(known.path); prefix.push(known.content.replace(/\r\n?/g, '\n').replace(/\n$/, ''));
      } else if (/^echo [-=]+$/.test(segment)) prefix.push(segment.slice(5));
      else return false;
    }
    const actual = outputText(output), expected = normalized(prefix.join('\n'));
    const deliveredPrefix = normalized(actual.replace(/^ *\d+(?:\t|→)/gm, ''));
    return readPaths.length === 2 && readPaths.includes(file) && actual.length <= 4 * 1024 * 1024 &&
      (deliveredPrefix === expected || deliveredPrefix.startsWith(expected + '\n'));
  }
  const cd = /^cd\s+(.+)$/.exec(parts[0] ?? '');
  if (cd) {
    const target = literal(cd[1]!);
    if (target !== cwd) return false;
    parts.shift();
  }
  // A cwd change or shell control cannot turn a relative target into another
  // file, or leave a printed old command mistaken for an executed read.
  if (parts.some(p => /^(?:cd|pushd|popd|source|\.|eval|exec|exit|return|function|alias|if|then|else|for|while|until|case)\s/.test(p) ||
      /^(?:exit|return|fi|done)$/.test(p) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(p))) return false;
  const readTarget = (p: string): string | undefined => {
    const cat = /^cat(?:\s+-n)?(?:\s+--)?\s+(.+)$/.exec(p);
    const sed = /^sed\s+-n\s+(?:'\d+(?:,\d+)?p'|"\d+(?:,\d+)?p"|\d+(?:,\d+)?p)\s+(.+)$/.exec(p);
    return literal((cat ?? sed)?.[1] ?? '');
  };
  // Unrelated reads may precede/follow a delivered file. They cannot mutate it
  // or print replacement content through another interpreter. Only discarded
  // stderr is allowed; a credited cat/sed itself still has no redirection.
  const readOnly = (part: string) => {
    // A neighboring optional file read may report absence. It never receives
    // source/test delivery credit; only earlier independent cat/sed segments do.
    const fallback = /^(cat(?:\s+-n)?(?:\s+--)?\s+.+)\s+2>\/dev\/null\s+\|\|\s+echo\s+(.+)$/.exec(part);
    if (fallback) return readTarget(fallback[1]!) !== undefined && literal(fallback[2]!) !== undefined && !part.includes('\\');
    const stages: string[] = [];
    let value = '', quoted = '';
    for (const char of part) {
      if (quoted) { value += char; if (char === quoted) quoted = ''; }
      else if (char === "'" || char === '"') { quoted = char; value += char; }
      else if (char === '|') { stages.push(value); value = ''; }
      else value += char;
    }
    stages.push(value);
    return stages.every(value => {
      const stage = value.trim().replace(/(?:^|\s)2>\/dev\/null(?=\s|$)/g, ' ').trim();
      if (/[<>]/.test(stage.replace(/'[^']*'|"[^"]*"/g, ''))) return false;
      // Backslashes are data only in these closed grep display patterns.
      // In particular, echo -e cannot print replacement fixture bodies.
      const grepRange = /^grep\s+-n(?:\s+-i)?(?:\s+-B\d{1,4})?(?:\s+-A\d{1,4})?\s+"(?:[^"\\$`]|\\[|.])*"\s+(.+)$/.exec(stage);
      const grepInput = grepRange && literal(grepRange[1]!);
      const displayGrep = Boolean(grepInput && !grepInput.startsWith('-'));
      // An awk range without actions only prints matching input lines.
      // Programs, BEGIN/END, output redirection and interpreter calls cannot
      // match this grammar, and its input path must be one literal operand.
      const awkRange = /^awk\s+'\/(?:[^/\\]|\\[./|])*\/,\/(?:[^/\\]|\\[./|])*\/'\s+(.+)$/.exec(stage);
      const awkInput = awkRange && literal(awkRange[1]!);
      // A single flag starts display at a heading and exits at the next one.
      // No other awk action, output destination or interpreter call is allowed.
      const awkHeadings = /^awk\s+'\/(?:[^/\\]|\\[./|])*\/\{f=1\} f&&\/(?:[^/\\]|\\[./|])*\/\{exit\} f'\s+(.+)$/.exec(stage);
      const headingInput = awkHeadings && literal(awkHeadings[1]!);
      const displayAwk = Boolean((awkInput && !awkInput.startsWith('-')) || (headingInput && !headingInput.startsWith('-')));
      if (stage.includes('\\') && !/^grep\s+-(?:E|cE)\s+'[^']*'(?:\s+[^\\]*)?$/.test(stage) && !displayGrep && !displayAwk) return false;
      const git = /^git\s+(log|diff)(?:\s+(.*))?$/.exec(stage);
      // These neighboring Git calls are display-only: literal revisions and the
      // observed display flag. Quoted/concatenated or unknown options may write
      // files or invoke helpers, so they cannot borrow a read-only classification.
      const gitDisplay = git !== null && (!git[2] || git[2].split(/\s+/).every(token =>
        token === (git[1] === 'log' ? '--oneline' : '--stat') ||
        (git[1] === 'log' && /^-[1-9]\d{0,4}$/.test(token)) || /^[A-Za-z0-9_][A-Za-z0-9_./~^-]*$/.test(token)));
      return /^(?:cat|grep|head|ls|echo)(?:\s|$)/.test(stage) || stage === 'pwd' || stage === 'wc -l' || stage === 'git ls-files' || stage === "sed 's/^/TESTFILES:/'" || /^\[ -f [A-Za-z0-9_.\/-]+ \]$/.test(stage) ||
        readTarget(stage) !== undefined || gitDisplay || displayAwk;
    });
  };
  if (parts.some(p => p && !readOnly(p))) return false;
  // A successful, unmixed && list may include literal display separators
  // and a closed diff-stat command. These segments never receive file credit.
  const andDisplay = (p: string) => {
    if (p === 'echo' || /^echo\s+[-=]+$/.test(p) || /^echo [-=]{2,} [A-Za-z0-9_.\/-]+ [-=]{2,}$/.test(p)) return true;
    const caption = /^echo\s+(.+)$/.exec(p), value = caption && literal(caption[1]!);
    if (value && /^[-=]{2,}\s+[A-Za-z0-9_][A-Za-z0-9_./-]*(?:\s+(?:vs|and)\s+[A-Za-z0-9_][A-Za-z0-9_./-]*)?\s+[-=]{2,}$/.test(value)) return true;
    return /^git\s+diff(?:\s+[A-Za-z0-9_][A-Za-z0-9_./~^-]*)?\s+--stat$/.test(p);
  };
  if (andList && semicolons) {
    const caption = /^echo (.+)$/.exec(parts[0] ?? ''), value = caption && literal(caption[1]!);
    if (!value || ![owned.source, owned.tests].some(f => value === `=== ${path.relative(cwd, f.path)} ===`)) return false;
    // Later display commands can mask an earlier exit code. Require both owned
    // reads in the initial && chain and their exact ordered stdout prefix.
    const prefix: string[] = [], readPaths: string[] = [];
    for (let i = 0; i < parts.length && (i === 0 || separators[i - 1] === '&&'); i++) {
      const segment = parts[i]!, target = readTarget(segment);
      const known = target && [owned.source, owned.tests].find(f => path.resolve(cwd, target) === f.path);
      if (known && /^cat -n /.test(segment) && !readPaths.includes(known.path)) {
        readPaths.push(known.path); prefix.push(known.content.replace(/\r\n?/g, '\n').replace(/\n$/, ''));
      } else if (andDisplay(segment) && /^echo(?: |$)/.test(segment)) {
        const value = segment.slice(5); prefix.push(literal(value) ?? value);
      } else return false;
      if (readPaths.length === 2) break;
    }
    const actual = outputText(output), expected = normalized(prefix.join('\n'));
    const deliveredPrefix = normalized(actual.replace(/^ *\d+(?:\t|→)/gm, ''));
    return readPaths.length === 2 && readPaths.includes(file) && actual.length <= 4 * 1024 * 1024 &&
      (deliveredPrefix === expected || deliveredPrefix.startsWith(expected + '\n'));
  }
  if (andList && parts.some(p => readTarget(p) === undefined && !andDisplay(p))) return false;
  return parts.some(p => {
    const target = readTarget(p);
    return target !== undefined && path.resolve(cwd, target) === file;
  });
}
function delivered(output: unknown, expected: string): boolean {
  const text = outputText(output);
  const body = normalized(expected);
  if (!body || text.length > 4 * 1024 * 1024) return false;
  if (normalized(text).includes(body)) return true;
  // Native Read gutters and cat -n use different separators; retain actual
  // code indentation and require the entire contiguous file, not filenames.
  return normalized(text.replace(/^ *\d+(?:\t|→)/gm, '')).includes(body);
}

export function coverageAuditReadEvidence(transcript: unknown[], files: CoverageAuditFiles): { sourceRead: boolean; testsRead: boolean } {
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
    uses = new Map<string, { name: string; input: Record<string, any> }>(),
    results = new Set<string>();
  for (const e of transcript.slice(transcript.indexOf(init[0]) + 1)) {
    if (!object(e) || e.session_id !== session || (e.parent_tool_use_id !== null && e.parent_tool_use_id !== undefined) ||
        !object(e.message) || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (!object(b)) continue;
      if (e.type === 'assistant' && e.message.role === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && object(b.input)) {
        if (uses.has(b.id)) return { sourceRead: false, testsRead: false };
        uses.set(b.id, { name: b.name, input: b.input });
      } else if (e.type === 'user' && e.message.role === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (results.has(b.tool_use_id)) return { sourceRead: false, testsRead: false };
        results.add(b.tool_use_id);
        const u = uses.get(b.tool_use_id);
        if (!u || (b.is_error !== undefined && b.is_error !== false)) continue;
        for (const [key, file] of [['sourceRead', files.source], ['testsRead', files.tests]] as const) {
          const named = u.name === 'Read'
            ? typeof u.input.file_path === 'string' && path.resolve(files.cwd, u.input.file_path) === file.path
            : u.name === 'Bash' && readsFile(u.input.command, file.path, files.cwd, b.content, files);
          if (named && delivered(b.content, file.content)) found[key] = true;
        }
      }
    }
  }
  return found;
}
/** Top-level ASCII, optionally fenced; an outer source/example fence owns its body. */
function diagramBlocks(output: string): string[][] {
  const blocks: string[][] = [];
  let outside: string[] = [];
  const example = (line: string) => /^(?:example|sample|illustration)\b/i.test(line.trim().replace(/^[#*]+\s*/, ''));
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
        allowed: /^(?:text|ascii|plaintext)?$/.test(marker[2]!.trim()) && !outside.some(example), lines: [] };
      outside = [];
    } else outside.push(line);
  }
  if (outside.length) blocks.push(outside);
  return blocks.filter(lines => {
    const firstRow = lines.findIndex(line => treeRow(line) !== undefined);
    return firstRow >= 0 && !lines.slice(0, firstRow).some(example);
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
  return { depth: match[1]!.length, text: match[2]!.split(/ {3,}(?=[├└+|])/, 1)[0]! };
}

function diagramLegend(lines: string[], firstRow: number): Map<string, boolean> {
  const meanings = new Map<string, boolean>();
  const pair = String.raw`\[([✓✔✗✘])\][\t ]+(TESTED|COVERED|GAP|UNTESTED)`;
  const legend = new RegExp(String.raw`^${pair}[\t |,;]+${pair}$`, 'i');
  for (const original of lines.slice(0, firstRow)) {
    // Decorative branch keys and an explicit GAP explanation do not change
    // the two coverage meanings. All other qualifiers keep the closed grammar.
    const line = original.replace(/[\t ]+[─-]+►[\t ]+branch$/i, '')
      .replace(/(\[[✓✔✗✘]\][\t ]+(?:GAP|UNTESTED))[\t ]+\((?:no test|GAP)\)$/i, '$1');
    const start = line.search(/\[[✓✔✗✘]\]/);
    if (start < 0) continue;
    if (/^\s*>|["“”]|\b(?:not|no|never|example|sample|false|incorrect|hypothetical)\b/i.test(line)) return new Map();
    // Only a legend label or a literal file's coverage-map caption may precede
    // the pair. Arbitrary prose must not be discarded into an affirmative key.
    const prefix = line.slice(0, start).trim();
    if (prefix && !/^(?:Legend:|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+[\t ]+[—–-][\t ]+(?:test[\t ]+)?coverage[\t ]+map)$/i.test(prefix)) return new Map();
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
  return meanings;
}

/** Text markers need an explicit, current legend in this same diagram block. */
function diagramWordLegend(lines: string[]): Map<string, boolean> | undefined {
  const declarations = lines.filter(line => /^\s*Legend\b/i.test(line) && /\[\s*(?:OK|GAP)\s*\]/i.test(line));
  if (!declarations.length) return undefined;
  const meanings = new Map<string, boolean>();
  const pair = String.raw`\[\s*(OK|GAP)\s*\]\s+(covered|tested|no test|untested)`;
  const form = new RegExp(String.raw`^\s*Legend:?\s+${pair}(?:\s+[|,;]?\s*|[|,;]\s*)${pair}\s*$`, 'i');
  for (const line of declarations) {
    const match = form.exec(line);
    if (!match || match[1]!.toUpperCase() === match[3]!.toUpperCase()) return new Map();
    for (const [name, description] of [[match[1]!, match[2]!], [match[3]!, match[4]!]]) {
      const key = name.toUpperCase(), covered = /^(?:covered|tested)$/i.test(description);
      if ((key === 'OK') !== covered || (meanings.has(key) && meanings.get(key) !== covered)) return new Map();
      meanings.set(key, covered);
    }
  }
  if (lines.some(line => /^\s*(?:Correction:\s*)?(?:This|The|That)\s+legend\s+(?:is|has been)\s+['"‘’“”`]*(?:withdrawn|superseded|cancelled|canceled|rejected|retracted|not current|no longer current)\b/i.test(line))) return new Map();
  return meanings;
}

/** Checkbox states are meaningful only under a current key in this block. */
function diagramCheckboxLegend(lines: string[]): Map<string, boolean> | undefined {
  const declarations = lines.filter(line => /^\s*Legend\b/i.test(line) && /\[[x ]\]/i.test(line));
  if (!declarations.length) return undefined;
  const pair = String.raw`\[([x ])\]\s+(covered(?: by an existing test)?|tested|no test(?: reaches this path)?|untested|GAP)`;
  const form = new RegExp(String.raw`^\s*Legend:?\s+${pair}(?:\s+[|,;]?\s*|[|,;]\s*)${pair}\s*$`, 'i');
  const meanings = new Map<string, boolean>();
  for (const original of declarations) {
    const line = original.replace(/[\t ]+[─-] happy path[\t ]+✗ negative path$/i, '');
    const match = form.exec(line);
    if (!match || match[1]!.toLowerCase() === match[3]!.toLowerCase()) return new Map();
    for (const [symbol, description] of [[match[1]!, match[2]!], [match[3]!, match[4]!]]) {
      const key = symbol.toLowerCase(), covered = /^(?:covered|tested)\b/i.test(description);
      if ((key === 'x') !== covered || (meanings.has(key) && meanings.get(key) !== covered)) return new Map();
      meanings.set(key, covered);
    }
  }
  const status = '(?:withdrawn|superseded|cancelled|canceled|rejected|retracted|incorrect|hypothetical|proposed|optional|not current|no longer current)';
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    const owner = '(?:this|the|that) legend (?:is|has been) ';
    const scalar = new RegExp(`((?:^|[.!?;]\\s+)[\\t ]*(?:Correction:\\s*)?${owner})["“'‘\x60](${status})["”'’\x60]`, 'gi');
    const current = line.replace(/\*\*/g, '').replace(scalar, '$1$2').replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’|`[^`\n]*`/g, '');
    if (/^\s*(?:Source|Quoted(?: source)?|Historical(?: note| assessment)?|Hypothetical|Example|If approved)\s*:/i.test(current) ||
        new RegExp(`(?:^|[.!?;]\\s+)[\\t ]*(?:Correction:\\s*)?${owner}${status}\\b`, 'i').test(current) ||
        /(?:^|[.!?;]\s+)[\t ]*(?:this|the|that) legend (?:applies|will apply) (?:only )?(?:if|once|when) approved\b/i.test(current)) return new Map();
  }
  return meanings;
}

function seededDiagram(output: string): boolean {
  for (const lines of diagramBlocks(output)) {
    const rows = lines.map(treeRow);
    // A coverage marker aligned beneath a branch's label continues that row.
    // Stop at prose or another branch; a distant parallel column cannot lend it.
    let owner = -1;
    for (let i = 0; i < lines.length; i++) {
      if (rows[i]) { owner = i; continue; }
      const continuation = /^([ |│]+)(\[[✓✔✗✘xX ]\].*)$/.exec(lines[i]!);
      if (owner >= 0 && continuation && [4, 8].includes(continuation[1]!.length - rows[owner]!.depth))
        rows[owner]!.text += ' ' + continuation[2]!;
      else if (!/^[ |│]*$/.test(lines[i]!)) owner = -1;
    }
    const legend = diagramLegend(lines, rows.findIndex(row => row !== undefined));
    const wordLegend = diagramWordLegend(lines);
    const checkboxLegend = diagramCheckboxLegend(lines);
    if (rows.some(row => row && /\[[x ]\]/i.test(row.text)) && checkboxLegend?.size !== 2) continue;
    const marker = String.raw`(?:\[[✓✔✗✘xX ]\]|\[\s*(?:OK|GAP)\s*\])`;
    const marked = (line: string) => /\[[✓✔✗✘xX ]\]|\[\s*OK\s*\]/i.test(line) ||
      (wordLegend !== undefined && /\[\s*GAP\s*\]/i.test(line));
    const symbolMeans = (line: string, covered: boolean) => {
      if (new RegExp(String.raw`\b(?:not|never)\s+${marker}|(?:${marker}|\b(?:marker|symbol))\s+(?:is|are)\s+(?:false|incorrect|wrong)\b`, 'i').test(line)) return false;
      // A status correction [covered]→[gap] carries only its final marker.
      // Unrelated contradictory markers cannot supply both coverage states.
      const corrected = line.replace(new RegExp(marker + String.raw`[\t ]*(?:→|->)[\t ]*(?=` + marker + ')', 'gi'), '');
      const states = [...corrected.matchAll(/\[([✓✔✗✘])\]|\[\s*(OK|GAP)\s*\]|\[([x ])\]/gi)]
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
export function coverageAuditVerdict(
  result: Pick<SkillTestResult, 'exitReason' | 'browseErrors' | 'output' | 'transcript'>,
  files: CoverageAuditFiles,
) {
  const reads = coverageAuditReadEvidence(Array.isArray(result.transcript) ? result.transcript : [], files);
  const diagram = typeof result.output === 'string' && seededDiagram(result.output),
    failures: string[] = [];
  if (result.exitReason !== 'success') failures.push('capture did not complete successfully');
  if (result.browseErrors.length) failures.push('capture reported tool errors');
  if (!reads.sourceRead) failures.push('missing successful source-file read');
  if (!reads.testsRead) failures.push('missing successful test-file read');
  if (!diagram) failures.push('missing seeded covered-payment/refund-gap diagram');
  return { ...reads, diagram, passed: failures.length === 0, failures };
}
