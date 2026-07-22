import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copilot, codex } from '../hosts';

const ROOT = path.resolve(import.meta.dir, '..');
const GENERATOR = path.join(ROOT, 'scripts', 'gen-skill-docs.ts');
const EXPORTER = path.join(ROOT, 'scripts', 'host-config-export.ts');
const SETUP = path.join(ROOT, 'setup');
const UNINSTALL = path.join(ROOT, 'bin', 'gstack-uninstall');
const GENERATED_SKILLS = path.join(ROOT, '.copilot', 'skills');
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function generatedSkillFiles(): string[] {
  return fs.readdirSync(GENERATED_SKILLS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(GENERATED_SKILLS, entry.name, 'SKILL.md'))
    .filter(file => fs.existsSync(file));
}

function parseFrontmatter(file: string): Record<string, unknown> {
  const content = fs.readFileSync(file, 'utf8');
  const end = content.indexOf('\n---', 4);
  expect(content.startsWith('---\n')).toBe(true);
  expect(end).toBeGreaterThan(0);
  return Bun.YAML.parse(content.slice(4, end)) as Record<string, unknown>;
}

beforeAll(() => {
  const result = Bun.spawnSync([process.execPath, 'run', GENERATOR, '--host', 'copilot'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('GitHub Copilot contract', () => {
  test('one declarative host covers CLI and app without sharing Codex paths', () => {
    expect(copilot.supportedSurfaces).toEqual(['cli', 'app']);
    expect(copilot.cliCommand).toBe('copilot');
    expect(copilot.cliAliases).toEqual([]);
    expect(copilot.globalRoot).toBe('.copilot/skills/gstack');
    expect(copilot.globalRootEnv).toBe('COPILOT_HOME');
    expect(copilot.localSkillRoot).toBe('.github/skills/gstack');
    expect(copilot.hostSubdir).toBe('.copilot');
    expect(copilot.frontmatter.nameLimit).toBe(64);
    expect(copilot.globalRoot).not.toBe(codex.globalRoot);
    expect(copilot.localSkillRoot).not.toBe(codex.localSkillRoot);
    expect(copilot.hostSubdir).not.toBe(codex.hostSubdir);
  });

  test('detects the standalone copilot executable and not legacy gh alone', () => {
    const fakeBin = tempDir('gstack-copilot-detect-');
    const copilotBin = path.join(fakeBin, 'copilot');
    fs.writeFileSync(copilotBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(copilotBin, 0o755);

    const detected = Bun.spawnSync([process.execPath, 'run', EXPORTER, 'detect'], {
      cwd: ROOT,
      env: { ...process.env, PATH: fakeBin },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(detected.exitCode, detected.stderr.toString()).toBe(0);
    expect(detected.stdout.toString().trim().split('\n')).toContain('copilot');

    fs.rmSync(copilotBin);
    const ghBin = path.join(fakeBin, 'gh');
    fs.writeFileSync(ghBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(ghBin, 0o755);
    const legacyOnly = Bun.spawnSync([process.execPath, 'run', EXPORTER, 'detect'], {
      cwd: ROOT,
      env: { ...process.env, PATH: fakeBin },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(legacyOnly.stdout.toString().split('\n')).not.toContain('copilot');
  });

  test('resolves Git Bash paths without Windows separators', () => {
    const resolved = Bun.spawnSync(
      [process.execPath, 'run', EXPORTER, 'resolve-global-root', 'copilot'],
      {
        cwd: ROOT,
        env: { ...process.env, HOME: '/c/Users/alice', COPILOT_HOME: '/d/copilot' },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
    expect(resolved.stdout.toString().trim()).toBe('/d/copilot/skills/gstack');
    expect(resolved.stdout.toString()).not.toContain('\\');
  });

  test('generated skills satisfy Agent Skills name and frontmatter limits', () => {
    const files = generatedSkillFiles();
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const frontmatter = parseFrontmatter(file);
      const directory = path.basename(path.dirname(file));
      expect(Object.keys(frontmatter).sort()).toEqual(['description', 'name']);
      expect(frontmatter.name).toBe(directory);
      expect(String(frontmatter.name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(String(frontmatter.name).length).toBeLessThanOrEqual(64);
      expect(String(frontmatter.description).length).toBeGreaterThan(0);
      expect(String(frontmatter.description).length).toBeLessThanOrEqual(1024);
    }
  });

  test('name-limit failures retain the Copilot host diagnostic', () => {
    const generator = fs.readFileSync(GENERATOR, 'utf8');
    expect(generator).toContain(
      '`${hostConfig.displayName} frontmatter name exceeds ${fm.nameLimit} characters: `'
    );
    expect(generator).not.toContain(
      '`${currentHost} frontmatter name exceeds ${fm.nameLimit} characters: `'
    );
  });

  test('generated content uses Copilot paths and tool vocabulary', () => {
    const content = generatedSkillFiles().map(file => fs.readFileSync(file, 'utf8')).join('\n');
    expect(content).toContain('${COPILOT_HOME:-$HOME/.copilot}/skills/gstack');
    expect(content).toContain('.github/skills/gstack');
    expect(content).toContain('$GSTACK_ROOT/review/checklist.md');
    expect(content).toContain('ask_user');
    expect(content).toContain('task tool');
    expect(content).not.toContain('.claude/skills');
    expect(content).not.toContain('.agents/skills');
    expect(content).not.toContain('$HOME/.github/skills');
    expect(content).not.toContain('${HOME}/$GSTACK_ROOT');
    expect(content).not.toContain('[ -f "$GSTACK_ROOT/VERSION" ] || [ -d "$GSTACK_ROOT/.git" ]');
    expect(content).not.toContain('AskUserQuestion');
    expect(content).not.toContain('use the Bash tool');
    expect(content).not.toContain('use the Agent tool');

    const upgrade = fs.readFileSync(
      path.join(GENERATED_SKILLS, 'gstack-upgrade', 'SKILL.md'),
      'utf8'
    );
    expect(upgrade).toContain('INSTALL_DIR="$(cat "$GSTACK_ROOT/.source-path")"');
    expect(upgrade).toContain('./setup --host copilot');
    expect(upgrade).toContain('### Step 4.5: Refresh a repository-local Copilot install');
    expect(upgrade).toContain('"$LOCAL_SOURCE/setup" --host copilot --local');
    expect(upgrade).not.toContain('$_ROOT/$GSTACK_ROOT');
    expect(upgrade).not.toMatch(/(?:^|&& )\.\/setup(?:\n|$)/m);
  });
});

describe('GitHub Copilot install and uninstall', () => {
  function setupEnv(home: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: home,
      COPILOT_HOME: path.join(home, 'custom-copilot'),
      GSTACK_HOME: path.join(home, '.gstack'),
      GSTACK_TEST_INSTALL_ONLY: '1',
      GSTACK_SKIP_FONTS: '1',
      GSTACK_SKIP_COREUTILS: '1',
      GSTACK_SKIP_GBRAIN_REGEN: '1',
    };
  }

  test('global and repository installs resolve skills and runtime assets', () => {
    const root = tempDir('gstack-copilot-install-');
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', repo]);

    const global = spawnSync('bash', [SETUP, '--host', 'copilot', '--quiet'], {
      cwd: ROOT,
      env: setupEnv(home),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(global.status, global.stderr).toBe(0);

    const globalRoot = path.join(home, 'custom-copilot', 'skills');
    expect(parseFrontmatter(path.join(globalRoot, 'gstack', 'SKILL.md')).name).toBe('gstack');
    expect(parseFrontmatter(path.join(globalRoot, 'gstack-review', 'SKILL.md')).name).toBe('gstack-review');
    expect(fs.realpathSync(path.join(globalRoot, 'gstack', 'bin'))).toBe(fs.realpathSync(path.join(ROOT, 'bin')));
    expect(fs.realpathSync(path.join(globalRoot, 'gstack', 'gstack-upgrade', 'SKILL.md')))
      .toBe(fs.realpathSync(path.join(GENERATED_SKILLS, 'gstack-upgrade', 'SKILL.md')));
    expect(fs.realpathSync(path.join(globalRoot, 'gstack', 'plan-ceo-review', 'SKILL.md')))
      .toBe(fs.realpathSync(path.join(GENERATED_SKILLS, 'gstack-plan-ceo-review', 'SKILL.md')));
    expect(fs.realpathSync(path.join(globalRoot, 'gstack', 'document-release', 'SKILL.md')))
      .toBe(fs.realpathSync(path.join(GENERATED_SKILLS, 'gstack-document-release', 'SKILL.md')));
    expect(fs.readFileSync(path.join(globalRoot, 'gstack', '.source-path'), 'utf8').trim())
      .toBe(fs.realpathSync(ROOT));
    for (const asset of [
      'VERSION',
      'scripts/jargon-list.json',
      'scripts/one-way-doors.ts',
      'lib/redact-audit-log.ts',
      'lib/diagram-render/dist/diagram-render.html',
      'design-html/vendor/pretext.js',
      'extension/manifest.json',
      'hosts/copilot.ts',
      'ios-qa/scripts/gen-accessors.ts',
      'ios-qa/daemon/src/index.ts',
      'review/checklist.md',
    ]) {
      expect(fs.existsSync(path.join(globalRoot, 'gstack', asset)), asset).toBe(true);
    }

    const questionPreference = spawnSync(
      path.join(globalRoot, 'gstack', 'bin', 'gstack-question-preference'),
      ['--check', 'copilot-runtime-test'],
      { env: setupEnv(home), encoding: 'utf8' }
    );
    expect(questionPreference.status, questionPreference.stderr).toBe(0);
    expect(questionPreference.stdout).toContain('ASK_NORMALLY');

    const platformDetect = spawnSync(
      path.join(globalRoot, 'gstack', 'bin', 'gstack-platform-detect'),
      [],
      { env: setupEnv(home), encoding: 'utf8' }
    );
    expect(platformDetect.status, platformDetect.stderr).toBe(0);

    const local = spawnSync('bash', [SETUP, '--host', 'copilot', '--local', '--quiet'], {
      cwd: repo,
      env: setupEnv(home),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(local.status, local.stderr).toBe(0);

    const localRoot = path.join(repo, '.github', 'skills');
    expect(parseFrontmatter(path.join(localRoot, 'gstack', 'SKILL.md')).name).toBe('gstack');
    expect(parseFrontmatter(path.join(localRoot, 'gstack-review', 'SKILL.md')).name).toBe('gstack-review');
    expect(fs.realpathSync(path.join(localRoot, 'gstack', 'bin'))).toBe(fs.realpathSync(path.join(ROOT, 'bin')));
    expect(fs.realpathSync(path.join(localRoot, 'gstack', 'plan-eng-review', 'SKILL.md')))
      .toBe(fs.realpathSync(path.join(GENERATED_SKILLS, 'gstack-plan-eng-review', 'SKILL.md')));
    expect(fs.readFileSync(path.join(localRoot, 'gstack', '.source-path'), 'utf8').trim())
      .toBe(fs.realpathSync(ROOT));
  }, 130_000);

  test('uninstall removes Copilot personal and repository skills', () => {
    const root = tempDir('gstack-copilot-uninstall-');
    const home = path.join(root, 'home');
    const copilotHome = path.join(home, 'custom-copilot');
    const fakeBin = path.join(root, 'bin');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, 'cygpath'),
      `#!/bin/sh\nprintf '%s\\n' '${copilotHome}'\n`
    );
    fs.chmodSync(path.join(fakeBin, 'cygpath'), 0o755);
    fs.mkdirSync(path.join(copilotHome, 'skills', 'gstack-review'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.github', 'skills', 'gstack-review'), { recursive: true });
    spawnSync('git', ['init', '-q', repo]);

    const result = spawnSync('bash', [UNINSTALL, '--force', '--keep-state'], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        COPILOT_HOME: 'C:\\Users\\alice\\copilot',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        GSTACK_STATE_DIR: path.join(home, '.gstack'),
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(copilotHome, 'skills', 'gstack-review'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.github', 'skills', 'gstack-review'))).toBe(false);
  });
});
