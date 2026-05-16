import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeBuildArtifacts } from '../scripts/finalize-build-artifacts';

describe('finalize-build-artifacts', () => {
  test('writes version files and removes Bun build temp artifacts without shell syntax', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-finalize-build-'));
    try {
      for (const relativePath of [
        'browse/dist/browse',
        'browse/dist/find-browse',
        'design/dist/design',
        'make-pdf/dist/pdf',
        'bin/gstack-global-discover',
      ]) {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, 'binary');
      }

      fs.writeFileSync(path.join(root, '.abc.bun-build'), 'temp');

      const result = finalizeBuildArtifacts(root, 'abc123');

      expect(result.versionFiles).toEqual([
        'browse/dist/.version',
        'design/dist/.version',
        'make-pdf/dist/.version',
      ]);
      expect(result.executables).toHaveLength(5);
      expect(result.removedArtifacts).toEqual(['.abc.bun-build']);
      expect(fs.readFileSync(path.join(root, 'browse/dist/.version'), 'utf8')).toBe('abc123\n');
      expect(fs.existsSync(path.join(root, '.abc.bun-build'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
