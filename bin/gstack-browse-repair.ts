#!/usr/bin/env bun
/** Repair the Playwright browser cache used by gstack browse. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const MAX_INSTALL_MS = 300_000;

type BrowserSpec = { name: string; revision: string; browserVersion: string };

function fail(message: string): never {
  console.error(`[browse-repair] ${message}`);
  process.exit(1);
}

function readSpec(name: string): BrowserSpec {
  const file = path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { browsers: BrowserSpec[] };
  const spec = data.browsers.find(browser => browser.name === name);
  if (!spec) fail(`Playwright browser spec ${name} not found`);
  return spec;
}

function expectedExecutable(spec: BrowserSpec): string | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  if (spec.name === 'chromium') {
    return path.join(CACHE, `chromium-${spec.revision}`, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  }
  if (spec.name === 'chromium-headless-shell') {
    return path.join(CACHE, `chromium_headless_shell-${spec.revision}`, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  }
  return null;
}

function installationDirectory(spec: BrowserSpec): string {
  return spec.name === 'chromium'
    ? path.join(CACHE, `chromium-${spec.revision}`)
    : path.join(CACHE, `chromium_headless_shell-${spec.revision}`);
}

function isHealthy(spec: BrowserSpec): boolean {
  const executable = expectedExecutable(spec);
  if (!executable || !fs.existsSync(executable)) return false;
  if (!fs.existsSync(path.join(installationDirectory(spec), 'INSTALLATION_COMPLETE'))) return false;
  const result = Bun.spawnSync([executable, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  return result.exitCode === 0;
}

function archiveUrl(spec: BrowserSpec): string | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  const archive = spec.name === 'chromium'
    ? 'chrome-mac-arm64.zip'
    : spec.name === 'chromium-headless-shell'
      ? 'chrome-headless-shell-mac-arm64.zip'
      : null;
  return archive ? `https://storage.googleapis.com/chrome-for-testing-public/${spec.browserVersion}/mac-arm64/${archive}` : null;
}

async function repairMacArtifact(spec: BrowserSpec): Promise<void> {
  const url = archiveUrl(spec);
  const executable = expectedExecutable(spec);
  if (!url || !executable) fail(`no direct repair path for ${process.platform}/${process.arch}`);
  const installDir = installationDirectory(spec);
  if (fs.existsSync(installDir)) {
    const backup = `${installDir}.incomplete-${Date.now()}`;
    fs.renameSync(installDir, backup);
    console.error(`[browse-repair] preserved incomplete cache at ${backup}`);
  }
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const archive = path.join(os.tmpdir(), `gstack-${spec.name}-${spec.revision}-${process.pid}.zip`);
  try {
    // macOS ships curl, and its file-backed transfer avoids buffering a
    // 150MB+ Chromium archive inside Bun. The earlier fetch + Bun.write path
    // could spin indefinitely while materializing a large Response object.
    const download = Bun.spawnSync([
      'curl', '--fail', '--location', '--silent', '--show-error',
      '--max-time', String(MAX_INSTALL_MS / 1000), '--output', archive, url,
    ], { stdout: 'pipe', stderr: 'pipe', timeout: MAX_INSTALL_MS + 5_000 });
    if (download.exitCode !== 0) {
      fail(`download failed for ${spec.name}: ${download.stderr.toString().trim() || 'timed out'}`);
    }
    const unpack = Bun.spawnSync(['ditto', '-x', '-k', archive, installDir], { stdout: 'pipe', stderr: 'pipe', timeout: MAX_INSTALL_MS });
    if (unpack.exitCode !== 0) fail(`could not unpack ${spec.name}: ${unpack.stderr.toString().trim()}`);
  } finally {
    try { fs.unlinkSync(archive); } catch {}
  }
  if (!expectedExecutable(spec) || !fs.existsSync(expectedExecutable(spec)!)) {
    fail(`${spec.name} still failed its executable health check`);
  }
  // Playwright's registry only recognizes browser directories carrying this
  // marker. Without it, a later installer/GC can discard a working repair.
  fs.writeFileSync(path.join(installDir, 'INSTALLATION_COMPLETE'), '', { mode: 0o600 });
  if (!isHealthy(spec)) fail(`${spec.name} still failed its registry health check`);
}

function repairViaPlaywright(): void {
  const cli = path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js');
  const result = Bun.spawnSync(['node', cli, 'install', 'chromium', 'chromium-headless-shell'], {
    stdout: 'pipe', stderr: 'pipe', timeout: MAX_INSTALL_MS,
  });
  if (result.exitCode !== 0) fail(`Playwright install failed: ${result.stderr.toString().trim() || 'timed out'}`);
}

const repair = process.argv.slice(2).includes('--repair');
// The direct executable health check below is intentionally macOS/Apple
// Silicon-specific. Other Playwright platforms use different archive layouts;
// defer their validation/install semantics to Playwright's own CLI rather than
// declaring a healthy cache broken on every setup run.
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  if (repair) repairViaPlaywright();
  console.log('[browse-repair] Playwright browser repair delegated to Playwright');
  process.exit(0);
}
const specs = [readSpec('chromium'), readSpec('chromium-headless-shell')];
const unhealthy = specs.filter(spec => !isHealthy(spec));
if (!unhealthy.length) {
  console.log('[browse-repair] Playwright browser cache is healthy');
  process.exit(0);
}
if (!repair) fail(`missing or unhealthy: ${unhealthy.map(spec => spec.name).join(', ')} (run with --repair)`);

for (const spec of unhealthy) await repairMacArtifact(spec);

const stillUnhealthy = specs.filter(spec => !isHealthy(spec));
if (stillUnhealthy.length) fail(`repair incomplete: ${stillUnhealthy.map(spec => spec.name).join(', ')}`);
console.log('[browse-repair] Playwright browser cache repaired');
