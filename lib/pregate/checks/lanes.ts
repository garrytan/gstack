/**
 * pregate check `lanes` (tier 1, tests stage): the touched files map to test
 * files (lib/pregate/lane-selection.ts); the local ones run under
 * `set -o pipefail` with the exit code and the runner's own summary judged
 * (zero tests ran is a failure, exit 0 or not); platform lanes this machine
 * cannot run become persisted `requires-remote` obligations. A touched file
 * with no lane is `FAIL lanes — <file> has no test lane`, never a pass.
 * Incidents: p0-4-pipe-hidden-failure (`false | tail` read as green),
 * p0-4-windows-lane-unrun (a Windows-only change merged with its lane unrun).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { selectLanes, type Selection } from '../lane-selection';
import type { CheckDef, CheckResult, PregateContext } from '../types';

/** The test command with `{files}`; detected from the repo when the config does not name one. */
export function detectRunner(ctx: PregateContext, files: readonly string[]): string | null {
  if (ctx.config.runner) return ctx.config.runner;
  const has = (f: string) => fs.existsSync(path.join(ctx.repoRoot, f));
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (has('bunfig.toml') || has('bun.lock') || has('bun.lockb')) return 'bun test {files}';
  if (deps.vitest) return 'npx vitest run {files}';
  if (deps.jest) return 'npx jest {files}';
  if (files.every(f => /\.py$/.test(f)) && files.length) return 'python3 -m pytest {files}';
  if (files.every(f => /\.[cm]?js$/.test(f)) && files.length) return 'node --test {files}';
  if (files.every(f => /\.[cm]?[jt]sx?$/.test(f)) && files.length && Bun.which('bun')) return 'bun test {files}';
  return null;
}

export interface RunnerSummary { ran: number | null; failed: number | null }

/** The runner's own summary line: bun, node --test, vitest, jest, pytest. null when not recognised. */
export function parseSummary(output: string): RunnerSummary {
  let m: RegExpExecArray | null;
  if ((m = /^\s*(?:#|ℹ)\s*tests\s+(\d+)/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(?:#|ℹ)\s*fail\s+(\d+)/m.exec(output)?.[1] ?? 0) };
  if ((m = /Ran\s+(\d+)\s+tests?\s+across/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(\d+)\s+fail\b/m.exec(output)?.[1] ?? 0) };
  if ((m = /^\s*(\d+)\s+pass\s*$/m.exec(output))) return { ran: Number(m[1]) + Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0), failed: Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0) };
  if ((m = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/.exec(output))) return { ran: Number(m[3]), failed: Number(m[1] ?? 0) };
  if ((m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  if (/no tests ran/.test(output) || /No tests found/i.test(output)) return { ran: 0, failed: 0 };
  if ((m = /(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  return { ran: null, failed: null };
}

function runLocal(ctx: PregateContext, runner: string, files: string[]): { exit: number | null; ran: number | null; failed: number | null; log: string; tail: string[]; command: string } {
  const command = runner.replace('{files}', files.map(f => `'${f.replace(/'/g, `'\\''`)}'`).join(' '));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-lanes-'));
  const log = path.join(dir, 'lanes.log');
  const r = spawnSync('bash', ['-c', `set -o pipefail; ${command}`], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: ctx.timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...ctx.env, CI: ctx.env.CI ?? '1' } });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  fs.writeFileSync(log, `$ ${command}\n${output}`);
  const summary = parseSummary(output);
  return { exit: r.status, ...summary, log, tail: output.trim().split('\n').slice(-25), command };
}

function describe(sel: Selection): string[] {
  const lines = sel.noLane.map(f => `FAIL lanes — ${f} has no test lane`);
  for (const r of sel.remote) lines.push(`requires-remote ${r.lane} (${r.platform}): ${r.tests.length} test(s) — ${r.tests.slice(0, 8).join(' ')}${r.tests.length > 8 ? ' …' : ''}`);
  lines.push(`Tiers ran: ${sel.tiersRan.join(' ') || '(none)'}; requires-remote: ${[...new Set(sel.remote.map(r => r.platform))].join(' ') || 'none'}`);
  return lines;
}

function run(ctx: PregateContext): CheckResult {
  const sel = selectLanes(ctx);
  ctx.explain.push(...sel.provenance);
  for (const [lane, set] of Object.entries(sel.laneSets)) ctx.explain.push(`lane ${lane}: ${set === '?' ? 'file set unknown' : `${set.length} files`}`);
  const inputs = baseInputs(ctx, { selection: sha256(sel.tests.join('\n')), localTests: sha256(sel.localTests.join('\n')), remote: sha256(sel.remote.map(r => `${r.lane}:${r.tests.join(',')}`).join('\n')) });
  const lines = describe(sel);
  const base: CheckResult = { id: 'lanes', stage: 'tests', status: 'pass', inputs, lines, remote: sel.remote };
  if (sel.noLane.length) {
    return { ...base, status: 'fail', code: 'PREGATE_NO_LANE', detail: `${sel.noLane.length} touched file(s) with no test lane: ${sel.noLane.join(' ')}`, fix: 'add a test that names the file, or declare its lane (or []) under dependencies in .gstack/pregate.json' };
  }
  if (sel.tests.length === 0) return { ...base, detail: ctx.touched.length ? 'nothing touched selects a test' : 'no touched files' };
  if (!ctx.allowRepoCommands) return { ...base, status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', detail: `${sel.localTests.length} local test file(s) selected but not run (pass --allow-repo-commands)`, fix: 'rerun with --allow-repo-commands (what /ship passes)' };
  if (sel.localTests.length === 0) return { ...base, status: sel.remote.length ? 'requires-remote' : 'pass', detail: `no local lane; ${sel.remote.length} requires-remote obligation(s)` };
  const runner = detectRunner(ctx, sel.localTests);
  if (!runner) return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `no test runner detected for ${sel.localTests.length} selected file(s)`, fix: 'declare `runner` (with {files}) in .gstack/pregate.json' };
  const r = runLocal(ctx, runner, sel.localTests);
  const runLines = [...lines, `ran: ${r.command.length > 200 ? `${r.command.slice(0, 200)}…` : r.command}`, `log: ${r.log}`, ...r.tail.map(l => `  ${l}`)];
  const withRun = { ...base, lines: runLines, inputs: { ...inputs, command: sha256(r.command) } };
  if (r.exit === null) return { ...withRun, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `local lane timed out after ${ctx.timeoutMs} ms (${sel.localTests.length} files)`, fix: 'raise --timeout or split the selection; a timed-out lane never passes' };
  if (r.exit !== 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `local lane exited ${r.exit} (${r.failed ?? '?'} failed of ${r.ran ?? '?'} ran; ${sel.localTests.length} files; pipefail)`, fix: `read ${r.log}, fix the in-branch failure, rerun gstack-pregate --stage tests` };
  if (r.ran === 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `ZERO-RUN: the runner reported 0 tests for ${sel.localTests.length} selected file(s)`, fix: 'a bad selector, a missing file or a skipped describe; exit 0 is not a pass' };
  const detail = `${r.ran ?? 'count unavailable'} tests ran in ${sel.localTests.length} file(s), exit 0${sel.remote.length ? `; ${sel.remote.length} requires-remote obligation(s)` : ''}`;
  return { ...withRun, status: sel.remote.length ? 'requires-remote' : 'pass', detail };
}

export const lanesCheck: CheckDef = { id: 'lanes', stage: 'tests', tier: 1, downgradable: true, needsRepoCommands: true, run };
