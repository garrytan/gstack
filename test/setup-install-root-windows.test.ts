/**
 * #3498, installer side: setup's _render_install must accept a custom Windows
 * install root in either spelling (/c/... or C:/...), pass its plain-path
 * guard, and hand native Bun an --install-root the renderer accepts. Bun is a
 * native program, so Git Bash converts /c/... to C:/... on the way in; the
 * renderer test (gen-skill-docs-install-root-windows) covers what it does then.
 *
 * Windows only: the guard and the conversion are Git Bash behavior. The
 * function is sliced from setup and run through explicit bash; bun_cmd is a
 * native Bun that records the argv it received and fails the render.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const posix = (p: string) => p.replace(/\\/g, '/');

function slice(name: string): string {
  const start = SETUP.indexOf(`\n${name}() {`);
  const end = SETUP.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`cannot find ${name}() in setup`);
  return SETUP.slice(start + 1, end + 2);
}

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-root-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'win32')('setup _render_install with a custom Windows root (#3498)', () => {
  for (const root of ['/c/Users/example/isolated/claude-home/skills/gstack', 'C:/Users/example/isolated/claude-home/skills/gstack']) {
    test(`root spelled ${root.slice(0, 2)}... passes the guard and reaches the renderer`, () => {
      const argvFile = posix(path.join(tmp, 'argv.json'));
      const script = [
        'IS_WINDOWS=1',
        `HOME=${JSON.stringify(posix(tmp))}`,
        `SOURCE_GSTACK_DIR=${JSON.stringify(posix(ROOT))}`,
        `GSTACK_STATE_ROOT=${JSON.stringify(posix(path.join(tmp, 'state')))}`,
        '_GSTACK_OVERLAY=claude',
        `gstack_install_render_dir() { printf '%s\\n' ${JSON.stringify(posix(path.join(tmp, 'render')))}; }`,
        `bun_cmd() { ${JSON.stringify(posix(process.execPath))} -e 'require("fs").writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(1)))' -- "$@"; return 1; }`,
        `export ARGV_FILE=${JSON.stringify(argvFile)}`,
        slice('_render_install'),
        `_render_install claude ${JSON.stringify(root)}; echo "rc=$?"`,
      ].join('\n');
      const r = runBashSync(script, { encoding: 'utf8', timeout: 60_000 });
      expect(r.stderr).not.toContain('is not a plain path');
      const argv: string[] = JSON.parse(fs.readFileSync(path.join(tmp, 'argv.json'), 'utf8'));
      const given = argv[argv.indexOf('--install-root') + 1];
      expect(given, JSON.stringify(argv)).toMatch(/^(?:[Cc]:|\/c)\/Users\/example\/isolated\/claude-home\/skills\/gstack$/);
    });
  }
});
