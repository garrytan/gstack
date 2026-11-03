/**
 * GST-1220: a dead controller strands nothing. The VM pushes its own results to the
 * caller's sink, and `recover` rebuilds a VM's local state on another controller
 * from the encrypted bundle `up` wrote. Offline: the fake API and fake VM only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { creates, fakeVm, gitSrc, run, until, vmDirs, type FakeVm } from './helpers/ubi-runner-fake-vm';

const fixtures: FakeVm[] = [];
const make = () => { const f = fakeVm(); fixtures.push(f); return f; };
const stopSink = (f: FakeVm) => {
  const pidFile = join(f.vm, '.ubirun-sink.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader or gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
};
afterEach(() => {
  for (const f of fixtures.splice(0)) { stopSink(f); rmSync(f.root, { recursive: true, force: true }); }
});
const out = (r: { stdout: Buffer; stderr: Buffer }) => r.stdout.toString() + r.stderr.toString();
const tarList = (tgz: string) => Bun.spawnSync(['tar', '-tzf', tgz], { timeout: 10_000 }).stdout.toString();
const heartbeat = (tgz: string) => {
  const r = Bun.spawnSync(['tar', '-xzOf', tgz, 'heartbeat.json'], { timeout: 10_000 });
  try { return JSON.parse(r.stdout.toString()) as { vm: string; seq: number }; } catch { return { vm: '', seq: 0 }; }
};
const fileSink = (f: FakeVm, dir = join(f.root, 'sink')) => ({ UBI_SINK: 'file:' + dir, UBI_SINK_ALLOW_FILE: '1', UBI_SINK_INTERVAL: '1', UBI_REAP: '0' });
const keyBody = (key: string) => key.split('\n').filter(l => l && !l.startsWith('-----'));

describe('ubi-runner results sink (GST-1220 a)', () => {
  test('the controller dies after up, and the VM still pushes its results to the sink', async () => {
    const f = make();
    const up = run(f, ['up', '--sink-path', 'results'], fileSink(f));
    expect(out(up)).toContain('sink: pushing');
    expect(up.exitCode).toBe(0);
    const name = up.stdout.toString().trim();
    rmSync(f.state, { recursive: true, force: true });
    mkdirSync(join(f.vm, 'results'), { recursive: true });
    writeFileSync(join(f.vm, 'results', 'r.json'), '{"score": 7}\n');
    const tgz = join(f.root, 'sink', name, 'results.tgz');
    await until(() => existsSync(tgz) && tarList(tgz).includes('results/r.json'), 30_000);
    const first = heartbeat(tgz);
    expect(first.vm).toBe(name);
    writeFileSync(join(f.vm, 'results', 'r2.json'), '{"score": 8}\n');
    await until(() => heartbeat(tgz).seq > first.seq && tarList(tgz).includes('results/r2.json'), 30_000);
  }, 90_000);

  test('a sink must be a presigned https-put URL; file: only under the test switch; nothing is created otherwise', () => {
    const f = make();
    for (const spec of ['http://plain.example/x', 'git:https://github.com/a/b', 'file:/tmp/x']) {
      const r = run(f, ['up'], { UBI_SINK: spec, UBI_REAP: '0' });
      expect(r.exitCode).not.toBe(0);
      expect(out(r)).toContain('UBI_SINK_INVALID');
    }
    expect(creates(f)).toBe(0);
  });

  test('the presigned URL reaches the VM only through a 600 file, never a command line or a log', async () => {
    const f = make();
    const url = 'https://bucket.example/o?X-Amz-Signature=sekritsig123';
    const up = run(f, ['up'], { UBI_SINK: 'https-put:' + url, UBI_REAP: '0' });
    expect(up.exitCode).toBe(0);
    await until(() => existsSync(join(f.vm, '.ubirun-sink.curl')) && existsSync(join(f.vm, '.ubirun-sink.pid')), 30_000);
    expect(readFileSync(join(f.vm, '.ubirun-sink.curl'), 'utf8')).toContain('sekritsig123');
    expect(statSync(join(f.vm, '.ubirun-sink.curl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.vm, '.ubirun-sink.conf')).mode & 0o777).toBe(0o600);
    expect(f.ssh()).not.toContain('sekritsig123');
    expect(out(up)).not.toContain('sekritsig123');
  }, 60_000);

  test('run keeps the presigned URL out of its run record, and a command word --sink stays in it', async () => {
    const f = make();
    writeFileSync(join(f.root, 'make-test.sh'), 'echo begin; sleep 3\n');
    const a = f.spawn(['run', '--sink', 'https-put:https://b.example/o?X-Amz-Signature=sekritsig456', '--src', gitSrc(f), '--', 'make', 'test', '--sink', 'kept'], { UBI_REAP: '0' });
    await until(() => vmDirs(f).some(d => existsSync(join(f.state, d, 'command.out')) && readFileSync(join(f.state, d, 'command.out'), 'utf8').includes('begin')), 30_000);
    const name = vmDirs(f)[0]!;
    const record = readFileSync(join(f.state, name, 'run'), 'utf8');
    expect(record).not.toContain('sekritsig456');
    expect(record).toContain(' -- make test --sink kept');
    expect(await a.exited).toBe(0);
    expect(f.listed().trim()).toBe('');
  }, 90_000);

  test('a failed final push prints SINK_FLUSH_FAILED, the VM is destroyed anyway, and run exits 1', () => {
    const f = make();
    const blocker = join(f.root, 'blocker');
    writeFileSync(blocker, 'a file where the sink directory should be\n');
    const r = run(f, ['run', '--src', gitSrc(f), '--', 'echo hi'], { ...fileSink(f, blocker), UBI_SINK_INTERVAL: '3600' });
    expect(out(r)).toContain('SINK_FLUSH_FAILED: vm=');
    expect(r.exitCode).toBe(1);
    expect(f.listed().trim()).toBe('');
  }, 90_000);

  test('a snapshot over UBI_SINK_MAX_MB keeps the last good one, and the final flush stops the pusher and fails', async () => {
    const f = make();
    const env = { ...fileSink(f), UBI_SINK_MAX_MB: '1' };
    const up = run(f, ['up', '--sink-path', 'results', '--sink-path', '.'], env);
    expect(up.exitCode).toBe(0);
    const name = up.stdout.toString().trim();
    mkdirSync(join(f.vm, 'results'), { recursive: true });
    writeFileSync(join(f.vm, 'results', 'r.json'), '{"score": 7}\n');
    const tgz = join(f.root, 'sink', name, 'results.tgz');
    await until(() => existsSync(tgz) && tarList(tgz).includes('results/r.json'), 30_000);
    expect(tarList(tgz)).not.toContain('.ubirun-');
    const pid = Number(readFileSync(join(f.vm, '.ubirun-sink.pid'), 'utf8').trim());
    writeFileSync(join(f.vm, 'results', 'big.bin'), Buffer.from(Array.from({ length: 3 << 20 }, () => Math.floor(Math.random() * 256))));
    const down = run(f, ['down', name], env);
    expect(down.exitCode).toBe(0);
    expect(out(down)).toMatch(new RegExp('SINK_FLUSH_FAILED: vm=' + name + ' seq=\\d+ last_push=\\d+ sink_skipped=size'));
    expect(tarList(tgz)).toContain('results/r.json');
    expect(tarList(tgz)).not.toContain('big.bin');
    expect(() => process.kill(pid, 0)).toThrow();
  }, 90_000);

  test('a reaped VM whose final push fails does not fail a run that passed on its own VM', () => {
    const f = make();
    const blocker = join(f.root, 'blocker');
    writeFileSync(blocker, 'a file where the sink directory should be\n');
    const old = 'ubirun-thrd1-1000000000-abcd1234-t1';
    expect(run(f, ['up', '-n', old], { ...fileSink(f, blocker), UBI_SINK_INTERVAL: '3600' }).exitCode).toBe(0);
    const r = run(f, ['run', '--src', gitSrc(f), '--', 'echo hi']);
    expect(out(r)).toContain('SINK_FLUSH_FAILED: vm=' + old);
    expect(r.exitCode).toBe(0);
    expect(f.listed().trim()).toBe('');
  }, 90_000);
});

describe('ubi-runner recovery bundle (GST-1220 b)', () => {
  const setup = () => {
    const f = make();
    const rec = join(f.root, 'recovery');
    const up = run(f, ['up', '--tag', 'shard=3'], { UBI_RECOVERY_DIR: rec, UBI_REAP: '0' });
    expect(up.exitCode).toBe(0);
    const name = up.stdout.toString().trim();
    const key = readFileSync(join(f.state, name, 'key'), 'utf8');
    const bundle = join(rec, 'thrd1', name + '.bundle');
    return { f, rec, up, name, key, bundle, state2: join(f.root, 'state2') };
  };

  test('recover rebuilds a VM on a new controller, and pull and down work from there', () => {
    const { f, rec, up, name, key, bundle, state2 } = setup();
    expect(existsSync(bundle)).toBe(true);
    expect(statSync(bundle).mode & 0o777).toBe(0o600);
    expect(readFileSync(bundle, 'latin1')).not.toContain('PRIVATE KEY');
    const env2 = { UBI_RECOVERY_DIR: rec, UBI_RUNNER_STATE: state2, UBI_OWNER: 'thrd2', UBI_REAP: '0' };
    const r = run(f, ['recover', '--owner', 'thrd1'], env2);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain(`RECOVERED: vm=${name} ip=192.0.2.1 owner=thrd1 tags=shard=3`);
    expect(readFileSync(join(state2, name, 'key'), 'utf8')).toBe(key);
    expect(statSync(join(state2, name)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(state2, name, 'env'), 'utf8')).toMatch(/^CREATE_PID=$/m);
    const again = run(f, ['recover', '--owner', 'thrd1'], env2);
    expect(again.stdout.toString()).toContain(`RECOVER_FAILED: vm=${name} code=RECOVER_EXISTS`);
    mkdirSync(join(f.root, 'remote-fs', 'results'), { recursive: true });
    writeFileSync(join(f.root, 'remote-fs', 'results', 'r.json'), '{}\n');
    expect(run(f, ['pull', name, 'results', join(f.root, 'pulled')], env2).exitCode).toBe(0);
    expect(existsSync(join(f.root, 'pulled', 'results', 'r.json'))).toBe(true);
    const down = run(f, ['down', name], env2);
    expect(down.exitCode).toBe(0);
    expect(existsSync(bundle)).toBe(false);
    expect(f.listed().trim()).toBe('');
    for (const line of keyBody(key)) for (const text of [out(up), out(r), out(down), f.ssh()]) expect(text).not.toContain(line);
  }, 90_000);

  test('a wrong secret or a tampered bundle never decrypts, writes no state and keeps the bundle', () => {
    const { f, rec, name, bundle, state2 } = setup();
    const env2 = { UBI_RECOVERY_DIR: rec, UBI_RUNNER_STATE: state2, UBI_REAP: '0' };
    const wrong = run(f, ['recover'], { ...env2, UBI_RECOVERY_KEY: 'not-the-secret' });
    expect(wrong.stdout.toString()).toContain(`RECOVER_FAILED: vm=${name} code=RECOVER_DECRYPT_FAILED`);
    const bytes = readFileSync(bundle);
    bytes[bytes.length - 40] ^= 1;
    writeFileSync(bundle, bytes);
    chmodSync(bundle, 0o600);
    const tampered = run(f, ['recover'], env2);
    expect(tampered.stdout.toString()).toContain(`RECOVER_FAILED: vm=${name} code=RECOVER_DECRYPT_FAILED`);
    expect(existsSync(join(state2, name))).toBe(false);
    expect(existsSync(bundle)).toBe(true);
  }, 60_000);

  test('a valid bundle under another VM or owner name is refused before the API is asked', () => {
    const { f, rec, name, bundle, state2 } = setup();
    const other = 'ubirun-other-1700000000-dead1234-t3';
    writeFileSync(join(rec, 'thrd1', other + '.bundle'), readFileSync(bundle));
    mkdirSync(join(rec, 'thrd9'), { recursive: true });
    writeFileSync(join(rec, 'thrd9', name + '.bundle'), readFileSync(bundle));
    writeFileSync(join(f.root, 'listed'), f.listed() + 'us-east-a2 ' + other + '\n');
    const env2 = { UBI_RECOVERY_DIR: rec, UBI_RUNNER_STATE: state2, UBI_REAP: '0' };
    const r = run(f, ['recover'], env2);
    expect(r.stdout.toString()).toContain(`RECOVER_FAILED: vm=${other} code=RECOVER_DECRYPT_FAILED`);
    expect(r.stdout.toString()).toContain(`RECOVERED: vm=${name}`);
    expect(existsSync(join(state2, other))).toBe(false);
    const adopted = run(f, ['recover', '--owner', 'thrd9'], { ...env2, UBI_RUNNER_STATE: join(f.root, 'state3') });
    expect(adopted.stdout.toString()).toContain(`RECOVER_FAILED: vm=${name} code=RECOVER_DECRYPT_FAILED`);
  }, 60_000);

  test('an API outage keeps the bundle; a VM that is gone drops it', () => {
    const { f, rec, name, bundle, state2 } = setup();
    const env2 = { UBI_RECOVERY_DIR: rec, UBI_RUNNER_STATE: state2, UBI_REAP: '0' };
    writeFileSync(join(f.root, 'listed.show-fails'), '');
    const down = run(f, ['recover'], env2);
    expect(down.stdout.toString()).toContain(`RECOVER_FAILED: vm=${name} code=RECOVER_API_UNAVAILABLE`);
    expect(existsSync(bundle)).toBe(true);
    rmSync(join(f.root, 'listed.show-fails'));
    writeFileSync(join(f.root, 'listed'), '');
    const gone = run(f, ['recover'], env2);
    expect(gone.stdout.toString()).toContain(`RECOVER_GONE: vm=${name}`);
    expect(existsSync(bundle)).toBe(false);
  }, 60_000);

  test('a counted run refuses before any create without a recovery directory', () => {
    const f = make();
    for (const [args, extra] of [[['up'], { UBI_COUNTED: '1' }], [['up', '--counted'], {}]] as [string[], Record<string, string>][]) {
      const r = run(f, args, { ...extra, UBI_REAP: '0' });
      expect(r.exitCode).not.toBe(0);
      expect(out(r)).toContain('UBI_RECOVERY_REQUIRED');
    }
    expect(creates(f)).toBe(0);
    writeFileSync(join(f.root, 'blocker'), 'a file where the recovery directory should be\n');
    const unwritable = run(f, ['up', '--counted'], { UBI_RECOVERY_DIR: join(f.root, 'blocker', 'rec'), UBI_REAP: '0' });
    expect(unwritable.exitCode).not.toBe(0);
    expect(out(unwritable)).toContain('UBI_RECOVERY_UNAVAILABLE');
    expect(creates(f)).toBe(0);
    for (const bad of [['--sink-path', '/etc'], ['--sink-path', 'a/../..'], ['--tag', 'no-equals']]) {
      const r = run(f, ['up', ...bad], { UBI_REAP: '0' });
      expect(r.exitCode).not.toBe(0);
    }
    expect(creates(f)).toBe(0);
    const rec = join(f.root, 'recovery');
    const ok = run(f, ['up', '--counted'], { UBI_RECOVERY_DIR: rec, UBI_REAP: '0' });
    expect(ok.exitCode).toBe(0);
    expect(existsSync(join(rec, 'thrd1', ok.stdout.toString().trim() + '.bundle'))).toBe(true);
  });

  test('a counted rerun refuses to reattach to a VM that has no bundle', async () => {
    const f = make();
    const repo = gitSrc(f);
    writeFileSync(join(f.root, 'make-test.sh'), 'echo begin; sleep 4; echo end\n');
    const a = f.spawn(['run', '--src', repo, '--', 'make test'], { UBI_REAP: '0' });
    await until(() => vmDirs(f).some(d => existsSync(join(f.state, d, 'command.out')) && readFileSync(join(f.state, d, 'command.out'), 'utf8').includes('begin')), 30_000);
    process.kill(a.pid, 'SIGKILL');
    await a.exited;
    const name = vmDirs(f)[0]!;
    const r = run(f, ['run', '--counted', '--src', repo, '--', 'make test'], { UBI_RECOVERY_DIR: join(f.root, 'rec'), UBI_REAP: '0' });
    expect(out(r)).toContain('UBI_RECOVERY_REQUIRED: a counted run would reattach to ' + name);
    expect(r.exitCode).not.toBe(0);
    expect(creates(f)).toBe(1);
    expect(run(f, ['down', name]).exitCode).toBe(0);
  }, 90_000);

  test('a counted rerun refuses a bundle that does not open, and reattaches once the bundle is good again', async () => {
    const f = make();
    const repo = gitSrc(f);
    const rec = join(f.root, 'rec');
    writeFileSync(join(f.root, 'make-test.sh'), 'echo begin; sleep 4; echo end\n');
    const a = f.spawn(['run', '--src', repo, '--', 'make test'], { UBI_RECOVERY_DIR: rec, UBI_REAP: '0' });
    await until(() => vmDirs(f).some(d => existsSync(join(f.state, d, 'command.out')) && readFileSync(join(f.state, d, 'command.out'), 'utf8').includes('begin')), 30_000);
    process.kill(a.pid, 'SIGKILL');
    await a.exited;
    const name = vmDirs(f)[0]!;
    const bundle = join(rec, 'thrd1', name + '.bundle');
    const good = readFileSync(bundle);
    writeFileSync(bundle, 'not a bundle\n');
    const corrupt = run(f, ['run', '--counted', '--src', repo, '--', 'make test'], { UBI_RECOVERY_DIR: rec, UBI_REAP: '0' });
    expect(out(corrupt)).toContain('UBI_RECOVERY_REQUIRED: a counted run would reattach to ' + name);
    expect(corrupt.exitCode).not.toBe(0);
    expect(creates(f)).toBe(1);
    writeFileSync(bundle, good);
    const ok = run(f, ['run', '--counted', '--src', repo, '--', 'make test'], { UBI_RECOVERY_DIR: rec, UBI_REAP: '0' });
    expect(out(ok)).toContain('reattached to ' + name);
    expect(ok.exitCode).toBe(0);
    expect(creates(f)).toBe(1);
  }, 90_000);

  test('the runner never forwards its own variables: --pass and --trust-config both refuse them', () => {
    const f = make();
    const dir = gitSrc(f, { command: 'make verify', pass: ['RECOVERY_SECRET'] });
    const env = { UBI_RECOVERY_KEY: 'recovery-key-value', UBI_SINK: 'https-put:https://b.example/o?X-Amz-Signature=sekritsig321', UBI_REAP: '0' };
    const trusted = run(f, ['verify', '--src', dir, '--trust-config'], env);
    expect(trusted.exitCode).toBe(1);
    expect(out(trusted)).toContain('--pass RECOVERY_SECRET');
    for (const name of ['RECOVERY_SECRET', 'RECOVERY_DIR', 'OWNER', 'SINK_INTERVAL', 'UBI_RECOVERY_KEY', 'UBI_SINK']) {
      const r = run(f, ['run', '--pass', name, '--src', dir, '--', 'true'], env);
      expect(r.exitCode).toBe(1);
      expect(out(r)).toContain('--pass ' + name);
    }
    expect(creates(f)).toBe(0);
    expect(existsSync(join(f.root, 'ubirun-env'))).toBe(false);
  });

  test('--pass forwards the value the caller exported, never a runner variable of the same name', () => {
    const f = make();
    const sinkDir = join(f.root, 'sink');
    const repo = gitSrc(f);
    for (const name of ['opt', 'src', 'sink']) {
      const r = run(f, ['run', '--pass', name, '--src', repo, '--', 'test "$' + name + '" = caller-' + name], { ...fileSink(f, sinkDir), [name]: 'caller-' + name });
      expect(out(r)).not.toContain('not in this shell');
      expect(r.exitCode).toBe(0);
    }
    expect(f.ssh()).not.toContain(sinkDir);
  }, 120_000);

  test('an option value spelled --sink does not carry the presigned URL into the run record', async () => {
    const f = make();
    writeFileSync(join(f.root, 'make-test.sh'), 'echo begin; sleep 3\n');
    const a = f.spawn(['run', '--key-input', '--sink', '--sink', 'https-put:https://b.example/o?X-Amz-Signature=sekritsig789', '--src', gitSrc(f), '--', 'make', 'test'], { UBI_REAP: '0' });
    await until(() => vmDirs(f).some(d => existsSync(join(f.state, d, 'command.out')) && readFileSync(join(f.state, d, 'command.out'), 'utf8').includes('begin')), 30_000);
    const name = vmDirs(f)[0]!;
    const record = readFileSync(join(f.state, name, 'run'), 'utf8');
    expect(record).not.toContain('sekritsig789');
    expect(record).toContain('--key-input --sink --src');
    expect(await a.exited).toBe(0);
  }, 90_000);
});
