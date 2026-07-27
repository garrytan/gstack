/**
 * resolveSlug portability guard (free).
 *
 * `bin/gstack-slug` is an extension-less bash script. On Windows, spawnSync
 * without a shell goes through CreateProcess, which does not honour shebangs:
 * the direct call fails with ENOENT, stdout is null, and resolveSlug used to
 * return the literal "unknown". Both consumers -- gstack-decision-log and
 * gstack-decision-search -- then read and write ~/.gstack/projects/unknown/.
 * On the write side that is one anonymous bucket shared by every repo on the
 * machine; on the read side the directory does not exist, so the search
 * returns an empty list and exits 0. The session is told there are no prior
 * decisions and re-litigates settled calls in good faith.
 *
 * Two things are pinned here, because the bug had two halves:
 *
 *   1. the fallback -- an extension-less shebang script must resolve on every
 *      platform, which is what the `bash <script>` retry buys;
 *   2. the diagnosis -- a resolution failure must be audible. A mute fallback
 *      is what let this live long enough to corrupt sessions' reasoning.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSlug } from '../lib/bin-context';

/** A stand-in for bin/gstack-slug: shebang script, deliberately no extension. */
function fakeSlugBin(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-slug-'));
  const bin = path.join(dir, 'gstack-slug-fake');
  fs.writeFileSync(bin, body);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe('resolveSlug', () => {
  test('resolves an extension-less shebang script on every platform', () => {
    const bin = fakeSlugBin('#!/usr/bin/env bash\necho "SLUG=demo-project"\necho "BRANCH=main"\n');
    expect(resolveSlug(bin)).toBe('demo-project');
  });

  test('warns on stderr rather than returning "unknown" in silence', () => {
    const missing = path.join(os.tmpdir(), 'gstack-slug-that-does-not-exist-9f3a');
    const seen: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    };
    try {
      // The fallback value is kept, so no caller breaks...
      expect(resolveSlug(missing)).toBe('unknown');
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }
    // ...but it must never be silent.
    expect(seen.join('')).toContain('could not resolve the project slug');
  });
});
