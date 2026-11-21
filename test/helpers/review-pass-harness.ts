/** Shared fixtures for the review-pass tests: the manifest builder, a feature-branch repository, a fake Capy host whose shell is real, and the pass program runner. */
import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sectionTexts } from '../../lib/review-brief';
import { buildManifest, markReader, type Manifest } from '../../lib/review-pass';
import type { Dispatch } from '../../lib/review-depth';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const BIN = path.join(ROOT, 'bin');
export const texts = sectionTexts(ROOT);
export const SHA = 'a'.repeat(40);
export const spec = (name: string, exclude: string[] = []): Dispatch => ({ role: 'specialist', name, effort: 'full', exclude });

export function tmp(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
export function manifest(dispatches: Dispatch[], o: Partial<Parameters<typeof buildManifest>[0]> = {}): Manifest {
  const out = tmp('rp-out-');
  const root = tmp('rp-root-');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return buildManifest({ pass: 'p1', out, ledger: path.join(out, 'ledger.jsonl'), base: 'main', diffBase: SHA, root, checklistRoot: ROOT, dispatches, next: 'full', planLines: [], ...o });
}
export const collectAll = (m: Manifest, stage: string) => { for (const r of m.readers.filter(x => x.stage === stage)) { markReader(m, r.reader, 'intent'); markReader(m, r.reader, 'created', { path: '9' }); markReader(m, r.reader, 'collected'); } };

export function writeManifestFile(m: Manifest): string {
  const f = path.join(m.out, 'pass-manifest.json');
  fs.writeFileSync(f, JSON.stringify(m));
  return f;
}

/** A repository on a feature branch with enough runtime lines for a full plan. */
/** A checkout whose history shares no commit with repo()'s, standing in for a project's default checkout of another repository. */
export function unrelated(env: NodeJS.ProcessEnv): string {
  const dir = fs.realpathSync(tmp('rp-other-'));
  const r = spawnSync('bash', ['-c', 'git init -q -b main && echo other > o.txt && git add -A && git commit -qm other'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return dir;
}

export function repo(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmp('rp-repo-');
  const env = { ...process.env, PATH: BIN + path.delimiter + process.env.PATH, GSTACK_STATE_ROOT: path.join(dir, '.state'), GSTACK_SWEEP_ROOTS: dir, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); };
  sh("git init -q -b main && echo '{}' > package.json && mkdir -p src && echo 'export const a = 1;' > src/a.ts && echo .state > .gitignore && git add -A && git commit -qm base && git checkout -qb feat");
  sh('for i in $(seq 1 80); do echo "export const v$i = $i;" >> src/a.ts; done && git commit -qam feat');
  return { dir, env };
}

export interface Sub { title: string; prompt: string; status: string; polls: number; model?: unknown; summary?: string; late?: boolean; error?: string }
/** A fake Capy host: the shell is real (the repository's bins), subagents are scripted. */
export const cleanReply = (title: string) => (title.endsWith('outside-voice') ? 'Recommendation: ship as-is because no finding survived' : 'NO FINDINGS');
/** The REVIEWED_TREE line a reader prints from dir (its brief's checkout when it follows the workspace paragraph); '' outside a checkout. */
export function treeLine(dir: string): string {
  if (!dir) return '';
  const git = (a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 30_000 });
  const tree = git(['rev-parse', 'HEAD^{tree}']), top = git(['rev-parse', '--show-toplevel']);
  return tree.status === 0 && top.status === 0 ? `REVIEWED_TREE: ${tree.stdout.trim()} ${top.stdout.trim()}\n` : '';
}
export const briefDir = (prompt: string) => /Workspace: the checkout under review is (.+?)\. Your shell and file tools/.exec(prompt)?.[1] ?? '';
export function host(dir: string, env: NodeJS.ProcessEnv, o: { output?: (title: string) => string; reportFrom?: (title: string) => string; fail?: (title: string) => boolean; reject?: (title: string) => boolean; createThrows?: (title: string) => 'before' | 'after' | undefined; pollsToFinish?: number; lateSummary?: boolean; hang?: (title: string) => boolean; stopped?: (title: string) => boolean; keepSummary?: boolean; epoch?: number; error?: (title: string) => string | undefined } = {}) {
  let clock = 0;
  const subs = new Map<string, Sub>();
  const creates: Sub[] = [];
  const starts: number[][] = [];
  const stops: string[] = [];
  const reply = (s: Sub) => treeLine(o.reportFrom?.(s.title) ?? briefDir(s.prompt)) + (o.output?.(s.title) ?? cleanReply(s.title));
  const advance = () => {
    for (const s of subs.values()) {
      if (s.late && !s.summary) { s.summary = reply(s); continue; }
      if (s.status !== 'working' || o.hang?.(s.title)) continue;
      if (++s.polls < (o.pollsToFinish ?? 1)) continue;
      if (o.error?.(s.title)) { s.status = 'failed'; s.error = o.error(s.title); if (o.keepSummary) s.summary = reply(s); }
      else if (o.stopped?.(s.title)) { s.status = 'stopped'; if (o.keepSummary) s.summary = reply(s); }
      else if (o.fail?.(s.title)) { s.status = 'failed'; if (o.keepSummary) s.summary = reply(s); }
      else if (o.lateSummary && !s.late) { s.status = 'done'; s.late = true; }
      else { s.status = 'done'; s.summary = reply(s); }
    }
  };
  const tools = {
    capy: {
      bash: async ({ command }: { command: string }) => {
        const r = spawnSync('bash', ['-c', command], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        return { exit_code: r.status ?? 1, output: (r.stdout ?? '') + (r.stderr ?? '') };
      },
      write: async ({ path: p, content }: { path: string; content: string }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return { path: p }; },
    },
    subagent: {
      create: async ({ tasks, start }: { tasks: Array<{ title: string; prompt: string }>; start: { machine: string; model?: unknown } }) => {
        const t = tasks[0]!;
        const mode = o.createThrows?.(t.title);
        if (mode === 'before') throw new Error('create lost before it ran');
        expect(start.machine).toBe('shared');
        const index = subs.size + 1;
        const rejected = !!o.reject?.(t.title) && !creates.some(c => c.title === t.title);
        const s: Sub = { title: t.title, prompt: t.prompt, status: rejected ? 'draft' : 'working', polls: 0, model: start.model };
        subs.set(String(index), s);
        creates.push(s);
        if (mode === 'after') throw new Error('create result lost');
        return { tasks: [{ index, title: t.title }], ...(rejected ? { rejected: [{ index, error: 'cap' }] } : {}) };
      },
      start: async ({ indices, model }: { indices: number[]; model?: unknown }) => { starts.push(indices); for (const i of indices) { const s = subs.get(String(i))!; s.status = 'working'; if (model) s.model = model; } return { started: indices.map(index => ({ index })), rejected: [] }; },
      list: async () => { advance(); return { tasks: [...subs].map(([p, s]) => ({ path: p, title: s.title, status: s.status })), total: subs.size }; },
      get: async ({ path: p }: { path: string }) => ({ path: p, status: subs.get(p)!.status, summary: subs.get(p)!.summary, ...(subs.get(p)!.error ? { latest_error: subs.get(p)!.error } : {}) }),
      stop: async ({ paths }: { paths: string[] }) => { stops.push(...paths); for (const p of paths) subs.get(p)!.status = 'stopped'; return { results: paths.map(p => ({ path: p, ok: true })) }; },
    },
    thread: { get: async () => ({ cost: { tokens: 1000 + clock, credits: 1 + clock / 1000 } }) },
  };
  return { tools, subs, creates, starts, stops, sleep: async (ms: number) => { clock += ms; }, now: async () => (o.epoch ?? 1_000_000) + clock };
}

export const PROGRAM = fs.readFileSync(path.join(ROOT, 'lib/capy-review-pass.js'), 'utf8');
export const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<string>;
export async function runPass(h: ReturnType<typeof host>, input: Record<string, unknown>): Promise<string> {
  return new AsyncFunction('tools', 'sleep', 'now', 'input', PROGRAM)(h.tools, h.sleep, h.now, { startedAt: await h.now(), laneModel: 'anthropic/claude-opus-5-5', ...input });
}
export const bin = (dir: string, env: NodeJS.ProcessEnv, a: string[]) => spawnSync(path.join(BIN, 'gstack-review-dispatch'), a, { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
export const briefDirOf = (h: ReturnType<typeof host>, title: string) => briefDir(h.creates.find(c => c.title === title)?.prompt ?? '');
