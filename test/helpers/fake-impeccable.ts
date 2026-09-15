/**
 * Install test/fixtures/fake-impeccable.ts as an executable `impeccable` in a
 * fresh temp dir OUTSIDE any repo (the wrapper refuses an in-repo IMPECCABLE_BIN
 * by design). Shared by the unit and E2E suites so the shim is set up one way.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const IMPECCABLE_FAKE_SRC = path.join(import.meta.dir, '..', 'fixtures', 'fake-impeccable.ts');
export const DETECT_SAMPLE = path.join(import.meta.dir, '..', 'fixtures', 'impeccable-detect-sample.json');

export function installFakeImpeccable(prefix = 'gstack-fake-impeccable-'): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = path.join(dir, 'impeccable');
  fs.copyFileSync(IMPECCABLE_FAKE_SRC, bin);
  fs.chmodSync(bin, 0o755);
  fs.copyFileSync(DETECT_SAMPLE, path.join(dir, 'impeccable-detect-sample.json')); // the shim's documented default output, beside it
  return { dir, bin };
}
