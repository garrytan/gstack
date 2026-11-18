/**
 * spawnSync that never hands back cut-off output as a finished read (GST-3086).
 *
 * Bun's node:child_process spawnSync can return status 0 together with error
 * ENOBUFS and stdout cut near maxBuffer: when the child exits before the
 * overflow kill lands (or ignores SIGTERM), the exit status is the child's own
 * clean exit (seen on Bun 1.4.2 and 1.4.4, GSTA-618, #4490). The default
 * maxBuffer is 1 MiB, so every buffered call has a limit. A caller that checks
 * only `status` then treats part of a diff, a file list or a scan input as the
 * whole answer. execFileSync and execSync throw in that case; spawnSync does not.
 *
 * This keeps Node's signature and result. When `error` is set and `status` is
 * not null, or the error is ENOBUFS, it returns `status: null` (so a
 * `status === 0` check fails closed), keeps `error.code`, and names
 * SPAWN_OUTPUT_INCOMPLETE in `error.message` and on the end of a captured stderr.
 */
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resultLine } from './result-codes';

export const spawnSync = ((...args: unknown[]) => {
  const r = (nodeSpawnSync as (...a: unknown[]) => SpawnSyncReturns<string | Buffer>)(...args);
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (!r.error || (r.status === null && code !== 'ENOBUFS')) return r;
  const line = resultLine(String(args[0]), 'SPAWN_OUTPUT_INCOMPLETE', `${code ?? r.error.message}, exit ${r.status ?? r.signal ?? 'unknown'}`);
  r.error.message = `${r.error.message} (SPAWN_OUTPUT_INCOMPLETE)`;
  const stderr = typeof r.stderr === 'string' ? `${r.stderr}${r.stderr && !r.stderr.endsWith('\n') ? '\n' : ''}${line}\n`
    : Buffer.isBuffer(r.stderr) ? Buffer.concat([r.stderr, Buffer.from(`${r.stderr.length && r.stderr[r.stderr.length - 1] !== 10 ? '\n' : ''}${line}\n`)])
    : r.stderr;
  return { ...r, status: null, stderr };
}) as typeof nodeSpawnSync;
