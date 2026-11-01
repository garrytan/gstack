/**
 * #3498: on Windows, Git Bash converts setup's /c/... install root to C:/...
 * when it hands the argument to native Bun, and the renderer refused any root
 * not starting with "/", so a custom-root install kept the default-install
 * paths. A drive-letter root is accepted and rendered in the /c/... form that
 * setup verified; anything else outside the plain charset still refuses.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from '../lib/bun-isolation';

const ROOT = path.resolve(import.meta.dir, '..');
let out = '';

beforeEach(() => { out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-install-root-'))); });
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

const render = (installRoot: string) => spawnSync(process.execPath, [
  ...bunIsolationArgs(), path.join(ROOT, 'scripts', 'gen-skill-docs.ts'), '--host', 'claude', '--out-dir', path.join(out, 'render'), '--install-root', installRoot,
], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });

test('a drive-letter install root renders as its /c/... spelling (#3498)', () => {
  const r = render('C:/Users/example/isolated/claude-home/skills/gstack');
  expect(r.status, r.stderr).toBe(0);
  const skill = fs.readFileSync(path.join(out, 'render', 'SKILL.md'), 'utf8');
  expect(skill).toContain('/c/Users/example/isolated/claude-home/skills/gstack/bin/gstack-skill-start --skill');
  expect(skill).not.toContain('C:/Users/example');
}, 260_000);

test('a root with a space still refuses (#3498)', () => {
  const r = render('C:/Users/First Last/skills/gstack');
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('--install-root must be');
}, 260_000);
