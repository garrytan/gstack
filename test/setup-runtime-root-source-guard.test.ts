import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// #3084: a checkout living at a host's runtime root (~/.cursor/skills/gstack)
// was moved aside and rm -rf'd by _activate_runtime_root's swap. The helper
// must refuse, unchanged, when the root is or contains the source checkout.
const setup = fs.readFileSync(path.resolve(import.meta.dir, '../setup'), 'utf8');
const fn = (name: string) => {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup helper: ${name}`);
  return setup.slice(start + 1, end + 2);
};
const helpers = ['_copy_skill_md', '_skill_copy_hash', '_skill_copy_unmodified', '_preserve_skill_copy_edits', '_record_skill_copies', '_activate_runtime_root'].map(fn).join('\n');

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-guard-'));
  tmps.push(tmp);
  return tmp;
}

function checkout(dir: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'setup'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0.0\n');
}

function run(tmp: string, src: string, root: string) {
  return runBashScript([
    'set -e', 'log() { echo "$@"; }', `GSTACK_STATE_ROOT="${tmp}/state"`, '_SKILL_COPIES_FILE="$GSTACK_STATE_ROOT/skill-copies.tsv"',
    helpers,
    'build() { mkdir -p "$2"; echo runtime > "$2/SKILL.md"; }',
    `_activate_runtime_root build "${src}" "${root}" || echo "rc=$?"`,
  ].join('\n'), { timeout: 30_000 });
}

describe.skipIf(process.platform === 'win32')('setup: runtime root never replaces the source checkout (#3084)', () => {
  test('refuses when the runtime root is the checkout', () => {
    const tmp = fixture();
    const root = path.join(tmp, 'home/.cursor/skills/gstack');
    checkout(root);
    const r = run(tmp, root, root);
    expect(r.stdout).toContain('rc=1');
    expect(r.stderr).toContain('contains the gstack source checkout');
    for (const f of ['.git', 'setup', 'VERSION']) expect(fs.existsSync(path.join(root, f))).toBe(true);
    expect(fs.existsSync(path.join(root, 'SKILL.md'))).toBe(false);
    expect(fs.readdirSync(path.dirname(root))).toEqual(['gstack']);
  });

  test('refuses when the checkout is nested inside the runtime root', () => {
    const tmp = fixture();
    const root = path.join(tmp, 'home/.cursor/skills/gstack');
    const src = path.join(root, 'repo');
    checkout(src);
    const r = run(tmp, src, root);
    expect(r.stdout).toContain('rc=1');
    expect(fs.existsSync(path.join(src, '.git'))).toBe(true);
  });

  test('refuses when the runtime root reaches the checkout through a symlinked parent', () => {
    const tmp = fixture();
    const src = path.join(tmp, 'real/skills/gstack');
    checkout(src);
    fs.mkdirSync(path.join(tmp, 'home'));
    fs.symlinkSync(path.join(tmp, 'real/skills'), path.join(tmp, 'home/skills'));
    const r = run(tmp, src, path.join(tmp, 'home/skills/gstack'));
    expect(r.stdout).toContain('rc=1');
    expect(fs.existsSync(path.join(src, '.git'))).toBe(true);
  });

  test('still replaces a runtime root that is only a symlink to the checkout', () => {
    const tmp = fixture();
    const src = path.join(tmp, 'checkout');
    checkout(src);
    const root = path.join(tmp, 'home/.cursor/skills/gstack');
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(src, root);
    const r = run(tmp, src, root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('rc=');
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe('runtime\n');
    expect(fs.existsSync(path.join(src, '.git'))).toBe(true);
  });

  test('still replaces a separate runtime root', () => {
    const tmp = fixture();
    const src = path.join(tmp, 'checkout');
    checkout(src);
    const root = path.join(tmp, 'home/.cursor/skills/gstack');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'stale.md'), 'stale\n');
    const r = run(tmp, src, root);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(root)).toEqual(['SKILL.md']);
  });
});
