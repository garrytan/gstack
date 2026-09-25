import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { nativeBrowserPaths, importNativeCookies } from '../src/cookie-import-native';
import { nativeCookieEnvironment, NATIVE_COOKIE_NODE_SCRIPT, NATIVE_PROGRESS_PREFIX } from '../src/cookie-import-native-worker';
import { parseNativeCookieDiagnostic } from '../src/cookie-import-native-job';
import { hashNativeFile, nativeCodeHashes, nativeCodeMatches, NATIVE_CODE_INPUTS, NATIVE_QUALIFICATION_DATA, readNativeQualifications } from '../src/cookie-import-native-integrity';

const root = mkdtempSync(path.join(tmpdir(), 'native-cookies-'));
const env = { LOCALAPPDATA: 'C:\\fixture\\Local', PROGRAMFILES: 'C:\\Apps', 'PROGRAMFILES(X86)': 'C:\\Apps32' };
const node = Bun.which('node');
if (!node) throw new Error('Node is required for native-cookie transport tests');

afterAll(() => rmSync(root, { recursive: true, force: true }));

function isolatedEnv(): NodeJS.ProcessEnv {
  const local = path.join(root, 'AppData', 'Local');
  const roaming = path.join(root, 'AppData', 'Roaming');
  const temporary = path.join(local, 'Temp');
  for (const directory of [local, roaming, temporary]) mkdirSync(directory, { recursive: true });
  return {
    PATH: path.dirname(node!),
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: local,
    APPDATA: roaming,
    TEMP: temporary,
    TMP: temporary,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function expectNativeProgress(stderr: string) {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  return lines.map(line => {
    expect(line.startsWith(NATIVE_PROGRESS_PREFIX)).toBe(true);
    const record = JSON.parse(line.slice(NATIVE_PROGRESS_PREFIX.length));
    expect(parseNativeCookieDiagnostic(record)).toEqual(record);
    return record;
  });
}

function adapter(options: object, extraEnv: object = {}) {
  const script = `
    const { importNativeCookies } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/cookie-import-native.ts'))});
    const { CookieImportError } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/cookie-import-browser.ts'))});
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process.versions, 'bun', { value: undefined });
    process.env.LOCALAPPDATA = ${JSON.stringify(env.LOCALAPPDATA)};
    Object.assign(process.env, ${JSON.stringify(extraEnv)});
    try { console.log(JSON.stringify({ cookies: await importNativeCookies(${JSON.stringify(options)}) })); }
    catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message, typed: error instanceof CookieImportError })); }
  `;
  const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', script], { env: isolatedEnv(), encoding: 'utf8', timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

const options = {
  browserName: 'Edge',
  userDataDir: 'C:\\fixture\\Local\\Microsoft\\Edge\\User Data',
  profile: 'Default',
  domains: ['example.test'],
};

describe('native-cookie production admission', () => {
  test('the real member entry reports boot and decoded input before refusing an unowned job', () => {
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts'), '--member-smoke'], {
      env: isolatedEnv(), input: JSON.stringify({ jobName: 'Local\\gstack-cookie-00000000-0000-0000-0000-000000000000' }), encoding: 'utf8', timeout: 10_000,
    });
    const progress = expectNativeProgress(result.stderr);
    expect(progress).toContainEqual({ stage: 'worker_boot', memberMode: true });
    expect(progress).toContainEqual({ stage: 'member_input' });
    expect(progress).toContainEqual({ stage: 'member_decoded' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'native_supervision_failed', diagnostic: { stage: 'job_open' } });
  });

  test.each([['malformed', '{'], ['oversized', 'x'.repeat(1024 * 1024 + 1)]])('the real member rejects %s input before opening a job', (_name, input) => {
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts'), '--member-smoke'], {
      env: isolatedEnv(), input, encoding: 'utf8', timeout: 10_000,
    });
    const progress = expectNativeProgress(result.stderr);
    expect(progress).toContainEqual({ stage: 'member_input' });
    expect(progress).not.toContainEqual({ stage: 'member_decoded' });
    expect(progress).not.toContainEqual({ stage: 'job_open' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'native_supervision_failed', diagnostic: { stage: 'member_input' } });
  });

  test.skipIf(process.platform === 'win32')('qualification refuses non-Windows without issuing a receipt', () => {
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--config=/dev/null', path.resolve(import.meta.dir, 'cookie-import-native-qualification.ts'), root], {
      env: isolatedEnv(), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no cases ran and no qualification was issued');
  });

  test('activation data is separate from the receipt code inputs', () => {
    expect(NATIVE_CODE_INPUTS).toContain('browse/src/cookie-import-native.ts');
    expect(NATIVE_CODE_INPUTS).toContain('browse/src/cookie-database.ts');
    expect(NATIVE_CODE_INPUTS).toContain('browse/src/cookie-import-native-worker.ts');
    expect(NATIVE_CODE_INPUTS).toContain('browse/scripts/build-node-server.sh');
    expect(NATIVE_CODE_INPUTS).toContain('browse/dist/server-node.mjs');
    expect(NATIVE_CODE_INPUTS).not.toContain(NATIVE_QUALIFICATION_DATA);
  });

  test('empty selection never launches or widens to all cookies', async () => {
    expect(await importNativeCookies({ ...options, domains: [] })).toEqual([]);
  });

  test('rejects unsupported production runtime', async () => {
    await expect(importNativeCookies(options)).rejects.toMatchObject({ code: 'not_supported' });
  });

  test('rejects invalid domains before launching', async () => {
    for (const domain of ['https://example.test', 'example.test/path', '*', 'example.test\n--flag']) {
      await expect(importNativeCookies({ ...options, domains: [domain] })).rejects.toMatchObject({ code: 'invalid_domain' });
    }
  });

  test('valid Chromium hostname forms reach runtime admission', async () => {
    for (const domain of ['service_name.example.test', '-service.example.test', '[::1]']) {
      await expect(importNativeCookies({ ...options, domains: [domain] })).rejects.toMatchObject({ code: 'not_supported' });
    }
  });

  test('unqualified Windows extraction is closed with a typed safe error', () => {
    expect(adapter(options)).toMatchObject({ code: 'native_unqualified', typed: true });
  });

  test('environment flags cannot activate unqualified extraction', () => {
    expect(adapter(options, { GSTACK_COOKIE_NATIVE_QUALIFY: '1', GSTACK_NATIVE_COOKIES: '1' })).toMatchObject({ code: 'native_unqualified', typed: true });
  });

  test('Chrome default user-data policy also blocks numbered profiles', () => {
    const result = adapter({ ...options, browserName: 'Chrome', userDataDir: 'C:\\fixture\\Local\\Google\\Chrome\\User Data', profile: 'Profile 2' });
    expect(result.code).toBe('native_profile_unsupported');
    expect(result.message).toContain('Chrome 136');
    expect(result.message).toContain('both pipe and TCP');
    expect(result.message).toContain('sign in manually');
  });

  test('does not substitute a different browser for an unsupported identity', () => {
    expect(adapter({ ...options, browserName: 'Dia' })).toMatchObject({ code: 'not_supported', typed: true });
  });

  test('rejects mismatched and copied profile roots', () => {
    expect(adapter({ ...options, browserName: 'Brave' })).toMatchObject({ code: 'native_profile_unsupported' });
    expect(adapter({ ...options, userDataDir: 'C:\\copied-profile' })).toMatchObject({ code: 'native_profile_unsupported' });
  });

  test('rejects profile traversal without echoing the supplied text', () => {
    const result = adapter({ ...options, profile: '../sensitive-sentinel' });
    expect(result.code).toBe('invalid_profile');
    expect(JSON.stringify(result)).not.toContain('sensitive-sentinel');
  });

  test('maps every supported browser to only its own executable and data root', () => {
    const expected = [
      ['Chrome', 'Google\\Chrome', 'chrome.exe'],
      ['Chromium', 'Chromium', 'chrome.exe'],
      ['Brave', 'BraveSoftware\\Brave-Browser', 'brave.exe'],
      ['Edge', 'Microsoft\\Edge', 'msedge.exe'],
    ];
    for (const [name, relative, exe] of expected) {
      const mapping = nativeBrowserPaths(name, env);
      expect(mapping.userDataDir).toBe(`${env.LOCALAPPDATA}\\${relative}\\User Data`);
      expect(mapping.executables.length).toBeGreaterThan(0);
      for (const candidate of mapping.executables) expect(candidate.endsWith(`\\${relative}\\Application\\${exe}`)).toBe(true);
    }
    expect(nativeBrowserPaths('Edge', env).executables[0]).toStartWith('C:\\Apps32');
    expect(nativeBrowserPaths('Brave', env).executables.join(' ')).not.toContain('chrome.exe');
  });

  test('browser environment excludes inherited secrets and runtime injection', () => {
    expect(nativeCookieEnvironment({ ...env, SystemRoot: 'C:\\Windows', API_KEY: 'sensitive-sentinel', NODE_OPTIONS: '--require=unsafe', DEBUG: 'pw:*', PWDEBUG: '1' })).toEqual({ ...env, SystemRoot: 'C:\\Windows' });
  });
});

async function qualifiedAdapterFixture() {
  const fixture = mkdtempSync(path.join(root, 'admission-'));
  for (const file of NATIVE_CODE_INPUTS) {
    const destination = path.join(fixture, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (file === 'browse/dist/server-node.mjs') continue;
    copyFileSync(path.resolve(import.meta.dir, '../..', file === 'browse/dist/bun-polyfill.cjs' ? 'browse/src/bun-polyfill.cjs' : file), destination);
  }
  const activation = path.join(fixture, NATIVE_QUALIFICATION_DATA);
  writeFileSync(activation, '[]\n');
  const bundle = path.join(fixture, 'browse/dist/server-node.mjs');
  const build = async () => {
    const result = await Bun.build({
      entrypoints: [path.join(fixture, 'browse/src/cookie-import-native.ts')],
      target: 'node',
      define: { 'import.meta.dir': JSON.stringify(path.join(fixture, 'browse/src')) },
    });
    expect(result.success).toBe(true);
    writeFileSync(bundle, await result.outputs[0].text());
  };
  await build();
  const probe = spawnSync(node!, ['-p', 'JSON.stringify({ version: process.version, architecture: process.arch })'], { env: isolatedEnv(), encoding: 'utf8', timeout: 10_000 });
  expect(probe.status).toBe(0);
  const runtime = JSON.parse(probe.stdout);
  const sourceHashes = await nativeCodeHashes(fixture, Date.now() + 25_000);
  const receipt = {
    browserName: 'Edge', architecture: runtime.architecture, windowsRelease: release(),
    executableSha256: '0'.repeat(64), nodeVersion: runtime.version, bunVersion: Bun.version,
    playwrightVersion: '1.62.1', sourceHashes,
  };
  const virtualRoot = `C:\\gstack-${path.basename(fixture)}`;
  const windowsEnv = { LOCALAPPDATA: `${virtualRoot}\\Local`, PROGRAMFILES: `${virtualRoot}\\Apps`, 'PROGRAMFILES(X86)': `${virtualRoot}\\Apps32` };
  const input = { ...options, userDataDir: nativeBrowserPaths('Edge', windowsEnv).userDataDir };
  const invoke = () => {
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      let spawns = 0;
      cp.spawn = () => { spawns++; throw new Error('Unexpected browser launch before source admission'); };
      syncBuiltinESMExports();
      const { importNativeCookies } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.assign(process.env, ${JSON.stringify(windowsEnv)});
      try { await importNativeCookies(${JSON.stringify(input)}); console.log(JSON.stringify({ accepted: true, spawns })); }
      catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message, spawns, typed: error.name === 'CookieImportError' })); }
    `;
    const result = spawnSync(node!, ['--input-type=module', '-e', script], { cwd: fixture, env: isolatedEnv(), encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  return { fixture, activation, bundle, build, receipt, invoke };
}

describe('production adapter source-bound qualification', () => {
  test('matching code passes admission, while later worker/core/database/bundle edits reject the old receipt', async () => {
    const fixture = await qualifiedAdapterFixture();
    expect(fixture.invoke()).toMatchObject({ code: 'native_unqualified', spawns: 0, typed: true });
    writeFileSync(fixture.activation, JSON.stringify([fixture.receipt]));
    expect(fixture.invoke()).toMatchObject({ code: 'not_installed', spawns: 0, typed: true });
    for (const file of ['browse/src/cookie-import-native-worker.ts', 'browse/src/cookie-import-native-job.ts', 'browse/src/cookie-import-native-integrity.ts', 'browse/src/cookie-import-browser.ts', 'browse/src/cookie-database.ts', 'browse/scripts/build-node-server.sh', 'browse/dist/server-node.mjs']) {
      const target = path.join(fixture.fixture, file);
      const original = readFileSync(target);
      writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
      expect(fixture.invoke()).toMatchObject({ code: 'native_unqualified', spawns: 0, typed: true });
      writeFileSync(target, original);
    }
    expect(fixture.invoke()).toMatchObject({ code: 'not_installed', spawns: 0, typed: true });
  });

  test('activation-only edits preserve all bound bytes, including a rebuilt Node bundle', async () => {
    const fixture = await qualifiedAdapterFixture();
    const before = readFileSync(fixture.bundle);
    writeFileSync(fixture.activation, JSON.stringify([fixture.receipt], null, 2) + '\n');
    await fixture.build();
    expect(readFileSync(fixture.bundle)).toEqual(before);
    expect(await nativeCodeHashes(fixture.fixture, Date.now() + 25_000)).toEqual(fixture.receipt.sourceHashes);
    expect(fixture.invoke()).toMatchObject({ code: 'not_installed', spawns: 0 });
  });

  test('partial or legacy receipts cannot activate even when their browser/runtime tuple matches', async () => {
    const fixture = await qualifiedAdapterFixture();
    const sourceHashes = { ...fixture.receipt.sourceHashes };
    delete sourceHashes['browse/src/cookie-database.ts'];
    writeFileSync(fixture.activation, JSON.stringify([{ ...fixture.receipt, sourceHashes }]));
    expect(fixture.invoke()).toMatchObject({ code: 'native_unqualified', spawns: 0 });
    writeFileSync(fixture.activation, JSON.stringify([{ ...fixture.receipt, sourceHashes: undefined }]));
    expect(fixture.invoke()).toMatchObject({ code: 'native_unqualified', spawns: 0 });
    expect(nativeCodeMatches(sourceHashes, fixture.receipt.sourceHashes)).toBe(false);
  });

  test('qualification reads have a size cap and share the operation deadline', async () => {
    const fixture = mkdtempSync(path.join(root, 'bounds-'));
    const activation = path.join(fixture, NATIVE_QUALIFICATION_DATA);
    mkdirSync(path.dirname(activation), { recursive: true });
    writeFileSync(activation, ' '.repeat(1024 * 1024 + 1));
    await expect(readNativeQualifications(fixture, Date.now() + 25_000)).rejects.toThrow('native_unqualified');
    await expect(hashNativeFile(activation, Date.now() - 1)).rejects.toThrow('native_timeout');
  });

  test('a stalled source read aborts and destroys its stream at the deadline', async () => {
    const fixture = mkdtempSync(path.join(root, 'stalled-read-'));
    const entry = path.join(fixture, 'integrity.mjs');
    const built = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, '../src/cookie-import-native-integrity.ts')], target: 'node' });
    expect(built.success).toBe(true);
    writeFileSync(entry, await built.outputs[0].text());
    const script = `
      import fs from 'node:fs';
      import { Readable } from 'node:stream';
      import { syncBuiltinESMExports } from 'node:module';
      let aborted = false;
      let closed = false;
      fs.createReadStream = (file, options) => {
        const stream = new Readable({ read() {} });
        stream.once('close', () => { closed = true; });
        options.signal.addEventListener('abort', () => { aborted = true; stream.destroy(new Error('synthetic interruption')); }, { once: true });
        return stream;
      };
      syncBuiltinESMExports();
      const { hashNativeFile } = await import(${JSON.stringify(pathToFileURL(entry).href)});
      const started = Date.now();
      let code;
      try { await hashNativeFile('synthetic-source', started + 20); }
      catch (error) { code = error.message; }
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({ code, aborted, closed, elapsed: Date.now() - started }));
    `;
    const result = spawnSync(node!, ['--input-type=module', '-e', script], { env: isolatedEnv(), encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const outcome = JSON.parse(result.stdout);
    expect(outcome).toMatchObject({ code: 'native_timeout', aborted: true, closed: true });
    expect(outcome.elapsed).toBeLessThan(1500);
  });
});

function runNodeWorker(mode: string, cookies: object[] = [], exitCode = 21) {
  const fixture = mkdtempSync(path.join(root, 'worker-'));
  const observation = path.join(fixture, 'observed.json');
  const playwrightEntry = path.join(fixture, 'playwright.cjs');
  writeFileSync(playwrightEntry, `
    exports.chromium = {
      async launchPersistentContext(userDataDir, options) {
        require('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ userDataDir, options, nodeVersion: process.version }));
        if (${JSON.stringify(mode)} === 'locked') throw new Error('ProcessSingleton sensitive-sentinel');
        if (${JSON.stringify(mode)} === 'policy') throw new Error('Remote debugging requires a non-default data directory sensitive-sentinel');
        if (${JSON.stringify(mode)} === 'failure') throw new Error('sensitive-sentinel');
        if (${JSON.stringify(mode)} === 'process-exit') throw new Error('<process did exit: exitCode=${exitCode}, signal=null> sensitive-sentinel');
        return { cookies: async () => ${JSON.stringify(cookies)}, close: async () => {} };
      },
    };
  `);
  const userDataDir = path.join(fixture, 'profile');
  mkdirSync(userDataDir);
  const result = spawnSync(node!, ['--input-type=commonjs', '-e', NATIVE_COOKIE_NODE_SCRIPT], {
    env: isolatedEnv(),
    input: JSON.stringify({ playwrightEntry, userDataDir, executablePath: 'C:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe', profile: 'Profile 2', domains: ['EXAMPLE.TEST.'], deadline: Date.now() + 25_000 }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  const progress = expectNativeProgress(result.stderr);
  expect(progress).toContainEqual({ stage: 'node_input' });
  expect(progress).toContainEqual({ stage: 'node_load' });
  return { result: JSON.parse(result.stdout), observation: JSON.parse(readFileSync(observation, 'utf8')), userDataDir };
}

describe('production Node Playwright worker', () => {
  test('real synthetic Playwright pipe smoke uses no TCP and leaves no browser', () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright');
    const fixture = mkdtempSync(path.join(root, 'pipe-'));
    const observation = path.join(fixture, 'launch.json');
    const playwrightEntry = path.join(fixture, 'instrumented-playwright.cjs');
    writeFileSync(playwrightEntry, `
      const cp = require('node:child_process');
      const spawn = cp.spawn;
      cp.spawn = function(command, args, options) {
        const child = spawn.call(this, command, args, options);
        require('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ args, pid: child.pid }));
        return child;
      };
      const { chromium } = require(${JSON.stringify(require.resolve('playwright'))});
      exports.chromium = { async launchPersistentContext(root, options) {
        const context = await chromium.launchPersistentContext(root, options);
        await context.addCookies([{ name: 'synthetic', value: 'synthetic', domain: 'example.test', path: '/' }]);
        return context;
      } };
    `);
    const result = spawnSync(node!, ['--input-type=commonjs', '-e', NATIVE_COOKIE_NODE_SCRIPT], {
      env: isolatedEnv(),
      input: JSON.stringify({ playwrightEntry, userDataDir: path.join(fixture, 'User Data'), executablePath: chromium.executablePath(), profile: 'Default', domains: ['example.test'], deadline: Date.now() + 25_000 }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    const progress = expectNativeProgress(result.stderr);
    expect(progress).toContainEqual({ stage: 'browser_launch' });
    expect(progress).toContainEqual({ stage: 'cookie_read' });
    expect(JSON.parse(result.stdout).cookies).toHaveLength(1);
    const launched = JSON.parse(readFileSync(observation, 'utf8'));
    expect(launched.args).toContain('--remote-debugging-pipe');
    expect(launched.args.some((arg: string) => arg.startsWith('--remote-debugging-port'))).toBe(false);
    expect(launched.args.some((arg: string) => /^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(arg))).toBe(false);
    expect(launched.args).toContain(`--user-data-dir=${path.join(fixture, 'User Data')}`);
    expect(() => process.kill(launched.pid, 0)).toThrow();
  }, 35_000);

  test('launches the requested profile once through Playwright with no TCP or bypass arguments', () => {
    const { result, observation, userDataDir } = runNodeWorker('success');
    expect(result).toEqual({ cookies: [] });
    expect(observation.userDataDir).toBe(userDataDir);
    expect(observation.options).toMatchObject({
      executablePath: 'C:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe',
      args: ['--profile-directory=Profile 2'],
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      headless: true,
      chromiumSandbox: true,
    });
    expect(observation.options.timeout).toBeGreaterThan(0);
    expect(observation.options.timeout).toBeLessThanOrEqual(25_000);
    expect(observation.nodeVersion).toStartWith('v');
    expect(Object.keys(observation.options.env)).not.toContain('NODE_OPTIONS');
  });

  test('bare/dotted matching preserves scope and cookie attributes', () => {
    const cookie = { name: 'synthetic', value: 'synthetic', domain: 'example.test', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 };
    const selected = [cookie, { ...cookie, domain: '.example.test' }];
    const { result } = runNodeWorker('success', [...selected, { ...cookie, domain: 'other.example.test' }, { ...cookie, domain: 'badexample.test' }]);
    expect(result.cookies).toEqual(selected);
  });

  test.each([['locked', 'browser_running'], ['policy', 'native_profile_unsupported'], ['failure', 'native_failed']])('classifies %s without leaking browser stderr or retrying', (mode, error) => {
    const { result } = runNodeWorker(mode);
    expect(result).toEqual({ error, diagnostic: { stage: 'browser_launch' } });
    expect(JSON.stringify(result)).not.toContain('sensitive-sentinel');
  });

  test('reports only the managed browser exit code, not raw launch errors', () => {
    const { result } = runNodeWorker('process-exit');
    expect(result).toEqual({ error: 'browser_running', diagnostic: { stage: 'browser_launch', exitCode: 21 } });
    expect(JSON.stringify(result)).not.toContain('sensitive-sentinel');
  });

  test.each([0, 1, 20, 22, 24, -1, -1073741819])('does not classify unrelated browser exit %d as a profile lock', exitCode => {
    const { result } = runNodeWorker('process-exit', [], exitCode);
    expect(result).toEqual({ error: 'native_failed', diagnostic: { stage: 'browser_launch', exitCode } });
  });
});
