/**
 * One Bun version across every CI surface.
 *
 * The drift class this pins: Dockerfile.ci's comment records that the old
 * `| BUN_VERSION=x.y.z bash` form silently installed latest on every image
 * rebuild (observed 1.3.13/1.3.14 drift vs the 1.3.10 devs ran locally),
 * and before 2026-08-29 the lanes disagreed four ways (1.3.13 / latest /
 * unpinned / 1.3.10). Different Bun versions change test-runner OUTPUT
 * SHAPES the strict classifiers regex-match, spawn semantics, and shell
 * parsing — a lane on a different Bun is testing a different product.
 *
 * Bumping Bun: change every surface in one commit; this test names each one.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

interface Pin {
  surface: string;
  version: string;
}

function collectPins(): Pin[] {
  const pins: Pin[] = [];

  for (const name of fs.readdirSync(WORKFLOWS_DIR).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const source = fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf-8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/uses:\s*oven-sh\/setup-bun@/.test(lines[i])) continue;
      // A pinned stanza is `with:` + `bun-version: <v>` within the next few
      // lines; an unpinned setup-bun is itself drift (installs latest).
      const window = lines.slice(i + 1, i + 4).join('\n');
      const m = window.match(/bun-version:\s*["']?([\w.]+)["']?/);
      pins.push({
        surface: `${name}:${i + 1}`,
        version: m ? m[1] : '<unpinned setup-bun — installs latest>',
      });
    }
  }

  const dockerfile = fs.readFileSync(
    path.join(ROOT, '.github', 'docker', 'Dockerfile.ci'), 'utf-8');
  const dockerPin = dockerfile.match(/bash -s ["']?bun-v([\w.]+)["']?/);
  pins.push({
    surface: 'Dockerfile.ci',
    version: dockerPin ? dockerPin[1] : '<no bun-vX.Y.Z positional arg>',
  });

  const gitlab = fs.readFileSync(path.join(ROOT, '.gitlab-ci.yml'), 'utf-8');
  const gitlabPin = gitlab.match(/BUN_VERSION:\s*["']?([\w.]+)["']?/);
  pins.push({
    surface: '.gitlab-ci.yml',
    version: gitlabPin ? gitlabPin[1] : '<no BUN_VERSION>',
  });

  return pins;
}

describe('bun version pins', () => {
  test('every CI surface pins the same bun version', () => {
    const pins = collectPins();
    // Sanity: the scan found the known surfaces (a regex rot that finds
    // nothing must fail loudly, not vacuously pass).
    expect(pins.length).toBeGreaterThanOrEqual(6);

    const versions = [...new Set(pins.map((p) => p.version))];
    const detail = pins.map((p) => `${p.surface} → ${p.version}`).join('\n');
    expect(versions, `bun version drift across CI surfaces:\n${detail}`).toHaveLength(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
