import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

// Security regression guard for the basic-ftp transitive dependency.
//
// basic-ftp reaches the tree only transitively:
//   puppeteer-core > @puppeteer/browsers > proxy-agent > pac-proxy-agent > get-uri > basic-ftp
//
// Versions <= 5.3.0 carry four HIGH advisories, all fixed in 5.3.1:
//   - GHSA-chqc-8p9q-pq6q  CVE-2026-39983  FTP command injection via CRLF (fixed 5.2.1)
//   - GHSA-6v7q-wjvx-w8wg  incomplete CRLF protection, USER/PASS + MKD bypass (fixed 5.2.2)
//   - GHSA-rpmf-866q-6p89  DoS via unbounded multiline control-response buffering
//   - GHSA-rp42-5vxx-qpwr  DoS via unbounded memory in Client.list()
//
// The fix is a bun `overrides` pin (not a phantom direct dependency): overriding
// forces EVERY basic-ftp in the tree to the safe version, including get-uri's
// nested copy. A direct-dependency bump leaves that nested copy behind — which is
// exactly the failure mode this test is here to catch. See the CVE-2026-39983
// upgrade fix for the full rationale.
const MIN_SAFE = '5.3.1';

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

describe('basic-ftp security pin (CVE-2026-39983 and siblings)', () => {
  test('package.json overrides basic-ftp to a safe version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const pin = pkg.overrides?.['basic-ftp'];
    expect(pin, 'package.json overrides.basic-ftp must exist').toBeDefined();
    const pinned = String(pin).replace(/^[\^~]/, '');
    expect(
      cmpSemver(pinned, MIN_SAFE) >= 0,
      `overrides.basic-ftp is "${pin}" but must be >= ${MIN_SAFE}`,
    ).toBe(true);
  });

  test('no basic-ftp entry in bun.lock resolves below the safe version', () => {
    const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf-8');
    // Match every resolved basic-ftp specifier, including nested paths like
    // "get-uri/basic-ftp" that a direct-dependency bump would leave vulnerable.
    const versions = [...lock.matchAll(/basic-ftp@(\d+\.\d+\.\d+)/g)].map(m => m[1]);
    expect(versions.length, 'expected at least one basic-ftp entry in bun.lock').toBeGreaterThan(0);
    const vulnerable = versions.filter(v => cmpSemver(v, MIN_SAFE) < 0);
    expect(
      vulnerable,
      `bun.lock still resolves vulnerable basic-ftp version(s): ${vulnerable.join(', ')}`,
    ).toEqual([]);
  });
});
