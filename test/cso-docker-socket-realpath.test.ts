import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';
import { realpathSocket } from '../lib/cso/docker';

describe.skipIf(process.platform === 'win32')('CSO Docker socket path resolution', () => {
  let root = '';
  let socketPath = '';
  let server: net.Server;
  beforeAll(async () => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'cso-sock-'));
    socketPath = join(root, 'docker.sock');
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('resolves a Unix socket that realpath cannot open', () => {
    const real = realpathSocket(socketPath);
    expect(fs.statSync(real).isSocket()).toBe(true);
    expect(real).toBe(join(fs.realpathSync(root), 'docker.sock'));
  });

  test('follows absolute and relative symbolic links down to the socket', () => {
    const absoluteLink = join(root, 'absolute.sock');
    fs.symlinkSync(socketPath, absoluteLink);
    const relativeLink = join(root, 'relative.sock');
    fs.symlinkSync('absolute.sock', relativeLink);
    const expected = realpathSocket(socketPath);
    expect(realpathSocket(absoluteLink)).toBe(expected);
    expect(realpathSocket(relativeLink)).toBe(expected);
  });

  test('resolves a socket through a symlinked parent directory', () => {
    const linkedDirectory = join(root, 'run');
    fs.symlinkSync(root, linkedDirectory);
    expect(realpathSocket(join(linkedDirectory, 'docker.sock'))).toBe(realpathSocket(socketPath));
  });

  test('still reports a missing socket as an error', () => {
    expect(() => realpathSocket(join(root, 'missing.sock'))).toThrow();
  });

  test('matches realpath for ordinary files', () => {
    const file = join(root, 'plain');
    fs.writeFileSync(file, 'x');
    expect(realpathSocket(file)).toBe(fs.realpathSync(file));
  });
});

// On macOS Bun's own realpath fails on a socket, so the suite above already
// exercises the fallback there. Linux resolves sockets natively, so this block
// forces the failure to keep the fallback covered on every CI platform.
describe.skipIf(process.platform === 'win32')(
  'CSO Docker socket path resolution when realpath refuses sockets',
  () => {
    let root = '';
    let socketPath = '';
    let server: net.Server;
    const realpath = fs.realpathSync;
    const refusing = (code: string) =>
      ((path: fs.PathLike, ...rest: any[]) => {
        if (fs.statSync(path).isSocket()) {
          const error = new Error(`${code}: operation not supported on socket`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return realpath(path, ...rest);
      }) as typeof fs.realpathSync;
    beforeAll(async () => {
      root = fs.mkdtempSync(join(os.tmpdir(), 'cso-sock-stub-'));
      socketPath = join(root, 'docker.sock');
      server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      });
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    afterEach(() => {
      (fs.realpathSync as any).mockRestore?.();
    });

    test('falls back to resolving the leaf by hand on EOPNOTSUPP', () => {
      const stub = spyOn(fs, 'realpathSync').mockImplementation(refusing('EOPNOTSUPP'));
      expect(realpathSocket(socketPath)).toBe(join(realpath(root), 'docker.sock'));
      expect(stub).toHaveBeenCalledWith(socketPath);
      expect(stub.mock.calls.length).toBeGreaterThan(1);
    });

    test('still follows symbolic links to the socket on EOPNOTSUPP', () => {
      spyOn(fs, 'realpathSync').mockImplementation(refusing('EOPNOTSUPP'));
      const link = join(root, 'link.sock');
      fs.symlinkSync('docker.sock', link);
      const directory = join(root, 'run');
      fs.symlinkSync(root, directory);
      const expected = join(realpath(root), 'docker.sock');
      expect(realpathSocket(link)).toBe(expected);
      expect(realpathSocket(join(directory, 'docker.sock'))).toBe(expected);
    });

    test('propagates any other realpath error unchanged', () => {
      spyOn(fs, 'realpathSync').mockImplementation(refusing('EACCES'));
      expect(() => realpathSocket(socketPath)).toThrow(/EACCES/);
    });
  },
);
