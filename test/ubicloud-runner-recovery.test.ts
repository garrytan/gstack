/**
 * GST-1220: a dead controller strands nothing. The VM pushes its own results to the
 * caller's sink, and `recover` rebuilds a VM's local state on another controller
 * from the encrypted bundle `up` wrote. Offline: the fake API and fake VM only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { creates, fakeVm, gitSrc, run, until, type FakeVm } from './helpers/ubi-runner-fake-vm';

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
    await until(() => existsSync(join(f.vm, '.ubirun-sink.curl')), 30_000);
    expect(readFileSync(join(f.vm, '.ubirun-sink.curl'), 'utf8')).toContain('sekritsig123');
    expect(statSync(join(f.vm, '.ubirun-sink.curl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.vm, '.ubirun-sink.conf')).mode & 0o777).toBe(0o600);
    expect(f.ssh()).not.toContain('sekritsig123');
    expect(out(up)).not.toContain('sekritsig123');
  }, 60_000);

  test('a failed final push prints SINK_FLUSH_FAILED, the VM is destroyed anyway, and run exits 1', () => {
    const f = make();
    const blocker = join(f.root, 'blocker');
    writeFileSync(blocker, 'a file where the sink directory should be\n');
    const r = run(f, ['run', '--src', gitSrc(f), '--', 'echo hi'], { ...fileSink(f, blocker), UBI_SINK_INTERVAL: '3600' });
    expect(out(r)).toContain('SINK_FLUSH_FAILED: vm=');
    expect(r.exitCode).toBe(1);
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
    for (const extra of [{ UBI_COUNTED: '1' }, {}]) {
      const r = run(f, extra.UBI_COUNTED ? ['up'] : ['up', '--counted'], { ...extra, UBI_REAP: '0' });
      expect(r.exitCode).not.toBe(0);
      expect(out(r)).toContain('UBI_RECOVERY_REQUIRED');
    }
    expect(creates(f)).toBe(0);
  });
});
