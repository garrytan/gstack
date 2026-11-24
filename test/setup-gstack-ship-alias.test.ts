import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

const setup = fs.readFileSync(path.resolve(import.meta.dir, '../setup'), 'utf8');
const fn = (name: string) => {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup helper: ${name}`);
  return setup.slice(start + 1, end + 2);
};
const helpers = ['_write_owned_marker', '_claude_entry_is_ours', '_install_alias_skill_md', 'link_claude_gstack_ship_alias']
  .map(fn)
  .join('\n');

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) {
    fs.chmodSync(t, 0o755);
    fs.rmSync(t, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('setup: gstack-ship agent alias', () => {
  test('installs a thin wrapper that points at gstack/ship/SKILL.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-alias-'));
    tmps.push(tmp);
    const gstack = path.join(tmp, 'gstack-src');
    const skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(gstack, 'ship', 'sections'), { recursive: true });
    fs.mkdirSync(path.join(gstack, 'gstack-ship'), { recursive: true });
    fs.writeFileSync(path.join(gstack, 'ship/SKILL.md'), 'name: ship\n---\ncanonical ship body\n');
    fs.writeFileSync(path.join(gstack, 'gstack-ship/SKILL.md'), fs.readFileSync(path.join(import.meta.dir, '../gstack-ship/SKILL.md'), 'utf8'));
    fs.writeFileSync(path.join(gstack, 'ship/sections', 'tests.md'), 'tests section\n');

    const r = runBashScript(
      [
        'set -e',
        'SOURCE_GSTACK_DIR="' + gstack + '"',
        '_DISABLED_SKILLS=" "',
        helpers,
        `link_claude_gstack_ship_alias "$SOURCE_GSTACK_DIR" "${skills}"`,
      ].join('\n'),
      { timeout: 30_000 },
    );
    expect(r.status, r.stderr).toBe(0);

    const aliasMd = path.join(skills, 'gstack-ship/SKILL.md');
    expect(fs.existsSync(aliasMd)).toBe(true);
    const text = fs.readFileSync(aliasMd, 'utf8');
    expect(text).toMatch(/^name: gstack-ship/m);
    expect(text).toContain('Read');
    expect(text).toContain('ship/SKILL.md');
    expect(text).not.toContain('canonical ship body');
    const sect = fs.lstatSync(path.join(skills, 'gstack-ship/sections'));
    expect(sect.isSymbolicLink()).toBe(true);
  });
});