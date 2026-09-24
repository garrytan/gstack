import * as path from 'node:path';
import { createHash } from 'node:crypto';

interface StartContext {
  repo: string;
  state: string;
  slug: string;
  directory: string;
  branch: string;
  wtree: string;
  startedAt: string;
}

/** Keep executable commands around heredocs; their data cannot introduce reads.
 * This handles the literal delimiters used by the canonical Bun reuse command. */
function withoutHereDocBodies(source: string): string | undefined {
  let output = '', quote = '';
  const pending: { delimiter: string; tabs: boolean }[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && quote !== "'") { output += char + (source[++i] ?? ''); continue; }
    if (quote) { if (char === quote) quote = ''; output += char; continue; }
    if (char === '"' || char === "'") { quote = char; output += char; continue; }
    if (char === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      while (i < source.length && source[i] !== '\n') output += source[i++];
      i--; continue;
    }
    if (char === '<' && source[i + 1] === '<') {
      const match = /^<<(-)?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w-]*))/.exec(source.slice(i));
      if (!match) return undefined;
      pending.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: !!match[1] });
      output += ' '; i += match[0].length - 1; continue;
    }
    output += char;
    if (char !== '\n' || !pending.length) continue;
    for (const document of pending.splice(0)) {
      let found = false;
      while (i + 1 < source.length) {
        const end = source.indexOf('\n', i + 1);
        const line = source.slice(i + 1, end < 0 ? source.length : end).replace(/\r$/, '');
        i = end < 0 ? source.length : end;
        if ((document.tabs ? line.replace(/^\t*/, '') : line) === document.delimiter) { found = true; break; }
      }
      if (!found) return undefined;
    }
  }
  return pending.length ? undefined : output;
}

function containsPath(text: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'\x60])${escaped}(?=$|[\\s"'\x60;])`).test(text);
}

function substitutionEnd(source: string, start: number): number {
  let depth = 1, quote = '';
  for (let i = start + 2; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (char === '$' && source[i + 1] === '(' && quote !== "'") {
      i = substitutionEnd(source, i);
      if (i < 0) return -1;
      continue;
    }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Bounded inspection syntax, not a shell executor: quoted arguments and comments
 * cannot introduce commands. Unknown inspection forms fail closed. */
function commands(source: string): { words: string[]; before: string; after: string; substitutions: number[]; quoted: number[] }[] {
  const executable = withoutHereDocBodies(source);
  if (executable === undefined) return [];
  source = executable;
  const result: ReturnType<typeof commands> = [];
  let words: string[] = [], substitutions: number[] = [], quoted: number[] = [];
  let word = '', quote = '', before = '', expanded = false, wasQuoted = false;
  const flush = () => {
    if (word) {
      if (expanded) substitutions.push(words.length);
      if (wasQuoted) quoted.push(words.length);
      words.push(word);
    }
    word = ''; expanded = false; wasQuoted = false;
  };
  const end = (separator: string) => {
    flush(); if (words.length) result.push({ words, before, after: separator, substitutions, quoted });
    words = []; substitutions = []; quoted = []; before = separator;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && quote !== "'") {
      wasQuoted = true;
      if (quote === '"' && !/[$`"\\\n]/.test(source[i + 1] ?? '')) word += char;
      else { const escaped = source[++i] ?? ''; word += escaped === '$' ? '\0$' : escaped; }
      continue;
    }
    if (char === '$' && source[i + 1] === '(' && quote !== "'") {
      const end = substitutionEnd(source, i);
      if (end < 0) return [];
      expanded = true; word += source.slice(i, end + 1); i = end; continue;
    }
    if (quote) { if (char === quote) quote = ''; else word += quote === "'" && char === '$' ? '\0$' : char; continue; }
    if (char === '"' || char === "'") { quote = char; wasQuoted = true; continue; }
    if (char === '#' && !word) { while (i < source.length && source[i] !== '\n') i++; end(';'); }
    else if (';|&()\n'.includes(char)) {
      const separator = (char === '&' || char === '|') && source[i + 1] === char ? char + source[++i] : char;
      end(separator === '\n' ? ';' : separator);
    }
    else if (/\s/.test(char)) flush();
    else word += char;
  }
  if (quote) return [];
  end('');
  return result;
}

const basename = (word = '') => word.split(/[\\/]/).at(-1);
const sourcePaths = (file: string) => file.includes('\\') || /^[A-Za-z]:\//.test(file) ? path.win32 : path.posix;
type SourcePaths = ReturnType<typeof sourcePaths>;

function topLevelCommands(calls: ReturnType<typeof commands>): ReturnType<typeof commands> {
  const scopes: string[] = [], result: ReturnType<typeof commands> = [];
  for (const call of calls) {
    if (call.before === '(') scopes.push(')');
    if (!scopes.length && ['', ';'].includes(call.before)) {
      if (['exit', 'return', 'exec'].includes(call.words[0])) break;
      result.push(call);
    }
    let index = 0;
    while (!call.quoted.includes(index) && ['then', 'else', 'do'].includes(call.words[index])) index++;
    const head = call.quoted.includes(index) ? '' : call.words[index];
    const close = ({ if: 'fi', for: 'done', while: 'done', until: 'done', case: 'esac', '{': '}' } as Record<string, string>)[head];
    if (close) scopes.push(close);
    else if (['fi', 'done', 'esac', '}'].includes(head) && scopes.pop() !== head) return [];
    if (call.after === ')' && scopes.pop() !== ')') return [];
  }
  return result;
}

function reviewStart(words: string[]): boolean {
  return words.length === 3 && basename(words[0]) === 'gstack-review-log'
    && words[1] === '--start' && words[2] === 'review';
}

function startTokenOutput(source: string, variables: Map<string, string | undefined>, token: string): string | undefined {
  const calls = commands(source);
  if (calls.length === 1 && reviewStart(calls[0].words) && !calls[0].before && !calls[0].after) return token;
  const first = calls[0];
  if (!first || first.before || first.words[0] !== 'echo' || first.words.length !== 2
    || expandVariables(first.words[1], variables) !== token) return undefined;
  for (let i = 1; i < calls.length; i++) {
    if (calls[i - 1].after !== '|') return undefined;
    const words = calls[i].words;
    if (['head', 'tail'].includes(words[0]) && (words.length === 2 && words[1] === '-1'
      || words.length === 3 && words[1] === '-n' && words[2] === '1')) continue;
    if (words.length !== 3 || words[0] !== 'grep' || !['-oE', '-Eo'].includes(words[1])
      || !/^\[[A-Za-z0-9_.-]+\]\+$/.test(words[2])) return undefined;
    try { if (new RegExp(words[2]).exec(token)?.[0] !== token) return undefined; } catch { return undefined; }
  }
  return calls.at(-1)?.after ? undefined : token;
}

function sameCallStartRead(source: string, file: string, expected: StartContext, token: string): boolean {
  const paths = sourcePaths(file), variables = new Map<string, string | undefined>([
    ['GSTACK_HOME', expected.state], ['SLUG', expected.slug],
  ]);
  if (paths.normalize(expected.directory) !== paths.join(expected.state, 'projects', expected.slug, '.review-starts')) return false;
  let cwd: string | undefined = expected.repo, started = false;
  for (const call of commands(source)) {
    if (!['', ';'].includes(call.before) || !['', ';'].includes(call.after)
      || /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|exit|return|exec|eval|source|\.|[{}!])$/.test(call.words[0])) return false;
    if (started && reader(call.words, operand => {
      const value = expandVariables(operand, variables);
      return value !== undefined && literalPath(value, cwd, paths) === file;
    })) return true;
    if (reviewStart(call.words)) {
      if (cwd !== expected.repo || variables.get('GSTACK_HOME') !== expected.state) return false;
      started = true;
    } else if (call.words.every(word => /^[A-Za-z_]\w*=/.test(word))) {
      for (const word of call.words) {
        const equal = word.indexOf('='), expression = word.slice(equal + 1);
        const substitution = /^\$\(([\s\S]*)\)$/.exec(expression);
        const value = substitution ? startTokenOutput(substitution[1], variables, token) : expandVariables(expression, variables);
        if (substitution && value === token && commands(substitution[1]).some(child => reviewStart(child.words))) {
          if (cwd !== expected.repo || variables.get('GSTACK_HOME') !== expected.state) return false;
          started = true;
        }
        variables.set(word.slice(0, equal), value);
      }
    } else if (call.words[0] === 'cd') {
      const args = call.words.slice(call.words[1] === '--' ? 2 : 1);
      const value = args.length === 1 ? expandVariables(args[0], variables) : undefined;
      cwd = value ? literalPath(value, cwd, paths) : undefined;
    } else if (['export', 'local', 'declare', 'readonly', 'unset', 'read', 'pushd', 'popd'].includes(call.words[0])) return false;
  }
  return false;
}

function successfulFinish(source: string, text: string, token: string, expected: StartContext): boolean {
  const calls = commands(source), topLevel = topLevelCommands(calls);
  const located = withDirectories(calls, expected.repo, sourcePaths(expected.repo), new Map([
    ['GSTACK_HOME', expected.state], ['SLUG', expected.slug],
  ]));
  const finishes = (words: string[]) => basename(words[0]) === 'gstack-review-log'
    && words.some((word, index) => word === '--finish' && (words[index + 1] === token
      || /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(words[index + 1] ?? '')));
  for (const call of topLevel) {
    if (finishes(call.words)) return true;
    if (call.quoted.includes(0) || call.words[0] !== 'if' || call.after !== ';' || !finishes(call.words.slice(1))) continue;
    const index = calls.indexOf(call), success = calls[index + 1], failure = calls[index + 2], exit = calls[index + 3], end = calls[index + 4];
    const context = located[index], argument = call.words[call.words.indexOf('--finish') + 1];
    if (context.cwd !== expected.repo || context.variables.get('GSTACK_HOME') !== expected.state
      || expandVariables(argument, context.variables) !== token) continue;
    if (success?.words[0] !== 'then' || success.quoted.includes(0) || success.words[1] !== 'echo' || success.words.length !== 3
      || /[$`\0]/.test(success.words[2]) || !text.split('\n').includes(success.words[2])
      || failure?.words[0] !== 'else' || failure.quoted.includes(0) || failure.words[1] !== 'echo'
      || exit?.words[0] !== 'exit' || !/^[1-9]\d*$/.test(exit.words[1] ?? '') || exit.words.length !== 2
      || end?.words[0] !== 'fi' || end.quoted.includes(0) || end.words.length !== 1
      || ![success, failure, exit, end].every(part => part.before === ';' && part.after === ';')) continue;
    if (!topLevel.some(read => calls.indexOf(read) > index + 4 && basename(read.words[0]) === 'gstack-review-read')) continue;
    for (const line of text.split('\n')) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const binding = row?.review_binding;
      if (row?.skill === 'review' && row.completed === true && row.wtree === expected.wtree
        && binding?.state === 'verified' && binding.start_wtree === expected.wtree && binding.end_wtree === expected.wtree
        && binding.started_at === expected.startedAt && binding.branch_id === createHash('sha256').update(expected.branch).digest('hex')) return true;
    }
  }
  return false;
}

/** Resolve source-spelled paths, independent of the machine replaying the trace.
 * Shell expansion is handled only by the discovery forms below, never guessed. */
function literalPath(value: string, cwd: string | undefined, paths: SourcePaths): string | undefined {
  if (!value || /[\0$`*?\[\]~]/.test(value)) return undefined;
  return paths.isAbsolute(value) ? paths.normalize(value) : cwd ? paths.resolve(cwd, value) : undefined;
}

function expandVariables(value: string, variables: Map<string, string | undefined>): string | undefined {
  if (value.includes('\0') || value.includes('`')) return undefined;
  let known = true;
  const expanded = value.replace(/\$\{([A-Za-z_]\w*)(?::-[^}]*)?\}|\$([A-Za-z_]\w*)/g, (_match, braced, bare) => {
    const bound = variables.get(braced ?? bare);
    if (bound === undefined) known = false;
    return bound ?? '';
  });
  return known && !expanded.includes('$') ? expanded : undefined;
}

/** Bash starts each tool call in the fixture repo. Literal cd changes the base
 * for subsequent operands; pipelines/subshells cannot leak their cwd outward. */
function withDirectories(calls: ReturnType<typeof commands>, initialCwd: string | undefined, paths: SourcePaths,
  trustedEnvironment: Map<string, string | undefined>) {
  let cwd = initialCwd;
  let variables = new Map(trustedEnvironment), previousCd = false;
  const stack: { cwd: string | undefined; variables: Map<string, string | undefined> }[] = [];
  return calls.map(call => {
    if (call.before === '(') stack.push({ cwd, variables: new Map(variables) });
    const located = { ...call, cwd, variables: new Map(variables) };
    const conditional = ['&&', '||'].includes(call.before) && !(call.before === '&&' && previousCd);
    previousCd = false;
    if (call.words[0] === 'cd' && call.before !== '|' && !['|', '&'].includes(call.after)) {
      const args = call.words.slice(call.words[1] === '--' ? 2 : 1);
      const argument = args.length === 1 ? expandVariables(args[0], variables) : undefined;
      cwd = conditional || call.after === '||' || !argument || argument.startsWith('-')
        ? undefined : literalPath(argument, cwd, paths);
      previousCd = cwd !== undefined;
    } else if (['pushd', 'popd'].includes(call.words[0])) cwd = undefined;
    const assignments = ['export', 'local', 'declare', 'readonly'].includes(call.words[0]) ? call.words.slice(1) : call.words;
    const isolated = call.before === '|' || ['|', '&'].includes(call.after);
    if (!isolated && assignments.every(word => /^[A-Za-z_]\w*=/.test(word))) {
      for (const word of assignments) {
        const equal = word.indexOf('=');
        variables.set(word.slice(0, equal), conditional ? undefined : expandVariables(word.slice(equal + 1), variables));
      }
    } else if (!isolated && call.words[0] === 'unset') for (const name of call.words.slice(1)) variables.delete(name);
    if (call.after === ')') {
      const restored = stack.pop();
      cwd = restored?.cwd; variables = restored?.variables ?? new Map();
    }
    return located;
  });
}
function reader(words: string[], target: string | ((operand: string) => boolean)): boolean {
  const tool = basename(words[0]);
  if (!['cat', 'head', 'tail', 'sed', 'jq'].includes(tool!)) return false;
  let expression = tool === 'sed' || tool === 'jq', options = true;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (options && word === '--') { options = false; continue; }
    if (options && word.startsWith('-')) {
      if (tool === 'jq' && ['--arg', '--argjson', '--slurpfile', '--rawfile'].includes(word)) { i += 2; continue; }
      if (tool === 'jq' && ['--args', '--jsonargs'].includes(word)) return false;
      if ((tool === 'sed' && ['-e', '--expression', '-f', '--file'].includes(word))
        || (tool === 'jq' && ['-f', '--from-file'].includes(word))) { expression = false; i++; }
      else if (['head', 'tail'].includes(tool!) && ['-n', '-c', '--lines', '--bytes'].includes(word)) i++;
      continue;
    }
    if (expression) { expression = false; continue; }
    if (typeof target === 'function' ? target(word) : word === target) return true;
  }
  return false;
}

const rebinds = (words: string[], variable: string) => words[0]?.startsWith(`${variable}=`)
  || ['export', 'local', 'declare', 'readonly', 'unset'].includes(words[0])
    && words.slice(1).some(word => word === variable || word.startsWith(`${variable}=`));

/** A path-producing find pipeline; filters may select lines, not supply another file. */
function findOutput(calls: ReturnType<typeof commands>): boolean {
  if (!calls.length || basename(calls[0].words[0]) !== 'find'
    || calls[0].words.some(word => ['-exec', '-execdir', '-ok', '-okdir', '-printf', '-fprintf',
      '-fprint', '-fprint0', '-ls', '-fls', '-delete', '-print0'].includes(word))) return false;
  return calls.slice(1).every((call, offset) => {
    if (calls[offset].after !== '|' || !['head', 'tail'].includes(basename(call.words[0])!)) return false;
    for (let i = 1; i < call.words.length; i++) {
      if (['-n', '--lines'].includes(call.words[i])) { if (!/^\d+$/.test(call.words[++i] ?? '')) return false; }
      else if (!/^(?:-\d+|-n\d+|--lines=\d+)$/.test(call.words[i])) return false;
    }
    return true;
  });
}

/** JSON-only cat output is sufficient when discovery itself pins this filename
 * beneath a literal ancestor of its fixture-owned path. */
function findBindsFile(calls: ReturnType<typeof commands>, file: string, cwd: string | undefined,
  variables: Map<string, string | undefined>): boolean {
  if (!findOutput(calls)) return false;
  const words = calls[0].words.map(word => expandVariables(word, variables) ?? word);
  const paths = sourcePaths(file);
  const scope = words[1];
  const root = literalPath(scope, cwd, paths), actual = paths.normalize(file);
  if (!root || (words[2] && !words[2].startsWith('-'))) return false;
  if (root === actual) return true;
  if (root === paths.parse(root).root || !actual.startsWith(root.replace(/[\\/]$/, '') + paths.sep)
    || words.some(word => ['-o', '-or', '!', '-not'].includes(word))) return false;
  const filename = paths.basename(file);
  return words.some((word, index) => {
    const pattern = words[index + 1] ?? '';
    if (word === '-name') return pattern === filename;
    if (word !== '-path' || !pattern.includes(filename)) return false;
    const glob = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    // find prints paths in the spelling of its root, including relative roots.
    const discovered = scope.replace(/[\\/]$/, '') + paths.sep + paths.relative(root, actual);
    return new RegExp(`^${glob}$`).test(discovered);
  });
}

function inspectsFile(source: string, file: string, returnedPath: boolean, expected: StartContext): boolean {
  const paths = sourcePaths(file);
  const environment = new Map([['GSTACK_HOME', expected.state], ['SLUG', expected.slug]]);
  const calls = withDirectories(commands(source), paths.normalize(expected.repo), paths, environment);
  if (calls.some(call => reader(call.words, operand => {
    const expanded = expandVariables(operand, call.variables);
    return expanded !== undefined && literalPath(expanded, call.cwd, paths) === file;
  }))) return true;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    for (const index of call.substitutions) {
      const operand = call.words[index];
      const assignment = /^([A-Za-z_]\w*)=\$\(([\s\S]*)\)$/.exec(operand);
      if (index === 0 && call.words.length === 1 && assignment && findOutput(commands(assignment[2]))
        && (returnedPath || findBindsFile(commands(assignment[2]), file, call.cwd, call.variables))) {
        for (const next of calls.slice(i + 1)) {
          if (rebinds(next.words, assignment[1])) break;
          if (reader(next.words, `$${assignment[1]}`) || reader(next.words, `\${${assignment[1]}}`)) return true;
        }
      }
      if (!reader(call.words, operand)) continue;
      const quoted = /^\$\(([\s\S]*)\)$/.exec(operand);
      if (quoted && findOutput(commands(quoted[1]))
        && (returnedPath || findBindsFile(commands(quoted[1]), file, call.cwd, call.variables))) return true;
    }
  }
  if (!returnedPath) return false;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call.words[0] === 'for' && /^[A-Za-z_]\w*$/.test(call.words[1])
      && call.words[2] === 'in' && call.words.length === 4) {
      const pattern = expandVariables(call.words[3], call.variables);
      const match = pattern && /^(.*)[\\/]\*(?:\.json)?$/.exec(pattern);
      if (match && literalPath(match[1], call.cwd, paths) === paths.dirname(file)) {
        for (const next of calls.slice(i + 1)) {
          if (next.words[0] === 'done') break;
          const words = next.words[0] === 'do' ? next.words.slice(1) : next.words;
          if (rebinds(words, call.words[1])) break;
          if (reader(words, `$${call.words[1]}`) || reader(words, `\${${call.words[1]}}`)) return true;
        }
      }
    }
    if (basename(call.words[0]) !== 'find') continue;
    const exec = call.words.indexOf('-exec');
    const action = call.words.slice(exec + 1);
    if (exec >= 0 && reader(action, '{}')) return true;
    if (exec >= 0 && ['sh', 'bash'].includes(basename(action[0])!) && action[1] === '-c') {
      // find -exec sh -c 'cat "$1"' _ {} \; passes each found path as $1.
      const argument = action.indexOf('{}') - 3;
      const script = commands((action[2] ?? '').replaceAll('\0$', '$'));
      if (argument > 0 && !script.some(child => ['set', 'shift'].includes(child.words[0]))
        && script.some(child => reader(child.words, `$${argument}`))) return true;
    }
    if (call.after === '|' && calls[i + 1]?.words[0] === 'while') {
      const header = calls[i + 1].words;
      const variable = header.at(-1)!;
      const executable = header.slice(1).find(word => !/^[A-Za-z_]\w*=/.test(word));
      if (executable !== 'read' || !/^[A-Za-z_]\w*$/.test(variable)) continue;
      for (const next of calls.slice(i + 2)) {
        if (next.words[0] === 'done') break;
        const words = next.words[0] === 'do' ? next.words.slice(1) : next.words;
        if (rebinds(words, variable)) break;
        if (reader(words, `$${variable}`) || reader(words, `\${${variable}}`)) return true;
      }
    }
  }
  return false;
}

/** Inspect native public tool blocks only; narration and instruction contents are not evidence. */
export function hasTrustedReviewStartRead(events: unknown[], expected: StartContext): boolean {
  const pending = new Map<string, { tool: string; input: any; at: number }>();
  const pairs: { tool: string; input: any; at: number; returnedAt: number; text: string }[] = [];
  let position = 0;
  for (const event of events as any[]) {
    for (const block of Array.isArray(event?.message?.content) ? event.message.content : []) {
      position++;
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        pending.set(block.id, { tool: block.name, input: block.input, at: position });
      } else if (event.type === 'user' && block.type === 'tool_result') {
        const call = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (!call || block.is_error === true) continue;
        const text = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.filter((part: any) => part.type === 'text'
            && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
        pairs.push({ ...call, returnedAt: position, text });
      }
    }
  }

  for (const start of pairs) {
    if (start.tool !== 'Bash' || typeof start.input?.command !== 'string'
      || !topLevelCommands(commands(start.input.command)).some(call => {
        if (reviewStart(call.words)) return true;
        if (call.words.length !== 1 || !call.substitutions.includes(0)) return false;
        const assignment = /^[A-Za-z_]\w*=\$\(([\s\S]*)\)$/.exec(call.words[0]);
        const children = assignment ? commands(assignment[1]) : [];
        return children.length === 1 && !children[0].before && !children[0].after && reviewStart(children[0].words);
      })) continue;
    for (const token of start.text.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g) ?? []) {
      // Archived public Linux paths keep their spelling when free tests run on Windows.
      const paths = sourcePaths(expected.directory);
      const file = paths.join(expected.directory, `${token}.json`);
      const finish = pairs.find(pair => pair.at > start.returnedAt && pair.tool === 'Bash'
        && typeof pair.input?.command === 'string'
        // The documented shell variable is valid too: the trusted final row's
        // started_at below binds its resolved value to this observed capture.
        && successfulFinish(pair.input.command, pair.text, token, expected));
      if (!finish) continue;
      for (const read of pairs) {
        const sameCall = read === start;
        if ((!sameCall && read.at <= start.returnedAt) || read.returnedAt >= finish.at) continue;
        const command = typeof read.input?.command === 'string' ? read.input.command : '';
        const directRead = read.tool === 'Read' && typeof read.input?.file_path === 'string'
          && literalPath(read.input.file_path, expected.repo, paths) === file;
        // Discovery may return the path only in stdout; bind its cat invocation
        // to that discovery instead of accepting unrelated reader/find words.
        const shellRead = read.tool === 'Bash' && (sameCall ? sameCallStartRead(command, file, expected, token)
          : inspectsFile(command, file, containsPath(read.text, file), expected));
        if (!directRead && !shellRead) continue;
        for (const line of read.text.split('\n')) {
          // Native Read can prefix the single-line JSON file with a line number.
          const json = line.replace(/^\s*\d+[\t →]+(?=\{)/, '').trim();
          let record: any;
          try { record = JSON.parse(json); } catch { continue; }
          if (sameCall && start.text.indexOf(token) >= start.text.indexOf(line)) continue;
          if (record?.skill === 'review' && record.repo === expected.repo && record.branch === expected.branch
            && record.wtree === expected.wtree && typeof expected.startedAt === 'string'
            && record.started_at === expected.startedAt) return true;
        }
      }
    }
  }
  return false;
}
