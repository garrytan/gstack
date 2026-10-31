/**
 * ship-audit — gstack-ship-preflight --audit (GSTA-167 variant G): the parent's single
 * reads and the deterministic part of /ship's non-blocking audits in one call. It writes
 * the branch diff once to <out>/diff.patch, the commits to <out>/commits.txt and the
 * TODOS.md items that name a touched path to <out>/todos.md, maps each changed runtime
 * file to the tests that name it (Step 7), lists the plan candidates Step 8 offers, and
 * prints which audit still needs a reader. The parent reads these small files and never
 * TODOS.md or the diff whole; the audits' briefs stay their sections' own.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPath } from './review-depth';
import { resolveStateRoot } from './state-root';
import { bin, gh, git, hostedOrigin, Report, short } from './ship-bin-common';

const DATA_PATH = /\.(json|jsonl|ndjson|ya?ml|toml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf)$/i;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i;
const TEST_SPECS = ['test', 'tests', '__tests__', 'spec', '*.test.*', '*.spec.*'];
const TODOS_HITS_MAX = 120;

const stem = (p: string) => path.basename(p).replace(/\.[^.]+$/, '');
const readOr = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/** TODOS.md lines naming a touched path or its file stem (a stem under 4 characters only by full path), under their nearest heading. */
export function todosHits(text: string, touched: readonly string[]): string[] {
  const keys = [...new Set(touched.flatMap(p => [p, ...(stem(p).length >= 4 ? [stem(p)] : [])]))];
  const out: string[] = [];
  let heading = '', printed = '';
  for (const line of text.split('\n')) {
    if (/^#{1,6} /.test(line)) { heading = line; continue; }
    if (!keys.some(k => line.includes(k))) continue;
    if (heading && heading !== printed) { out.push(heading); printed = heading; }
    out.push(line);
    if (out.length >= TODOS_HITS_MAX) break;
  }
  return out;
}

/** Step 8's discovery: the PR body's Plan: binding, docs/designs/ files this branch changed or that name it, then personal plan files naming it. */
function planCandidates(cwd: string, fork: string, branch: string): string[] {
  const found: string[] = [];
  if (hostedOrigin(cwd)) {
    const bound = /^\s*Plan:\s*(\S+)/m.exec(gh(cwd, ['pr', 'view', '--json', 'body', '-q', '.body']).stdout.replace(/[\r`]/g, ''))?.[1];
    if (bound) found.push(`PLAN_BINDING: ${bound}`);
  }
  const designs = new Set([
    ...git(cwd, ['diff', '--name-only', '--diff-filter=AM', fork, '--', 'docs/designs/*.md']).stdout.split('\n'),
    ...(branch ? git(cwd, ['grep', '-l', '-F', '-e', branch, '--', 'docs/designs/*.md']).stdout.split('\n') : []),
  ].filter(Boolean));
  for (const d of designs) found.push(`PLAN_CANDIDATE: ${d}`);
  if (!branch) return found;
  const slug = /^SLUG=(\S+)/m.exec(bin(cwd, 'gstack-slug', [], 30_000).stdout)?.[1] ?? path.basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '');
  const home = process.env.HOME ?? '';
  for (const dir of [path.join(resolveStateRoot(process.env), 'projects', slug), path.join(home, '.claude/plans'), path.join(home, '.codex/plans'), path.join(cwd, '.gstack/plans')]) {
    let names: string[];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')); } catch { continue; }
    for (const n of names) if (readOr(path.join(dir, n)).includes(branch)) found.push(`PLAN_CANDIDATE: ${path.join(dir, n)}`);
  }
  return found;
}

export function audit(cwd: string, base: string, out: string): Report {
  const r = new Report();
  const fork = git(cwd, ['merge-base', `origin/${base}`, 'HEAD']).stdout.trim() || `origin/${base}`;
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const diff = git(cwd, ['diff', fork]).stdout;
  const files = git(cwd, ['diff', '--name-only', fork]).stdout.split('\n').filter(Boolean);
  const commits = git(cwd, ['log', '--oneline', `origin/${base}..HEAD`]).stdout;
  fs.writeFileSync(path.join(out, 'diff.patch'), diff, { mode: 0o600 });
  fs.writeFileSync(path.join(out, 'commits.txt'), commits, { mode: 0o600 });
  r.add(`CONTEXT: diff=${path.join(out, 'diff.patch')} bytes=${Buffer.byteLength(diff)} files=${files.length} commits=${commits.split('\n').filter(Boolean).length} log=${path.join(out, 'commits.txt')}`);

  if (!fs.existsSync(path.join(cwd, 'TODOS.md'))) r.add('TODOS: none (no TODOS.md)');
  else {
    const text = readOr(path.join(cwd, 'TODOS.md'));
    const hits = todosHits(text, files);
    fs.writeFileSync(path.join(out, 'todos.md'), hits.join('\n') + (hits.length ? '\n' : ''), { mode: 0o600 });
    r.add(`TODOS: bytes=${Buffer.byteLength(text)} hits=${hits.filter(l => !/^#{1,6} /.test(l)).length} file=${path.join(out, 'todos.md')} (Steps 8.2 and 14 read this file, never TODOS.md whole)`);
  }

  const tests = files.filter(p => TEST_PATH.test(p)).map(p => ({ p, text: readOr(path.join(cwd, p)) }));
  const runtime = files.filter(p => !TEST_PATH.test(p) && !DATA_PATH.test(p) && fs.existsSync(path.join(cwd, p)) && classifyPath(p, cwd) === 'code');
  // One read of the tracked test tree for every changed file, instead of one full-tree git grep per file.
  const testTree = runtime.length ? git(cwd, ['ls-files', '-z', '--', ...TEST_SPECS]).stdout.split('\0').filter(Boolean).map(f => readOr(path.join(cwd, f))) : [];
  const map = runtime.map(p => ({
    p,
    changed: tests.filter(t => t.p.includes(stem(p)) || t.text.includes(stem(p))).length,
    referencing: testTree.filter(text => text.includes(stem(p))).length,
  }));
  const mapFile = path.join(out, 'coverage.txt');
  fs.writeFileSync(mapFile, map.map(m => `${m.p} changed_tests=${m.changed} referencing_tests=${m.referencing}\n`).join(''), { mode: 0o600 });
  for (const m of map.slice(0, 8)) r.add(`COVERAGE_MAP: ${m.p} changed_tests=${m.changed} referencing_tests=${m.referencing}`);
  const untested = map.filter(m => m.changed === 0).map(m => m.p);
  r.add(!runtime.length ? 'Coverage: skipped (no runtime file changed; no audit reader)'
    : untested.length ? `Coverage: ${untested.length} of ${runtime.length} changed runtime files have no changed test naming them (${short(untested, 4)}); map=${mapFile}`
    : `Coverage: deterministic (each of ${runtime.length} changed runtime files has a changed test naming it; no audit reader); map=${mapFile}`);

  const branch = git(cwd, ['branch', '--show-current']).stdout.trim().replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  const plans = planCandidates(cwd, fork, branch);
  for (const line of plans.slice(0, 5)) r.add(line);
  if (!plans.length) r.add('Plan completion audit: not run (no plan is bound to this branch and no docs/designs/ file matches). Fix: add "Plan: <path>" to the PR body, or run /autoplan.');
  r.add(`READER: coverage=${untested.length ? 'needed' : 'none'} plan=${plans.length ? 'needed' : 'none'}`);
  return r;
}
