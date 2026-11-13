/**
 * pregate's docs-only route (R81; docs/pregate.md#docs-only). When lib/docs-only.ts classifies the change from the
 * merge base with origin/<base> to the working tree as human docs only, the lanes check runs the docs lane here
 * instead of the test lanes: links on added lines must resolve, and the tests that read docs by directory
 * (DOCS_READER_TESTS, those present in this repository) run locally. It owes no remote gate, so no CI carry is needed;
 * pregate's regen (generated-page freshness) and secrets (credential scan) checks run as always.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../bun-isolation';
import { addedLines, brokenLinks } from '../doc-links';
import { classifyDocsOnly } from '../docs-only';
import { explicitPath } from '../test-paths';
import type { CheckResult, PregateContext } from './types';

/** The lanes result for a docs-only change, or null when the change is not docs-only (or cannot be classified). */
export function docsOnlyLane(ctx: PregateContext, base: CheckResult): CheckResult | null {
  const ref = `origin/${ctx.base}`;
  let r;
  try { r = classifyDocsOnly({ root: ctx.repoRoot, base: ref }); } catch { return null; }
  if (!r.docsOnly) return null;
  ctx.explain.push(`docs-only: ${r.files.length} file(s) (lib/docs-only.ts); the test lanes are not owed`);
  const md = r.files.filter(f => /\.md$/i.test(f) && fs.existsSync(path.join(ctx.repoRoot, f)));
  let broken;
  try {
    const mb = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    broken = brokenLinks(ctx.repoRoot, md, addedLines(ctx.repoRoot, mb || ref, md));
  } catch (e) {
    return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `docs-only: the link check could not read the diff: ${(e as Error).message}`, fix: `git fetch origin ${ctx.base}, then rerun gstack-pregate` };
  }
  const lines = [...(base.lines ?? []), `docs-only: ${r.files.join(' ')}`, ...broken.map(b => `${b.file}:${b.line}: ${b.target}: ${b.reason}`)];
  if (broken.length) return { ...base, lines, status: 'fail', cause: 'diff', code: 'PREGATE_LANE_FAILED', detail: `docs-only: ${broken.length} broken link(s) on added lines`, fix: 'correct each link or add the heading it names, then rerun gstack-pregate' };
  const tests = r.tests.filter(t => fs.existsSync(path.join(ctx.repoRoot, t)));
  const done = (detail: string): CheckResult => ({ ...base, lines, status: 'pass', remote: [], detail });
  if (!tests.length) return done(`docs-only: ${r.files.length} file(s); links on added lines resolve; no docs reader tests; the test suites are not owed`);
  if (!ctx.allowRepoCommands) return { ...base, lines, status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', detail: `docs-only: ${tests.length} docs reader test file(s) selected but not run (pass --allow-repo-commands)`, fix: 'rerun with --allow-repo-commands (what /ship passes)' };
  const run = spawnSync(process.execPath, [...bunIsolationArgs(), 'test', '--timeout=30000', ...tests.map(explicitPath)], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  if (run.status !== 0) return { ...base, lines: [...lines, tail], status: 'fail', cause: 'diff', code: 'PREGATE_LANE_FAILED', detail: `docs-only: docs reader tests failed (${run.error ? run.error.message : `exit ${run.status}`})`, fix: `bun test ${tests.map(explicitPath).join(' ')}` };
  return done(`docs-only: ${r.files.length} file(s); links on added lines resolve; ${tests.length} docs reader test file(s) passed; the test suites are not owed`);
}
