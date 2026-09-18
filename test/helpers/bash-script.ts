/**
 * Run an assembled bash script from a TEMP FILE — never via `bash -c <argv>`.
 *
 * Why: the setup harnesses slice functions out of `setup` and join them into
 * one script. On Windows, bash is an MSYS2 program; when its parent is a
 * non-MSYS process (bun), msys-2.0.dll's build_argv() runs every argument
 * containing any of `?*["'(){}` through globify()/glob(). glob() copies the
 * pattern into a fixed `Char patbuf[8192]` and silently stops after
 * 8192 - MB_CUR_MAX (8186 characters under C.UTF-8); GLOB_NOCHECK then hands
 * the truncated text to bash as the argument. Observed on windows-free-tests
 * when the alias harness grew from 6.7 KB to 15.7 KB: the `-c` script was cut
 * inside a single-quoted token on line 178 ("unexpected EOF while looking for
 * matching `'"). A short, glob-character-free file path never enters
 * globify, and bash reads the file's bytes directly, so quoting and encoding
 * are never re-parsed by any argument layer. The same ~8186-char ceiling
 * applies to any MSYS tool (sh, sed, awk, grep) spawned from bun on Windows
 * with a long single argument.
 *
 * `timeout` is always set (test/spawnsync-timeout-tripwire.test.ts).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BashScriptResult {
  status: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

export interface BashScriptOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function runBashScript(script: string, opts: BashScriptOptions = {}): BashScriptResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bash-script-'));
  const file = path.join(dir, 'script.sh');
  // LF only: a stray CR would reach bash as part of a token.
  fs.writeFileSync(file, script.replace(/\r\n/g, '\n'));
  try {
    const r = spawnSync('bash', [file], {
      encoding: 'utf-8',
      timeout: opts.timeout ?? 60_000,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    // A spawn failure (bash missing) or a timeout kill has no bash stderr of
    // its own; surface the cause instead of a bare status -1.
    const stderr = (r.stderr ?? '') + (r.error ? `\n[spawn] ${r.error.message}` : '');
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr, signal: r.signal ?? null };
  } finally {
    // Best-effort: an AV scanner or indexer still holding script.sh on
    // Windows must never turn a good result into an unlink error.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
}
