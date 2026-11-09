/**
 * Selected test files the configured JS runner's own config leaves out
 * (GST-2146). A vitest `include`/`exclude` or a jest `testMatch`/
 * `testPathIgnorePatterns` can keep a directory out of the default run, often
 * behind an env var (alphaclaw's tests/live and tests/container run only under
 * OPENCLAW_LIVE_E2E=1). Handed such a file, vitest exits 1 on "No test files
 * found" and jest on "No tests found", which the lane read as a failed test;
 * beside other files, the runner skips it silently and the lane counted it as
 * run. Two answers, both from the runner itself rather than a parse of its
 * config, so the config's env-gated branches resolve as they would here:
 * `excludedByConfig` asks the runner which of a group's files it would run
 * (`vitest list --filesOnly`, `jest --listTests`) before the lane runs, and
 * `noTestFilesFound` reads a run that still ended on that message. Either way
 * the files are not applicable here: not run, not counted as covered, never a
 * failure. Any doubt (another runner, a listing that fails or cannot be read,
 * a file missing from disk) leaves the files to run as before.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runBashSync } from '../script-invocation';

const VITEST_RUN = /(?<![\w-])vitest\s+run(?![\w-])/;
const JEST = /(?<![\w-])jest(?![\w-])/;
const NO_FILES = /^\s*(No test files found|No tests found), exiting with code 1\b.*$/m;
const quote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Files a runner's config leaves out of a run, and why. */
export interface NotApplicable { files: string[]; reason: string }

/**
 * The listing command for `runner` with `files`: vitest's `list --filesOnly` (its JSON written to `out`) for a `vitest run`
 * command, jest's `--listTests --json` for a jest one; null for any other runner, which runs every file as before.
 */
export function listCommand(runner: string, files: readonly string[], out: string): string | null {
  const joined = files.map(quote).join(' ');
  if (VITEST_RUN.test(runner)) return runner.replace(VITEST_RUN, `vitest list --filesOnly --json=${quote(out)}`).replace('{files}', () => joined);
  if (JEST.test(runner) && !/--listTests\b/.test(runner)) return runner.replace(JEST, 'jest --listTests --json').replace('{files}', () => joined);
  return null;
}

/**
 * The files of a run group (`files` relative to `cwd`) the runner's config would not run, asked of the runner in the lane's
 * own environment. Null when the runner has no listing command, the listing fails, times out or prints nothing readable,
 * or every file is listed: then every file runs.
 */
export function excludedByConfig(runner: string, cwd: string, files: readonly string[], env: NodeJS.ProcessEnv, scratch: string, timeoutMs: number): NotApplicable | null {
  const out = path.join(scratch, `list-${process.pid}-${Date.now()}.json`);
  const command = listCommand(runner, files, out);
  if (!command) return null;
  const r = runBashSync(command, { cwd, env: { ...env, CI: env.CI ?? '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  let listed: unknown;
  try { listed = JSON.parse(VITEST_RUN.test(runner) ? fs.readFileSync(out, 'utf8') : r.stdout.trim()); } catch { return null; } finally { fs.rmSync(out, { force: true }); }
  if (!Array.isArray(listed)) return null;
  const paths = listed.map(e => (typeof e === 'string' ? e : typeof e?.file === 'string' ? e.file : null));
  if (paths.some(p => p === null)) return null;
  const runs = new Set(paths.map(p => real(path.resolve(cwd, p as string))));
  const excluded = files.filter(f => !runs.has(real(path.join(cwd, f))));
  if (!excluded.length) return null;
  const tool = VITEST_RUN.test(runner) ? 'vitest list --filesOnly' : 'jest --listTests';
  return { files: excluded, reason: `the runner's config excludes them: \`${tool}\` does not list them in this environment` };
}

/**
 * A run that exited non-zero with no test summary on the runner's own "No test files found" (vitest) or "No tests found"
 * (jest), for files that all exist under `cwd`: the config excluded every one, and the message (with the include and
 * exclude lines vitest prints after it) is the reason. Null otherwise; a missing file still fails as a bad selector.
 */
export function noTestFilesFound(output: string, cwd: string, files: readonly string[]): string | null {
  const m = NO_FILES.exec(output);
  if (!m || !files.length || !files.every(f => fs.existsSync(path.join(cwd, f)))) return null;
  const patterns = output.slice(m.index).split('\n').map(l => l.trim()).filter(l => /^(include|exclude|testMatch|testPathIgnorePatterns|testRegex):/.test(l));
  return `the runner's config excludes them: the runner said "${m[1]}"${patterns.length ? ` (${patterns.join('; ').replace(/\s+/g, ' ')})` : ''}`;
}
