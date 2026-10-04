/**
 * F5 (#2706): installed skills must SERVE the rendered section files.
 *
 * A gbrain install serves each brain-aware SKILL.md from the render dir
 * (#2569). Its STOP pointers name absolute render-dir paths, but its section
 * index names `sections/<f>.md` relative to the installed skill directory,
 * and runtime assets were linked from the checkout, so the rendered "Save
 * Results to Brain" blocks, which live only in the rendered section files,
 * were generated and never read. Both install paths are covered: setup's
 * _link_skill_runtime_assets and bin/gstack-relink (which
 * `gstack-config gbrain-refresh` calls after rendering).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBashScript } from './helpers/bash-script';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const SAVE_BLOCK = '## Save Results to Brain';

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`\n${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}()`);
  return SETUP_SRC.slice(start + 1, end + 3);
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-sections-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A checkout and a render for one carved skill; manifest.json exists only in the checkout. */
function fixture() {
  const install = path.join(tmp, 'gstack');
  const render = path.join(tmp, 'state', 'render', 'claude');
  const skills = path.join(tmp, 'skills');
  const put = (p: string, body: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  put(path.join(install, 'ship/SKILL.md'), '---\nname: ship\ndescription: t\n---\n# ship');
  put(path.join(install, 'ship/sections/adversarial.md'), 'body\n');
  put(path.join(install, 'ship/sections/tests.md'), 'tests\n');
  put(path.join(install, 'ship/sections/manifest.json'), '{"x":1}\n');
  put(path.join(install, 'ship/checklist.md'), 'checkout checklist\n');
  put(path.join(render, 'ship/SKILL.md'), '---\nname: ship\ndescription: t\n---\n# ship rendered');
  put(path.join(render, 'ship/sections/adversarial.md'), `body\n${SAVE_BLOCK}\n`);
  fs.mkdirSync(skills, { recursive: true });
  return { install, render, skills, dst: path.join(skills, 'ship') };
}

function runSetupHelper(src: string, dst: string, render?: string) {
  fs.mkdirSync(dst, { recursive: true });
  const r = runBashScript(['set -eu', 'IS_WINDOWS=0', extractFn('_link_or_copy'), extractFn('_link_skill_runtime_assets'),
    `_link_skill_runtime_assets "${src}" "${dst}" 1${render ? ` "${render}"` : ''}`].join('\n'), { timeout: 30_000 });
  expect(r.status, r.stderr).toBe(0);
}

describe('installed skills serve rendered sections (F5, #2706)', () => {
  test("setup's _link_skill_runtime_assets serves the rendered section per file and keeps checkout-only assets", () => {
    const fx = fixture();
    runSetupHelper(path.join(fx.install, 'ship'), fx.dst, path.join(fx.render, 'ship'));
    expect(fs.readFileSync(path.join(fx.dst, 'sections/adversarial.md'), 'utf-8')).toContain(SAVE_BLOCK);
    expect(fs.readFileSync(path.join(fx.dst, 'sections/tests.md'), 'utf-8')).toBe('tests\n');
    expect(fs.existsSync(path.join(fx.dst, 'sections/manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(fx.dst, 'checklist.md'), 'utf-8')).toBe('checkout checklist\n');
  });

  test('without a render the checkout assets are linked as before', () => {
    const fx = fixture();
    runSetupHelper(path.join(fx.install, 'ship'), fx.dst);
    expect(fs.lstatSync(path.join(fx.dst, 'sections')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(fx.dst, 'sections/adversarial.md'), 'utf-8')).not.toContain(SAVE_BLOCK);
  });

  test('gstack-relink (the gbrain-refresh path) serves the render, and the checkout again once the render is gone', () => {
    const fx = fixture();
    fs.mkdirSync(path.join(fx.install, 'bin'), { recursive: true });
    for (const f of ['gstack-relink', 'gstack-config', 'gstack-state-root.sh', 'gstack-install-registry.sh', 'gstack-patch-names']) {
      fs.copyFileSync(path.join(BIN, f), path.join(fx.install, 'bin', f));
      fs.chmodSync(path.join(fx.install, 'bin', f), 0o755);
    }
    // The layout setup leaves: SKILL.md and sections/ linked from the checkout.
    runSetupHelper(path.join(fx.install, 'ship'), fx.dst);
    fs.symlinkSync(path.join(fx.install, 'ship/SKILL.md'), path.join(fx.dst, 'SKILL.md'));
    const relink = () => {
      const r = spawnSync('bash', [path.join(fx.install, 'bin/gstack-relink')], {
        encoding: 'utf-8', timeout: 30_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, GSTACK_STATE_ROOT: path.join(tmp, 'state'),
          GSTACK_INSTALL_DIR: fx.install, GSTACK_SKILLS_DIR: fx.skills, GSTACK_USER_RENDER_DIR: fx.render },
      });
      expect(r.status, r.stderr).toBe(0);
    };
    relink();
    expect(fs.readFileSync(path.join(fx.dst, 'SKILL.md'), 'utf-8')).toContain('ship rendered');
    expect(fs.readFileSync(path.join(fx.dst, 'sections/adversarial.md'), 'utf-8')).toContain(SAVE_BLOCK);
    expect(fs.existsSync(path.join(fx.dst, 'sections/manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(fx.install, 'ship/sections/adversarial.md'), 'utf-8')).toBe('body\n');

    fs.rmSync(path.join(fx.render, 'ship/sections'), { recursive: true });
    relink();
    expect(fs.realpathSync(path.join(fx.dst, 'sections'))).toBe(fs.realpathSync(path.join(fx.install, 'ship/sections')));
  });

  test('a sections/ directory the user owns is left alone by relink', () => {
    const fx = fixture();
    fs.mkdirSync(path.join(fx.install, 'bin'), { recursive: true });
    for (const f of ['gstack-relink', 'gstack-config', 'gstack-state-root.sh', 'gstack-install-registry.sh', 'gstack-patch-names']) {
      fs.copyFileSync(path.join(BIN, f), path.join(fx.install, 'bin', f));
      fs.chmodSync(path.join(fx.install, 'bin', f), 0o755);
    }
    fs.mkdirSync(path.join(fx.dst, 'sections'), { recursive: true });
    fs.writeFileSync(path.join(fx.dst, 'sections/adversarial.md'), 'my notes\n');
    fs.writeFileSync(path.join(fx.dst, '.gstack-owned'), fx.install + '\n');
    const r = spawnSync('bash', [path.join(fx.install, 'bin/gstack-relink')], {
      encoding: 'utf-8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, GSTACK_STATE_ROOT: path.join(tmp, 'state'),
        GSTACK_INSTALL_DIR: fx.install, GSTACK_SKILLS_DIR: fx.skills, GSTACK_USER_RENDER_DIR: fx.render },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(fx.dst, 'sections/adversarial.md'), 'utf-8')).toBe('my notes\n');
  });
});
