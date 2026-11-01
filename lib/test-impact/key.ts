/**
 * test-impact/key — the cache key and eligibility of one free test file at a tree (GST-167 PR 2, plan d5).
 *
 * A key is a sha256 over every input that can change what the test does, read
 * at the given tree through git (never the working tree):
 *   - traced: each path the test's strace read set names (lib/test-impact/trace.ts),
 *     as the sha256 of its bytes from `git cat-file --batch`, `dir`, or `absent`;
 *   - listed: the sorted entry names of every repo directory the trace listed;
 *   - graph: the forward import-graph closure of the test (lib/pregate/import-graph.ts),
 *     capped at MAX_HOPS hops; a closure that reaches the cap is ineligible, never truncated;
 *   - global: bun.lock, bunfig.toml, every tsconfig*.json and the pregate `dependencies`;
 *   - code: KEY_CODE_FILES, the runner, planner, shard engine, graph and key code;
 *   - tool: the bytes of each executable outside the repo the trace ran (git, bash, tar…), read on this machine;
 *   - runtime and env: the runtime manifest and ENV_ALLOWLIST values.
 * A test is ineligible (always executed) when it is always_run in the base or the tree list,
 * has no trace, one older than TRACE_MAX_AGE_MS or dated in the future, one made under other
 * allowlisted env values or another runtime, its traced run failed or touched the
 * network, the real HOME, shared /tmp or .git, it read a repo path the tree does not track (a build
 * output), or its graph walk hit the cap. A tree that
 * changes any KEY_CODE_FILES file against the base makes every test ineligible.
 * scripts/test-impact.ts loads this module from the base ref, so a branch cannot change the
 * rules that decide what it skips.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchesAny } from '../ship-policy';
import { PREGATE_CONFIG_PATH } from '../pregate/config';
import { buildGraph, type Graph } from '../pregate/import-graph';
import { ALWAYS_RUN_PATH, parseAlwaysRun } from '../pregate/lane-selection';
import { ENV_ALLOWLIST, envDigests, readTrace } from './trace';

export { ENV_ALLOWLIST };

export const MAX_HOPS = 12;
export const TRACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far in the future a trace's timestamp may sit (clock skew) before it counts as stale. */
export const TRACE_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Tracer, key, CLI, the runner/planner and every repo module it imports, and the graph and always-run code the key reads. PR 4 adds its verifier here. */
export const KEY_CODE_FILES = [
  'lib/test-impact/trace.ts', 'lib/test-impact/key.ts', 'scripts/test-impact.ts',
  'scripts/test-free-shards.ts', 'scripts/lib/shard-engine.ts', 'scripts/lib/free-home-guard.ts', 'scripts/lib/free-ci-health.ts',
  'scripts/lib/windows-curation.ts', 'test/helpers/paid-test-set.ts', 'test/helpers/touchfiles.ts', 'test/helpers/test-selection.ts', 'lib/state-root.ts',
  'lib/pregate/import-graph.ts', 'lib/pregate/lane-selection.ts',
];
const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;

export interface TreeEntry { mode: string; type: string; oid: string }
export interface TreeIndex { treeish: string; entries: Map<string, TreeEntry>; children: Map<string, string[]> }
export type InputKind = 'traced' | 'listed' | 'graph' | 'global' | 'code' | 'tool' | 'runtime' | 'env';
export interface KeyInput { kind: InputKind; path: string; digest: string }
export interface KeyResult { test: string; eligible: boolean; reasons: string[]; key: string | null; inputs: KeyInput[]; tracedAt: string | null }
export interface KeyReport { tree: string; base: string | null; keyCodeEdited: string[]; alwaysRunGlobs: { base: string[]; tree: string[] }; results: KeyResult[] }
export interface KeyOptions {
  repoRoot: string; tree: string; base?: string | null; tests: string[]; traceDir: string;
  now?: number; runtime?: Record<string, string>; env?: Record<string, string | undefined>;
}

function git(repoRoot: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv): Buffer {
  const r = spawnSync('git', args, { cwd: repoRoot, input, env, timeout: 300_000, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.error?.message ?? r.stderr?.toString().trim() ?? r.status}`);
  return r.stdout;
}

/** Every path at a tree-ish with its mode, type and object id, and each directory's sorted entry names (`.` is the root). */
export function readTreeIndex(repoRoot: string, treeish: string): TreeIndex {
  const entries = new Map<string, TreeEntry>();
  const children = new Map<string, string[]>();
  for (const rec of git(repoRoot, ['ls-tree', '-r', '-t', '-z', '--full-tree', treeish]).toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    const rel = rec.slice(tab + 1);
    entries.set(rel, { mode: mode!, type: type!, oid: oid! });
    const parent = path.posix.dirname(rel);
    children.set(parent, [...(children.get(parent) ?? []), path.posix.basename(rel)]);
  }
  for (const list of children.values()) list.sort();
  return { treeish, entries, children };
}

/** sha256 of each blob's bytes, read in one `git cat-file --batch`. */
export function blobDigests(repoRoot: string, oids: Iterable<string>): Map<string, string> {
  const want = [...new Set(oids)];
  const out = new Map<string, string>();
  if (!want.length) return out;
  const buf = git(repoRoot, ['cat-file', '--batch'], want.join('\n') + '\n');
  for (let at = 0; at < buf.length;) {
    const nl = buf.indexOf(10, at);
    const [oid, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    if (type === 'missing' || size === undefined) throw new Error(`git cat-file: ${oid} missing`);
    const start = nl + 1;
    out.set(oid!, createHash('sha256').update(buf.subarray(start, start + Number(size))).digest('hex'));
    at = start + Number(size) + 1;
  }
  return out;
}

/** A file's text at a tree-ish, or null when the tree has no such blob. */
export function catText(repoRoot: string, treeish: string, rel: string): string | null {
  const r = spawnSync('git', ['cat-file', 'blob', `${treeish}:${rel}`], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * A tree-ish checked out into a fresh temp directory with every file staged, so the import graph (git ls-files) sees exactly
 * that tree. It goes through a private index and checkout-index, never `git archive`, whose export-ignore and export-subst
 * attributes would let the tree itself hide files from the graph.
 */
export function materializeTree(repoRoot: string, treeish: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-impact-tree-'));
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}.index` };
  try {
    git(repoRoot, ['read-tree', treeish], undefined, env);
    git(repoRoot, ['checkout-index', '-a', '-f', `--prefix=${dir}/`], undefined, env);
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A', '-f']);
    return dir;
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { fs.rmSync(env.GIT_INDEX_FILE, { force: true }); }
}

/** The runtime manifest a key binds: platform, architecture and Bun version. */
export function runtimeManifest(): Record<string, string> {
  return { platform: process.platform, arch: process.arch, bun: typeof Bun === 'undefined' ? 'none' : Bun.version };
}

/**
 * Files the test reaches through forward graph edges (imports, literals, convention, declarations; `dir/**` expands to the
 * directory's files), at most `maxHops` edges away. `capped` holds the chain to the first file past the cap; a capped closure
 * is incomplete, so its test is ineligible.
 */
export function forwardClosure(graph: Graph, test: string, maxHops = MAX_HOPS): { files: string[]; capped: string[] | null } {
  const forward = new Map<string, string[]>();
  for (const [dep, edges] of graph.reverse) {
    const targets = dep.endsWith('/**') ? [...graph.files].filter(f => f.startsWith(dep.slice(0, -2))) : [dep];
    for (const e of edges) forward.set(e.from, [...(forward.get(e.from) ?? []), ...targets]);
  }
  const parent = new Map<string, string | null>([[test, null]]);
  let frontier = [test];
  for (let hop = 0; frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier) for (const t of forward.get(node) ?? []) {
      if (parent.has(t)) continue;
      if (hop === maxHops) {
        const chain = [t];
        for (let n: string | null = node; n !== null; n = parent.get(n) ?? null) chain.unshift(n);
        return { files: [...parent.keys()].sort(), capped: chain };
      }
      parent.set(t, node);
      next.push(t);
    }
    frontier = next;
  }
  return { files: [...parent.keys()].sort(), capped: null };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const toolDigests = new Map<string, string>();
function toolDigest(file: string): string {
  let digest = toolDigests.get(file);
  if (digest === undefined) {
    try { digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { digest = 'absent'; }
    toolDigests.set(file, digest);
  }
  return digest;
}

/** Keys and eligibility for each test at `tree`, with `base` as the trusted reference for always_run and key code. */
export function computeKeys(opts: KeyOptions): KeyReport {
  const { repoRoot, tree, tests } = opts;
  const base = opts.base ?? null;
  const now = opts.now ?? Date.now();
  const treeIdx = readTreeIndex(repoRoot, tree);
  const baseIdx = base === null ? null : readTreeIndex(repoRoot, base);
  const keyCodeEdited = baseIdx ? KEY_CODE_FILES.filter(f => treeIdx.entries.get(f)?.oid !== baseIdx.entries.get(f)?.oid) : [];
  const listText = (ref: string | null, label: string) => { const t = ref === null ? null : catText(repoRoot, ref, ALWAYS_RUN_PATH); return t === null ? [] : parseAlwaysRun(t, `${ALWAYS_RUN_PATH} at ${label}`); };
  const alwaysRunGlobs = { base: listText(base, base ?? ''), tree: listText(tree, tree) };
  const alwaysGlobs = [...new Set([...alwaysRunGlobs.base, ...alwaysRunGlobs.tree])];
  const pregate = catText(repoRoot, tree, PREGATE_CONFIG_PATH);
  let dependencies: Record<string, string[]> = {};
  try { dependencies = pregate === null ? {} : (JSON.parse(pregate).dependencies ?? {}); } catch { throw new Error(`${PREGATE_CONFIG_PATH} at ${tree}: not valid JSON`); }
  let graph: Graph | null = null;
  if (!keyCodeEdited.length) {
    const dir = materializeTree(repoRoot, tree);
    try { graph = buildGraph(dir, { declarations: dependencies }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const envNow = envDigests(opts.env ?? process.env);
  const runtime = opts.runtime ?? runtimeManifest();
  const shared: KeyInput[] = [
    ...[...treeIdx.entries.keys()].filter(p => p === 'bun.lock' || p === 'bunfig.toml' || TSCONFIG.test(p)).map(p => ({ kind: 'global' as const, path: p, digest: '' })),
    { kind: 'global', path: `${PREGATE_CONFIG_PATH}#dependencies`, digest: sha(JSON.stringify(dependencies)) },
    ...KEY_CODE_FILES.map(p => ({ kind: 'code' as const, path: p, digest: '' })),
    ...Object.entries(runtime).sort().map(([k, v]) => ({ kind: 'runtime' as const, path: k, digest: v })),
    ...Object.entries(envNow).map(([k, digest]) => ({ kind: 'env' as const, path: k, digest })),
  ];
  const pending = tests.map(test => {
    const reasons: string[] = [];
    if (treeIdx.entries.get(test)?.type !== 'blob') reasons.push(`not a file at ${tree}`);
    if (keyCodeEdited.length) reasons.push(`the tree edits key code (${keyCodeEdited.join(', ')}); every test runs`);
    const listed = [alwaysRunGlobs.base.some(g => matchesAny([g], test)) ? `${base}` : '', alwaysRunGlobs.tree.some(g => matchesAny([g], test)) ? tree : ''].filter(Boolean);
    if (alwaysGlobs.some(g => matchesAny([g], test))) reasons.push(`always_run (${ALWAYS_RUN_PATH} at ${listed.join(' and ')})`);
    const trace = readTrace(opts.traceDir, test);
    if (!trace) reasons.push('no trace');
    else {
      const age = now - Date.parse(trace.tracedAt);
      if (!(age >= -TRACE_CLOCK_SKEW_MS && age <= TRACE_MAX_AGE_MS)) reasons.push(`stale trace (traced ${trace.tracedAt}, limit ${TRACE_MAX_AGE_MS / 86_400_000} days)`);
      if (trace.exitCode !== 0) reasons.push(`the traced run failed (exit ${trace.exitCode})`);
      const envDiff = ENV_ALLOWLIST.filter(k => trace.env?.[k] !== envNow[k]);
      if (envDiff.length) reasons.push(`traced under other values of ${envDiff.join(', ')}`);
      const runtimeDiff = Object.keys(runtime).filter(k => trace.runtime?.[k] !== runtime[k]);
      if (runtimeDiff.length) reasons.push(`traced on another runtime (${runtimeDiff.map(k => `${k} ${trace.runtime?.[k]} vs ${runtime[k]}`).join(', ')})`);
      reasons.push(...trace.ineligible);
      const untracked = (trace.present ?? []).filter(p => p !== '.' && !treeIdx.entries.has(p));
      if (untracked.length) reasons.push(`reads paths ${tree} does not track (${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? ` +${untracked.length - 5} more` : ''})`);
    }
    const closure = graph ? forwardClosure(graph, test) : null;
    if (closure?.capped) reasons.push(`import graph deeper than ${MAX_HOPS} hops: ${closure.capped.join(' → ')}`);
    const traced = new Set(trace?.paths ?? []);
    const files: KeyInput[] = [
      ...[...traced].map(p => ({ kind: 'traced' as const, path: p, digest: '' })),
      ...(closure?.files ?? []).filter(p => !traced.has(p)).map(p => ({ kind: 'graph' as const, path: p, digest: '' })),
      ...Object.keys(trace?.dirs ?? {}).map(d => ({ kind: 'listed' as const, path: d, digest: '' })),
      ...(trace?.tools ?? []).map(t => ({ kind: 'tool' as const, path: t, digest: toolDigest(t) })),
    ];
    return { test, reasons, trace, inputs: [...files, ...shared.map(s => ({ ...s }))] };
  });
  const blobOf = (p: string) => { const e = treeIdx.entries.get(p); return e?.type === 'blob' ? e.oid : null; };
  const digests = blobDigests(repoRoot, pending.flatMap(t => t.inputs.filter(i => i.kind !== 'listed' && !i.digest).map(i => blobOf(i.path)).filter((o): o is string => o !== null)));
  const results = pending.map(({ test, reasons, trace, inputs }) => {
    for (const i of inputs) {
      if (i.digest) continue;
      const e = i.path === '.' ? { type: 'tree', mode: '040000', oid: '' } : treeIdx.entries.get(i.path);
      if (i.kind === 'listed') i.digest = e?.type === 'tree' ? sha((treeIdx.children.get(i.path) ?? []).join('\0')) : 'absent';
      else if (!e) i.digest = 'absent';
      else i.digest = e.type === 'blob' ? `${e.mode}:${digests.get(e.oid)}` : e.type === 'tree' ? 'dir' : `${e.type}:${e.oid}`;
    }
    inputs.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
    const eligible = reasons.length === 0;
    const key = eligible ? sha([`test\t${test}`, ...inputs.map(i => `${i.kind}\t${i.path}\t${i.digest}`)].join('\n')) : null;
    return { test, eligible, reasons, key, inputs, tracedAt: trace?.tracedAt ?? null };
  });
  return { tree, base, keyCodeEdited, alwaysRunGlobs, results };
}
