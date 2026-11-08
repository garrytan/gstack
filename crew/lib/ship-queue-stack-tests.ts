/**
 * `train build --dry-run --stack-tests`: before a train spends a gate, run
 * each PR's new test files on the integrated prefix that includes it (T<k>,
 * the merge of main and every slot up to and including the PR), not on the
 * PR head alone. A test that passes on its branch and fails once an earlier
 * slot changed what it reads is a stack red, caught here for the price of a
 * few test files instead of a gate. Each prefix is checked out in a scratch
 * worktree (the repo's node_modules linked in when it has one), the files run
 * with the test command (`bun --no-env-file --config=/dev/null test` by
 * default; `--stack-tests-command "<cmd>"` for another runner, the files
 * appended), and the worktree is removed. A PR that adds no test file is
 * reported as such and never fails.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from '../../lib/bun-isolation';
import { git } from './ship-queue-gate';
import type { TrainPrefix, TrainSlot } from './ship-queue-train-record';

export const DEFAULT_STACK_TEST_COMMAND = ['bun', ...bunIsolationArgs(), 'test'];
/** Bun's own test-file rule: the name ends in `.test`, `_test`, `.spec` or `_spec` before its extension; a helper or fixture under test/ is not a test file and would make `bun test <file>` exit 1 for matching nothing. */
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

export interface StackTestResult { pr: string; prefix: number; files: string[]; ok: boolean; detail: string }

/** Test files the PR adds relative to the base (added, not modified). */
export function newTestFiles(repoRoot: string, baseSha: string, head: string): string[] {
  const r = git(repoRoot, ['diff', '--name-only', '--diff-filter=A', `${baseSha}...${head}`]);
  return r.ok ? r.out.split('\n').map(s => s.trim()).filter(f => f && TEST_FILE.test(f)) : [];
}

export function stackTests(repoRoot: string, baseSha: string, slots: TrainSlot[], prefixes: TrainPrefix[], command: string[] = DEFAULT_STACK_TEST_COMMAND, timeoutMs = 600_000): StackTestResult[] {
  const results: StackTestResult[] = [];
  for (const [i, slot] of slots.entries()) {
    const prefix = prefixes[i + 1];
    if (!prefix) break;
    const files = newTestFiles(repoRoot, baseSha, slot.head);
    if (!files.length) { results.push({ pr: slot.pr, prefix: prefix.index, files, ok: true, detail: 'no new test files' }); continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stack-tests-'));
    try {
      const add = git(repoRoot, ['worktree', 'add', '--detach', '-q', dir, prefix.commit]);
      if (!add.ok) { results.push({ pr: slot.pr, prefix: prefix.index, files, ok: false, detail: `cannot check out T${prefix.index}: ${add.err.slice(0, 160)}` }); continue; }
      const modules = path.join(repoRoot, 'node_modules');
      if (fs.existsSync(modules) && !fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir');
      const [bin, ...args] = command;
      const run = spawnSync(bin!, [...args, ...files.map(f => `./${f}`)], { cwd: dir, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: process.env.CI ?? '1' }, maxBuffer: 64 * 1024 * 1024 });
      const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').filter(l => /^\(fail\)|^\s*\d+ (pass|fail)$|^error:/.test(l)).slice(-6).join('; ');
      results.push({ pr: slot.pr, prefix: prefix.index, files, ok: run.status === 0, detail: run.status === 0 ? 'pass' : run.error ? `${run.error.message}` : tail || `exit ${run.status}` });
    } finally {
      git(repoRoot, ['worktree', 'remove', '--force', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}

/** One `STACK_TESTS:` line per slot. */
export function stackTestLine(r: StackTestResult): string {
  if (!r.files.length) return `STACK_TESTS: #${r.pr} T${r.prefix} no new test files`;
  return `STACK_TESTS: #${r.pr} T${r.prefix} ${r.files.length} new test file(s) ${r.ok ? 'pass' : 'FAIL'} (${r.files.join(', ')})${r.ok ? '' : `: ${r.detail}`}`;
}
