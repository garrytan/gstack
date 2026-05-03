import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('gstack plugin manifest points Codex at the generated skills bundle', () => {
  const pluginJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'plugins', 'gstack', '.codex-plugin', 'plugin.json'), 'utf8'),
  );

  expect(pluginJson.name).toBe('gstack');
  expect(pluginJson.skills).toBe('./skills/');
  expect(pluginJson.interface.displayName).toBe('gstack');
  expect(pluginJson.interface.category).toBe('Coding');
});

test('repo-local marketplace publishes the gstack plugin entry', () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );

  expect(marketplace.name).toBe('gstack-local');
  expect(marketplace.plugins).toEqual([
    {
      name: 'gstack',
      source: {
        source: 'local',
        path: './plugins/gstack',
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Coding',
    },
  ]);
});

test('plugin skills directory resolves to the generated Codex skill tree', () => {
  const skillsPath = path.join(ROOT, 'plugins', 'gstack', 'skills');
  const stat = fs.lstatSync(skillsPath);

  expect(stat.isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(skillsPath)).toBe('../../.agents/skills');
});
