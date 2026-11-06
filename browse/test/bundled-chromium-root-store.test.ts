/**
 * #3338: the browse daemon's default headless browser (chrome-headless-shell) and the full Chromium it uses
 * for headed mode, handoff and extensions verify TLS against the Chrome Root Store compiled into the binary.
 * Chrome removed emSign ECC Root CA - G3, the root over the eight eMudhra intermediates whose keys were
 * compromised. Nobody holds that root's key, so no fixture chain can exercise it; this reads the installed
 * binaries instead. A still-trusted root (ISRG Root X1) must be present, which proves the scan reads the root
 * store and keeps a missing or relocated store from passing. Linux only: there both bundled browsers are single
 * executables; macOS keeps the full browser's store in its framework.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import { chromium } from 'playwright';

const REMOVED_ROOT = 'emSign ECC Root CA - G3';
const TRUSTED_ROOT = 'ISRG Root X1';

async function headlessShellPath(): Promise<string> {
  const server = await chromium.launchServer({ headless: true });
  try {
    return server.process().spawnfile;
  } finally {
    await server.close();
  }
}

describe.skipIf(process.platform !== 'linux')('bundled Chromium root store (#3338)', () => {
  test('neither bundled browser carries the removed eMudhra root', async () => {
    for (const file of [await headlessShellPath(), chromium.executablePath()]) {
      const binary = fs.readFileSync(fs.realpathSync(file));
      expect({ file, trustedRoot: binary.includes(TRUSTED_ROOT), removedRoot: binary.includes(REMOVED_ROOT) })
        .toEqual({ file, trustedRoot: true, removedRoot: false });
    }
  }, 30_000);
});
