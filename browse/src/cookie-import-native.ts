import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import path from 'node:path';
import { CookieImportError, normalizeCookieDomain, type PlaywrightCookie } from './cookie-import-browser';
import { hashNativeFile, nativeCodeHashes, nativeCodeMatches, readNativeQualifications, type NativeQualifiedBuild } from './cookie-import-native-integrity';

type BrowserName = 'Chrome' | 'Chromium' | 'Brave' | 'Edge';

export function nativeBrowserPaths(browserName: string, env: NodeJS.ProcessEnv): {
  name: BrowserName;
  userDataDir: string;
  executables: string[];
} {
  const get = (key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const local = get('LOCALAPPDATA');
  if (!local || !path.win32.isAbsolute(local)) {
    throw new CookieImportError('The Windows browser data location is unavailable. Sign in manually in the gstack browser.', 'native_profile_unsupported');
  }
  const pf = get('PROGRAMFILES') || 'C:\\Program Files';
  const pf86 = get('PROGRAMFILES(X86)') || 'C:\\Program Files (x86)';
  const mappings = {
    chrome: { name: 'Chrome', root: ['Google', 'Chrome'], exe: 'chrome.exe', installs: [pf, pf86, local] },
    chromium: { name: 'Chromium', root: ['Chromium'], exe: 'chrome.exe', installs: [local] },
    brave: { name: 'Brave', root: ['BraveSoftware', 'Brave-Browser'], exe: 'brave.exe', installs: [pf, pf86, local] },
    edge: { name: 'Edge', root: ['Microsoft', 'Edge'], exe: 'msedge.exe', installs: [pf86, pf, local] },
  } as const;
  const key = browserName.toLowerCase();
  if (!Object.hasOwn(mappings, key)) {
    throw new CookieImportError('This browser has no supported Windows native-cookie mapping. Sign in manually in the gstack browser.', 'not_supported');
  }
  const browser = mappings[key as keyof typeof mappings];
  return {
    name: browser.name,
    userDataDir: path.win32.join(local, ...browser.root, 'User Data'),
    executables: [...new Set(browser.installs.map(root => path.win32.join(root, ...browser.root, 'Application', browser.exe)))],
  };
}

export async function importNativeCookies(options: {
  browserName: string;
  userDataDir: string;
  profile: string;
  domains: string[];
}): Promise<PlaywrightCookie[]> {
  let domains: string[];
  try {
    if (!Array.isArray(options.domains)) throw new Error();
    domains = [...new Set(options.domains.map(normalizeCookieDomain))];
  } catch {
    throw new CookieImportError('Native cookie import needs explicit valid domain selections.', 'invalid_domain');
  }
  if (!domains.length) return [];
  if (process.platform !== 'win32' || process.versions.bun) {
    throw new CookieImportError('Native cookie import requires the Windows Node server. Sign in manually in the gstack browser.', 'not_supported');
  }
  if (!/^(Default|Profile [0-9]+)$/.test(options.profile)) {
    throw new CookieImportError('Select an existing browser profile before importing cookies.', 'invalid_profile');
  }
  const browser = nativeBrowserPaths(options.browserName, process.env);
  if (path.win32.resolve(options.userDataDir).toLowerCase() !== path.win32.resolve(browser.userDataDir).toLowerCase()) {
    throw new CookieImportError('Native cookie import cannot substitute or copy the selected browser profile. Sign in manually in the gstack browser.', 'native_profile_unsupported');
  }
  if (browser.name === 'Chrome') {
    throw new CookieImportError('Chrome 136 and later block remote debugging of the default user-data directory, including every profile inside it, over both pipe and TCP. Default-directory extraction is unavailable; sign in manually in the gstack browser.', 'native_profile_unsupported');
  }
  const deadline = Date.now() + 25_000;
  let qualified: NativeQualifiedBuild[];
  try {
    const root = path.resolve(import.meta.dir, '../..');
    const builds = await readNativeQualifications(root, deadline);
    qualified = builds.filter(build => build.browserName === browser.name && build.nodeVersion === process.version && build.architecture === process.arch && build.windowsRelease === release());
    if (qualified.length) {
      const hashes = await nativeCodeHashes(root, deadline);
      qualified = qualified.filter(build => nativeCodeMatches(build.sourceHashes, hashes));
    }
  } catch (error) {
    throw new CookieImportError('The native-cookie qualification inputs could not be verified. Sign in manually in the gstack browser.', error instanceof Error && error.message === 'native_timeout' ? 'native_timeout' : 'native_unqualified');
  }
  if (!qualified.length) {
    throw new CookieImportError('Windows native cookie extraction is disabled until this browser and runtime pass native process-ownership and forced-cleanup qualification. Sign in manually in the gstack browser.', 'native_unqualified');
  }
  const executablePath = browser.executables.find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  if (!executablePath) throw new CookieImportError('The selected browser executable is not installed.', 'not_installed');
  try {
    const profilePath = path.join(options.userDataDir, options.profile);
    if (realpathSync(options.userDataDir).toLowerCase() !== path.win32.resolve(options.userDataDir).toLowerCase()
      || realpathSync(profilePath).toLowerCase() !== path.win32.resolve(profilePath).toLowerCase()
      || !statSync(profilePath).isDirectory()) {
      throw new Error('invalid_profile');
    }
  } catch {
    throw new CookieImportError('The selected source profile is unavailable or redirects to another location.', 'native_profile_unsupported');
  }
  const require = createRequire(import.meta.url);
  let playwrightVersion: string;
  let playwrightEntry: string;
  let executableSha256: string;
  try {
    playwrightVersion = require('playwright/package.json').version;
    playwrightEntry = require.resolve('playwright');
    executableSha256 = await hashNativeFile(executablePath, deadline);
  } catch (error) {
    throw new CookieImportError('The native browser build could not be checked safely. Sign in manually in the gstack browser.', error instanceof Error && error.message === 'native_timeout' ? 'native_timeout' : 'native_unqualified');
  }
  const bunCandidates = [
    ...(process.env.BUN_INSTALL ? [path.join(process.env.BUN_INSTALL, 'bin', 'bun.exe')] : []),
    ...(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, 'bun.exe')),
    ...(process.env.USERPROFILE ? [path.join(process.env.USERPROFILE, '.bun', 'bin', 'bun.exe')] : []),
  ];
  const bunExecutable = bunCandidates.find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  if (!bunExecutable || !qualified.some(build => build.executableSha256 === executableSha256 && build.playwrightVersion === playwrightVersion)) {
    throw new CookieImportError('This browser build or supervisor runtime has not passed native qualification. Sign in manually in the gstack browser.', 'native_unqualified');
  }
  if (Date.now() >= deadline) throw new CookieImportError('Native cookie import exceeded its operation deadline.', 'native_timeout');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(systemroot|windir|temp|tmp|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|programdata|path|pathext)$/i.test(key) && typeof value === 'string'));
  const worker = spawn(bunExecutable, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.join(import.meta.dir, 'cookie-import-native-worker.ts')], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      worker.kill();
      reject(new CookieImportError('Native cookie cleanup could not be confirmed within its deadline.', 'native_cleanup_failed'));
    }, Math.max(0, deadline + 5_000 - Date.now()));
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) worker.kill();
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new CookieImportError('Native cookie supervision could not start.', 'native_supervision_failed'));
    });
    worker.once('close', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (Array.isArray(result.cookies)) resolve(result.cookies);
        else reject(new CookieImportError('Native cookie import did not complete. Sign in manually in the gstack browser.', ['native_timeout', 'native_failed', 'native_cleanup_failed', 'native_supervision_failed', 'browser_running', 'native_profile_unsupported'].includes(result.error) ? result.error : 'native_failed'));
      } catch {
        reject(new CookieImportError('Native cookie supervision did not return a complete result.', 'native_failed'));
      }
    });
    worker.stdin.on('error', () => {});
    worker.stdin.write(JSON.stringify({
      nodeExecutable: process.execPath,
      nodeArchitecture: process.arch,
      playwrightEntry,
      executablePath,
      userDataDir: options.userDataDir,
      profile: options.profile,
      domains,
      deadline,
      qualifiedBunVersions: qualified.filter(build => build.executableSha256 === executableSha256 && build.playwrightVersion === playwrightVersion).map(build => build.bunVersion),
    }) + '\n');
  });
}
