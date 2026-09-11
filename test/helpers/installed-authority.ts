import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function runtimeAttestation(file: string) {
  const info = fs.statSync(file);
  return {
    realpath: fs.realpathSync(file),
    sha256: new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex'),
    owner_uid: info.uid,
    mode: info.mode & 0o777,
  };
}

export function createInstalledAuthorityFixture(sourceRoot: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-authority-install-'));
  const bin = path.join(root, 'bin');
  const authority = path.join(root, 'dist/authority');
  fs.cpSync(path.join(sourceRoot, 'bin'), bin, { recursive: true });
  fs.cpSync(path.join(sourceRoot, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(path.join(sourceRoot, 'dist/authority'), authority, { recursive: true });
  fs.chmodSync(path.join(bin, 'gstack-anchor'), 0o755);
  fs.writeFileSync(path.join(root, '.ecpe-installed-runtime.json'), JSON.stringify({
    schema: 'ecpe.gstack-runtime.v1',
    tools: { bun: runtimeAttestation(process.execPath) },
  }) + '\n');
  return {
    root,
    bin,
    anchor: path.join(bin, 'gstack-anchor'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
