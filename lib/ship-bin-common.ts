/**
 * ship-bin-common — what gstack-ship-preflight and gstack-ship-release share: running git
 * and sibling bins with timeouts, flag reading, the effective ship policy, and the compact
 * result every step prints (KEY: lines, STOP: where the agent must judge, NEXT: what it
 * does next). The bins chain existing commands and never make a decision the /ship prose
 * assigns to the agent.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fragmentSlug } from './changelog-fragments';
import { BIN_DIR, runBashSync, runScriptSync, scriptInvocation } from './script-invocation';

export interface Run { status: number | null; stdout: string; stderr: string }
const done = (r: { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: Error }): Run =>
  ({ status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') + (r.error ? r.error.message : '') });

export function git(cwd: string, args: string[], timeout = 120_000): Run {
  return done(spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
}
export function bin(cwd: string, name: string, args: string[], timeout = 600_000): Run {
  return done(runScriptSync(path.join(BIN_DIR, name), args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }));
}
/** Whether origin's configured URL names a host (https, ssh or scp form), before any insteadOf rewrite; a local path or file:// remote has none, so gh cannot map it to a repository. */
export function hostedOrigin(cwd: string): boolean {
  const url = git(cwd, ['config', '--get', 'remote.origin.url']).stdout.trim();
  return /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?[^/:\s]+[:/]|[^@/\s]+@[^/:\s]+:)\S+$/i.test(url) && !/^file:/i.test(url);
}
/** gh with argv, never a shell, so a branch name cannot change what runs. */
export function gh(cwd: string, args: string[], timeout = 60_000): Run {
  return done(spawnSync('gh', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
}
export function sh(cwd: string, command: string, timeout = 1_800_000): Run {
  return done(runBashSync(command, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }));
}
/** A sibling bin run without blocking, so independent test lanes run in parallel. */
export function binAsync(cwd: string, name: string, args: string[], timeout = 3_600_000): Promise<Run> {
  const inv = scriptInvocation(path.join(BIN_DIR, name), args);
  if (!inv.ok) return Promise.resolve({ status: null, stdout: '', stderr: inv.error });
  return new Promise(resolve => {
    const child = spawn(inv.cmd, inv.argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-200_000); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-200_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

export function flagReader(argv: readonly string[]) {
  const all = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
  return { all, flag: (n: string) => all(n).at(-1), has: (n: string) => argv.includes(n) };
}

/** --lane <label>=<command> pairs (Step 5's labels and exact commands). */
export function lanes(argv: readonly string[]): { label: string; command: string }[] | string {
  const out: { label: string; command: string }[] = [];
  for (const raw of flagReader(argv).all('--lane')) {
    const at = raw.indexOf('=');
    if (at < 1 || at === raw.length - 1) return `--lane ${raw} is not <label>=<command>`;
    out.push({ label: raw.slice(0, at), command: raw.slice(at + 1) });
  }
  return out;
}

/** The base branch's effective ship policy (gstack-ship-policy show-effective --json), or null when unreadable. */
export function shipPolicy(cwd: string, base: string): Record<string, any> | null {
  const r = bin(cwd, 'gstack-ship-policy', ['show-effective', '--base', base, '--json'], 60_000);
  try { return JSON.parse(r.stdout).policy ?? null; } catch { return null; }
}

/** Manifests a version stamp writes: release metadata only while the edit changes nothing but the version. */
export const VERSIONED_MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];

/** True when `p` in the working tree differs from `p` at `ref` (a commit or tree) in its version fields alone; a new, deleted or unparseable file never qualifies. */
export function versionOnlyEdit(cwd: string, ref: string, p: string): boolean {
  const before = git(cwd, ['show', `${ref}:${p}`]);
  if (before.status !== 0) return false;
  let now: string;
  try { now = fs.readFileSync(path.join(cwd, p), 'utf8'); } catch { return false; }
  const strip = (s: string) => {
    const o = JSON.parse(s);
    delete o.version;
    if (o.packages?.['']) delete o.packages[''].version;
    return JSON.stringify(o);
  };
  try { return strip(before.stdout) === strip(now); } catch { return false; }
}

/**
 * Release metadata a version stamp and Steps 13-14 write, compared against `ref`: the release commit's paths,
 * never a behavior change. A manifest counts only while its edit is version-only (a dependency, script or
 * lockfile change is a build input); bun.lock never counts.
 */
export function releasePaths(policy: Record<string, any> | null, cwd: string, ref: string): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const fragment = fragmentPath(policy, cwd);
  return [...new Set(['VERSION', 'CHANGELOG.md', 'TODOS.md', 'agents-digest/gstack-AGENTS.md', ...VERSIONED_MANIFESTS.filter(p => versionOnlyEdit(cwd, ref, p)),
    ...(typeof policy?.changelog === 'string' ? [policy.changelog] : []), ...(fragment ? [fragment] : []), ...list(policy?.release_outputs), ...list(policy?.stamp_paths)])];
}

/** Under `changelog_fragments`, the branch's own Step 13 entry `<dir>/<branch-slug>.md` (docs/ship-policy.md#changelog-fragments); null without the key. */
export function fragmentPath(policy: Record<string, any> | null, cwd: string): string | null {
  const dir = policy?.changelog_fragments?.dir;
  if (typeof dir !== 'string') return null;
  return `${dir.replace(/\/+$/, '')}/${fragmentSlug(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim())}.md`;
}

/** The paths a lane receipt may ignore: release metadata except TODOS.md, whose Step 14 edit reruns the lanes (ship/SKILL.md Step 16). */
export const evidenceExempt = (release: readonly string[]) => release.filter(p => p !== 'TODOS.md');

export const short = (list: readonly string[], n = 6) => list.slice(0, n).join(',') + (list.length > n ? `,+${list.length - n} more` : '');
export const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 240) ?? '';

/** The compact result: at most MAX_LINES lines; STOP and NEXT always survive the cap. */
export const MAX_LINES = 30;
export class Report {
  readonly lines: string[] = [];
  exit = 0;
  add(line: string): this { this.lines.push(line); return this; }
  next(what: string): this { return this.add(`NEXT: ${what}`); }
  stop(what: string): Report { this.exit = 3; return this.add(`STOP: ${what}`); }
  render(): string {
    const keep = this.lines.length <= MAX_LINES ? this.lines
      : [...this.lines.filter(l => !/^(STOP|NEXT):/.test(l)).slice(0, MAX_LINES - 1 - this.lines.filter(l => /^(STOP|NEXT):/.test(l)).length), `… ${this.lines.length - MAX_LINES + 1} line(s) cut`, ...this.lines.filter(l => /^(STOP|NEXT):/.test(l))];
    return keep.join('\n') + '\n';
  }
}

/** Run each lane through gstack-evidence run in parallel and read its recorded line. */
export async function runLanes(cwd: string, list: { label: string; command: string }[]): Promise<{ label: string; exit: number | null; testsRan: string; log: string }[]> {
  return Promise.all(list.map(async l => {
    const r = await binAsync(cwd, 'gstack-evidence', ['run', '--label', l.label, '--', l.command]);
    const m = /gstack-evidence: recorded label=\S+ exit=(\S+) tests_ran=(\S+) log=(\S+)/.exec(r.stderr);
    return { label: l.label, exit: r.status, testsRan: m?.[2] ?? 'unknown', log: m?.[3] ?? '-' };
  }));
}

/** Step 5's lane verdict: a lane passes on its runner count, never exit 0 alone. */
export function laneLine(l: { label: string; exit: number | null; testsRan: string; log: string }): { line: string; ok: boolean } {
  const zero = l.exit === 0 && l.testsRan === '0';
  const state = l.exit !== 0 ? 'FAIL' : zero ? 'ZERO-RUN' : l.testsRan === 'unknown' ? 'pass (count unavailable)' : 'pass';
  return { line: `LANE: ${l.label} ${state} exit=${l.exit} tests_ran=${l.testsRan} log=${l.log}`, ok: l.exit === 0 && !zero };
}
