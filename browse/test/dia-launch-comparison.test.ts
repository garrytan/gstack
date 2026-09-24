import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareDiaLaunchReceipts, normalizedLaunchHashes } from '../../.github/scripts/dia-launch-driver.mjs';
import { runDiaLaunchComparison, safeDiaComparisonResponse } from '../../.github/scripts/qualify-dia-macos';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dc-')));
const driverFile = path.resolve(import.meta.dir, '../../.github/scripts/dia-launch-driver.mjs');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('diagnostic-only Dia runtime comparison', () => {
  test('normalization replaces only declared owned path boundaries', () => {
    const first = normalizedLaunchHashes(['--user-data-dir=/owned/a/home/profile', '--headless'], { HOME: '/owned/a/home', PATH: '/usr/bin:/bin' }, { home: '/owned/a/home' });
    const second = normalizedLaunchHashes(['--user-data-dir=/owned/b/home/profile', '--headless'], { HOME: '/owned/b/home', PATH: '/usr/bin:/bin' }, { home: '/owned/b/home' });
    expect(first).toEqual(second);
    expect(normalizedLaunchHashes(['--user-data-dir=/owned/a/home-other'], {}, { home: '/owned/a/home' }).argvSha256)
      .not.toBe(normalizedLaunchHashes(['--user-data-dir=/owned/b/home-other'], {}, { home: '/owned/b/home' }).argvSha256);
    expect(normalizedLaunchHashes(['--label=https://private.invalid/owned/a/home'], {}, { home: '/owned/a/home' }).argvSha256)
      .not.toBe(normalizedLaunchHashes(['--label=https://private.invalid/owned/b/home'], {}, { home: '/owned/b/home' }).argvSha256);
    expect(JSON.stringify(first)).not.toContain('/owned');
  });

  test('IPC rejects raw payloads at any nesting depth', () => {
    for (const value of [{ args: ['private-argv'] }, { cleanup: { raw: 'private-value' } }, { error: 'private-error-value' },
      { startupPages: { categories: ['https://private.invalid'] } }, { driver: { release: '/private/path' } }]) {
      expect(safeDiaComparisonResponse(value)).toBe(false);
    }
    expect(safeDiaComparisonResponse({ protocol: 1, purpose: 'source', error: 'operation_timeout', cleanup: { confirmed: false } })).toBe(true);
  });

  test('the actual driver entry refuses an unapproved host without exposing its request', () => {
    for (const executable of [process.execPath, Bun.which('node')!]) {
      const result = spawnSync(executable, [driverFile, '/private-untrusted/account.json'], {
        env: { PATH: '/usr/bin:/bin', HOME: root }, input: '{"private":"request-value"}', encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ protocol: 1, ready: false, error: 'driver_admission_failed', cleanup: { confirmed: false } });
    }
  });

  test('the real bounded stdin callback works under both runtimes and refuses raw request payloads', () => {
    const entry = path.join(root, 'stdin-probe.mjs');
    writeFileSync(entry, `import { readComparisonRequest } from ${JSON.stringify(pathToFileURL(driverFile).href)};
      try { const request = readComparisonRequest(); process.stdout.write(JSON.stringify({purpose:request.purpose})); }
      catch { process.stdout.write(JSON.stringify({rejected:true})); }`);
    for (const executable of [process.execPath, Bun.which('node')!]) {
      for (const input of ['{"purpose":"control"}', '{"purpose":"control","env":{"PRIVATE":"value"}}', 'x'.repeat(16 * 1024 + 1)]) {
        const result = spawnSync(executable, [entry], { env: { HOME: root, PATH: '/usr/bin:/bin' }, input, encoding: 'utf8', timeout: 5000 });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(input === '{"purpose":"control"}' ? { purpose: 'control' } : { rejected: true });
      }
    }
  });
  test('both pinned runtimes execute the same protected worker with matched normalized inputs', async () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node 24.18 is required for the comparison regression');
    const entry = path.join(root, 'probe.mjs');
    const executablePath = realpathSync((await import('playwright')).chromium.executablePath());
    writeFileSync(entry, `import { runProtectedLaunch } from ${JSON.stringify(pathToFileURL(driverFile).href)};
      const home = process.env.HOME;
      const result = await runProtectedLaunch(${JSON.stringify(executablePath)}, home + '/profile',
        { HOME: home, TMPDIR: home + '/tmp', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }, 'control', { home });
      process.stdout.write(JSON.stringify(result) + '\\n');`);
    const results: any[] = [];
    for (const [name, executable] of [['bun', process.execPath], ['node', node]]) {
      const home = path.join(root, name);
      mkdirSync(home);
      mkdirSync(path.join(home, 'tmp'));
      const result = spawnSync(executable, [entry], { env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        encoding: 'utf8', timeout: 40_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const observed = JSON.parse(result.stdout);
      expect(observed.ready).toBe(true);
      expect(observed.protocolResponded).toBe(true);
      expect(observed.cleanup.confirmed).toBe(true);
      expect(observed.cleanup.childClosed).toBe(true);
      expect(observed.cleanup.groupAbsent).toBe(true);
      expect(observed.cleanup.launchSettled).toBe(true);
      expect(observed.rootCount).toBe(1);
      expect(observed.launchAttempts[0].pipeFlag).toBe(true);
      expect(observed.launchAttempts[0].sandboxDisablingFlag).toBe(false);
      expect(observed.samplingEnabled).toBe(false);
      expect(safeDiaComparisonResponse(observed)).toBe(true);
      expect(JSON.stringify(observed)).not.toContain(home);
      results.push(observed);
    }
    expect(results[0].argvSha256).toBe(results[1].argvSha256);
    expect(results[0].environmentSha256).toBe(results[1].environmentSha256);
  }, 90_000);

  const arm = (runtime: 'bun' | 'node', ready: boolean) => {
    const sha = 'a'.repeat(64);
    const config = { mode: 'launch-only', runtime, qualificationCredit: false, executableSha256: runtime === 'bun' ? sha : 'b'.repeat(64), driverSha256: sha, helpersSha256: sha };
    const driver = { runtime, version: runtime === 'bun' ? '1.4.0' : '24.18.0', architecture: 'arm64', os: 'darwin', release: '24.6.0', playwright: '1.62.1',
      executableSha256: config.executableSha256, driverSha256: sha, helpersSha256: sha };
    const result = (purpose: string, success: boolean) => ({ protocol: 1, purpose, ready: success, launchReturned: success, protocolResponded: success,
      samplingEnabled: false, rootCount: 1, supervisor: { closed: true, exitCode: 0 }, cleanup: { confirmed: true, childClosed: true, groupAbsent: true, launchSettled: true,
        groups: [{ absenceConfirmed: true, childCloseObserved: true }] }, startupPages: { allowed: true }, postProbePages: { allowed: true },
      argvSha256: sha, environmentSha256: sha, driver, launchAttempts: [{ sandboxRequired: true, sandboxDisablingFlag: false, pipeFlag: true,
        tcpDebuggingFlag: false, mockKeychainFlag: false, passwordStoreFlag: false, firstRunSuppressed: false, headlessFlag: true,
        expectedProfile: true, detached: true, shellDisabled: true, stdioCount: 5, extraPipeDescriptors: true, profileArgumentCount: 1 }] });
    return { launchComparison: config, counts: { pass: 0, fail: 0, skip: 0 }, launcher: { accountGuid: runtime + '-separate-account', sourceRevision: 'c'.repeat(40), archiveSha256: sha, destinationSha256: sha },
      launcherCleanup: { serviceStopped: true, userDomainStopped: true, userProcessesStopped: true, accountRemoved: true, groupRemoved: true, stagingRemoved: true },
      backgroundPreflight: { status: 'passed', comparisonControl: result('control', true) },
      qualification: { launchComparison: { qualificationCredit: false, source: result('source', ready) }, counts: { pass: 0, fail: 0, skip: 0 },
        keychainStage: 'completed', isolation: { registeredIdentity: true, sharedRegisteredHome: true },
        cleanup: { ownedBrowsersStopped: true, sourceProfileRemoved: true, keychainRestored: true, mountDetached: true, fixtureRemoved: true },
        platform: { os: 'darwin', architecture: 'arm64', bun: '1.4.0', playwright: '1.62.1', release: '24.6.0' },
        artifact: { signatureVerified: true, gatekeeperNotarized: true, macosCompatibility: { compatible: true, hostVersion: '15.7.9' },
          architectures: ['arm64'], sha256: sha, executableSha256: sha, version: '1.49.1', bundleId: 'company.thebrowser.dia', team: 'S6N382Y83G' } } };
  };

  test('paired receipts distinguish runtime readiness without awarding qualification credit', () => {
    expect(compareDiaLaunchReceipts(arm('bun', false), arm('node', true))).toEqual({ comparable: true, qualificationCredit: false, outcome: 'node_only_ready' });
    expect(compareDiaLaunchReceipts(arm('bun', false), arm('node', false)).outcome).toBe('neither_ready');
    expect(compareDiaLaunchReceipts(arm('bun', true), arm('node', true)).outcome).toBe('both_ready');
  });

  test('incomplete or incompatible arms cannot support a runtime conclusion', () => {
    const left = arm('bun', false);
    const mutations = [
      (right: any) => { right.backgroundPreflight.comparisonControl.ready = false; },
      (right: any) => { right.launcherCleanup.userDomainStopped = false; },
      (right: any) => { right.qualification.cleanup.sourceProfileRemoved = false; },
      (right: any) => { right.qualification.artifact.executableSha256 = 'b'.repeat(64); },
      (right: any) => { right.qualification.launchComparison.source.argvSha256 = 'b'.repeat(64); },
      (right: any) => { right.qualification.launchComparison.source.launchAttempts[0].sandboxDisablingFlag = true; },
      (right: any) => { right.qualification.launchComparison.source.driver.version = '24.19.0'; },
      (right: any) => { right.qualification.launchComparison.source.cleanup.launchSettled = false; },
      (right: any) => { right.counts.pass = 1; },
      (right: any) => { right.launcher.accountGuid = left.launcher.accountGuid; },
      (right: any) => { delete right.qualification.platform; },
    ];
    for (const mutate of mutations) {
      const right = arm('node', true);
      mutate(right);
      expect(compareDiaLaunchReceipts(left, right).comparable).toBe(false);
    }
  });

  test('comparison supervisor binds code hashes and rejects extra private response fields', async () => {
    const work = path.join(root, 'ipc');
    mkdirSync(path.join(work, 'bin'), { recursive: true });
    mkdirSync(path.join(work, 'repo/.github/scripts'), { recursive: true });
    const executable = path.join(work, 'bin/node');
    const driver = path.join(work, 'repo/.github/scripts/dia-launch-driver.mjs');
    const helpers = path.join(work, 'repo/.github/scripts/qualify-dia-macos.ts');
    for (const file of [executable, driver, helpers]) writeFileSync(file, 'synthetic code');
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const account: any = { work, snapshot: path.join(work, 'repo'), configFile: path.join(work, 'account.json'), environment: { HOME: work },
      launchComparison: { mode: 'launch-only', runtime: 'node', executable, executableSha256: hash(executable), driverSha256: hash(driver), helpersSha256: hash(helpers) } };
    const response: any = { protocol: 1, purpose: 'control', ready: false, launchReturned: false, samplingEnabled: false, cleanup: { confirmed: false },
      driver: { runtime: 'node', version: '24.18.0', architecture: 'arm64', os: 'darwin', playwright: '1.62.1',
        executableSha256: hash(executable), driverSha256: hash(driver), helpersSha256: hash(helpers) } };
    let calls = 0;
    const execute = ((command: string, args: string[], options: any) => {
      calls++;
      expect(command).toBe(executable);
      expect(args).toEqual([driver, account.configFile]);
      expect(JSON.parse(options.input)).toEqual({ purpose: 'control' });
      expect(options.timeout).toBeLessThanOrEqual(40_000);
      expect(options.maxBuffer).toBe(64 * 1024);
      return { status: 0, stdout: JSON.stringify(response), stderr: '' };
    }) as typeof spawnSync;
    expect((await runDiaLaunchComparison(account, 'control', undefined, execute)).supervisor.exitCode).toBe(0);
    response.error = 'private-error-value';
    expect((await runDiaLaunchComparison(account, 'control', undefined, execute)).error).toBe('driver_exchange_failed');
    writeFileSync(executable, 'changed executable');
    await expect(runDiaLaunchComparison(account, 'control', undefined, execute)).rejects.toThrow('comparison_driver_inputs_changed');
    expect(calls).toBe(2);
    await expect(runDiaLaunchComparison({ ...account, launchComparison: undefined }, 'control', undefined, execute)).rejects.toThrow('comparison_driver_authority_missing');
  });
});
