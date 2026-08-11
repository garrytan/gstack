import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BASH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const tempDirs: string[] = [];

function toBashPath(value: string): string {
  return process.platform === 'win32'
    ? value.replace(/^([A-Za-z]):\\/, (_match, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/')
    : value;
}

function makeFixture(): { root: string; install: string; skills: string; state: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prefix-projection-'));
  tempDirs.push(root);
  const install = path.join(root, 'install');
  const skills = path.join(root, 'skills');
  const state = path.join(root, 'state');
  const bin = path.join(install, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(skills, { recursive: true });

  for (const script of ['gstack-config', 'gstack-relink', 'gstack-patch-names']) {
    const destination = path.join(bin, script);
    fs.copyFileSync(path.join(ROOT, 'bin', script), destination);
    fs.chmodSync(destination, 0o755);
  }
  for (const skill of ['qa', 'review', 'ship', 'gstack-upgrade']) {
    const skillDir = path.join(install, skill);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: fixture ${skill}\n---\n# ${skill}\n`,
    );
  }
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config.yaml'), 'skill_prefix: true\n');
  return { root, install, skills, state };
}

function runRelink(fixture: ReturnType<typeof makeFixture>): void {
  execFileSync(BASH, [toBashPath(path.join(fixture.install, 'bin', 'gstack-relink'))], {
    env: {
      ...process.env,
      GSTACK_INSTALL_DIR: toBashPath(fixture.install),
      GSTACK_SKILLS_DIR: toBashPath(fixture.skills),
      GSTACK_STATE_DIR: toBashPath(fixture.state),
      HOME: toBashPath(path.join(fixture.root, 'home')),
      USERPROFILE: toBashPath(path.join(fixture.root, 'home')),
      TMPDIR: toBashPath(fixture.root),
      TMP: toBashPath(fixture.root),
      TEMP: toBashPath(fixture.root),
    },
    stdio: 'pipe',
  });
}

function skillName(file: string): string | undefined {
  return fs.readFileSync(file, 'utf-8').match(/^name:\s*(.+)$/m)?.[1];
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copySetupFixture(): { root: string; source: string; home: string; codexHome: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-projection-'));
  tempDirs.push(root);
  const source = path.join(root, 'source');
  const excluded = new Set(['.git', '.agents', 'node_modules', 'browse/dist']);
  fs.cpSync(ROOT, source, {
    recursive: true,
    preserveTimestamps: true,
    filter: candidate => !excluded.has(path.relative(ROOT, candidate).replaceAll('\\', '/')),
  });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(source, 'browse'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'browse', 'dist'), path.join(source, 'browse', 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, source, home: path.join(root, 'home'), codexHome: path.join(root, 'codex-home') };
}

function runSetup(fixture: ReturnType<typeof copySetupFixture>, prefix: boolean): void {
  execFileSync(BASH, [toBashPath(path.join(fixture.source, 'setup')), '--host', 'codex', prefix ? '--prefix' : '--no-prefix', '--no-team', '--no-plan-tune-hooks', '--quiet'], {
    cwd: fixture.source,
    env: {
      ...process.env,
      HOME: toBashPath(fixture.home),
      USERPROFILE: toBashPath(fixture.home),
      CODEX_HOME: toBashPath(fixture.codexHome),
      GSTACK_SKIP_FONTS: '1',
    },
    stdio: 'pipe',
    timeout: 180_000,
  });
}

function runRelinkFailure(fixture: ReturnType<typeof makeFixture>): string {
  try {
    runRelink(fixture);
  } catch (error: any) {
    return Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]).toString('utf-8');
  }
  throw new Error('Expected gstack-relink to reject an unowned wrapper collision.');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('prefix projections', () => {
  test('relink writes prefixed wrappers without mutating canonical skills', () => {
    const fixture = makeFixture();
    const canonical = new Map(
      ['qa', 'review', 'ship', 'gstack-upgrade'].map(skill => [
        skill,
        fs.readFileSync(path.join(fixture.install, skill, 'SKILL.md'), 'utf-8'),
      ]),
    );

    runRelink(fixture);

    for (const [skill, source] of canonical) {
      expect(fs.readFileSync(path.join(fixture.install, skill, 'SKILL.md'), 'utf-8')).toBe(source);
    }
    expect(skillName(path.join(fixture.skills, 'gstack-qa', 'SKILL.md'))).toBe('gstack-qa');
    expect(skillName(path.join(fixture.skills, 'gstack-review', 'SKILL.md'))).toBe('gstack-review');
    expect(skillName(path.join(fixture.skills, 'gstack-ship', 'SKILL.md'))).toBe('gstack-ship');
    expect(skillName(path.join(fixture.skills, 'gstack-upgrade', 'SKILL.md'))).toBe('gstack-upgrade');

    fs.writeFileSync(path.join(fixture.state, 'config.yaml'), 'skill_prefix: false\n');
    runRelink(fixture);
    runRelink(fixture);

    for (const [skill, source] of canonical) {
      expect(fs.readFileSync(path.join(fixture.install, skill, 'SKILL.md'), 'utf-8')).toBe(source);
    }
    expect(skillName(path.join(fixture.skills, 'qa', 'SKILL.md'))).toBe('qa');
    expect(skillName(path.join(fixture.skills, 'review', 'SKILL.md'))).toBe('review');
    expect(skillName(path.join(fixture.skills, 'ship', 'SKILL.md'))).toBe('ship');
    expect(fs.existsSync(path.join(fixture.skills, 'gstack-qa'))).toBe(false);
  });

  test('relink preserves an unmarked user-owned wrapper collision', () => {
    const fixture = makeFixture();
    const collision = path.join(fixture.skills, 'gstack-qa');
    fs.mkdirSync(collision, { recursive: true });
    fs.writeFileSync(path.join(collision, 'SKILL.md'), '---\nname: gstack-qa\n---\n# my private skill\n');

    const output = runRelinkFailure(fixture);

    expect(output).toContain('unowned skill wrapper');
    expect(fs.readFileSync(path.join(collision, 'SKILL.md'), 'utf-8')).toContain('my private skill');
    expect(fs.existsSync(path.join(collision, '.gstack-skill-projection'))).toBe(false);
  });

  test('relink adopts only a verified legacy wrapper and marks the refreshed copy', () => {
    const fixture = makeFixture();
    const legacy = path.join(fixture.skills, 'gstack-qa');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), fs.readFileSync(path.join(fixture.install, 'qa', 'SKILL.md'))
      .toString().replace('name: qa', 'name: gstack-qa'));

    runRelink(fixture);

    expect(skillName(path.join(legacy, 'SKILL.md'))).toBe('gstack-qa');
    expect(fs.readFileSync(path.join(legacy, '.gstack-skill-projection'), 'utf-8').trim()).toBe('gstack-skill-projection-v1');
  });

  test('actual Codex setup projects prefix modes without mutating canonical .agents skills', () => {
    const fixture = copySetupFixture();
    const skills = path.join(fixture.codexHome, 'skills');
    runSetup(fixture, true);

    const sourceSkill = path.join(fixture.source, '.agents', 'skills', 'gstack-qa', 'SKILL.md');
    const sourceMetadata = path.join(fixture.source, '.agents', 'skills', 'gstack-qa', 'agents', 'openai.yaml');
    const canonicalHashes = [sha256(sourceSkill), sha256(sourceMetadata)];
    expect(skillName(path.join(skills, 'gstack-qa', 'SKILL.md'))).toBe('gstack-qa');
    expect(fs.readFileSync(path.join(skills, 'gstack-qa', 'agents', 'openai.yaml'), 'utf-8')).toContain('display_name: "gstack-qa"');
    expect(fs.readFileSync(path.join(skills, 'gstack-qa', 'agents', 'openai.yaml'), 'utf-8')).toContain('default_prompt: "Use gstack-qa for this task."');

    runSetup(fixture, false);
    expect(fs.existsSync(path.join(skills, 'gstack-qa'))).toBe(false);
    expect(skillName(path.join(skills, 'qa', 'SKILL.md'))).toBe('qa');
    expect(fs.readFileSync(path.join(skills, 'qa', 'agents', 'openai.yaml'), 'utf-8')).toContain('display_name: "qa"');
    expect(fs.readFileSync(path.join(skills, 'qa', 'agents', 'openai.yaml'), 'utf-8')).toContain('default_prompt: "Use qa for this task."');
    expect(fs.existsSync(path.join(skills, 'gstack-gstack-upgrade'))).toBe(false);
    expect(skillName(path.join(skills, 'gstack-upgrade', 'SKILL.md'))).toBe('gstack-upgrade');

    runSetup(fixture, true);
    expect(fs.existsSync(path.join(skills, 'qa'))).toBe(false);
    expect(skillName(path.join(skills, 'gstack-qa', 'SKILL.md'))).toBe('gstack-qa');
    expect([sha256(sourceSkill), sha256(sourceMetadata)]).toEqual(canonicalHashes);
    expect(fs.readFileSync(sourceSkill, 'utf-8')).toMatch(/^name: qa$/m);
    expect(fs.readFileSync(sourceMetadata, 'utf-8')).toContain('display_name: "gstack-qa"');
  }, 360_000);
});
