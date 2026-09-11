import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveInstalledRuntimeRoot, resolveInstalledTool } from '../lib/toolchain-policy';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(file: string): string {
  return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture(): { root: string; manifest: string; gh: string; glab: string; pathShim: string; log: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-toolchain-')));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const shim = path.join(root, 'shim');
  fs.mkdirSync(bin);
  fs.mkdirSync(shim);
  const log = path.join(root, 'spawns.log');
  const gh = path.join(bin, 'gh');
  const glab = path.join(bin, 'glab');
  const pathShim = path.join(shim, 'gh');
  fs.writeFileSync(gh, '#!/bin/sh\nprintf "gh version 2.91.0 (fixture)\\n"\nprintf "absolute\\n" >> "$ECPE_TOOL_LOG"\n');
  fs.writeFileSync(glab, '#!/bin/sh\nprintf "glab version 1.80.0 (fixture)\\n"\nprintf "glab-absolute\\n" >> "$ECPE_TOOL_LOG"\n');
  fs.writeFileSync(pathShim, '#!/bin/sh\nprintf "shim\\n" >> "$ECPE_TOOL_LOG"\nexit 91\n');
  fs.chmodSync(gh, 0o755);
  fs.chmodSync(glab, 0o755);
  fs.chmodSync(pathShim, 0o755);
  const manifest = path.join(root, '.ecpe-installed-runtime.json');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 'ecpe.gstack-runtime.v1',
    tools: {
      gh: {
        realpath: gh,
        owner_uid: process.getuid!(),
        mode: 0o755,
        sha256: sha256(gh),
        version: 'gh version 2.91.0 (fixture)',
      },
      glab: {
        realpath: glab,
        owner_uid: process.getuid!(),
        mode: 0o755,
        sha256: sha256(glab),
        version: 'glab version 1.80.0 (fixture)',
      },
    },
  }));
  return { root, manifest, gh, glab, pathShim, log };
}

describe('manifest-backed toolchain policy', () => {
  test('resolves the runtime root from both source and bundled module layouts', () => {
    expect(resolveInstalledRuntimeRoot('/opt/gstack/lib')).toBe('/opt/gstack');
    expect(resolveInstalledRuntimeRoot('/opt/gstack/dist/authority')).toBe('/opt/gstack');
  });

  test('executes only the attested absolute gh and gives a PATH shim zero spawns', async () => {
    const f = fixture();
    const oldPath = process.env.PATH;
    process.env.PATH = path.dirname(f.pathShim);
    process.env.ECPE_TOOL_LOG = f.log;
    try {
      const tool = await resolveInstalledTool('gh', { manifestPath: f.manifest });
      expect(tool.realpath).toBe(f.gh);
      expect(fs.readFileSync(f.log, 'utf8')).toBe('absolute\n');
    } finally {
      process.env.PATH = oldPath;
      delete process.env.ECPE_TOOL_LOG;
    }
  });

  test('rejects content or permission movement before any version child runs', async () => {
    const f = fixture();
    fs.appendFileSync(f.gh, '# moved\n');
    await expect(resolveInstalledTool('gh', { manifestPath: f.manifest })).rejects.toThrow('tool_hash_mismatch:gh');
    expect(fs.existsSync(f.log)).toBe(false);
  });

  test('resolves an attested glab provider tool from the installed manifest', async () => {
    const f = fixture();
    process.env.ECPE_TOOL_LOG = f.log;
    try {
      const tool = await resolveInstalledTool('glab', { manifestPath: f.manifest });
      expect(tool.realpath).toBe(f.glab);
      expect(fs.readFileSync(f.log, 'utf8')).toBe('glab-absolute\n');
    } finally {
      delete process.env.ECPE_TOOL_LOG;
    }
  });
});
