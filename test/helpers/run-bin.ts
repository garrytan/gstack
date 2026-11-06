/**
 * Shared spawnSync wrapper for free unit tests that shell out to bin/
 * scripts. Before this helper, ~36 test files each carried a near-identical
 * local `run()` (spawnSync + utf-8 + {status, stdout, stderr} normalization)
 * differing only in env composition, cwd, and timeout — drift-prone copies
 * of one idea.
 *
 * Free-test-only by design: nothing under the paid globs should import this,
 * so it never becomes a de facto global touchfile (paid selection is owned
 * by test/helpers/e2e-helpers.ts and friends).
 */
import { spawnSync } from 'node:child_process';

import { STATE_ROOT_VARS } from '../../lib/state-root';

export interface RunBinResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunBinOptions {
  cwd?: string;
  /** Merged over process.env (an `undefined` value deletes the key). */
  env?: Record<string, string | undefined>;
  /**
   * Isolation shorthand: points every state-root variable (GSTACK_STATE_ROOT,
   * GSTACK_HOME, GSTACK_STATE_DIR; lib/state-root.ts) here. GSTACK_STATE_ROOT
   * outranks the others, so an exported one would otherwise send the bin's
   * writes to that root instead (GST-1659).
   */
  gstackHome?: string;
  /** Also move $HOME (bins that write $HOME-anchored files, e.g. artifacts-remote pointers). */
  home?: string;
  input?: string;
  /** Default 60s — a wedged bin fails the test, never the shard wall. */
  timeoutMs?: number;
  maxBuffer?: number;
  /** Trim stdout/stderr (config-getter style bins). */
  trim?: boolean;
}

export function runBin(command: string, args: string[] = [], opts: RunBinOptions = {}): RunBinResult {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  if (opts.gstackHome !== undefined) {
    for (const name of STATE_ROOT_VARS) env[name] = opts.gstackHome;
  }
  if (opts.home !== undefined) env.HOME = opts.home;
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }

  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: env as Record<string, string>,
    encoding: 'utf-8',
    input: opts.input,
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: opts.maxBuffer,
  });

  const shape = (text: string | null | undefined): string => {
    const value = text ?? '';
    return opts.trim ? value.trim() : value;
  };
  return {
    // -1 for spawn failure/kill mirrors the strictest of the old locals: a
    // null status must never alias a real exit code.
    status: result.status ?? -1,
    stdout: shape(result.stdout),
    stderr: shape(result.stderr),
  };
}
