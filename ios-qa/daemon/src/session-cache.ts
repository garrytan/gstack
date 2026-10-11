// Persisted session bearer. A successful bootstrap consumes the app's one-shot
// boot token, so a restarted daemon used to have no way back in except
// relaunching the app, which wipes its QA state (#1796). The daemon now keeps
// the rotated bearer in $GSTACK_STATE_ROOT/ios-qa-session.json and a fresh
// daemon process resumes it once, at its first tunnel request.
//
// The boot token is never written here. The bearer is bound to the device,
// app and port that issued it and is only ever sent through recoverTunnel in
// pinned-address mode: to the address devicectl reports for that UDID, after
// /healthz names the same bundle. It is presented at most once per daemon
// process, and the file is cleared before every bootstrap, so a rejected or
// foreign bearer is never replayed.

import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveStateRoot } from '../../../lib/state-root';
import { recoverTunnel, type RecoveryOptions, type TunnelRecovery } from './tunnel-bootstrap';
import type { DeviceTunnel } from './proxy';

export interface PersistedSession {
  version: 1;
  udid: string;
  bundle_id: string;
  port: number;
  bearer: string;
  created_at: string;
}

export function defaultSessionPath(): string {
  return join(resolveStateRoot(), 'ios-qa-session.json');
}

/** Read the persisted session. A file that is not private to this user, or not valid, is removed unused. */
export function readSession(path: string): { session: PersistedSession | null; discarded?: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { session: null };
  }
  const discard = (reason: string) => {
    clearSession(path);
    return { session: null, discarded: reason };
  };
  if (!st.isFile()) return discard('it is not a regular file');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return discard(`it is owned by uid ${st.uid}`);
    if ((st.mode & 0o077) !== 0) return discard(`other users can access it (mode ${(st.mode & 0o777).toString(8)})`);
  }
  let parsed: Partial<PersistedSession>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PersistedSession>;
  } catch {
    return discard('it is not valid JSON');
  }
  if (
    parsed?.version !== 1
    || typeof parsed.udid !== 'string' || !parsed.udid
    || typeof parsed.bundle_id !== 'string' || !parsed.bundle_id
    || !Number.isInteger(parsed.port)
    || typeof parsed.bearer !== 'string' || !parsed.bearer
  ) {
    return discard('it does not hold a version 1 session');
  }
  return { session: parsed as PersistedSession };
}

/** Write the session owner-only through a fresh temp file, so an existing file's mode or link never applies. */
export function writeSession(tunnel: DeviceTunnel, bundleId: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const session: PersistedSession = {
    version: 1,
    udid: tunnel.udid,
    bundle_id: bundleId,
    port: tunnel.port,
    bearer: tunnel.bootTokenRotated,
    created_at: new Date().toISOString(),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

/** Best effort: a directory at the path stays, and writeSession then reports it. */
export function clearSession(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

/**
 * Decide whether a new daemon process can resume the persisted bearer. Only
 * a session bound to the configured app, port and (when pinned) UDID is
 * probed, and only through recoverTunnel's pinned-address mode.
 */
export async function resumeSession(
  path: string,
  opts: Omit<RecoveryOptions, 'pinnedAddressOnly'> & { port: number },
): Promise<TunnelRecovery> {
  const { session, discarded } = readSession(path);
  if (discarded) {
    return { action: 'bootstrap', reason: `ignored ${path} because ${discarded}` };
  }
  if (!session) return { action: 'bootstrap', reason: `no persisted session at ${path}` };
  if (session.bundle_id !== opts.bundleId || session.port !== opts.port || (opts.udid && session.udid !== opts.udid)) {
    return {
      action: 'bootstrap',
      reason: `persisted session belongs to ${session.bundle_id} on ${session.udid} port ${session.port}, not this target`,
    };
  }
  return recoverTunnel(
    { udid: session.udid, ipv6Addr: '', port: session.port, bootTokenRotated: session.bearer },
    { ...opts, pinnedAddressOnly: true },
  );
}
