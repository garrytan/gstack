#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * test-impact — trace free tests and compute their reuse keys (GST-167 PR 2; docs/test-impact.md).
 *
 *   scripts/test-impact.ts trace [--out <dir>] <test-file>...
 *       Run each file with `bun test` under strace (Linux) and write its read set to <dir>
 *       (default .context/test-impact/traces).
 *   scripts/test-impact.ts key --tree <ref> [--base <ref>] [--traces <dir>] [--json] <test-file>...
 *       Print each file's key at <ref>, or why it is ineligible. With --base, the key code is
 *       loaded from that ref, not from this checkout (plan d5).
 *   scripts/test-impact.ts explain [--tree <ref>] [--base <ref>] [--traces <dir>] <test-file>
 *       Print every input of one file's key and why it is or is not eligible.
 *
 * Nothing here changes what CI runs. Exit codes: 0 done, 1 a traced run or key failed, 2 usage or setup.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import * as localKey from '../lib/test-impact/key';
import type { KeyOptions, KeyReport } from '../lib/test-impact/key';
import { STRACE_FLAGS, TRACE_VERSION, envDigests, parseStrace, tracePath, type TraceRecord } from '../lib/test-impact/trace';

const USAGE = 'usage: test-impact.ts trace [--out <dir>] <test-file>... | key --tree <ref> [--base <ref>] [--traces <dir>] [--json] <test-file>... | explain [--tree <ref>] [--base <ref>] [--traces <dir>] <test-file>';
const DEFAULT_TRACES = path.join('.context', 'test-impact', 'traces');

function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('not inside a git repository');
  return r.stdout.trim();
}

function parseArgs(argv: string[], flags: string[], booleans: string[] = []): { opts: Record<string, string | true>; files: string[] } {
  const opts: Record<string, string | true> = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (booleans.includes(a)) opts[a] = true;
    else if (flags.includes(a)) { const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`); opts[a] = v; }
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  return { opts, files };
}

const relTo = (root: string, file: string) => path.relative(root, path.resolve(file)).split(path.sep).join('/');

function trace(root: string, argv: string[]): number {
  const { opts, files } = parseArgs(argv, ['--out']);
  if (!files.length) throw new Error(USAGE);
  if (spawnSync('strace', ['-V'], { timeout: 30_000 }).status !== 0) { console.error('test-impact: strace not found; tracing needs Linux with strace installed'); return 2; }
  const out = path.resolve(root, String(opts['--out'] ?? DEFAULT_TRACES));
  fs.mkdirSync(out, { recursive: true });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  let failed = 0;
  for (const file of files.map(f => relTo(root, f))) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-impact-run-'));
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-impact-log-'));
    try {
      const log = path.join(logDir, 'strace.txt');
      const r = spawnSync('strace', [...STRACE_FLAGS, '-o', log, '--', process.execPath, ...bunIsolationArgs(), 'test', path.join(root, file), '--timeout=30000', '--max-concurrency=1'],
        { cwd: root, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, timeout: 600_000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const set = parseStrace(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', { repoRoot: root, home: os.homedir(), tmpDir: tmp, pathDirs: (process.env.PATH ?? '').split(path.delimiter) });
      const record: TraceRecord = { version: TRACE_VERSION, test: file, tracedAt: new Date().toISOString(), commit: head.status === 0 ? head.stdout.trim() : null, exitCode: r.status, runtime: localKey.runtimeManifest(), env: envDigests(process.env), ...set };
      fs.writeFileSync(tracePath(out, file), JSON.stringify(record, null, 2) + '\n');
      if (r.status !== 0) failed++;
      const verdict = set.ineligible.length ? `ineligible: ${set.ineligible.join('; ')}` : 'eligible';
      console.log(`traced ${file}: exit ${r.status ?? r.signal}, ${set.paths.length} paths, ${Object.keys(set.dirs).length} listed dirs, ${verdict} → ${path.relative(root, tracePath(out, file))}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}

/** computeKeys from the base ref's own key code when --base is given (the trusted path), else from this checkout. */
async function keys(root: string, options: Omit<KeyOptions, 'repoRoot'>): Promise<{ report: KeyReport; source: string }> {
  if (!options.base) return { report: localKey.computeKeys({ repoRoot: root, ...options }), source: 'this checkout (untrusted: no --base)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-impact-base-'));
  try {
    const tar = path.join(dir, 'code.tar');
    const a = spawnSync('git', ['archive', '--format=tar', '-o', tar, options.base, 'lib', 'scripts'], { cwd: root, timeout: 300_000 });
    if (a.status !== 0) throw new Error(`git archive ${options.base} failed: ${a.stderr?.toString().trim()}`);
    const x = spawnSync('tar', ['-xf', tar, '-C', dir], { timeout: 300_000 });
    if (x.status !== 0) throw new Error(`tar -xf failed: ${x.stderr?.toString().trim()}`);
    const entry = path.join(dir, 'lib', 'test-impact', 'key.ts');
    const source = `${options.base}:lib/test-impact/key.ts`;
    if (!fs.existsSync(entry)) {
      const results = options.tests.map(test => ({ test, eligible: false, reasons: [`${options.base} has no lib/test-impact/key.ts; nothing is reusable until the key code lands there`], key: null, inputs: [], tracedAt: null }));
      return { report: { tree: options.tree, base: options.base, keyCodeEdited: [], alwaysRunGlobs: { base: [], tree: [] }, results }, source };
    }
    const trusted = await import(entry) as typeof localKey;
    return { report: trusted.computeKeys({ repoRoot: root, ...options, runtime: trusted.runtimeManifest() }), source };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function key(root: string, argv: string[], explain: boolean): Promise<number> {
  const { opts, files } = parseArgs(argv, ['--tree', '--base', '--traces'], ['--json']);
  if (!files.length || (explain && files.length !== 1) || (!explain && !opts['--tree'])) throw new Error(USAGE);
  const { report, source } = await keys(root, {
    tree: String(opts['--tree'] ?? 'HEAD'), base: opts['--base'] ? String(opts['--base']) : null,
    tests: files.map(f => relTo(root, f)), traceDir: path.resolve(root, String(opts['--traces'] ?? DEFAULT_TRACES)),
  });
  if (opts['--json']) { console.log(JSON.stringify({ source, ...report }, null, 2)); return 0; }
  console.log(`tree ${report.tree}${report.base ? `, base ${report.base}` : ''}; key code from ${source}`);
  for (const r of report.results) {
    console.log(r.eligible ? `KEY ${r.test} ${r.key!.slice(0, 12)} (${r.inputs.length} inputs)` : `INELIGIBLE ${r.test}: ${r.reasons.join('; ')}`);
    if (!explain) continue;
    console.log(`  traced at: ${r.tracedAt ?? 'never'}${r.key ? `\n  key: ${r.key}` : ''}`);
    console.log(`  always_run globs: base [${report.alwaysRunGlobs.base.join(', ')}], tree [${report.alwaysRunGlobs.tree.join(', ')}]`);
    for (const kind of ['traced', 'listed', 'graph', 'global', 'code', 'tool', 'runtime', 'env'] as const) {
      const list = r.inputs.filter(i => i.kind === kind);
      if (!list.length) continue;
      console.log(`  ${kind} (${list.length}):`);
      for (const i of list) console.log(`    ${i.path}  ${kind === 'runtime' ? i.digest : i.digest.slice(-12)}`);
    }
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const root = repoRoot();
  if (cmd === 'trace') return trace(root, rest);
  if (cmd === 'key') return key(root, rest, false);
  if (cmd === 'explain') return key(root, rest, true);
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => { console.error(`test-impact: ${error.message}`); process.exit(2); });
}
