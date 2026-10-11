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
  /** Test file paths named literally in the run steps. */
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

const TEST_COMMAND = /\b(?:bun test|bun run test\b|bun run test:|npm test|npm run test\b|pnpm test|yarn test|pytest|go test|cargo test|rspec|bin\/test-lane|node --test|vitest|jest|test-(?:free|paid)-shards\.ts(?![^\n]*--(?:ci-verify|ci-plan|list)\b))\b/;
const TEST_FILE = /(?<![\w/])((?:[\w.-]+\/)*(?:test|tests|spec|__tests__)\/[\w./-]*\.(?:test|spec)\.[a-z]+|(?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?![\w/])/g;

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
    const m = /^([^:#]+?):(?:\s+(.*))?$/.exec(body);
    const key = m ? m[1]!.trim() : body;
    let value = m ? (m[2] ?? '').trim() : '';
    if (/^[|>][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || indentOf(lines[i + 1]!) > indent)) { i++; parts.push(lines[i]!.trim()); }
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
    const testFiles = [...new Set(commands.flatMap(c => [...c.matchAll(TEST_FILE)].map(m => m[1]!)))];
    let tier: LaneTier = 'unit';
    if (jobPlatform !== 'any' && jobPlatform !== here) tier = 'platform';
    else if (/\b(e2e|evals?)\b/i.test(`${name} ${job.key} ${jobName}`)) tier = 'e2e';
    else if (maxParallel === '1' || /serial/i.test(`${job.key} ${jobName}`)) tier = 'serial';
    return {
      id: `${file}/${job.key}`, workflow: file, workflowName: name, job: job.key, jobName, runsOn, platform: jobPlatform, commands, testFiles,
      matrixExpression, tier, runsTests: commands.some(c => TEST_COMMAND.test(c)), manual, source: `.github/workflows/${file}:${job.line}`,
    };
  });
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
