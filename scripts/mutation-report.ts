#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * mutation-report — the weekly, report-only mutation trial (docs/TESTING_INTERNALS.md#mutation-report).
 * StrykerJS plants small wrong edits (mutants) in the lib files with the most landings on main in the last
 * 30 days (a file no test imports, or with nothing to mutate, is listed and the next one takes its place) and runs the tests
 * that import each file; a mutant no test fails on "survived" and is listed in the report. Nothing here
 * gates a merge: the script exits 0 whatever it finds, and 1 only when it cannot run.
 *
 *   bun scripts/mutation-report.ts --throwaway-checkout --stryker-dir <dir> --out-dir <dir>
 *       [--files N | --only lib/<file>.ts] [--since-days N] [--file-budget-min N] [--concurrency N] [--summary-file <path>]
 *
 * Stryker mutates files IN PLACE (its sandbox copy cannot follow this repo's symlinked directories),
 * so the script refuses a dirty tree and needs --throwaway-checkout; it restores the tree with git after
 * every file. --stryker-dir holds the exact-pinned install below (npm install --prefix, never package.json).
 *
 * Before Stryker runs on a file, the selected tests must pass unedited; then a positive control plants a
 * throw at the top of the file and the same tests must fail with that throw's message. If they don't, the
 * tests never load the file in-process (for example they only spawn it), every mutant would show as a
 * false survivor, and the file is reported as "control survived" without a mutation run. Stryker runs
 * under `timeout`, which kills its whole process group at the file budget, and the report is rewritten
 * after every file so a job that hits its own limit still leaves the finished files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from '../lib/spawn-sync';
import { buildGraph, isTestFile, testsFor } from '../lib/pregate/import-graph';

export const STRYKER_PACKAGES = ['@stryker-mutator/core@10.1.1', '@hughescr/stryker-bun-runner@1.6.0'];
export const CONTROL_MESSAGE = 'mutation-report positive control';
export const CONTROL_LINE = `throw new Error('${CONTROL_MESSAGE}');\n`;
const CONTROL_MS = 10 * 60_000;
const FREE_TEST_TIMEOUT_MS = 30_000;
const MAX_TESTS = 20;
const SURVIVORS_SHOWN = 15;

export interface Churn { file: string; commits: number }
export interface Mutant { id?: string; mutatorName: string; replacement?: string; status: string; location: { start: { line: number; column: number } } }
export interface FileResult {
  file: string; commits: number; tests: string[]; testsFound: number; testSource: 'direct' | 'transitive' | 'none';
  outcome: 'scored' | 'no tests' | 'no mutants' | 'control survived' | 'unfinished' | 'failed';
  detail?: string; counts?: Record<string, number>; score?: number; survivors?: Mutant[]; minutes?: number;
}

/** Rank existing, non-test lib TypeScript files by landings in `git log --first-parent --format= --name-only` output. */
export function rankChurn(nameLog: string, exists: (file: string) => boolean, n: number): Churn[] {
  const counts = new Map<string, number>();
  for (const line of nameLog.split('\n')) {
    const f = line.trim();
    if (!/^lib\/.+\.ts$/.test(f) || f.endsWith('.d.ts') || isTestFile(f)) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts].filter(([f]) => exists(f)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n).map(([file, commits]) => ({ file, commits }));
}

export function plantControl(source: string): string { return CONTROL_LINE + source; }

/** Stryker's mutation score: detected (killed, timeout) over detected plus undetected (survived, no coverage). */
export function summarize(mutants: Mutant[]): { counts: Record<string, number>; score: number | undefined; survivors: Mutant[] } {
  const counts: Record<string, number> = {};
  for (const m of mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
  const undetected = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
  const survivors = mutants.filter(m => m.status === 'Survived')
    .sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column);
  return { counts, score: detected + undetected ? detected / (detected + undetected) : undefined, survivors };
}

const cell = (s: string) => '`' + s.replace(/\s+/g, ' ').slice(0, 80).replace(/[^\x20-\x7e]/g, '?').replace(/[`|]/g, '?') + '`';

export function renderMarkdown(results: FileResult[], meta: { sinceDays: number; head: string; packages: string[] }): string {
  const lines = [
    '## Mutation report (report-only)', '',
    `The lib files with the most landings in the last ${meta.sinceDays} days at ${meta.head.slice(0, 12)}; ${meta.packages.join(', ')}. A file no test imports ("no tests") or with nothing to mutate ("no mutants") is listed and the next file takes its place; at most ${MAX_TESTS} test files run per file.`,
    'A survivor is a small wrong edit that every selected test still passed. Nothing here blocks a merge.', '',
    '| file | landings | tests | outcome | killed | survived | no coverage | timeout | score | minutes |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const c = r.counts ?? {};
    const n = (k: string) => (r.counts ? String(c[k] ?? 0) : '-');
    lines.push(`| ${cell(r.file)} | ${r.commits} | ${r.tests.length}${r.testsFound > r.tests.length ? ` of ${r.testsFound}` : ''} (${r.testSource}) | ${r.outcome}${r.detail ? ': ' + r.detail.replace(/[|\n]/g, ' ').slice(0, 120) : ''} | ${n('Killed')} | ${n('Survived')} | ${n('NoCoverage')} | ${n('Timeout')} | ${r.score === undefined ? '-' : (r.score * 100).toFixed(1) + '%'} | ${r.minutes ?? '-'} |`);
  }
  for (const r of results) {
    if (!r.survivors?.length) continue;
    lines.push('', `### Survivors in ${cell(r.file)} (${r.survivors.length}${r.survivors.length > SURVIVORS_SHOWN ? `, first ${SURVIVORS_SHOWN} by line` : ''})`, '');
    for (const m of r.survivors.slice(0, SURVIVORS_SHOWN))
      lines.push(`- line ${m.location.start.line}: ${m.mutatorName}${m.replacement === undefined ? '' : ' → ' + cell(m.replacement)}`);
  }
  return lines.join('\n') + '\n';
}

function fail(msg: string): never {
  process.stderr.write(`mutation-report: ${msg}\n`);
  process.exit(1);
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) fail(`git ${args[0]} failed: ${r.error?.message ?? (r.stderr ?? '').trim().slice(0, 300)}`);
  return r.stdout;
}

function restoreTree(): void {
  git(['checkout', '--', '.']);
  fs.rmSync('.stryker-tmp', { recursive: true, force: true });
  if (git(['status', '--porcelain', '--untracked-files=no']).trim()) fail('the tree is still dirty after restoring it; stopping');
}

function selectTests(graph: ReturnType<typeof buildGraph>, file: string): Pick<FileResult, 'tests' | 'testsFound' | 'testSource'> {
  const direct = [...new Set((graph.reverse.get(file) ?? []).map(e => e.from).filter(f => graph.tests.has(f) && f.startsWith('test/')))].sort();
  const found = direct.length ? direct : testsFor(graph, file).tests.filter(f => f.startsWith('test/')).sort();
  return { tests: found.slice(0, MAX_TESTS), testsFound: found.length, testSource: direct.length ? 'direct' : found.length ? 'transitive' : 'none' };
}

function runTests(tests: string[], deadline: number) {
  return spawnSync(process.execPath, ['test', ...tests.map(t => './' + t), `--timeout=${FREE_TEST_TIMEOUT_MS}`],
    { encoding: 'utf-8', timeout: Math.max(1_000, Math.min(CONTROL_MS, deadline - Date.now())), maxBuffer: 256 * 1024 * 1024 });
}

function mutateFile(c: Churn, sel: Pick<FileResult, 'tests' | 'testsFound' | 'testSource'>, o: { strykerDir: string; outDir: string; budgetMs: number; concurrency: number }): FileResult {
  const started = Date.now();
  const deadline = started + o.budgetMs;
  const base: FileResult = { ...c, ...sel, outcome: 'failed' };
  const baseline = runTests(sel.tests, deadline);
  if (baseline.error) return { ...base, outcome: 'unfinished', detail: `the selected tests did not finish unedited: ${baseline.error.message}` };
  if (baseline.status !== 0) return { ...base, detail: `the selected tests fail before any edit (exit ${baseline.status})` };
  fs.writeFileSync(c.file, plantControl(fs.readFileSync(c.file, 'utf-8')));
  const control = runTests(sel.tests, deadline);
  restoreTree();
  if (control.error) return { ...base, detail: `positive control did not finish: ${control.error.message}` };
  if (control.status === 0 || !`${control.stdout}${control.stderr}`.includes(CONTROL_MESSAGE))
    return { ...base, outcome: 'control survived', detail: 'the selected tests did not fail on the planted throw' };

  const slug = c.file.replace(/[^a-zA-Z0-9]+/g, '-');
  const reportFile = path.join(o.outDir, `${slug}.json`);
  const configFile = path.join(o.outDir, `${slug}.stryker.json`);
  fs.writeFileSync(configFile, JSON.stringify({
    appendPlugins: [path.join(o.strykerDir, 'node_modules/@hughescr/stryker-bun-runner/dist/index.js')],
    testRunner: 'bun', mutate: [c.file], inPlace: true, ignoreStatic: true,
    bun: { testFiles: sel.tests, timeout: 60_000 },
    reporters: ['progress-append-only', 'json'], jsonReporter: { fileName: reportFile },
    concurrency: o.concurrency, timeoutMS: 30_000, tempDirName: '.stryker-tmp',
  }, null, 2));
  const budgetS = Math.round((deadline - Date.now()) / 1000);
  if (budgetS < 60) return { ...base, outcome: 'unfinished', detail: `the controls used the ${Math.round(o.budgetMs / 60_000)}-minute file budget` };
  const run = spawnSync('timeout', ['--kill-after=60', String(budgetS), 'node', path.join(o.strykerDir, 'node_modules/@stryker-mutator/core/bin/stryker.js'), 'run', configFile],
    { encoding: 'utf-8', timeout: (budgetS + 120) * 1000, maxBuffer: 512 * 1024 * 1024 });
  fs.writeFileSync(path.join(o.outDir, `${slug}.log`), (run.stdout ?? '') + (run.stderr ?? ''));
  restoreTree();
  const minutes = Math.round((Date.now() - started) / 60_000);
  if (run.status === 124 || run.status === 137) return { ...base, outcome: 'unfinished', detail: `stopped at the ${Math.round(o.budgetMs / 60_000)}-minute file budget`, minutes };
  if (run.error || run.status !== 0 || !fs.existsSync(reportFile))
    return { ...base, detail: `stryker ${run.error ? run.error.message : `exit ${run.status}`}: ${(run.stderr || run.stdout || '').trim().split('\n').pop()}`, minutes };
  let mutants: Mutant[];
  try {
    mutants = Object.values((JSON.parse(fs.readFileSync(reportFile, 'utf-8')) as { files: Record<string, { mutants: Mutant[] }> }).files).flatMap(f => f.mutants);
  } catch (error) {
    return { ...base, detail: `unreadable Stryker report: ${String(error).slice(0, 120)}`, minutes };
  }
  if (!mutants.length) return { ...base, outcome: 'no mutants', detail: 'Stryker found nothing to mutate (a data-only file)', minutes };
  return { ...base, outcome: 'scored', ...summarize(mutants), minutes };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) fail(`${name} needs a value`);
  return v;
}

function intArg(argv: string[], name: string, fallback: number): number {
  const v = arg(argv, name);
  if (v === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(v)) fail(`${name} must be a positive integer`);
  return Number(v);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--throwaway-checkout')) fail('Stryker edits files in place; pass --throwaway-checkout and run only in a disposable checkout');
  const strykerDir = arg(argv, '--stryker-dir'), outDir = arg(argv, '--out-dir'), summaryFile = arg(argv, '--summary-file'), only = arg(argv, '--only');
  if (!strykerDir || !outDir) fail('--stryker-dir and --out-dir are required');
  const files = intArg(argv, '--files', 5), sinceDays = intArg(argv, '--since-days', 30);
  const budgetMs = intArg(argv, '--file-budget-min', 55) * 60_000, concurrency = intArg(argv, '--concurrency', 4);
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  if (git(['status', '--porcelain', '--untracked-files=no']).trim()) fail('the checkout has uncommitted changes; use a clean disposable checkout');
  const resolvedOut = path.resolve(outDir);
  const rel = path.relative(process.cwd(), resolvedOut);
  if (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)) fail('--out-dir must be outside the checkout');
  fs.mkdirSync(resolvedOut, { recursive: true });
  const head = git(['rev-parse', 'HEAD']).trim();
  const ranked = rankChurn(git(['log', '--first-parent', `--since=${sinceDays} days ago`, '--format=', '--name-only', 'HEAD', '--', 'lib']), f => fs.existsSync(f), Number.MAX_SAFE_INTEGER);
  const churn = only ? ranked.filter(c => c.file === only) : ranked;
  if (only && !churn.length) fail(`--only ${only} is not a lib file landed in the last ${sinceDays} days`);
  if (!churn.length) fail(`no lib files landed in the last ${sinceDays} days (is this a shallow clone?)`);
  const graph = buildGraph(process.cwd());
  const results: FileResult[] = [];
  const write = () => {
    const md = renderMarkdown(results, { sinceDays, head, packages: STRYKER_PACKAGES });
    fs.writeFileSync(path.join(resolvedOut, 'mutation-report.md'), md);
    fs.writeFileSync(path.join(resolvedOut, 'mutation-report.json'), JSON.stringify({ head, sinceDays, packages: STRYKER_PACKAGES, results }, null, 2));
    return md;
  };
  for (const c of churn) {
    if (results.filter(r => r.outcome !== 'no tests' && r.outcome !== 'no mutants').length >= files) break;
    const sel = selectTests(graph, c.file);
    const r = sel.tests.length ? mutateFile(c, sel, { strykerDir: path.resolve(strykerDir), outDir: resolvedOut, budgetMs, concurrency }) : { ...c, ...sel, outcome: 'no tests' as const };
    results.push(r);
    write();
    process.stdout.write(`MUTATION_FILE: file=${r.file} outcome=${r.outcome.replace(/ /g, '_')} tests=${r.tests.length} survived=${r.counts?.Survived ?? '-'} score=${r.score === undefined ? '-' : r.score.toFixed(3)}\n`);
  }
  const md = write();
  if (summaryFile) fs.appendFileSync(summaryFile, md);
  process.stdout.write(md);
}
