import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRemoteUrl } from '../ship-queue-train-record';

export interface WorkflowStep { uses?: string; run?: string; name?: string; with?: Record<string, unknown> }
export interface WorkflowJob { id: string; runsOn: string; matrixSize: number; needs: string[]; steps: WorkflowStep[] }
export interface Workflow { file: string; name: string; prTrigger: boolean; prPathFilter: boolean; schedule: boolean; pushDefault: boolean; jobs: WorkflowJob[]; text: string; unreadable?: string }
export interface HookInfo { manager: string; file: string; runs: string[] }

export interface StaticView {
  root: string;
  head: string;
  dirty: boolean;
  workflows: Workflow[];
  packageScripts: Record<string, string>;
  deps: string[];
  files: string[];
  hook: HookInfo | null;
  testFilesMentioning: (pattern: RegExp) => string[];
}

const MAX_YAML_BYTES = 512 * 1024;
const MAX_ANCHORS = 50;

function git(root: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The repo slug behind a checkout's origin, normalized so a proxy or SSH form of the same GitHub repo matches. */
export function originSlug(root: string): string | null {
  const url = git(root, ['remote', 'get-url', 'origin']);
  if (!url) return null;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(normalizeRemoteUrl(url));
  return m ? m[1]! : null;
}

function asList(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]; }

function matrixSize(strategy: any): number {
  const m = strategy?.matrix;
  if (!m || typeof m !== 'object') return 1;
  let size = 1;
  for (const [k, v] of Object.entries(m)) if (k !== 'include' && k !== 'exclude' && Array.isArray(v)) size *= v.length;
  return size + (Array.isArray(m.include) && size === 1 ? m.include.length - 1 : 0);
}

export function parseWorkflow(file: string, text: string, defaultBranch: string): Workflow {
  const base: Workflow = { file, name: path.basename(file), prTrigger: false, prPathFilter: false, schedule: false, pushDefault: false, jobs: [], text };
  if (text.length > MAX_YAML_BYTES) return { ...base, unreadable: 'larger than 512 KB' };
  if ((text.match(/(^|\s)[&*][A-Za-z0-9_-]+/g) ?? []).length > MAX_ANCHORS) return { ...base, unreadable: 'too many YAML anchors' };
  let doc: any;
  try { doc = Bun.YAML.parse(text); } catch (e) { return { ...base, unreadable: `YAML parse failed: ${(e as Error).message.split('\n')[0]}` }; }
  if (!doc || typeof doc !== 'object') return { ...base, unreadable: 'not a mapping' };
  const on = doc.on ?? doc[true as any];
  const triggers: Record<string, any> = typeof on === 'string' ? { [on]: {} } : Array.isArray(on) ? Object.fromEntries(on.map((t: string) => [t, {}])) : (on ?? {});
  const pr = triggers.pull_request ?? triggers.pull_request_target;
  const push = triggers.push;
  const jobs = Object.entries<any>(doc.jobs ?? {}).map(([id, j]) => ({
    id, runsOn: Array.isArray(j?.['runs-on']) ? j['runs-on'].join(',') : String(j?.['runs-on'] ?? (j?.uses ? '(reusable workflow)' : '')),
    matrixSize: matrixSize(j?.strategy), needs: asList(j?.needs),
    steps: (Array.isArray(j?.steps) ? j.steps : []).map((s: any) => ({ uses: s?.uses, run: typeof s?.run === 'string' ? s.run : undefined, name: s?.name, with: s?.with })),
  }));
  return {
    ...base, name: String(doc.name ?? base.name),
    prTrigger: pr !== undefined, prPathFilter: Boolean(pr && (pr.paths || pr['paths-ignore'])),
    schedule: triggers.schedule !== undefined,
    pushDefault: push !== undefined && (!push?.branches || asList(push.branches).some(b => b === defaultBranch || b === '**' || b === '*')),
    jobs,
  };
}

function readHook(root: string): HookInfo | null {
  const hooksPath = git(root, ['config', '--get', 'core.hooksPath']);
  const candidates: [string, string][] = [
    ...(hooksPath ? [[ 'core.hooksPath', path.join(root, hooksPath, 'pre-push') ] as [string, string]] : []),
    ['husky', path.join(root, '.husky', 'pre-push')],
    ['lefthook', path.join(root, 'lefthook.yml')],
    ['git', path.join(git(root, ['rev-parse', '--git-path', 'hooks']) ? path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks'])!) : path.join(root, '.git', 'hooks'), 'pre-push')],
  ];
  for (const [manager, file] of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (manager === 'lefthook' && !/pre-push:/.test(text)) continue;
    const runs = ['lint', 'typecheck', 'format', 'test'].filter(k => new RegExp(k === 'typecheck' ? 'typecheck|tsc|tsgo|type-check' : k, 'i').test(text));
    return { manager, file: path.relative(root, file), runs };
  }
  return null;
}

export function readStatic(root: string, defaultBranch: string): StaticView {
  const files = (git(root, ['ls-files']) ?? '').split('\n').filter(Boolean);
  const wfFiles = files.filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const workflows = wfFiles.map(f => parseWorkflow(f, fs.readFileSync(path.join(root, f), 'utf8'), defaultBranch));
  let pkg: any = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  const testFiles = files.filter(f => /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/.test(f));
  return {
    root, head: git(root, ['rev-parse', 'HEAD']) ?? 'unknown', dirty: Boolean(git(root, ['status', '--porcelain'])),
    workflows, packageScripts: pkg.scripts ?? {}, deps: Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }),
    files, hook: readHook(root),
    testFilesMentioning: (pattern: RegExp) => testFiles.filter(f => { try { return pattern.test(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return false; } }),
  };
}
