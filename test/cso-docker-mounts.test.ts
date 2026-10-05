import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONTAINER_SHM_BYTES, DockerGroup, type ContainerSpec } from '../lib/cso/docker';

const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-m-'));
  roots.push(root);
  const directory = path.join(root, 'input'), file = path.join(root, 'policy'), socket = path.join(root, 'r.sock');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(file, 'cso_primary\n', { mode: 0o444 });
  fs.chmodSync(file, 0o444);
  const listener = Bun.listen({ unix: socket, socket: { data() {} } });
  restores.push(() => listener.stop(true));
  const image = `sha256:${'a'.repeat(64)}`, id = 'b'.repeat(64), calls: string[][] = [];
  let createArgs: string[] = [];
  const inspectHooks: Array<(value: any) => void> = [];
  const group = new (DockerGroup as any)({}, 'mount-regression', root, Date.now() + 60_000, {}) as DockerGroup;
  if (process.getuid!() === 0) {
    const uid = spyOn(process, 'getuid').mockReturnValue(1001);
    const lstat = fs.lstatSync;
    const owner = spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = lstat(...args);
      if (stat) stat.uid = typeof stat.uid === 'bigint' ? 1001n : 1001;
      return stat;
    }) as typeof fs.lstatSync);
    restores.push(() => uid.mockRestore(), () => owner.mockRestore());
  }
  group.anchor = 'c'.repeat(64);
  (group as any).docker = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'image') return JSON.stringify({
      Id: image, Os: 'linux', Architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
      Config: { Entrypoint: ['/opt/cso/entrypoint'] },
    });
    if (args[0] === 'create') { createArgs = args; return id; }
    if (args[0] === 'inspect') {
      const tmpfs = createArgs.flatMap((arg, index) => arg === '--tmpfs' ? [createArgs[index + 1].split(':')[0]] : []);
      const mounts = createArgs.flatMap((arg, index) => arg === '--mount' ? [createArgs[index + 1]] : []);
      const binds = mounts.filter(mount => !mount.startsWith('type=volume,'));
      const volumes = mounts.filter(mount => mount.startsWith('type=volume,')).map(mount => ({
        target: /dst=([^,]+)/.exec(mount)![1], o: /"volume-opt=o=([^"]+)"/.exec(mount)![1],
      }));
      const value = {
        HostConfig: { ReadonlyRootfs: true, ShmSize: CONTAINER_SHM_BYTES, Tmpfs: Object.fromEntries(tmpfs.map(target => [target, 'rw'])),
          Mounts: [...binds.map(() => ({ Type: 'bind' })), ...volumes.map(volume => ({ Type: 'volume', Target: volume.target,
            VolumeOptions: { DriverConfig: { Name: 'local', Options: { device: 'tmpfs', o: volume.o, type: 'tmpfs' } } } }))] },
        Mounts: [...tmpfs.map(Destination => ({ Type: 'tmpfs', Destination })), ...binds.map(mount => ({
          Type: 'bind', Destination: mount.split(',').find(part => part.startsWith('dst='))!.slice(4),
        })), ...volumes.map(volume => ({ Type: 'volume', Destination: volume.target, Driver: 'local' }))],
      };
      for (const hook of inspectHooks) hook(value);
      return JSON.stringify(value);
    }
    throw new Error(`Unexpected Docker call: ${args.join(' ')}`);
  };
  return { root, directory, file, socket, group, image, id, calls, inspectHooks };
}

describe.skipIf(process.platform === 'win32')('CSO Docker nonrecursive bind mounts', () => {
  const cases: Array<{ name: string; target: string; spec: (f: ReturnType<typeof fixture>) => Partial<ContainerSpec> }> = [
    { name: 'source', target: '/source', spec: f => ({ source: f.directory }) },
    { name: 'policy file', target: '/policy/check.json', spec: f => ({ readonlyFiles: [{ host: f.file, container: '/policy/check.json' }] }) },
    { name: 'PostgreSQL policy', target: '/policy/postgresql.databases', spec: f => ({ role: 'postgres', postgresDatabasePolicy: f.file }) },
    { name: 'fixtures', target: '/fixtures', spec: f => ({ readonlyDirectories: [{ host: f.directory, container: '/fixtures' }] }) },
    { name: 'offline metadata', target: '/metadata', spec: f => ({ readonlyMetadata: f.directory }) },
    { name: 'acquisition input metadata', target: '/input-metadata', spec: f => ({ readonlyInputMetadata: f.directory, metadataTmpfsBytes: 1024 }) },
    { name: 'offline archives', target: '/archives', spec: f => ({ readonlyArchiveDirectory: f.directory }) },
    { name: 'registry socket', target: '/run/cso-registry.sock', spec: f => ({ registrySocket: f.socket }) },
  ];

  for (const item of cases) test(`${item.name} uses the supported read-only nonrecursive option`, async () => {
    const f = fixture();
    expect(await f.group.createContainer({ role: 'app', image: f.image, command: ['/bin/sleep', '1'], ...item.spec(f) })).toBe(f.id);
    const args = f.calls.find(call => call[0] === 'create')!;
    const mounts = args.flatMap((arg, index) => arg === '--mount' ? [args[index + 1].split(',')] : []);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toContain(`dst=${item.target}`);
    expect(mounts[0]).toContain('readonly');
    expect(mounts[0]).toContain('bind-recursive=disabled');
    expect(mounts[0].some(option => option.startsWith('bind-nonrecursive'))).toBe(false);
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('no-new-privileges:true');
    expect(args).toContain('seccomp=builtin');
    expect(args[args.indexOf('--network') + 1]).toBe(`container:${f.group.anchor}`);
    expect(fs.readFileSync(path.join(f.root, 'resources.journal'), 'utf8')).toBe(`container:${f.id}\n`);
  });

  test('unsafe bind paths and permissions fail before Docker create', async () => {
    const f = fixture(), link = path.join(f.root, 'link');
    fs.symlinkSync(f.directory, link);
    const invalid: Array<Partial<ContainerSpec>> = [
      { source: link },
      { readonlyFiles: [{ host: link, container: '/policy/check.json' }] },
      { readonlyFiles: [{ host: f.file, container: '/outside-policy' }] },
      { role: 'postgres', postgresDatabasePolicy: f.directory },
      { readonlyDirectories: [{ host: link, container: '/fixtures' }] },
      { readonlyMetadata: link },
      { readonlyInputMetadata: link, metadataTmpfsBytes: 1024 },
      { readonlyArchiveDirectory: link },
      { registrySocket: f.file },
    ];
    for (const spec of invalid) await expect(f.group.createContainer({ role: 'app', image: f.image, command: ['/bin/sleep', '1'], ...spec })).rejects.toThrow();
    fs.chmodSync(f.directory, 0o777);
    await expect(f.group.createContainer({ role: 'app', image: f.image, command: ['/bin/sleep', '1'], readonlyMetadata: f.directory })).rejects.toThrow('private owned directory');
    expect(f.calls.some(call => call[0] === 'create')).toBe(false);
    expect(fs.existsSync(path.join(f.root, 'resources.journal'))).toBe(false);
  });

  // docker cp cannot read tmpfs mounts, so both export sources are tmpfs-backed local volumes.
  test.each([
    ['acquisition archives', '/archives', { archiveTmpfsBytes: 4096 }, 'noexec,nosuid,nodev'],
    ['prepared-tree work', '/work', { exportableWork: true as const }, 'nosuid,nodev'],
  ])('%s export from a bounded in-memory volume docker cp can read', async (_name, target, spec, flags) => {
    const f = fixture();
    expect(await f.group.createContainer({ role: 'app', image: f.image, command: ['/bin/sleep', '1'], ...(spec as Partial<ContainerSpec>) })).toBe(f.id);
    const args = f.calls.find(call => call[0] === 'create')!;
    const volume = args.flatMap((arg, index) => arg === '--mount' && args[index + 1].startsWith('type=volume,') ? [args[index + 1]] : []);
    expect(volume).toHaveLength(1);
    expect(volume[0]).toStartWith(`type=volume,dst=${target},volume-driver=local,volume-opt=type=tmpfs,volume-opt=device=tmpfs,"volume-opt=o=size=`);
    expect(volume[0]).toEndWith(`,mode=700,uid=${process.getuid!()},gid=${process.getgid!()},${flags}"`);
    expect(args.flatMap((arg, index) => arg === '--tmpfs' ? [args[index + 1].split(':')[0]] : [])).not.toContain(target);
  });

  test.each([
    ['dropped tmpfs driver options', (value: any) => { value.HostConfig.Mounts.at(-1).VolumeOptions.DriverConfig.Options.type = 'none'; }],
    ['a host-backed volume source', (value: any) => { value.HostConfig.Mounts.at(-1).Source = '/var/tmp/export'; }],
    ['an extra daemon volume', (value: any) => { value.Mounts.push({ Type: 'volume', Destination: '/data', Driver: 'local' }); }],
    ['a missing volume mount', (value: any) => { value.HostConfig.Mounts.pop(); }],
  ])('export volumes fail closed on %s', async (_name, mutate) => {
    const f = fixture(); f.inspectHooks.push(mutate);
    await expect(f.group.createContainer({ role: 'app', image: f.image, command: ['/bin/sleep', '1'], archiveTmpfsBytes: 4096 })).rejects.toThrow('Docker did not preserve');
    expect(fs.existsSync(path.join(f.root, 'resources.journal'))).toBe(false);
  });
});
