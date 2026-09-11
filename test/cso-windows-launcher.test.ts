import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const windows = process.platform === 'win32';
const required = process.env.GSTACK_CSO_WINDOWS_TESTS === '1';
if (required && !windows) throw new Error('GSTACK_CSO_WINDOWS_TESTS=1 requires native Windows; emulation does not qualify the launcher.');
let temporary = '', invocationCwd = '', launcher = '', core = '', marker = '', preload = '', publisher = '', buildStage = '';
beforeAll(() => {
  if (!windows) return;
  const installed = path.join(ROOT, 'bin', 'gstack-cso-launcher.exe');
  if (!fs.existsSync(installed)) throw new Error('Native CSO launcher is missing; run bun run build:cso with MSVC first.');
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'CSO launcher 空間 '));
  launcher = path.join(temporary, 'gstack-cso-launcher.exe');
  core = path.join(temporary, 'gstack-cso-core.exe');
  invocationCwd = path.join(temporary, 'audited cwd');
  fs.mkdirSync(invocationCwd);
  marker = path.join(temporary, 'preload-ran');
  preload = path.join(temporary, 'preload.ts');
  fs.writeFileSync(preload, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'startup injection');`);
  const source = path.join(temporary, 'core-fixture.ts');
  fs.writeFileSync(source, `import {existsSync,writeFileSync} from 'node:fs';
const hold=process.argv.indexOf('--hold-until');
if(hold>=0){writeFileSync(process.argv[hold+1],String(process.pid));while(!existsSync(process.argv[hold+2]))await Bun.sleep(10);writeFileSync(process.argv[hold+3],'exited');}
process.stdout.write(JSON.stringify({argv:process.argv.slice(2),env:process.env,cwd:process.cwd()}));
if(process.argv.includes('--exit-23'))process.exit(23);`);
  const compiled = spawnSync(process.execPath, ['build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', source, '--outfile', core], { encoding: 'utf8', timeout: 60_000 });
  expect(compiled.status).toBe(0);
  const digest = createHash('sha256').update(fs.readFileSync(core)).digest('hex');
  buildStage = fs.mkdtempSync(path.join(ROOT, 'bin', '.gstack-cso-stage.windows-launcher-test.'));
  const stagedLauncher = path.join(buildStage, 'gstack-cso-launcher.exe');
  const stagedPublisher = path.join(buildStage, 'gstack-cso-publish-lock.exe');
  const native = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'build-cso-windows.ps1'), '-RepoRoot', ROOT,
    '-OutputPath', stagedLauncher, '-LockOutputPath', stagedPublisher, '-CoreSha256', digest, '-GitExePath', Bun.which('git')!],
  { encoding: 'utf8', timeout: 60_000 });
  if (native.status !== 0) throw new Error(`Fixture launcher compilation failed: ${native.stdout}${native.stderr}`);
  fs.copyFileSync(stagedLauncher, launcher);
  publisher = path.join(temporary, 'gstack-cso-publish-lock.exe');
  fs.copyFileSync(stagedPublisher, publisher);
  fs.writeFileSync(path.join(temporary, '.gstack-cso-generation.lock'), '');
  fs.writeFileSync(path.join(temporary, '.gstack-cso-generation'), `${digest}\n`);
  fs.rmSync(buildStage, { recursive: true, force: true }); buildStage = '';
}, 140_000);
afterAll(() => {
  if (buildStage) fs.rmSync(buildStage, { recursive: true, force: true });
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

function launchEnvironment(extra: Record<string, string> = {}) {
  return { ...process.env, HOME: temporary, GSTACK_HOME: path.join(temporary, 'state'), PATH: temporary,
    NODE_OPTIONS: '--require=hostile', RUBYOPT: '-rhostile', PYTHONPATH: temporary,
    GSTACK_CSO_SECRET_CANARY: 'must-not-cross-startup', ...extra };
}

function launch(args: string[], extra: Record<string, string> = {}, file = launcher) {
  return spawnSync(file, args, {
    cwd: invocationCwd, encoding: 'utf8', timeout: 30_000,
    env: launchEnvironment(extra),
  });
}

async function waitForFile(file: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file) && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.existsSync(file)).toBe(true);
}

function publishProbe() {
  return spawnSync(publisher, [temporary, process.execPath, '--version'], { encoding: 'utf8', timeout: 10_000 });
}

function pathIdentity(value: string) {
  const stat = fs.statSync(value, { bigint: true });
  return { device: stat.dev, file: stat.ino };
}

function expectSuccessfulProcess(result: ReturnType<typeof spawnSync>, label: string) {
  if (result.status === 0) return;
  const bounded = (value: unknown) => String(value ?? '').slice(0, 8192);
  throw new Error(`${label} failed: ${JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: bounded(result.stdout),
    stderr: bounded(result.stderr),
  })}`);
}

describe('CSO native Windows build contract', () => {
  test('Windows builds use MSVC with a static CRT and no Bun-hosted public launcher', () => {
    const build = fs.readFileSync(path.join(ROOT, 'scripts/build-cso.sh'), 'utf8');
    const msvc = fs.readFileSync(path.join(ROOT, 'scripts/build-cso-windows.ps1'), 'utf8');
    expect(build).toContain('powershell.exe -NoProfile -NonInteractive');
    expect(build).toContain('build-cso-windows.ps1');
    expect(build).toContain('-OutputPath "$(cygpath -w "$CSO_STAGE_LAUNCHER")"');
    expect(build).toContain('-LockOutputPath "$(cygpath -w "$CSO_STAGE_LOCKER")"');
    expect(build).toContain('-CoreSha256 "$CSO_CORE_SHA256"');
    expect(build).toContain('-GitExePath "$(cygpath -aw "$CSO_WINDOWS_GIT")"');
    expect(build).toContain('CSO_PUBLISH_SHELL="$(cygpath -aw /usr/bin/bash.exe)"');
    expect(build).not.toContain('launcher-windows.ts');
    expect(fs.existsSync(path.join(ROOT, 'lib/cso/launcher-windows.ts'))).toBe(false);
    expect(msvc).toContain('Launch-VsDevShell.ps1');
    expect(msvc).toContain('[switch]$CheckOnly');
    expect(msvc).toContain('Normal CSO Windows builds require staged outputs and a lowercase SHA-256 core binding.');
    expect(msvc).toContain("[System.IO.FileAttributes]::ReparsePoint");
    expect(msvc).not.toContain("Join-Path $RepoRoot 'bin\\gstack-cso-launcher.exe'");
    expect(msvc).toContain("Set-Content -LiteralPath $source");
    expect(msvc).toContain('-Arch amd64 -HostArch amd64 -SkipAutomaticLocation');
    expect(msvc).toContain('StartsWith($installationPrefix');
    expect(msvc).toContain('/MT');
    expect(msvc).toContain('/W4 /WX');
    expect(msvc).toContain('GSTACK_CSO_CORE_SHA256');
    expect(msvc).toContain('GSTACK_CSO_GIT_PATH');
    expect(msvc).toContain('/FI$binding');
    expect(msvc).toContain('if ($LASTEXITCODE -ne 0)');
    const processSource=fs.readFileSync(path.join(ROOT,'lib','cso','process.ts'),'utf8');
    expect(processSource).toContain("includeNullPath=process.platform==='win32'?'/dev/null':nullPath");
    const launcherSource = fs.readFileSync(path.join(ROOT, 'lib/cso/launcher-windows.c'), 'utf8');
    expect(launcherSource).toContain('.gstack-cso-generation.lock');
    expect(launcherSource).toContain('.gstack-cso-generation');
    expect(launcherSource).toContain('GSTACK_CSO_CORE_SHA256');
    expect(launcherSource).toContain('BCryptOpenAlgorithmProvider');
    expect(launcherSource).toContain('MS_PRIMITIVE_PROVIDER');
    expect(launcherSource).toContain('sha256_handle(pinned_core');
    expect(launcherSource).toContain('#pragma comment(lib, "bcrypt.lib")');
    expect(launcherSource).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST');
    expect(launcherSource).toContain('joined_path');
    const childWait = launcherSource.indexOf('WaitForSingleObject(child.hProcess, INFINITE)');
    expect(childWait).toBeGreaterThan(0);
    expect(launcherSource.lastIndexOf('CloseHandle(pinned_core)')).toBeGreaterThan(childWait);
    expect(launcherSource.lastIndexOf('CloseHandle(generation_gate)')).toBeGreaterThan(childWait);
    const publisherSource = fs.readFileSync(path.join(ROOT, 'lib/cso/publish-lock.c'), 'utf8');
    expect(publisherSource).toContain('joined_path');
    expect(publisherSource).toContain('GENERIC_READ | GENERIC_WRITE, 0');
  });

  test('Windows CI runs the actual launcher tests rather than marking the platform supported from a source check', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/free-tests.yml'), 'utf8')) as any;
    const job = workflow.jobs['cso-windows-launcher'];
    expect(job['runs-on']).toBe('windows-latest');
    expect(job.steps.some((s: any) => s.run === 'bun run build:cso' && s.shell === 'bash')).toBe(true);
    const smoke = job.steps.find((s: any) => s.run === 'bun run test:cso:windows');
    expect(smoke.env.GSTACK_CSO_WINDOWS_TESTS).toBe('1');
    expect(smoke['continue-on-error']).not.toBe(true);
  });

  test.skipIf(!windows)('Windows build refuses output path escapes before invoking MSVC',()=>{
    const script=path.join(ROOT,'scripts/build-cso-windows.ps1'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'cso-bin-evil-'));
    const stage=fs.mkdtempSync(path.join(ROOT,'bin','.gstack-cso-stage.path-test.'));
    const validOutput=path.join(stage,'gstack-cso-launcher.exe'),validLock=path.join(stage,'gstack-cso-publish-lock.exe'),digest='a'.repeat(64);
    try{
      for(const [output,lock] of [[path.join(outside,'gstack-cso-launcher.exe'),validLock],[path.join(stage,'..','gstack-cso-launcher.exe'),validLock],[path.join(stage,'wrong.exe'),validLock],[validOutput,path.join(outside,'gstack-cso-publish-lock.exe')],[validOutput,path.join(stage,'wrong-lock.exe')]]){
        const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-RepoRoot',ROOT,'-OutputPath',output,'-LockOutputPath',lock,'-CoreSha256',digest,'-GitExePath',Bun.which('git')!],{encoding:'utf8',timeout:30_000});
        expect(result.status).not.toBe(0);expect(`${result.stdout}${result.stderr}`).toContain('direct, non-reparse staging directory');
      }
    }finally{fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
  });
});

(windows ? describe : describe.skip)('CSO native Windows startup', () => {
  test('BUN_OPTIONS cannot execute a preload before the environment is scrubbed', () => {
    const result = launch(['--version'], { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    const value = JSON.parse(result.stdout);
    expect(value.argv).toEqual(['--version']);
    expect(value.env.BUN_OPTIONS).toBeUndefined();
    expect(value.env.GSTACK_CSO_SECRET_CANARY).toBeUndefined();
    expect(value.env.NODE_OPTIONS).toBeUndefined();
    expect(value.env.GSTACK_HOME).toBe(path.join(temporary, 'state'));
    expect(value.env.PATH).not.toBe(temporary);
    expect(value.env.SystemRoot.toLowerCase()).toBe(process.env.SystemRoot!.toLowerCase());
    expect(pathIdentity(value.cwd)).toEqual(pathIdentity(temporary));
    expect(pathIdentity(value.cwd)).not.toEqual(pathIdentity(invocationCwd));
  });

  test('BUN_BE_BUN cannot turn the public command into the Bun runtime', () => {
    const result = launch(['--version'], { BUN_BE_BUN: '1' });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.argv).toEqual(['--version']);
    expect(value.env.BUN_BE_BUN).toBeUndefined();
  });

  test('preserves Unicode, empty, quoted, trailing-backslash and shell-looking arguments', () => {
    const args = ['', '空間', 'with spaces', 'a"b', 'C:\\directory with spaces\\', '\\"', '& whoami', '%PATH%', 'line\nbreak'];
    const result = launch(args);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).argv).toEqual(args);
  });

  test('forwards child exit status and fails closed on oversized inherited input', () => {
    expect(launch(['--exit-23']).status).toBe(23);
    const result = launch([], { GSTACK_HOME: 'x'.repeat(8193) });
    expect(result.status).toBe(69);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('environment input is too large');
  });

  test('resolves launcher installation aliases before locating its sibling core', () => {
    const alias = path.join(temporary, 'alias');
    fs.symlinkSync(temporary, alias, 'junction');
    const result = launch(['--version'], {}, path.join(alias, 'gstack-cso-launcher.exe'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).argv).toEqual(['--version']);
    fs.unlinkSync(alias);
  });

  test('rejects a launcher/manifest generation mismatch before executing the core', () => {
    const mismatched = path.join(temporary, 'mismatched generation');
    fs.mkdirSync(mismatched);
    fs.copyFileSync(launcher, path.join(mismatched, 'gstack-cso-launcher.exe'));
    fs.copyFileSync(core, path.join(mismatched, 'gstack-cso-core.exe'));
    fs.writeFileSync(path.join(mismatched, '.gstack-cso-generation.lock'), '');
    fs.writeFileSync(path.join(mismatched, '.gstack-cso-generation'), `${'0'.repeat(64)}\n`);
    const result = launch(['--version'], {}, path.join(mismatched, 'gstack-cso-launcher.exe'));
    expect(result.status).toBe(69);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('generations do not match');
  });

  test('rejects changed core bytes even when the generation manifest is unchanged', () => {
    const tampered = path.join(temporary, 'tampered core');
    fs.mkdirSync(tampered);
    const tamperedLauncher = path.join(tampered, 'gstack-cso-launcher.exe');
    const tamperedCore = path.join(tampered, 'gstack-cso-core.exe');
    fs.copyFileSync(launcher, tamperedLauncher);
    fs.copyFileSync(core, tamperedCore);
    fs.appendFileSync(tamperedCore, Buffer.from([0]));
    fs.writeFileSync(path.join(tampered, '.gstack-cso-generation.lock'), '');
    fs.copyFileSync(path.join(temporary, '.gstack-cso-generation'), path.join(tampered, '.gstack-cso-generation'));
    const result = launch(['--version'], {}, tamperedLauncher);
    expect(result.status).toBe(69);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('digest does not match');
  });

  test('the inherited generation gate survives launcher termination until the core exits', async () => {
    const ready = path.join(temporary, 'held-core.ready'), release = path.join(temporary, 'held-core.release'), exited = path.join(temporary, 'held-core.exited');
    const running = spawn(launcher, ['--hold-until', ready, release, exited], { cwd: invocationCwd, env: launchEnvironment(), stdio: 'ignore' });
    try {
      await waitForFile(ready);
      const launcherExited = new Promise<void>(resolveExit => running.once('exit', () => resolveExit()));
      running.kill('SIGKILL');
      await launcherExited;
      expect(publishProbe().status).toBe(73);
      fs.writeFileSync(release, 'release');
      const deadline = Date.now() + 10_000; let result = publishProbe();
      while (result.status === 73 && Date.now() < deadline) { await Bun.sleep(20); result = publishProbe(); }
      expect(result.status).toBe(0);
    } finally {
      fs.writeFileSync(release, 'release');
      if (!running.killed) running.kill('SIGKILL');
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await Bun.sleep(10);
    }
  }, 30_000);

  test('a missing core never falls back to a PATH executable or Bun', () => {
    const missing = path.join(temporary, 'missing core');
    fs.mkdirSync(missing);
    const copy = path.join(missing, 'gstack-cso-launcher.exe');
    fs.copyFileSync(launcher, copy);
    fs.writeFileSync(path.join(missing, '.gstack-cso-generation.lock'), '');
    fs.copyFileSync(path.join(temporary, '.gstack-cso-generation'), path.join(missing, '.gstack-cso-generation'));
    const result = launch(['--version'], {}, copy);
    expect(result.status).toBe(69);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('trusted compiled helper is missing');
  });

  test('the actual helper finds trusted Git and stores state under USERPROFILE without HOME', () => {
    const repository=path.join(temporary,'actual repository'),profile=path.join(temporary,'profile');
    fs.mkdirSync(repository);fs.mkdirSync(profile);
    const git='C:\\Program Files\\Git\\cmd\\git.exe',gitEnv={...process.env,HOME:profile};
    for(const args of [['init','-q'],['config','user.email','fixture@example.test'],['config','user.name','Fixture']] as string[][]){const result=spawnSync(git,args,{cwd:repository,encoding:'utf8',env:gitEnv,timeout:10_000});expect(result.status).toBe(0);}
    fs.writeFileSync(path.join(repository,'app.js'),'console.log("safe")\n');
    for(const args of [['add','app.js'],['commit','-qm','fixture']] as string[][]){const result=spawnSync(git,args,{cwd:repository,encoding:'utf8',env:gitEnv,timeout:10_000});expect(result.status).toBe(0);}
    const actual=path.join(ROOT,'bin','gstack-cso-launcher.exe'),env={...process.env,HOME:'',GSTACK_HOME:'',CLAUDE_PLUGIN_ROOT:'',CLAUDE_PLUGIN_DATA:'',USERPROFILE:profile,PATH:temporary,NODE_OPTIONS:'--require=hostile'};
    const doctor=spawnSync(actual,['doctor','--repo',repository],{cwd:repository,encoding:'utf8',env,timeout:30_000});expect(doctor.status).toBe(0);expect(JSON.parse(doctor.stdout).downloads).toBe(false);
    const started=spawnSync(actual,['start','--repo',repository,'--offline'],{cwd:repository,encoding:'utf8',env,timeout:30_000});expectSuccessfulProcess(started,'gstack-cso start');expect(JSON.parse(started.stdout).schemaVersion).toBe(3);expect(fs.existsSync(path.join(profile,'.gstack','security','cso'))).toBe(true);
  });
});
