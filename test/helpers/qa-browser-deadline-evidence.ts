import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeCalls, readQACheckpointFiles } from './qa-checkpoint-evidence';

type Call = { tool: string; input: any; output: string };
type Options = { directory: string; guard: string; browse: string; started: number; ended: number };

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function qaDeadlineShellPolicy(directory: string, guard: string, browse: string) {
  const setup = fs.readFileSync(path.join(directory, 'qa/sections/browser-setup.md'), 'utf8');
  const readiness = setup.match(/```bash\n(_gs_d\(\)[\s\S]*?)\n```/)?.[1];
  if (!readiness) throw new Error('QA deadline: missing owned readiness block');
  const allowed = [readiness, 'uname -s', 'date -u +%Y-%m-%dT%H:%M:%SZ',
    `[ -x ${quote(browse)} ] && echo READY || echo NEEDS_SETUP`,
    `ls -la ${quote(path.join(directory, 'qa-reports'))}`,
    `git -C ${quote(directory)} status --short`,
    `git -C ${quote(directory)} rev-parse HEAD`,
    `git -C ${quote(directory)} rev-parse --short HEAD`,
    `git -C ${quote(directory)} log -1 --format=%cI`,
    `git -C ${quote(directory)} branch --show-current`];
  const file = path.join(directory, 'qa-reports/deadline.json');
  return { allowed, file, prompt: `This native fixture accepts a deliberately narrow executable outer form. Run the BROWSER SETUP Aside readiness bash block verbatim, as its own Bash call (no appended commands). The fallback binary is already supplied. Other than that block, these standalone setup/bookkeeping Bash calls are allowed:
${allowed.slice(1).join('\n')}
Use Read/Glob for local inspection and Write only inside ${path.join(directory, 'qa-reports')}; the report and screenshots directories already exist. Memory files and learning stores outside that directory are not authorized. Write the initial charters and final report to the same caller-owned file ${path.join(directory, 'qa-reports/qa-only-report.md')}, not a separate charter file.
Every other Bash call must be exactly one invocation of bun ${quote(guard)}, with literal arguments, no outer assignments, substitutions, globs, pipes, redirects, prefixes, suffixes or shell operators. The exact runtime path ${quote(process.execPath)} may replace bun; no other launcher is accepted.
Start exactly once with: bun ${quote(guard)} start ${quote(file)} 30
Then use bun ${quote(guard)} status ${quote(file)} or bun ${quote(guard)} run ${quote(file)} -- COMMAND ARGS. Use the absolute guard path directly, not $G.
For browser scripts, put all assignments, pipelines and scripts INSIDE the child: bun ${quote(guard)} run ${quote(file)} -- bash -c 'B="${browse}"; "$B" goto URL; "$B" snapshot -i'. Literal argv and single/double quoted literal arguments are accepted; expansions are only allowed inside the single-quoted child script.
Do not write, reset, replace, chmod or remove deadline.json, invoke the guard recursively, or print QA_DEADLINE receipts yourself. Browser cleanup also goes inside the guard; after expiry only local report bookkeeping is allowed. Fallback screenshots must be saved directly in the owned screenshots directory; retain them and write the report after expiry without new browser calls. This fixture does not accept a separate post-expiry shell copy from Aside's session directory; mark that artifact unavailable rather than launching new browser work.
An expired refusal is not an executed probe or a pass. Report unfinished coverage honestly; do not try to finish every page after expiry.` };
}

function literalArgv(command: string): string[] {
  const words: string[] = [];
  let rest = command.trim();
  while (rest) {
    const word = /^(?:'[^']*'|"[^"$`\\]*"|[a-zA-Z0-9_./:@%+,=!-])+(?=[ \t]|$)/.exec(rest)?.[0];
    if (!word) throw new Error('QA deadline: unsupported outer shell composition');
    words.push([...word.matchAll(/'([^']*)'|"([^"$`\\]*)"|([a-zA-Z0-9_./:@%+,=!-]+)/g)].map(part => part[1] ?? part[2] ?? part[3]).join(''));
    rest = rest.slice(word.length).replace(/^[ \t]+/, '');
  }
  return words;
}

function owned(file: string, root: string) {
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('QA deadline: artifact outside owned directory');
  let current = resolved;
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('QA deadline: symlinked artifact path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (current === parent) break;
    current = parent;
  }
  return resolved;
}

function browserNativeCalls(transcript: unknown[]) {
  const identities = new Set<string>();
  for (const event of transcript as any[]) {
    if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block?.type === 'tool_use' && ['Write', 'Bash'].includes(block.name)) {
        identities.add(JSON.stringify([event.parent_tool_use_id ?? null, block.id]));
      }
    }
  }
  const relevant = (transcript as any[]).map(event => {
    if (!Array.isArray(event?.message?.content)) return event;
    return { ...event, message: { ...event.message, content: event.message.content.filter((block: any) => {
      if (block?.type === 'tool_use') return ['Write', 'Bash'].includes(block.name);
      return block?.type === 'tool_result' && identities.has(JSON.stringify([event.parent_tool_use_id ?? null, block.tool_use_id]));
    }) } };
  });
  const failures: string[] = [];
  const calls = nativeCalls(relevant, failures);
  if (failures.length) throw new Error('QA preparation: ' + failures.join('; '));
  return calls;
}

export function assertQaBrowserPreparation(transcript: unknown[], options: Pick<Options, 'directory' | 'guard'>) {
  const { directory, guard } = options;
  const reportRoot = path.join(directory, 'qa-reports');
  const report = owned(path.join(reportRoot, 'qa-only-report.md'), reportRoot);
  const state = path.join(reportRoot, 'deadline.json');
  const calls = browserNativeCalls(transcript);
  const firstGuard = calls.find(call => {
    if (call.parent !== null || call.name !== 'Bash' || typeof call.input.command !== 'string') return false;
    let argv: string[];
    try { argv = literalArgv(call.input.command); } catch { return false; }
    return ['bun', process.execPath].includes(argv[0]) && argv[1] === guard
      && ['start', 'run'].includes(argv[2]) && argv[3] === state;
  });
  if (!firstGuard) throw new Error('QA preparation: missing native guard boundary');
  const prepared = calls.some(call => call.parent === null && call.name === 'Write'
    && typeof call.input.file_path === 'string' && path.resolve(directory, call.input.file_path) === report
    && typeof call.input.content === 'string' && call.input.content.trim().length > 0
    && !call.failed && call.end > call.start && call.end < firstGuard.start);
  if (!prepared) throw new Error('QA preparation: owned nonempty report Write must complete before guard start/baseline');
}

export function assertQaBrowserCheckpoints(transcript: unknown[], options: Pick<Options, 'directory' | 'guard'>) {
  const fail = (reason: string): never => { throw new Error('QA checkpoint: ' + reason); };
  const root = path.join(options.directory, 'qa-reports');
  const files = readQACheckpointFiles(root);
  const calls = browserNativeCalls(transcript);
  const runs = calls.filter(call => {
    if (call.parent !== null || call.name !== 'Bash' || typeof call.input.command !== 'string') return false;
    let argv: string[];
    try { argv = literalArgv(call.input.command); } catch { return false; }
    return ['bun', process.execPath].includes(argv[0]) && argv[1] === options.guard
      && argv[2] === 'run' && argv[3] === path.join(root, 'deadline.json');
  });
  const notes: Array<{ call: (typeof calls)[number]; value: any }> = [];
  const written = new Set<string>();
  for (const call of calls) {
    if (call.name !== 'Write' || typeof call.input.file_path !== 'string') continue;
    const target = path.resolve(options.directory, call.input.file_path);
    const name = path.basename(target);
    if (!/^exploration-\d{3}\.json$/.test(name)) continue;
    if (call.parent !== null || path.dirname(target) !== root || call.failed || call.end <= call.start
      || written.has(name) || typeof call.input.content !== 'string' || files[name] !== call.input.content) fail('unbound or rewritten checkpoint');
    written.add(name);
    let value: any;
    try { value = JSON.parse(call.input.content); } catch { fail('invalid checkpoint JSON'); }
    if (!value || Array.isArray(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['hypothesis', 'nextCommand', 'observationCommand', 'observed'])
      || typeof value.hypothesis !== 'string' || !value.hypothesis.trim() || typeof value.nextCommand !== 'string' || !value.nextCommand.trim()) fail('invalid checkpoint fields');
    const previous = runs.filter(run => run.end < call.start).at(-1);
    if (!previous || value.observationCommand !== previous.input.command) fail('observation does not name the last completed probe');
    const lines = previous.output.split('\n');
    const receipts = lines.flatMap((line, index) => {
      if (!line.startsWith('QA_DEADLINE ')) return [];
      try { return [{ index, value: JSON.parse(line.slice('QA_DEADLINE '.length)) }]; } catch { return fail('invalid guard receipt'); }
    });
    if (receipts.length !== 2 || receipts[0].value.event !== 'started' || receipts[1].value.event !== 'finished') fail('refused or incomplete probe is not an observation');
    const text = lines.slice(receipts[0].index + 1, receipts[1].index).join('\n');
    let observed: unknown = text;
    try { observed = JSON.parse(text); } catch {}
    if (!isDeepStrictEqual(value.observed, observed)) fail('observation differs from the verbatim child result');
    notes.push({ call, value });
  }
  if (written.size !== Object.keys(files).length) fail('checkpoint lacks an acknowledged Write');
  for (const [index, run] of runs.entries()) {
    if (index === 0) continue;
    const previous = runs[index - 1];
    const matches = notes.filter(note => note.call.start > previous.end && note.call.end < run.start
      && note.value.nextCommand === run.input.command);
    if (matches.length !== 1) fail('follow-up lacks one acknowledged preceding checkpoint');
  }
}

export function assertQaBrowserDeadline(calls: Call[], options: Options & { expectedBudgetMs?: number }) {
  const fail = (reason: string): never => { throw new Error('QA deadline: ' + reason); };
  const { directory, guard, browse, started, ended, expectedBudgetMs = 30000 } = options;
  if (!Number.isSafeInteger(expectedBudgetMs) || expectedBudgetMs <= 0 || expectedBudgetMs > 2_147_483_647) fail('invalid expected deadline budget');
  const { file, allowed } = qaDeadlineShellPolicy(directory, guard, browse);
  const reportRoot = path.join(directory, 'qa-reports');
  owned(file, reportRoot);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o400)) fail('state is not immutable native state');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const timestamp = (value: unknown) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail('invalid receipt time');
    return Date.parse(value);
  };
  if (Object.keys(state).sort().join(',') !== 'budgetMs,deadlineAt,startedAt,version' || state.version !== 1 || state.budgetMs !== expectedBudgetMs
    || timestamp(state.deadlineAt) !== timestamp(state.startedAt) + expectedBudgetMs
    || timestamp(state.startedAt) < started || timestamp(state.startedAt) > ended) fail(`state is not this attempt’s expected ${expectedBudgetMs}ms deadline`);
  let starts = 0, launches = 0, completed = 0, refused = 0, timedOut = 0, browserAttempts = 0, observed = timestamp(state.startedAt);
  const checkStatus = (receipt: any) => {
    if (Object.keys(receipt).sort().join(',') !== 'budgetMs,deadlineAt,event,expired,guard,observedAt,remainingMs,startedAt,version') fail('unexpected status receipt schema');
    for (const key of ['version', 'startedAt', 'deadlineAt', 'budgetMs']) if (receipt[key] !== state[key]) fail('state reset or forged receipt');
    const time = timestamp(receipt.observedAt);
    if (time < observed || time > ended) fail('receipt time outside ordered attempt');
    observed = time;
    const remaining = Math.max(0, timestamp(state.deadlineAt) - time);
    if (receipt.remainingMs !== remaining || receipt.expired !== (remaining === 0)) fail('inconsistent remaining budget');
  };
  for (const call of calls) {
    if (call.tool === 'Edit') fail('Edit is forbidden');
    if (call.tool === 'Write') {
      if (typeof call.input?.file_path !== 'string') fail('missing artifact path');
      const target = owned(path.resolve(directory, call.input.file_path), reportRoot);
      if (target === file || target.startsWith(file + path.sep)) fail('reserved deadline path write');
      continue;
    }
    if (['Read', 'Glob'].includes(call.tool)) continue;
    if (call.tool !== 'Bash' || typeof call.input?.command !== 'string') fail('unsupported tool');
    const command = call.input.command.trim();
    if (allowed.includes(command)) {
      if ((call.output ?? '').includes('QA_DEADLINE ')) fail('receipt outside trusted guard invocation');
      continue;
    }
    const outer = literalArgv(command);
    if (!['bun', process.execPath].includes(outer[0])) fail('untrusted runtime or unguarded command');
    const argv = outer.slice(1);
    if (argv[0] !== guard || argv[2] !== file) fail('unguarded command or untrusted guard/state path');
    const receipts = (call.output ?? '').split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(line => {
      try { return JSON.parse(line.slice('QA_DEADLINE '.length)); } catch { return fail('malformed receipt'); }
    });
    if (receipts.some(receipt => receipt.guard !== 'qa-deadline')) fail('untrusted receipt');
    if (argv[1] === 'start') {
      if (++starts !== 1 || argv.length !== 4 || argv[3] !== String(expectedBudgetMs / 1000) || receipts.length !== 1 || receipts[0].event !== 'start') fail('missing or repeated native start');
      checkStatus(receipts[0]);
      if (stat.mtimeMs >= observed + 1 || stat.ctimeMs >= observed + 1 || stat.birthtimeMs >= observed + 1) fail('state changed after native start');
      continue;
    }
    if (starts !== 1) fail('guard used before native start');
    if (argv[1] === 'status') {
      if (argv.length !== 3 || receipts.length !== 1 || receipts[0].event !== 'status') fail('missing status receipt');
      checkStatus(receipts[0]);
      continue;
    }
    if (argv[1] !== 'run' || argv[3] !== '--' || argv.length < 5) fail('unsupported guard invocation');
    if (argv.slice(4).some(arg => arg.includes('deadline.json') || arg.includes('QA_DEADLINE') || arg.includes('gstack-qa-deadline'))) fail('child touches reserved deadline evidence');
    const browser = argv[4] === browse || argv[4] === 'aside'
      || (['bash', '/bin/bash'].includes(argv[4]) && argv[5] === '-c' && argv.length === 7
        && (argv[6].includes(browse) || /\baside\s+(?:repl|exec)\b/.test(argv[6])));
    if (browser) browserAttempts++;
    if (receipts.length === 1 && receipts[0].event === 'expired') {
      checkStatus(receipts[0]);
      if (!receipts[0].expired) fail('premature refusal');
      refused++;
      continue;
    }
    if (receipts.length !== 2 || receipts[0].event !== 'started' || receipts[1].event !== 'finished') fail('missing launch/completion receipts');
    checkStatus(receipts[0]);
    if (receipts[0].expired) fail('late launch');
    launches++;
    const finish = receipts[1], time = timestamp(finish.observedAt);
    if (Object.keys(finish).sort().join(',') !== 'deadlineAt,event,exitCode,guard,observedAt,timedOut'
      || finish.deadlineAt !== state.deadlineAt || time < observed || time > ended || !Number.isInteger(finish.exitCode)
      || typeof finish.timedOut !== 'boolean' || (finish.timedOut && finish.exitCode !== 124)
      || (finish.timedOut && time < timestamp(state.deadlineAt))
      || (time >= timestamp(state.deadlineAt) && !finish.timedOut)) fail('inconsistent completion receipt');
    observed = time;
    if (finish.timedOut) timedOut++;
    else if (finish.exitCode === 0) completed++;
  }
  if (starts !== 1 || launches + refused === 0 || browserAttempts === 0) fail('missing guarded browser attempt');
  return { launchedRuns: launches, completedRuns: completed, refusedRuns: refused, timedOutRuns: timedOut };
}
