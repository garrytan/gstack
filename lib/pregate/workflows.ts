/**
 * pregate/workflows — the lane list and platform tiers, read from the repo's
 * own `.github/workflows/*.yml` (plan C8): never a pre-gate-owned taxonomy,
 * so a changed CI matrix changes the pre-gate. The platform of a job comes
 * from `runs-on` through the same `laneOf` the doctor's project-pins row uses
 * (lib/runtime-pins.ts). A job whose `matrix:` is a workflow expression
 * (`${{ fromJSON(...) }}`) is planner-computed: its file list comes from the
 * runner-owned selection manifest `.gstack/pregate.json` declares for it, or
 * it is reported as an unsupported expression and treated conservatively.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneOf, type Lane as Platform } from '../runtime-pins';

export type LaneTier = 'unit' | 'serial' | 'e2e' | 'platform';

export interface Lane {
  /** `<workflow file>/<job id>`. */
  id: string;
  workflow: string;
  workflowName: string;
  job: string;
  jobName: string;
  runsOn: string;
  platform: Platform;
  /** Every `run:` step text, in order. */
  commands: string[];
  /** Test file paths named literally in the run steps, repo-relative: resolved against the step's working-directory and any literal `cd`/`pushd` before them; empty when one is named from an unresolvable directory (the lane may run any test). */
  testFiles: string[];
  /** The `matrix:` value when it is a workflow expression, else null. */
  matrixExpression: string | null;
  tier: LaneTier;
  /** True when a run step looks like a test command. */
  runsTests: boolean;
  /** True when the job's `if:` keys on a workflow_dispatch input: not a gate, never an obligation. */
  manual: boolean;
  source: string;
}

const TEST_COMMAND = /\b(?:bun test|bun run test\b|bun run test:|npm test|npm run test\b|pnpm test|yarn test|pytest|go test|cargo test|flutter test|dart test|dart run test|melos (?:run )?test|very_good test|rspec|bin\/test-lane|node --test|vitest|jest|test-(?:free|paid)-shards\.ts(?![^\n]*--(?:ci-verify|ci-plan|list)\b))\b/;
const TEST_FILE = /(?<![\w/])((?:[\w.-]+\/)*(?:test|tests|spec|__tests__)\/[\w./-]*\.(?:test|spec)\.[a-z]+|(?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?|(?:[\w.-]+\/)*test\/(?:[\w.-]+\/)*[\w.-]+_test\.dart)(?![\w/])/g;

function indentOf(line: string): number { return line.length - line.trimStart().length; }

interface Block { key: string; value: string; indent: number; line: number; children: Block[] }

/** A minimal YAML outline: key/value pairs and list items by indentation; block scalars (`|`, `>`) are joined into the value. */
function outline(text: string): Block[] {
  const lines = text.split('\n');
  const root: Block[] = [];
  const stack: Array<{ indent: number; children: Block[] }> = [{ indent: -1, children: root }];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = indentOf(raw);
    const body = raw.trim().replace(/^-\s+/, '');
    // A list item's key sits past its `- `: a block scalar ends at a line not indented past that key (a sibling step key).
    const keyColumn = indent + raw.trim().length - body.length;
    const m = /^([^:#]+?):(?:\s+(.*))?$/.exec(body);
    const key = m ? m[1]!.trim() : body;
    let value = m ? (m[2] ?? '').trim() : '';
    if (/^[|>][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || indentOf(lines[i + 1]!) > keyColumn)) { i++; parts.push(lines[i]!.trim()); }
      value = parts.filter(Boolean).join('\n');
    }
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const block: Block = { key, value, indent, line: i + 1, children: [] };
    stack[stack.length - 1]!.children.push(block);
    stack.push({ indent, children: block.children });
  }
  return root;
}

function find(blocks: Block[], key: string): Block | undefined { return blocks.find(b => b.key === key); }
/** `defaults: run: working-directory:` under `parent`, or null. */
function defaultDir(parent: Block[]): string | null {
  return find(find(find(parent, 'defaults')?.children ?? [], 'run')?.children ?? [], 'working-directory')?.value ?? null;
}
/** A step's working directory, repo-relative (`''` for the root), or null when it cannot be resolved: an expression, absolute, or escaping `..`. */
function resolveDir(dir: string | null): string | null {
  const d = (dir ?? '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  if (!d) return '';
  if (/\$\{\{/.test(d) || path.posix.isAbsolute(d)) return null;
  const n = path.posix.normalize(d).replace(/\/$/, '');
  return n === '.' ? '' : n === '..' || n.startsWith('../') ? null : n;
}
/** `cur` after a `cd`/`pushd` segment: its first word (a redirect or comment after it is ignored), when a literal relative path, joins it; a non-literal, absolute, bare or repo-escaping target (or an unknown `cur`) is null. */
function changeDir(cur: string | null, target: string | undefined): string | null {
  const t = (/^\s*(?:(['"])(.*?)\1|([^\s'"]+))(?=\s|$)/.exec(target ?? '') ?? []).slice(2).find(x => x !== undefined) ?? '';
  if (cur === null || !t || /[$`~*?[\]{}'"\\\s]/.test(t) || t.startsWith('-') || path.posix.isAbsolute(t)) return null;
  const n = path.posix.normalize(path.posix.join(cur, t)).replace(/\/$/, '');
  return n === '.' ? '' : n === '..' || n.startsWith('../') ? null : n;
}
/**
 * The repo-relative test paths one run command names, walking its shell segments (split on `&&`, `||`, `;`, `|`, newlines) from
 * `start` (null: unknown). `cd`/`pushd <literal>` moves the directory; any other directory change (`popd`, `cd "$X"`, a `cd` not
 * leading its segment) makes it unknown for the rest of the command. A segment's paths resolve against the directory current at
 * it; a path named while it is unknown, or escaping the repo, returns null (the lane may run any test). The package.json script a
 * segment runs (one level deep, as expandScripts) is walked from the root when the segment runs there, else from an unknown directory (npm runs the nearest package.json's script). A `( … )` subshell's directory changes end at its `)`.
 */
function commandTestFiles(command: string, start: string | null, scripts: Record<string, string> | null): string[] | null {
  let cur = start;
  const out: string[] = [];
  const saved: Array<string | null> = [];
  const segments = command.split(/&&|\|\||[;|\n]/);
  // A pipeline element, a `||` alternative, a background job, a command substitution, shell control flow, or a `)` with text after
  // it (a redirect) runs a `cd` in a scope or order this walk cannot track, so in such a command any directory change makes the
  // directory unknown (the lane may run any test).
  const untracked = /\||(?<!&)&(?!&)|`|\$\(|[{}]|\b(?:if|then|else|elif|case|while|until|for|select|function)\b/.test(command) || segments.some(seg => /\)/.test(seg.replace(/\)+\s*$/, '')));
  for (const raw of segments) {
    // A `( … )` subshell's cds end at its `)`.
    const opens = /^\s*(\(+)/.exec(raw)?.[1]!.length ?? 0;
    for (let i = 0; i < opens; i++) saved.push(cur);
    const seg = raw.replace(/^\s*\(+/, '');
    for (const m of seg.matchAll(TEST_FILE)) {
      const joined = cur === null ? null : path.posix.normalize(path.posix.join(cur, m[1]!)).replace(/^\.\//, '');
      if (joined === null || joined.startsWith('../')) return null;
      out.push(joined);
    }
    if (scripts) {
      for (const m of seg.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_.-]+)/g)) {
        if (!scripts[m[1]!]) continue;
        // npm runs the nearest package.json's script; only from the root is that known to be the root's.
        const inner = commandTestFiles(scripts[m[1]!]!, cur === '' ? '' : null, null);
        if (inner === null) return null;
        out.push(...inner);
      }
    }
    const cd = /^\s*(?:cd|pushd)(?:\s+(.*))?$/.exec(seg);
    if (cd) cur = untracked ? null : changeDir(cur, cd[1]);
    else if (/(?:^|[\s(){}])(?:cd|pushd|popd)(?=\s|$)/.test(seg)) cur = null;
    for (let closes = (/(\)+)\s*$/.exec(seg)?.[1]!.length ?? 0); closes > 0 && saved.length; closes--) { const outer = saved.pop()!; if (!untracked) cur = outer; }
  }
  return out;
}
function deepValues(blocks: Block[], key: string, out: string[] = []): string[] {
  for (const b of blocks) { if (b.key === key && b.value) out.push(b.value); deepValues(b.children, key, out); }
  return out;
}

/** `bun run x`, `npm run x`, `pnpm x`, `yarn x` → the package.json script text, one level deep, appended so its test files count. */
export function expandScripts(commands: string[], scripts: Record<string, string>): string[] {
  return commands.map(c => {
    const extra: string[] = [];
    for (const m of c.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_.-]+)/g)) if (scripts[m[1]!]) extra.push(scripts[m[1]!]!);
    return extra.length ? `${c}\n${extra.join('\n')}` : c;
  });
}

export function parseWorkflow(file: string, text: string, platform: NodeJS.Platform = process.platform, scripts: Record<string, string> = {}): Lane[] {
  const top = outline(text);
  const name = find(top, 'name')?.value ?? file;
  const jobs = find(top, 'jobs')?.children ?? [];
  const here = laneOf(platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux');
  return jobs.map(job => {
    const runsOn = find(job.children, 'runs-on')?.value ?? '';
    const condition = find(job.children, 'if')?.value ?? '';
    const manual = /inputs\.|workflow_dispatch/.test(condition);
    const commands = expandScripts(deepValues(find(job.children, 'steps')?.children ?? [], 'run'), scripts);
    const matrix = find(find(job.children, 'strategy')?.children ?? [], 'matrix');
    const matrixExpression = matrix && /\$\{\{/.test(matrix.value) ? matrix.value : null;
    const maxParallel = find(find(job.children, 'strategy')?.children ?? [], 'max-parallel')?.value;
    const jobPlatform = laneOf(runsOn);
    const jobName = find(job.children, 'name')?.value ?? job.key;
    // A step's paths resolve against its working-directory, else the job's defaults, else the workflow's.
    const jobDir = defaultDir(job.children) ?? defaultDir(top);
    // Each run command is walked from the step's directory through its `cd`s (commandTestFiles). A test path named from an
    // unresolvable directory leaves the lane's set unknown (empty: laneFileSet's may-run-anything path).
    let unresolved = false;
    const testFiles = [...new Set((find(job.children, 'steps')?.children ?? []).flatMap(step => {
      const dir = resolveDir(find([step, ...step.children], 'working-directory')?.value ?? jobDir);
      return deepValues([step], 'run').flatMap(c => commandTestFiles(c, dir, scripts) ?? (unresolved = true, []));
    }))];
    let tier: LaneTier = 'unit';
    if (jobPlatform !== 'any' && jobPlatform !== here) tier = 'platform';
    else if (/\b(e2e|evals?)\b/i.test(`${name} ${job.key} ${jobName}`)) tier = 'e2e';
    else if (maxParallel === '1' || /serial/i.test(`${job.key} ${jobName}`)) tier = 'serial';
    return {
      id: `${file}/${job.key}`, workflow: file, workflowName: name, job: job.key, jobName, runsOn, platform: jobPlatform, commands, testFiles: unresolved ? [] : testFiles,
      matrixExpression, tier, runsTests: commands.some(c => TEST_COMMAND.test(c)), manual, source: `.github/workflows/${file}:${job.line}`,
    };
  });
}

/** A workflow's `on:` trigger names, from `on: x`, `on: [x, y]`, `on: { x: {}, y: {} }` or its keys and list items. */
function triggers(top: Block[]): string[] {
  const on = top.find(b => /^['"]?on['"]?$/.test(b.key));
  if (!on) return [];
  return [...on.value.replace(/\s+#.*$/, '').split(/[\s,[\]{}:]+/), ...on.children.map(c => c.key)].map(s => s.trim()).filter(Boolean);
}

/** A `name:` or `uses:` value without its trailing comment and quotes. */
function scalar(value: string): string { return value.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, ''); }

/**
 * `workflow`'s workflow_dispatch trigger, the display name of its job `job`, and the workflow files with a job that calls it as
 * a local reusable workflow (`uses: ./.github/workflows/<workflow>`), each with its own workflow_dispatch trigger and the display
 * names of its calling jobs, all read from git `tree` (pregate.json's recorded tree), never the working tree. A workflow_call
 * run reports its caller's file and its jobs as `<calling job> / <job>`, so a caller's run is a run of the lane (GST-971).
 * Display names keep `${{ … }}` expressions as written; an unreadable tree or file has no trigger and no callers.
 */
export function workflowCallers(repoRoot: string, tree: string, workflow: string, job: string): { dispatch: boolean; jobName: string; callers: Array<{ file: string; dispatch: boolean; jobs: string[] }> } {
  const git = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const ls = git(['ls-tree', '--name-only', `${tree}:.github/workflows`]);
  const names = ls.status === 0 ? ls.stdout.split('\n').filter(n => /\.ya?ml$/.test(n)).sort() : [];
  const want = `./.github/workflows/${workflow}`;
  let dispatch = false;
  let jobName = job;
  const callers: Array<{ file: string; dispatch: boolean; jobs: string[] }> = [];
  for (const n of names) {
    const show = git(['show', `${tree}:.github/workflows/${n}`]);
    if (show.status !== 0) continue;
    const top = outline(show.stdout);
    const jobs = find(top, 'jobs')?.children ?? [];
    const canDispatch = triggers(top).includes('workflow_dispatch');
    if (n === workflow) {
      dispatch = canDispatch;
      const own = find(jobs, job);
      jobName = own ? scalar(find(own.children, 'name')?.value ?? '') || job : job;
      continue;
    }
    const calling = jobs.filter(j => scalar(find(j.children, 'uses')?.value ?? '') === want).map(j => scalar(find(j.children, 'name')?.value ?? '') || j.key);
    if (calling.length) callers.push({ file: n, dispatch: canDispatch, jobs: calling });
  }
  return { dispatch, jobName, callers };
}

/** A regex source matching a display name GitHub renders from `name`: each `${{ … }}` expression matches any text without ` / `. */
export function displayNamePattern(name: string): string {
  return name.split(/\$\{\{.*?\}\}/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:(?! / ).)+?');
}

/** Every job of every workflow, in file order. */
export function discoverLanes(repoRoot: string, platform: NodeJS.Platform = process.platform): Lane[] {
  const dir = path.join(repoRoot, '.github', 'workflows');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort(); } catch { return []; }
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* no package scripts */ }
  return names.flatMap(n => { try { return parseWorkflow(n, fs.readFileSync(path.join(dir, n), 'utf8'), platform, scripts); } catch { return []; } });
}

/** One `--explain` line per lane. */
export function describeLane(l: Lane): string {
  const matrix = l.matrixExpression ? ` matrix=${JSON.stringify(l.matrixExpression)}` : '';
  return `${l.id}: tier=${l.tier} platform=${l.platform} runs-on=${l.runsOn || '?'} tests=${l.runsTests ? 'yes' : 'no'}${l.manual ? ' manual' : ''}${matrix}${l.testFiles.length ? ` files=${l.testFiles.join(',')}` : ''} (${l.source})`;
}
