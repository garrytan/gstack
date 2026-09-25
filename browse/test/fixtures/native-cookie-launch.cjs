const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');

module.exports = ({ observation, playwrightEntry, mode = 'normal-close', inspectCommandLine = false, observerExecutable, seedCookie = { name: 'synthetic', value: 'synthetic', domain: 'example.test', path: '/' } }) => {
  if (inspectCommandLine && process.platform === 'win32' && typeof observerExecutable !== 'string') throw new Error('Native observer executable is required');
  const originalSpawn = cp.spawn;
  let inspected = Promise.resolve();
  let folderEvidence;
  const directoryState = (env, root) => ({
    requestedProfile: fs.existsSync(root),
    localEnvironment: fs.existsSync(env.LOCALAPPDATA || ''),
    roamingEnvironment: fs.existsSync(env.APPDATA || ''),
    localUnderProfile: fs.existsSync(path.join(env.USERPROFILE || '', 'AppData', 'Local')),
    roamingUnderProfile: fs.existsSync(path.join(env.USERPROFILE || '', 'AppData', 'Roaming')),
  });
  const safeFolders = value => Object.fromEntries(['local', 'roaming'].map(name => [name,
    Object.fromEntries(['verified', 'dontVerify'].map(kind => {
      const item = value?.[name]?.[kind];
      return [kind, {
        hresult: Number.isInteger(item?.hresult) ? item.hresult : null,
        pathHash: /^[a-f0-9]{64}$/.test(item?.pathHash) ? item.pathHash : null,
        exists: typeof item?.exists === 'boolean' ? item.exists : null,
        matchesEnvironment: typeof item?.matchesEnvironment === 'boolean' ? item.matchesEnvironment : null,
        underUserProfile: typeof item?.underUserProfile === 'boolean' ? item.underUserProfile : null,
      }];
    })),
  ]));
  const runProbe = (input, env) => new Promise(resolve => {
    const probe = originalSpawn(observerExecutable, [
      '--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.join(__dirname, 'native-cookie-process-observer.ts'),
      Buffer.from(JSON.stringify(input)).toString('base64'),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let stderrBytes = 0;
    let spawnFailed = false;
    const timer = setTimeout(() => probe.kill(), 5_000);
    probe.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 16384) probe.kill(); });
    probe.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    probe.once('error', () => { spawnFailed = true; });
    probe.once('close', code => {
      clearTimeout(timer);
      try { resolve({ measured: JSON.parse(output), code, stderrBytes }); }
      catch { resolve({ measured: { available: false, reason: spawnFailed ? 'probe_spawn_failed' : 'probe_no_receipt' }, code, stderrBytes }); }
    });
  });
  cp.spawn = function(command, args, options) {
    if (args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(arg))) throw new Error('Native fixture refuses a sandbox-disabled browser');
    const child = originalSpawn.call(this, command, args, options);
    const evidence = {
      command, args, pid: child.pid,
      argsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      envHash: createHash('sha256').update(JSON.stringify(Object.entries(options.env || {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex'),
      stderrBytes: 0,
      reasons: [],
      runtime: { node: process.version, bun: process.versions.bun || null, architecture: process.arch },
      folderEvidence,
    };
    const publish = () => fs.writeFileSync(observation, JSON.stringify(evidence));
    publish();
    let tail = '';
    child.stderr?.on('data', chunk => {
      evidence.stderrBytes += chunk.length;
      if (evidence.stderrBytes > 65536) return;
      const text = tail + chunk.toString('utf8');
      const patterns = {
        job_assignment_failed: /AssignProcessToJobObject|failed to (?:assign|create).*job object/i,
        sandbox_failed: /sandbox.*(?:failed|error)|SBOX_FATAL/i,
        profile_locked: /ProcessSingleton|profile.*in use/i,
        default_profile_policy: /remote debugging requires a non-default data directory/i,
        permission_denied: /access is denied|ERROR_ACCESS_DENIED|permission denied/i,
        crashpad_failed: /crashpad.*(?:failed|error)/i,
        missing_dependency: /specified module could not be found|0xc0000135/i,
      };
      for (const [reason, pattern] of Object.entries(patterns)) {
        if (pattern.test(text) && !evidence.reasons.includes(reason)) evidence.reasons.push(reason);
      }
      tail = text.slice(-512);
      publish();
    });
    child.once('exit', (code, signal) => { evidence.exitCode = code; evidence.signal = signal; publish(); });
    child.once('error', error => {
      evidence.spawnError = ['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code) ? error.code : 'spawn_failed';
      publish();
    });
    if (inspectCommandLine && process.platform === 'win32' && Number.isInteger(child.pid)) {
      inspected = runProbe({ pid: child.pid, owner: process.pid, image: command }, options.env).then(({ measured, code, stderrBytes }) => {
        const expectedHashes = args.map(arg => createHash('sha256').update(arg).digest('hex'));
        const dataDir = args.find(arg => arg.startsWith('--user-data-dir='))?.slice(16);
        evidence.observedCommandLine = {
          available: measured.available === true,
          parentMatched: measured.parentMatched === true,
          imageMatched: measured.imageMatched === true,
          reason: ['not_windows', 'invalid_input', 'process_open', 'process_identity', 'owned_process_unavailable', 'command_line', 'command_line_length', 'command_line_bounds', 'argument_parse', 'argument_bounds', 'job_query', 'observer_initialize', 'probe_spawn_failed', 'probe_no_receipt'].includes(measured.reason) ? measured.reason : undefined,
          win32Error: Number.isInteger(measured.win32Error) ? measured.win32Error : undefined,
          ntStatus: Number.isInteger(measured.ntStatus) ? measured.ntStatus : undefined,
          commandLineHash: /^[a-f0-9]{64}$/.test(measured.commandLineHash) ? measured.commandLineHash : undefined,
          argumentsMatchRequested: measured.available === true && JSON.stringify(measured.argumentHashes) === JSON.stringify(expectedHashes),
          userDataDirCount: Number.isInteger(measured.userDataDirCount) && measured.userDataDirCount >= 0 && measured.userDataDirCount <= 128 ? measured.userDataDirCount : undefined,
          userDataDirMatchesRequested: typeof dataDir === 'string' && measured.userDataDirHash === createHash('sha256').update(dataDir).digest('hex'),
          pipePresent: measured.pipePresent === true,
          browserInJob: typeof measured.browserInJob === 'boolean' ? measured.browserInJob : undefined,
          observerJobLimitFlags: Number.isInteger(measured.observerJobLimitFlags) ? measured.observerJobLimitFlags : undefined,
          observerJobQueryError: Number.isInteger(measured.observerJobQueryError) ? measured.observerJobQueryError : undefined,
          exitCode: code, stderrBytes,
        };
        evidence.folderEvidence.afterLaunch = safeFolders(measured.knownFolders);
        evidence.folderEvidence.directoriesAfterLaunch = directoryState(options.env, args.find(arg => arg.startsWith('--user-data-dir='))?.slice(16) || '');
        publish();
      });
    }
    return child;
  };
  const { chromium } = require(playwrightEntry);
  return { chromium: { async launchPersistentContext(root, options) {
    if (options.chromiumSandbox !== true) throw new Error('Native fixture requires the browser sandbox');
    const started = Date.now();
    if (inspectCommandLine && process.platform === 'win32') {
      const directoriesBefore = directoryState(options.env, root);
      const before = await runProbe({ mode: 'known-folders' }, options.env);
      folderEvidence = { beforeLaunch: safeFolders(before.measured.knownFolders), directoriesBefore, directoriesAfterProbe: directoryState(options.env, root) };
    }
    const context = await chromium.launchPersistentContext(root, inspectCommandLine && process.platform === 'win32'
      ? { ...options, timeout: Math.max(1, options.timeout - (Date.now() - started)) } : options);
    await inspected;
    await context.addCookies([seedCookie]);
    if (mode === 'stalled-close') context.close = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
    return context;
  } } };
};
