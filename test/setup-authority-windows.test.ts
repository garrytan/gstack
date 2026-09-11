import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const roots: string[] = [];
const digest = (file: string) => new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('Windows installed runtime attestation', () => {
  test('writer hashes and probes a Bun executable with Windows 0666 stat semantics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-runtime-writer-')); roots.push(root);
    const output = path.join(root, 'runtime.json');
    const result = spawnSync(process.execPath, ['--preload', path.join(import.meta.dir, 'helpers/emulate-windows-runtime-stat.ts'),
      path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts'), '--output', output], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    const bun = JSON.parse(fs.readFileSync(output, 'utf8')).tools.bun;
    expect(bun.identity_kind).toBe('windows-sha256-v1');
    expect(bun.sha256).toBe(digest(process.execPath));
    expect(bun.version).toBe(Bun.version);
    expect(bun.realpath).toBe(fs.realpathSync(process.execPath).replaceAll('\\', '/'));
  });

  for (const mismatch of [false, true]) {
    test(`Git Bash anchor ${mismatch ? 'rejects a changed' : 'runs the attested'} Bun at a Windows absolute path`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-runtime-anchor-')); roots.push(root);
      fs.mkdirSync(path.join(root, 'bin'));
      fs.mkdirSync(path.join(root, 'dist/authority'), { recursive: true });
      const physicalPath = fs.realpathSync(process.execPath);
      const nativePath = process.platform === 'win32'
        ? physicalPath.replaceAll('\\', '/')
        : 'C:/Program Files/Bun/bun.exe';
      const anchor = path.join(root, 'bin/gstack-anchor');
      let anchorSource = fs.readFileSync(path.join(ROOT, 'bin/gstack-anchor'), 'utf8');
      if (process.platform !== 'win32') {
        const uname = path.join(root, 'uname');
        const cygpath = path.join(root, 'cygpath');
        fs.writeFileSync(uname, '#!/bin/sh\nprintf "%s\\n" MINGW64_NT-10.0\n', { mode: 0o755 });
        fs.writeFileSync(cygpath, `#!/bin/sh\ncase "$1:$3" in\n-u:${quote(nativePath)}) printf '%s\\n' ${quote(physicalPath)} ;;\n-m:${quote(physicalPath)}) printf '%s\\n' ${quote(nativePath)} ;;\n*) exit 1 ;;\nesac\n`, { mode: 0o755 });
        // Adapt only the unavailable Git Bash OS tools off Windows; native CI
        // exercises the unmodified anchor and the runner's real cygpath.
        anchorSource = anchorSource
          .replaceAll('/usr/bin/uname', quote(uname))
          .replaceAll('/usr/bin/cygpath', quote(cygpath));
      }
      fs.writeFileSync(anchor, anchorSource, { mode: 0o755 });
      const bundle = path.join(root, 'dist/authority/gstack-project-identity.mjs');
      fs.writeFileSync(bundle, 'process.stdout.write("windows-bundle-ran\\n")\n');
      fs.writeFileSync(path.join(root, 'dist/authority/manifest.json'), JSON.stringify({ commands: {
        'gstack-project-identity': { sha256: digest(bundle) },
      } }));
      fs.writeFileSync(path.join(root, '.ecpe-installed-runtime.json'), JSON.stringify({ tools: { bun: {
        realpath: nativePath, identity_kind: 'windows-sha256-v1', owner_uid: 0, mode: 438,
        sha256: mismatch ? '0'.repeat(64) : digest(physicalPath),
      } } }));
      const result = spawnSync('bash', [anchor, 'gstack-project-identity'], { encoding: 'utf8', timeout: 30_000 });
      if (mismatch) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('bun_identity_mismatch');
        expect(result.stdout).toBe('');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('windows-bundle-ran\n');
      }
    });
  }
});
