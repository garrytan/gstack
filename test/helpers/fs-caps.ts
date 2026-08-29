/**
 * Functional filesystem-capability probe for tests that simulate failure by
 * revoking permissions (chmod 0500 a dir, then assert writes fail).
 *
 * The existing `process.getuid?.() === 0` guards catch only literal root —
 * but containers with CAP_DAC_OVERRIDE, user-namespace sandboxes, and some
 * overlay/fuse mounts ignore mode bits for non-root users too (observed:
 * Vercel sandbox, uid 1000, writes succeed in a 0500 dir). There the
 * "unwritable" simulation silently holds nothing and the test asserts a
 * failure that never happens. This probe tests the actual behavior once per
 * process instead of guessing from the uid.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let cachedWrite: boolean | null = null;
let cachedRead: boolean | null = null;

/** True when chmod 0000 on a file actually blocks this process's reads. */
export function canRevokeReads(): boolean {
  if (cachedRead !== null) return cachedRead;
  if (process.platform === 'win32' || process.getuid?.() === 0) return (cachedRead = false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-caps-'));
  const file = path.join(dir, 'probe');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o000);
  try {
    fs.readFileSync(file);
    cachedRead = false; // read succeeded → mode bits are not enforced here
  } catch {
    cachedRead = true;
  } finally {
    fs.chmodSync(file, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return cachedRead;
}

/** True when chmod 0500 on a directory actually blocks this process's writes. */
export function canRevokeWrites(): boolean {
  if (cachedWrite !== null) return cachedWrite;
  if (process.platform === 'win32' || process.getuid?.() === 0) return (cachedWrite = false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-caps-'));
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o500);
  try {
    fs.writeFileSync(path.join(locked, 'probe'), 'x');
    cachedWrite = false; // write succeeded → mode bits are not enforced here
  } catch {
    cachedWrite = true;
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return cachedWrite;
}
