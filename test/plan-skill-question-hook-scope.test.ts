import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = path.join(import.meta.dir, 'helpers/plan-skill-question-hook-scope.ts');
const sourceRoot = path.dirname(import.meta.dir);
// Rebind the OS-managed root and the explicit live-source/census dependency
// in a byte-bound copy. The inverse check preserves every guard function;
// mutation controls operate only on private source fixtures, never the repo.
const child = String.raw`
  try {
  const [helper, sourceRoot, root, scenario] = process.argv.slice(-4);
  const fs = { ...require('node:fs') }, path = require('node:path');
  const assert = require('node:assert/strict');
  const managedFixture = path.join(root, 'managed');
  const original = fs.readFileSync(helper, 'utf8');
  const matches = [...original.matchAll(/^const managedRoot = [\s\S]*?;$/gm)];
  assert.equal(matches.length, 1);
  assert(matches[0][0].includes('/Library/Application Support/ClaudeCode'));
  assert(matches[0][0].includes('/etc/claude-code'));
  assert(matches[0][0].includes('Program Files'));
  const replacement = 'const managedRoot = ' + JSON.stringify(managedFixture) + ';';
  const liveRoot = scenario.startsWith('live-') ? path.join(root, 'source') : sourceRoot;
  fs.mkdirSync(liveRoot, {recursive: true});
  const sourceDeclaration = "const skillSourceRoot = fs.realpathSync(path.resolve(import.meta.dir, '..', '..'));";
  const sourceReplacement = 'const skillSourceRoot = fs.realpathSync(' + JSON.stringify(liveRoot) + ');';
  const censusImport = "from './skill-census'";
  const censusReplacement = 'from ' + JSON.stringify(path.join(sourceRoot, 'test/helpers/skill-census.ts'));
  assert.equal(original.split(sourceDeclaration).length, 2);
  assert.equal(original.split(censusImport).length, 2);
  const copied = original.replace(matches[0][0], replacement)
    .replace(sourceDeclaration, sourceReplacement).replace(censusImport, censusReplacement);
  assert.equal(copied.replace(replacement, matches[0][0])
    .replace(sourceReplacement, sourceDeclaration).replace(censusReplacement, censusImport), original);
  const copiedHelper = path.join(root, 'scope-helper.ts');
  fs.writeFileSync(copiedHelper, copied, {flag: 'wx'});
  const { setupQuestionHookScope: setup, assertQuestionHookScope: check } = require(copiedHelper);
  const privateRoot = path.join(root, 'private');
  const configDir = path.join(privateRoot, 'pty-one', '.claude');
  const registry = path.join(privateRoot, 'with-skills', '.claude', 'skills');
  const runtime = path.join(privateRoot, 'with-skills', 'runtime');
  const project = path.join(root, 'project'), cwd = path.join(project, 'nested');
  for (const dir of [configDir, registry, runtime, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.symlinkSync(registry, path.join(configDir, 'skills'), 'dir');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const json = (file, value) => write(file, JSON.stringify(value));
  const skill = (name, front = 'name: ' + name, body = 'Question review instructions.') => {
    const file = path.join(runtime, name, 'SKILL.md');
    write(file, '---\n' + front + '\n---\n' + body);
    fs.mkdirSync(path.join(registry, name), { recursive: true });
    fs.symlinkSync(file, path.join(registry, name, 'SKILL.md'));
    return file;
  };
  const skillFile = skill('review');
  const projectSkill = (name = 'plan-ceo-review', target = path.join(project, name, 'SKILL.md'), content = fs.readFileSync(path.join(sourceRoot, 'plan-ceo-review/SKILL.md'), 'utf8')) => {
    write(target, content);
    const link = path.join(project, '.claude', 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(link), {recursive: true}); fs.symlinkSync(target, link);
    return target;
  };
  const settings = path.join(configDir, 'settings.json');
  const hooks = matcher => ({ hooks: { PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'must-not-run' }] }] } });
  let checks = 0;
  const refuses = fn => { assert.throws(fn); checks++; };
  const passes = () => { const scope = setup({ configDir, cwd }); check(scope); assert(Object.isFrozen(scope)); checks++; return scope; };
  switch (scenario) {
    case 'clean': passes(); break;
    case 'all-generated-skills': {
      const { skillCensus } = require(path.join(sourceRoot, 'test/helpers/skill-census.ts'));
      for (const [index, rel] of skillCensus(sourceRoot).physicalSkillFiles.entries()) {
        const file = path.join(runtime, 'generated-' + index, 'SKILL.md');
        write(file, fs.readFileSync(path.join(sourceRoot, rel)));
        fs.mkdirSync(path.join(registry, 'generated-' + index));
        fs.symlinkSync(file, path.join(registry, 'generated-' + index, 'SKILL.md'));
      }
      assert(fs.readdirSync(registry).length > 50); passes(); break;
    }
    case 'actual-hermetic-registry': {
      delete process.env.ANTHROPIC_API_KEY; delete process.env.GSTACK_ANTHROPIC_API_KEY;
      process.env.EVALS_HERMETIC = '1'; process.env.TMPDIR = root;
      const { hermeticSkillsConfigDir, getHermeticDirs } = require(path.join(sourceRoot, 'test/helpers/hermetic-env.ts'));
      const seeded = fs.realpathSync(hermeticSkillsConfigDir());
      const sessionRoot = fs.mkdtempSync(path.join(getHermeticDirs().runRoot, 'pty-'));
      const actualConfig = path.join(sessionRoot, '.claude'); fs.mkdirSync(actualConfig);
      fs.symlinkSync(path.join(seeded, 'skills'), path.join(actualConfig, 'skills'), 'dir');
      const scope = setup({configDir: fs.realpathSync(actualConfig), cwd}); check(scope);
      assert(fs.readdirSync(path.join(actualConfig, 'skills')).length > 50); checks++; break;
    }
    case 'live-census-alias':
    case 'live-router-cross-name':
    case 'live-cross-name':
    case 'live-noncensus-document':
    case 'live-external-census-target':
    case 'live-frontmatter-mutation':
    case 'live-source-drift': {
      const source = path.join(liveRoot, 'authored', 'SKILL.md');
      write(source, '---\nname: review\n---\nLive source instructions.');
      fs.symlinkSync(path.dirname(source), path.join(liveRoot, 'alias'), 'dir');
      write(path.join(liveRoot, 'SKILL.md'), '---\nname: gstack\n---\nRoot router.');
      const target = scenario === 'live-cross-name' ? path.join(liveRoot, 'other', 'SKILL.md')
        : scenario === 'live-noncensus-document' ? path.join(liveRoot, 'authored', 'reference.md')
          : scenario === 'live-external-census-target' ? path.join(root, 'outside', 'SKILL.md') : source;
      if (target !== source) write(target, '---\nname: other\n---\nUnrelated instructions.');
      if (scenario === 'live-external-census-target') {
        // Even appearing in the census via a source-directory symlink cannot
        // authorize a file outside the explicitly bound source root.
        write(target, '---\nname: review\n---\nOutside instructions.');
        fs.symlinkSync(path.dirname(target), path.join(liveRoot, 'outside-alias'), 'dir');
      }
      if (scenario === 'live-frontmatter-mutation') write(source,
        '---\nname: review\nhooks:\n  PreToolUse:\n    - matcher: AskUserQuestion\n      hooks: []\n---\n');
      fs.unlinkSync(path.join(registry, 'review', 'SKILL.md'));
      fs.symlinkSync(target, path.join(registry, 'review', 'SKILL.md'));
      if (scenario === 'live-census-alias') {
        for (const name of ['_gstack-command', 'gstack']) {
          fs.mkdirSync(path.join(registry, name));
          fs.symlinkSync(path.join(liveRoot, 'SKILL.md'), path.join(registry, name, 'SKILL.md'));
        }
        passes();
      } else if (scenario === 'live-router-cross-name') {
        fs.mkdirSync(path.join(registry, 'gstack'));
        fs.symlinkSync(source, path.join(registry, 'gstack', 'SKILL.md'));
        refuses(() => setup({configDir,cwd}));
      } else if (scenario === 'live-source-drift') {
        const scope = passes(); fs.appendFileSync(source, '\nchanged'); refuses(() => check(scope));
      } else refuses(() => setup({configDir,cwd}));
      break;
    }
    case 'alias-registry': {
      const alias = path.join(root, 'private-alias'); fs.symlinkSync(privateRoot, alias, 'dir');
      fs.unlinkSync(path.join(configDir, 'skills'));
      fs.symlinkSync(path.join(alias, 'with-skills', '.claude', 'skills'), path.join(configDir, 'skills'), 'dir');
      passes(); break;
    }
    case 'project-same-name-skill': projectSkill(); passes(); break;
    case 'project-cross-name-skill': projectSkill('plan-ceo-review', path.join(project, 'other-skill', 'SKILL.md')); refuses(() => setup({configDir,cwd})); break;
    case 'project-external-skill': projectSkill('plan-ceo-review', path.join(root, 'external-skill', 'SKILL.md')); refuses(() => setup({configDir,cwd})); break;
    case 'project-pretool-mutation':
      projectSkill('plan-ceo-review', undefined, '---\nname: plan-ceo-review\nhooks:\n  PreToolUse:\n    - matcher: AskUserQuestion\n      hooks: []\n---\n');
      refuses(() => setup({configDir,cwd})); break;
    case 'project-permission-mutation':
      projectSkill('plan-ceo-review', undefined, '---\nname: plan-ceo-review\nhooks:\n  PermissionRequest:\n    - matcher: AskUserQuestion\n      hooks: []\n---\n');
      refuses(() => setup({configDir,cwd})); break;
    case 'project-skill-drift': { const file = projectSkill(); const scope = passes(); fs.appendFileSync(file, '\nchanged'); refuses(() => check(scope)); break; }
    case 'empty-plugins-container': { const scope = passes(); fs.mkdirSync(path.join(configDir, 'plugins')); check(scope); checks++; break; }
    case 'new-plugin-registry': { const scope = passes(); json(path.join(configDir, 'plugins', 'installed_plugins.json'), {version: 2, plugins: {}}); refuses(() => check(scope)); break; }
    case 'changed-plugin-registry': { const file = path.join(configDir, 'plugins', 'installed_plugins.json'); json(file, {version: 2, plugins: {}}); const scope = passes(); json(file, {version: 3, plugins: {}}); refuses(() => check(scope)); break; }
    case 'plugin-container-symlink': { const scope = passes(); const outside = path.join(root, 'external-plugins'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(configDir, 'plugins'), 'dir'); refuses(() => check(scope)); break; }
    case 'plugin-container-nondirectory': { const scope = passes(); write(path.join(configDir, 'plugins'), ''); refuses(() => check(scope)); break; }
    case 'literal-noncaptured':
      json(settings, hooks('Glob')); json(path.join(project, '.claude', 'settings.local.json'), hooks('Read'));
      write(skillFile, '---\nname: review\nhooks:\n  PreToolUse:\n    - matcher: Grep\n      hooks: []\n---\n');
      passes(); break;
    case 'auq-settings': json(settings, hooks('AskUserQuestion')); refuses(() => setup({configDir,cwd})); break;
    case 'substring-settings': json(settings, hooks('Question')); refuses(() => setup({configDir,cwd})); break;
    case 'lowercase-auq': json(settings, hooks('askuserquestion')); refuses(() => setup({configDir,cwd})); break;
    case 'permission-auq': json(settings, {hooks: {PermissionRequest: hooks('AskUserQuestion').hooks.PreToolUse}}); refuses(() => setup({configDir,cwd})); break;
    case 'permission-other-tool':
      json(settings, {hooks: {PermissionRequest: hooks('Read').hooks.PreToolUse}});
      write(skillFile, '---\nname: review\nhooks:\n  PermissionRequest:\n    - matcher: Read\n      hooks: []\n---\n');
      passes(); break;
    case 'regex-settings': json(settings, hooks('Bash|AskUserQuestion')); refuses(() => setup({configDir,cwd})); break;
    case 'wildcard-settings': json(settings, hooks('.*')); refuses(() => setup({configDir,cwd})); break;
    case 'omitted-matcher': json(settings, hooks()); refuses(() => setup({configDir,cwd})); break;
    case 'malformed-hooks': json(settings, {hooks: {PreToolUse: 'Bash'}}); refuses(() => setup({configDir,cwd})); break;
    case 'ancestor-settings': json(path.join(project, '.claude', 'settings.json'), hooks('AskUserQuestion')); refuses(() => setup({configDir,cwd})); break;
    case 'managed-settings': json(path.join(managedFixture, 'managed-settings.json'), hooks('AskUserQuestion')); refuses(() => setup({configDir,cwd})); break;
    case 'managed-dropin': json(path.join(managedFixture, 'managed-settings.d', 'policy.json'), hooks('AskUserQuestion')); refuses(() => setup({configDir,cwd})); break;
    case 'auq-frontmatter': write(skillFile, '---\nname: review\nhooks:\n  PreToolUse:\n    - matcher: AskUserQuestion\n      hooks: []\n---\n'); refuses(() => setup({configDir,cwd})); break;
    case 'invalid-frontmatter': write(skillFile, '---\nname: [\n---\n'); refuses(() => setup({configDir,cwd})); break;
    case 'enabled-plugin': json(settings, {enabledPlugins: {'observer@local': true}}); refuses(() => setup({configDir,cwd})); break;
    case 'disabled-plugin': json(settings, {enabledPlugins: {'observer@local': false}}); passes(); break;
    case 'installed-plugin': json(path.join(configDir, 'plugins', 'installed_plugins.json'), {version: 2, plugins: {'observer@local': [{installPath: '/unused'}]}}); refuses(() => setup({configDir,cwd})); break;
    case 'module-config': json(settings, {modules: {observer: {}}}); refuses(() => setup({configDir,cwd})); break;
    case 'created-settings': { const scope = passes(); json(settings, {}); refuses(() => check(scope)); break; }
    case 'changed-settings': { json(settings, {model: 'unchanged'}); const scope = passes(); json(settings, {model: 'changed'}); refuses(() => check(scope)); break; }
    case 'deleted-settings': { json(settings, {}); const scope = passes(); fs.unlinkSync(settings); refuses(() => check(scope)); break; }
    case 'new-managed-dropin': { fs.mkdirSync(managedFixture); const scope = passes(); json(path.join(managedFixture, 'managed-settings.d', 'new.json'), {}); refuses(() => check(scope)); break; }
    case 'new-skill': { const scope = passes(); skill('new'); refuses(() => check(scope)); break; }
    case 'changed-skill': { const scope = passes(); fs.appendFileSync(skillFile, '\nchanged'); refuses(() => check(scope)); break; }
    case 'external-registry': { fs.unlinkSync(path.join(configDir, 'skills')); fs.symlinkSync(runtime, path.join(configDir, 'skills'), 'dir'); refuses(() => setup({configDir,cwd})); break; }
    case 'external-skill': { const file = path.join(root, 'outside.md'); write(file, '---\nname: review\n---\n'); fs.unlinkSync(path.join(registry, 'review', 'SKILL.md')); fs.symlinkSync(file, path.join(registry, 'review', 'SKILL.md')); refuses(() => setup({configDir,cwd})); break; }
    case 'settings-symlink': { const file = path.join(root, 'outside.json'); json(file, {}); fs.symlinkSync(file, settings); refuses(() => setup({configDir,cwd})); break; }
    case 'oversized-settings': write(settings, ' '.repeat(1024 * 1024 + 1)); refuses(() => setup({configDir,cwd})); break;
    case 'invalid-utf8': write(settings, Buffer.from([0xff])); refuses(() => setup({configDir,cwd})); break;
    case 'forged-descriptor': refuses(() => check({})); break;
    case 'fifo': { const result = require('node:child_process').spawnSync('mkfifo', [settings], {timeout: 1000}); assert.equal(result.status, 0); refuses(() => setup({configDir,cwd})); break; }
    default: {
      const match = /^file-tool-(PreToolUse|PermissionRequest|PostToolUse|PostToolUseFailure)-(Write|Edit|ExitPlanMode|AskUserQuestion|Bash|WebFetch)-(settings|frontmatter|managed|drift)$/.exec(scenario);
      if (!match) throw new Error('unknown scenario');
      const [, event, tool, location] = match;
      const scope = location === 'drift' ? passes() : null;
      if (location === 'frontmatter') {
        write(skillFile, '---\nname: review\nhooks:\n  ' + event + ':\n    - matcher: ' + tool + '\n      hooks: []\n---\n');
      } else {
        const file = location === 'managed' ? path.join(managedFixture, 'managed-settings.json') : settings;
        json(file, {hooks: {[event]: hooks(tool).hooks.PreToolUse}});
      }
      if ((event === 'PreToolUse' && (tool === 'Write' || tool === 'Edit' || tool === 'Bash' || tool === 'WebFetch') || event === 'PostToolUse' && tool === 'ExitPlanMode') && location !== 'drift') passes();
      else refuses(() => scope ? check(scope) : setup({configDir,cwd}));
      break;
    }
  }
  assert(checks > 0); fs.writeSync(1, JSON.stringify({ scenario, checks }));
  } catch (error) {
    require('node:fs').writeSync(2, 'Scope probe failed: ' + String(error) + '\n');
    process.exitCode = 1;
  }
`;

const scenarios = ['clean', 'all-generated-skills', 'actual-hermetic-registry', 'alias-registry',
  'live-census-alias', 'live-router-cross-name', 'live-cross-name', 'live-noncensus-document', 'live-external-census-target',
  'live-frontmatter-mutation', 'live-source-drift',
  'project-same-name-skill', 'project-cross-name-skill', 'project-external-skill',
  'project-pretool-mutation', 'project-permission-mutation', 'project-skill-drift',
  'empty-plugins-container', 'new-plugin-registry', 'changed-plugin-registry', 'plugin-container-symlink', 'plugin-container-nondirectory',
  'literal-noncaptured', 'auq-settings', 'substring-settings', 'lowercase-auq',
  'permission-auq', 'permission-other-tool',
  'regex-settings', 'wildcard-settings', 'omitted-matcher', 'malformed-hooks', 'ancestor-settings',
  'managed-settings', 'managed-dropin', 'auq-frontmatter', 'invalid-frontmatter', 'enabled-plugin',
  'disabled-plugin', 'installed-plugin', 'module-config', 'created-settings', 'changed-settings',
  'deleted-settings', 'new-managed-dropin', 'new-skill', 'changed-skill', 'external-registry',
  'external-skill', 'settings-symlink', 'oversized-settings', 'invalid-utf8', 'forged-descriptor'];
for (const event of ['PreToolUse', 'PermissionRequest', 'PostToolUse']) {
  for (const tool of ['Write', 'Edit', 'ExitPlanMode']) {
    for (const location of ['settings', 'frontmatter', 'managed', 'drift']) scenarios.push(`file-tool-${event}-${tool}-${location}`);
  }
}
for (const location of ['settings', 'frontmatter', 'managed', 'drift']) scenarios.push(`file-tool-PostToolUse-AskUserQuestion-${location}`);
for (const event of ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'])
  for (const tool of ['Bash', 'WebFetch'])
    for (const location of ['settings', 'frontmatter', 'managed', 'drift']) scenarios.push(`file-tool-${event}-${tool}-${location}`);
if (process.platform !== 'win32') scenarios.push('fifo');

for (const scenario of scenarios) test(`controlled question hook scope: ${scenario}`, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'question-hook-scope-')));
  try {
    const result = spawnSync(process.execPath, ['-e', child, helper, sourceRoot, root, scenario], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ scenario });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 7000);
