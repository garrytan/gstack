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
const literal = (token: string): string | undefined => {
  if (/^'[^']*'$/.test(token) || /^"[^"$`\\]*"$/.test(token)) return token.slice(1, -1);
  return /^[^\s'"$`\\;|&<>]+$/.test(token) ? token : undefined;
};

/** Closed literal cat/sed forms only; no shell execution or general shell parser. */
function readsFile(command: unknown, file: string, cwd: string): boolean {
  if (typeof command !== 'string' || command.length > 16384 || /[`$\r\n]/.test(command)) return false;
  const parts: string[] = [];
  let part = '', quote = '', andList = false, semicolons = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      // These escapes remain literal regex characters in double quotes. A
      // neighboring grep may use them; only its closed display form below
      // accepts the backslashes. Shell expansion and escaped quotes stay out.
      if (char === '\\' && quote !== "'" && !/[.|]/.test(command[index + 1] ?? '')) return false;
      part += char; if (char === quote) quote = '';
    }
    else if (char === '\'' || char === '"') { quote = char; part += char; }
    else if (/[\\#<{}()]/.test(char)) return false; // Comments, heredocs, functions and grouped execution are unsupported.
    else if (char === ';') { semicolons = true; parts.push(part.trim()); part = ''; }
    else if (char === '&') {
      if (command[index + 1] !== '&') return false;
      index++; andList = true; parts.push(part.trim()); part = '';
    }
    else part += char;
  }
  if (quote) return false;
  parts.push(part.trim());
  // A later semicolon can hide a failed && chain and a skipped read. Keep the
  // new conditional form closed: the successful result must cover one list.
  if (andList && semicolons) return false;
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
      // Backslashes are data only in this closed, single-quoted grep pattern.
      // In particular, echo -e cannot print replacement fixture bodies.
      const displayGrep = /^grep\s+-n\s+"(?:[^"\\$`]|\\[|.])*"\s+[^\\]+$/.test(stage);
      // An awk range without actions only prints matching input lines.
      // Programs, BEGIN/END, output redirection and interpreter calls cannot
      // match this grammar, and its input path must be one literal operand.
      const awkRange = /^awk\s+'\/(?:[^/\\]|\\[./|])*\/,\/(?:[^/\\]|\\[./|])*\/'\s+(.+)$/.exec(stage);
      const awkInput = awkRange && literal(awkRange[1]!);
      const displayAwk = Boolean(awkInput && !awkInput.startsWith('-'));
      if (stage.includes('\\') && !/^grep\s+-E\s+'[^']*'(?:\s+[^\\]*)?$/.test(stage) && !displayGrep && !displayAwk) return false;
      const git = /^git\s+(log|diff)(?:\s+(.*))?$/.exec(stage);
      // These neighboring Git calls are display-only: literal revisions and the
      // observed display flag. Quoted/concatenated or unknown options may write
      // files or invoke helpers, so they cannot borrow a read-only classification.
      const gitDisplay = git !== null && (!git[2] || git[2].split(/\s+/).every(token =>
        token === (git[1] === 'log' ? '--oneline' : '--stat') ||
        (git[1] === 'log' && /^-[1-9]\d{0,4}$/.test(token)) || /^[A-Za-z0-9_][A-Za-z0-9_./~^-]*$/.test(token)));
      return /^(?:cat|grep|head|ls|echo)(?:\s|$)/.test(stage) || stage === 'pwd' || stage === 'wc -l' || stage === 'git ls-files' ||
        readTarget(stage) !== undefined || gitDisplay || displayAwk;
    });
  };
  if (parts.some(p => p && !readOnly(p))) return false;
  if (andList && parts.some(p => readTarget(p) === undefined && !/^echo\s+[-=]+$/.test(p))) return false;
  return parts.some(p => {
    const target = readTarget(p);
    return target !== undefined && path.resolve(cwd, target) === file;
  });
}
function delivered(output: unknown, expected: string): boolean {
  const text = typeof output === 'string' ? output : Array.isArray(output) && output.every(b => object(b) && b.type === 'text' && typeof b.text === 'string')
    ? output.map(b => b.text).join('\n') : '';
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
            : u.name === 'Bash' && readsFile(u.input.command, file.path, files.cwd);
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
      .replace(/(\[[✓✔✗✘]\][\t ]+(?:GAP|UNTESTED))[\t ]+\(no test\)$/i, '$1');
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

function seededDiagram(output: string): boolean {
  for (const lines of diagramBlocks(output)) {
    const rows = lines.map(treeRow);
    const legend = diagramLegend(lines, rows.findIndex(row => row !== undefined));
    const symbolMeans = (line: string, covered: boolean) => {
      if (/\b(?:not|never)\s+\[[✓✔✗✘]\]|(?:\[[✓✔✗✘]\]|\b(?:marker|symbol))\s+(?:is|are)\s+(?:false|incorrect|wrong)\b/i.test(line)) return false;
      // A status correction [covered]→[gap] carries only its final marker.
      // Unrelated contradictory markers cannot supply both coverage states.
      const corrected = line.replace(/\[[✓✔✗✘]\][\t ]*(?:→|->)[\t ]*(?=\[[✓✔✗✘]\])/g, '');
      const states = [...corrected.matchAll(/\[([✓✔✗✘])\]/g)].map(match => legend.get(match[1]!));
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
      (/\[[✓✔✗✘]\]/.test(line) ? symbolMeans(line, true) :
       /(?:\bTESTED\b|\bCOVERED\b)/i.test(line) || (/✓/.test(line) && (legend.get('✓') ?? true))) && /happy|success|valid|USD/i.test(line) &&
      !/untested|(?:not|never)\s+(?:yet\s+)?(?:tested|covered)|no\s+test/i.test(line));
    const missing = subtree(refund).some(line =>
      (/\[[✓✔✗✘]\]/.test(line) ? symbolMeans(line, false) : /(?:\[GAP\]|✗\s*GAP|\bUNTESTED\b)/i.test(line)) &&
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
