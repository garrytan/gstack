import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPreparedExport, recordNpmArchiveEntry } from '../lib/cso/preparation-container';
import { materializePreparedExport } from '../lib/cso/preparation-docker';
import { validateSingleContainerProcessOutput } from '../lib/cso/docker';

const roots: string[] = [];
function temporary(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-prepared-export-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('CSO preparation container archive limits', () => {
  test('a zero-byte directory flood consumes the same bounded tar-entry budget as files', () => {
    let entries = 0;
    for (let index = 0; index < 200_000; index++) entries = recordNpmArchiveEntry(entries, '5');
    expect(entries).toBe(200_000);
    expect(() => recordNpmArchiveEntry(entries, '5')).toThrow('npm archive exceeded extraction limits');
    expect(() => recordNpmArchiveEntry(entries, '0')).toThrow('npm archive exceeded extraction limits');
  });

  test('exports only inert regular blobs and reconstructs contained dependency symlinks', () => {
    const root = temporary(), work = path.join(root, 'work'), exported = path.join(work, `.gstack-cso-export-${'a'.repeat(24)}`),
      inert = path.join(root, 'inert'), prepared = path.join(root, 'prepared');
    fs.mkdirSync(path.join(work, 'node_modules/lib'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(work, 'node_modules/.bin'), { mode: 0o700 });
    fs.writeFileSync(path.join(work, 'package.json'), '{"name":"fixture"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'node_modules/lib/tool.js'), 'export default 1;\n', { mode: 0o500 });
    fs.symlinkSync('../lib/tool.js', path.join(work, 'node_modules/.bin/tool'));
    fs.mkdirSync(prepared, { mode: 0o700 });

    const manifest = createPreparedExport(work, exported, 1024 * 1024);
    expect(fs.readdirSync(exported).sort()).toEqual(['blobs', 'manifest.json']);
    for (const name of fs.readdirSync(path.join(exported, 'blobs'))) expect(fs.lstatSync(path.join(exported, 'blobs', name)).isFile()).toBe(true);
    expect(manifest.entries.some(entry => entry.kind === 'symlink')).toBe(true);
    fs.cpSync(exported, inert, { recursive: true });
    materializePreparedExport(inert, prepared, 1024 * 1024);
    expect(fs.readFileSync(path.join(prepared, 'node_modules/.bin/tool'), 'utf8')).toBe('export default 1;\n');
    expect(fs.readlinkSync(path.join(prepared, 'node_modules/.bin/tool'))).toBe('../lib/tool.js');
  });

  test('rejects escaping links and special lifecycle output before an export is created', () => {
    for (const kind of ['symlink', 'fifo'] as const) {
      if (kind === 'fifo' && process.platform === 'win32') continue;
      const root = temporary(), work = path.join(root, 'work'), exported = path.join(work, `.gstack-cso-export-${(kind === 'symlink' ? 'b' : 'c').repeat(24)}`);
      fs.mkdirSync(work, { mode: 0o700 });
      if (kind === 'symlink') fs.symlinkSync('../../outside', path.join(work, 'host-escape'));
      else {
        const result = spawnSync('mkfifo', [path.join(work, 'lifecycle.fifo')], { timeout: 30_000 });
        expect(result.status).toBe(0);
      }
      expect(() => createPreparedExport(work, exported, 1024 * 1024)).toThrow(kind === 'symlink' ? 'escaping symlink' : 'special object');
      expect(fs.existsSync(exported)).toBe(false);
    }
  });

  test('refuses acquisition or preparation export while a manager-owned background process remains', () => {
    expect(() => validateSingleContainerProcessOutput('PID\n123\n')).not.toThrow();
    expect(() => validateSingleContainerProcessOutput('PID\n123\n456\n')).toThrow('background process');
    expect(() => validateSingleContainerProcessOutput('PID COMMAND\n123 bun\n')).toThrow('background process');
  });
});
