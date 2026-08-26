/**
 * v1.65.0.0 migration — remove rebrand-poisoned Chromium bundles (#2242)
 * and re-fetch a clean one, gating .done on a VERIFIED end state.
 *
 * Exercises the migration in a hermetic temp HOME + temp Playwright cache
 * (HOME / GSTACK_HOME / PLAYWRIGHT_BROWSERS_PATH all redirected) with a
 * stubbed bunx on PATH — nothing touches the real cache. Covers:
 *   - whole-revision-dir removal (INSTALLATION_COMPLETE marker included, so
 *     `playwright install` can't no-op with "is already downloaded")
 *   - clean bundles untouched
 *   - re-fetch runs from the gstack install root (repo-pinned playwright)
 *   - .done only written once a Chromium executable verifiably exists
 *   - failed re-fetch → warning + retry on next run (needs-refetch sentinel)
 *   - stranded revision dir (markers without .app) re-triggers the re-fetch
 *   - idempotent re-run after success
 *   - non-Darwin early exit
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.65.0.0.sh');

let tmpHome: string;
let fakeBinDir: string;
let pwCache: string;

const POISONED_PLIST =
  '<plist><dict><key>CFBundleName</key><string>GStack Browser</string></dict></plist>';
const CLEAN_PLIST =
  '<plist><dict><key>CFBundleName</key><string>Google Chrome for Testing</string></dict></plist>';

/** Build a Playwright-cache-shaped bundle: <revDir>/chrome-mac/<name>.app */
function makeBundle(
  revDir: string,
  opts: { plist: string; withExecutable?: boolean; withMarkers?: boolean }
): string {
  const appDir = path.join(revDir, 'chrome-mac', 'Google Chrome for Testing.app');
  const contents = path.join(appDir, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), opts.plist);
  if (opts.withExecutable) {
    const macos = path.join(contents, 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, 'Google Chrome for Testing'), '#!/bin/sh\n', {
      mode: 0o755,
    });
  }
  if (opts.withMarkers ?? true) {
    fs.writeFileSync(path.join(revDir, 'INSTALLATION_COMPLETE'), '');
    fs.writeFileSync(path.join(revDir, 'DEPENDENCIES_VALIDATED'), '');
  }
  return appDir;
}

/**
 * Stub bunx: records every invocation (args + cwd) and, unless told
 * otherwise, simulates a successful `playwright install chromium` by
 * creating a fresh revision dir with an executable in the temp cache.
 */
function makeFakeBunx(opts: { createsExecutable?: boolean } = {}): string {
  const creates = opts.createsExecutable ?? true;
  const callLog = path.join(fakeBinDir, 'bunx-calls.log');
  const script = `#!/bin/bash
echo "bunx $@ (pwd=$(pwd))" >> "${callLog}"
${
  creates
    ? `FRESH="\${PLAYWRIGHT_BROWSERS_PATH}/chromium-9999/chrome-mac/Chromium.app/Contents/MacOS"
mkdir -p "\${FRESH}"
printf '#!/bin/sh\\n' > "\${FRESH}/Chromium"
chmod 755 "\${FRESH}/Chromium"
touch "\${PLAYWRIGHT_BROWSERS_PATH}/chromium-9999/INSTALLATION_COMPLETE"`
    : '# simulates an offline / failed download: no files created'
}
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'bunx'), script, { mode: 0o755 });
  return callLog;
}

function run(extraEnv: Record<string, string> = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(MIGRATION, [], {
    env: {
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
      HOME: tmpHome,
      GSTACK_HOME: path.join(tmpHome, '.gstack'),
      PLAYWRIGHT_BROWSERS_PATH: pwCache,
      ...extraEnv,
    },
    encoding: 'utf-8',
    cwd: tmpHome,
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const doneFile = () => path.join(tmpHome, '.gstack', '.migrations', 'v1.65.0.0.done');

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-v1.65-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-v1.65-fake-'));
  pwCache = path.join(tmpHome, 'pw-cache', 'ms-playwright');
  fs.mkdirSync(pwCache, { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.gstack'), { recursive: true });
  // The migration gates on `uname -s` = Darwin; on the Linux CI runner the
  // real uname made every test early-exit with empty output. Shim Darwin so
  // the Darwin-path tests run everywhere; the non-Darwin test overwrites
  // this shim with its own Linux uname.
  fs.writeFileSync(path.join(fakeBinDir, 'uname'), '#!/bin/bash\necho Darwin\n', {
    mode: 0o755,
  });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('v1.65.0.0 migration — poisoned bundle removal', () => {
  test('poisoned revision dir removed WHOLE (markers included); clean bundle untouched; verified re-fetch → .done', () => {
    const poisonedRev = path.join(pwCache, 'chromium-1234');
    makeBundle(poisonedRev, { plist: POISONED_PLIST });
    const cleanRev = path.join(pwCache, 'chromium-5678');
    const cleanApp = makeBundle(cleanRev, { plist: CLEAN_PLIST, withExecutable: true });
    const log = makeFakeBunx();

    const r = run();
    expect(r.code).toBe(0);

    // The WHOLE revision dir is gone — .app AND the INSTALLATION_COMPLETE /
    // DEPENDENCIES_VALIDATED markers. Removing only the .app leaves markers
    // that make `playwright install chromium` no-op ("is already
    // downloaded"), stranding the user with NO browser + a success message.
    expect(fs.existsSync(poisonedRev)).toBe(false);

    // Clean bundle untouched.
    expect(fs.existsSync(path.join(cleanApp, 'Contents', 'Info.plist'))).toBe(true);
    expect(fs.existsSync(path.join(cleanRev, 'INSTALLATION_COMPLETE'))).toBe(true);

    // Re-fetch invoked...
    const calls = fs.readFileSync(log, 'utf-8');
    expect(calls).toContain('playwright install chromium');
    // ...from the gstack install root (repo-pinned playwright version), not
    // from the arbitrary cwd the migration runner happened to use.
    const realRoot = fs.realpathSync(ROOT);
    expect(calls.includes(`pwd=${ROOT}`) || calls.includes(`pwd=${realRoot}`)).toBe(true);

    // Verified end state → .done written.
    expect(fs.existsSync(doneFile())).toBe(true);
  });

  test('re-fetch produces no executable → WARNING, .done NOT written; next run retries and completes', () => {
    makeBundle(path.join(pwCache, 'chromium-1234'), { plist: POISONED_PLIST });
    const log = makeFakeBunx({ createsExecutable: false });

    const r = run();
    expect(r.code).toBe(0); // non-fatal per the migration contract
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain('bunx playwright install chromium');
    // Removal succeeded but the end state is "no browser": .done must NOT
    // be written so a re-run retries instead of recording success.
    expect(fs.existsSync(doneFile())).toBe(false);

    // Re-run with a working fetch: the pending state re-triggers the
    // re-fetch even though the scans have nothing left to remove.
    fs.rmSync(log, { force: true });
    makeFakeBunx({ createsExecutable: true });
    const r2 = run();
    expect(r2.code).toBe(0);
    expect(fs.readFileSync(log, 'utf-8')).toContain('playwright install chromium');
    expect(fs.existsSync(doneFile())).toBe(true);
  });

  test('stranded revision dir (install markers, no .app) re-triggers removal + re-fetch', () => {
    // The state an older version of this migration could leave behind:
    // .app removed, INSTALLATION_COMPLETE still present → `playwright
    // install` no-ops while the user has no browser at all.
    const strandedRev = path.join(pwCache, 'chromium-1234');
    fs.mkdirSync(path.join(strandedRev, 'chrome-mac'), { recursive: true });
    fs.writeFileSync(path.join(strandedRev, 'INSTALLATION_COMPLETE'), '');
    const log = makeFakeBunx();

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(strandedRev)).toBe(false);
    expect(fs.readFileSync(log, 'utf-8')).toContain('playwright install chromium');
    expect(fs.existsSync(doneFile())).toBe(true);
  });

  test('clean cache → no-op, no bunx call, .done written', () => {
    const cleanRev = path.join(pwCache, 'chromium-5678');
    const cleanApp = makeBundle(cleanRev, { plist: CLEAN_PLIST, withExecutable: true });
    const log = makeFakeBunx();

    const r = run();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('no-op');
    expect(fs.existsSync(log)).toBe(false); // bunx never invoked
    expect(fs.existsSync(path.join(cleanApp, 'Contents', 'Info.plist'))).toBe(true);
    expect(fs.existsSync(doneFile())).toBe(true);
  });

  test('second run after success → silent no-op (no rescan, no bunx)', () => {
    makeBundle(path.join(pwCache, 'chromium-1234'), { plist: POISONED_PLIST });
    const log = makeFakeBunx();
    const r1 = run();
    expect(r1.code).toBe(0);
    expect(fs.existsSync(doneFile())).toBe(true);

    fs.rmSync(log, { force: true });
    const r2 = run();
    expect(r2.code).toBe(0);
    expect(r2.stderr).toBe('');
    expect(fs.existsSync(log)).toBe(false);
  });

  test('non-Darwin → early exit, cache untouched, no bunx, .done written', () => {
    const poisonedApp = makeBundle(path.join(pwCache, 'chromium-1234'), {
      plist: POISONED_PLIST,
    });
    makeFakeBunx();
    // The script gates on `uname -s` != Darwin; shadow uname on PATH.
    fs.writeFileSync(path.join(fakeBinDir, 'uname'), '#!/bin/bash\necho Linux\n', {
      mode: 0o755,
    });

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(poisonedApp)).toBe(true); // nothing removed
    expect(fs.existsSync(path.join(fakeBinDir, 'bunx-calls.log'))).toBe(false);
    expect(fs.existsSync(doneFile())).toBe(true);
  });
});
