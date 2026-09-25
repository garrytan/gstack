import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SENTINEL } from '../lib/design-detect-contract';

const detector = fileURLToPath(new URL('../bin/gstack-design-detect.ts', import.meta.url));

test.each([
  { versions: ['4.3.1', '4.10.0'], selected: '4.10.0', custom: false },
  { versions: ['4.3.1', '4.10.0'], selected: '4.10.0', custom: true },
  { versions: ['4.3.1-beta.1', '4.3.1'], selected: '4.3.1', custom: false },
  { versions: ['99.0.0-', '4.3.1'], selected: '4.3.1', custom: false },
  { versions: ['a1b2c3d4'], selected: 'a1b2c3d4', custom: true },
  { versions: ['unknown'], selected: 'unknown', custom: false },
])('native plugin discovery %j', ({ versions, selected, custom }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plugin-native-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const config = custom ? path.join(root, 'custom config') : path.join(home, '.claude');
  for (const dir of [home, cwd, config]) fs.mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath),
    GSTACK_HOME: path.join(root, 'gstack'), IMPECCABLE_HOME: path.join(root, 'engine-cache'),
  };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!;
  if (custom) env.CLAUDE_CONFIG_DIR = config;
  try {
    const launchers = new Map<string, string>();
    for (const version of versions) {
      const skill = path.join(config, 'plugins', 'cache', 'market', 'impeccable', version, 'skills', 'impeccable');
      fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '# fixture\n');
      const launcher = path.join(skill, 'scripts', 'impeccable');
      fs.writeFileSync(launcher, 'This fixture is not an executable.\n');
      launchers.set(version, launcher);
    }
    if (custom) {
      const stale = path.join(home, '.claude', 'skills', 'impeccable');
      fs.mkdirSync(stale, { recursive: true });
      fs.writeFileSync(path.join(stale, 'SKILL.md'), '# stale default profile\n');
    }
    const probe = () => spawnSync(process.execPath, ['--no-env-file', 'run', detector, 'probe'], {
      cwd, env, encoding: 'utf-8', timeout: 30_000,
    });
    const found = probe();
    expect(found.status).toBe(0);
    const expectedLauncher = custom
      ? path.join(fs.realpathSync(config), path.relative(config, launchers.get(selected)!))
      : launchers.get(selected)!;
    expect(found.stdout.split('\n')[0]).toBe(`${SENTINEL.NOT_CACHED}: ${expectedLauncher}`);
    expect(found.stdout).toContain(`${SENTINEL.SKILL}: present`);
    expect(found.stdout).not.toContain(`${SENTINEL.READY}:`);
    fs.rmSync(path.join(config, 'plugins'), { recursive: true });
    const removed = probe();
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain(`${SENTINEL.SKILL}: absent`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
