/**
 * The install must SERVE the rendered section files, not just generate them (#2706).
 *
 * #2569 made the Claude installers prefer the gbrain-rendered SKILL.md out of
 * ~/.gstack/render/claude. Runtime assets kept coming from the checkout, so
 * SKILL.md was served from the render dir while sections/ was served from the
 * source tree — and the rendered "Save Results to Brain" blocks, which live
 * ONLY in the rendered section files, were generated and never read.
 *
 * gen-skill-docs-out-dir.test.ts already pins the generator side (the rendered
 * section file gains the block). These tests pin the delivery side: what the
 * installed skill dir actually serves.
 *
 * Both install paths are covered — setup's _link_skill_runtime_assets and
 * bin/gstack-relink, which `gstack-config gbrain-refresh` calls to "repoint
 * installed skills at the render".
 */
import { describe, test as _bunTest, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const test = Object.assign(
  ((name: any, fn: any, timeout?: number) =>
    _bunTest(name, fn, timeout ?? 15_000)) as typeof _bunTest,
  _bunTest,
);

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

/** Body of a shell function `name() { ... }`, including the closing brace. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}()`);
  return src.slice(start, end + 3);
}

const SAVE_BLOCK = '## Save Results to Brain';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-sections-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Source checkout + render dir for one carved skill. The rendered section
 * carries the brain block; the checkout copy does not. manifest.json exists
 * ONLY in the checkout — the reason the overlay has to be per-file rather than
 * a directory-level repoint.
 */
function fixture(): { src: string; render: string; dst: string } {
  const src = path.join(tmpDir, 'install', 'ship');
  const render = path.join(tmpDir, 'render', 'ship');
  const dst = path.join(tmpDir, 'skills', 'ship');
  fs.mkdirSync(path.join(src, 'sections'), { recursive: true });
  fs.mkdirSync(path.join(render, 'sections'), { recursive: true });
  fs.mkdirSync(dst, { recursive: true });

  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: ship\ndescription: t\n---\n# ship');
  fs.writeFileSync(path.join(src, 'sections', 'adversarial.md'), 'body\n');
  fs.writeFileSync(path.join(src, 'sections', 'tests.md'), 'tests\n');
  fs.writeFileSync(path.join(src, 'sections', 'manifest.json'), '{"x":1}\n');
  fs.writeFileSync(path.join(render, 'SKILL.md'), '---\nname: ship\ndescription: t\n---\n# ship rendered');
  // Only the diverging file is re-rendered with the block.
  fs.writeFileSync(path.join(render, 'sections', 'adversarial.md'), `body\n${SAVE_BLOCK}\n`);
  fs.writeFileSync(path.join(render, 'sections', 'tests.md'), 'tests\n');
  return { src, render, dst };
}

describe('installed skills serve rendered sections (#2706)', () => {
  test("setup's _link_skill_runtime_assets serves the rendered section, keeping checkout-only assets", () => {
    const { src, render, dst } = fixture();
    const script = [
      'set -eu',
      'IS_WINDOWS=0',
      extractFn(SETUP_SRC, '_link_or_copy'),
      extractFn(SETUP_SRC, '_link_skill_runtime_assets'),
      `_link_skill_runtime_assets "${src}" "${dst}" "${render}"`,
    ].join('\n');
    execSync(script, { shell: '/bin/bash', encoding: 'utf-8' });

    // The whole point: the block reaches the agent.
    expect(fs.readFileSync(path.join(dst, 'sections', 'adversarial.md'), 'utf-8')).toContain(SAVE_BLOCK);
    // A per-file overlay, not a directory repoint — checkout-only assets survive.
    expect(fs.existsSync(path.join(dst, 'sections', 'manifest.json'))).toBe(true);
    // Non-diverging files still resolve.
    expect(fs.readFileSync(path.join(dst, 'sections', 'tests.md'), 'utf-8')).toContain('tests');
  });

  test('_link_skill_runtime_assets without a render dir is unchanged (no-gbrain installs)', () => {
    const { src, dst } = fixture();
    const script = [
      'set -eu',
      'IS_WINDOWS=0',
      extractFn(SETUP_SRC, '_link_or_copy'),
      extractFn(SETUP_SRC, '_link_skill_runtime_assets'),
      `_link_skill_runtime_assets "${src}" "${dst}"`,
    ].join('\n');
    execSync(script, { shell: '/bin/bash', encoding: 'utf-8' });

    expect(fs.readFileSync(path.join(dst, 'sections', 'adversarial.md'), 'utf-8')).not.toContain(SAVE_BLOCK);
    expect(fs.existsSync(path.join(dst, 'sections', 'manifest.json'))).toBe(true);
  });

  test('gstack-relink repoints sections at the render (the gbrain-refresh path)', () => {
    const { src, render, dst } = fixture();
    const installDir = path.dirname(src);
    const skillsDir = path.dirname(dst);
    const renderRoot = path.dirname(render);

    const mockBin = path.join(installDir, 'bin');
    fs.mkdirSync(mockBin, { recursive: true });
    for (const b of ['gstack-config', 'gstack-relink', 'gstack-patch-names']) {
      fs.copyFileSync(path.join(BIN, b), path.join(mockBin, b));
      fs.chmodSync(path.join(mockBin, b), 0o755);
    }

    // Reproduce the pre-fix install shape: sections/ is a symlink INTO the
    // checkout. Relink must not link children through it (that would write
    // into the tracked install) — it has to rebuild a real directory.
    fs.symlinkSync(path.join(src, 'sections'), path.join(dst, 'sections'));

    const env: Record<string, string | undefined> = {
      ...process.env,
      GSTACK_STATE_DIR: tmpDir,
      GSTACK_INSTALL_DIR: installDir,
      GSTACK_SKILLS_DIR: skillsDir,
      GSTACK_USER_RENDER_DIR: renderRoot,
    };
    delete env.GSTACK_HOME;
    execSync(path.join(mockBin, 'gstack-relink'), { env, encoding: 'utf-8', timeout: 10000 });

    expect(fs.readFileSync(path.join(dst, 'sections', 'adversarial.md'), 'utf-8')).toContain(SAVE_BLOCK);
    expect(fs.existsSync(path.join(dst, 'sections', 'manifest.json'))).toBe(true);
    // The checkout stays pristine — nothing was written through the old symlink.
    expect(fs.readFileSync(path.join(src, 'sections', 'adversarial.md'), 'utf-8')).not.toContain(SAVE_BLOCK);
    expect(fs.readdirSync(path.join(src, 'sections')).sort())
      .toEqual(['adversarial.md', 'manifest.json', 'tests.md']);
  });
});
