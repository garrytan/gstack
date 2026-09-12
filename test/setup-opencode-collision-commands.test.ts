/**
 * OpenCode builtin slash-command collisions (#2629).
 *
 * OpenCode 1.18.3 ships a builtin `/review` with `subtask: true`. gstack's
 * generated skill keeps frontmatter `name: review`, so OpenCode never
 * registers the skill as `/review`. setup must not overwrite that builtin
 * with `commands/review.md`; it writes a namespaced `gstack-review.md`
 * (`subtask: false`) so `/gstack-review` loads the skill by its short name.
 *
 * Non-colliding skills (qa, ship, ...) already become skill-sourced commands
 * without `subtask` — do not batch-generate command files for them.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

const GENERATED_BANNER = '<!-- AUTO-GENERATED from';

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: fixture ${name}\n---\n\n# ${name}\n`;
}

function installCollisionCommands(skills: Record<string, string>, extraCommandFiles: Record<string, string> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-oc-cmd-'));
  const skillsDir = path.join(tmp, 'skills');
  const commandsDir = path.join(tmp, 'commands');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const [dirName, frontmatterName] of Object.entries(skills)) {
    const d = path.join(skillsDir, dirName);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), skillMd(frontmatterName));
  }
  if (Object.keys(extraCommandFiles).length > 0) {
    fs.mkdirSync(commandsDir, { recursive: true });
    for (const [fileName, body] of Object.entries(extraCommandFiles)) {
      fs.writeFileSync(path.join(commandsDir, fileName), body);
    }
  }

  const script = [
    extractFn('install_opencode_collision_commands'),
    `install_opencode_collision_commands "${skillsDir}" "${commandsDir}"`,
  ].join('\n');
  const run = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 15000 });
  const files = fs.existsSync(commandsDir) ? fs.readdirSync(commandsDir).sort() : [];
  const read = (name: string) => {
    const p = path.join(commandsDir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  };
  return { tmp, commandsDir, run, files, read };
}

function assertGeneratedCommand(body: string, skillName: string) {
  expect(body).toMatch(/^---\n/);
  expect(body).toContain('subtask: false');
  expect(body).not.toMatch(/agent:\s*plan/);
  expect(body).toContain('skill');
  expect(body).toContain(`"${skillName}"`);
  expect(body).toContain('preamble');
  const fmEnd = body.indexOf('\n---\n', 4);
  expect(fmEnd).toBeGreaterThan(0);
  const bannerAt = body.indexOf(GENERATED_BANNER);
  expect(bannerAt).toBeGreaterThan(fmEnd);
}

describe('setup: OpenCode collision commands — static (#2629)', () => {
  test('OpenCode install invokes the collision-command installer after linking skills', () => {
    const start = SETUP_SRC.indexOf('# 6c. Install for OpenCode');
    const end = SETUP_SRC.indexOf('# 6d. Install for Cursor', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = SETUP_SRC.slice(start, end);
    expect(block).toContain('link_opencode_skill_dirs');
    expect(block).toContain('install_opencode_collision_commands "$OPENCODE_SKILLS" "$OPENCODE_COMMANDS"');
    const linkAt = block.indexOf('link_opencode_skill_dirs');
    const installAt = block.indexOf('install_opencode_collision_commands');
    expect(installAt).toBeGreaterThan(linkAt);
    expect(block).toContain('/gstack-review');
    expect(block).toContain('/review is OpenCode');
  });

  test('collision installer writes only namespaced gstack-<name>.md files', () => {
    const fn = extractFn('install_opencode_collision_commands');
    expect(fn).toContain('"$commands_dir/gstack-${name}.md"');
    expect(fn).not.toMatch(/\$commands_dir\/(?:review|init)\.md/);
    expect(fn).not.toMatch(/review\|init/);
    expect(fn).toContain(GENERATED_BANNER);
    expect(fn).toContain('left in place (existing dir not gstack-managed — no generated banner)');
  });

  test('OPENCODE_COMMANDS is the canonical ~/.config/opencode/commands path', () => {
    const line = SETUP_SRC.split('\n').find((l) => l.startsWith('OPENCODE_COMMANDS='));
    expect(line).toBe('OPENCODE_COMMANDS="$HOME/.config/opencode/commands"');
  });

  test('README documents the OpenCode command install path and manual uninstall', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
    expect(readme).toContain('~/.config/opencode/commands/gstack-review.md');
    expect(readme).toContain('rm -f ~/.config/opencode/commands/gstack-review.md');
  });
});

describe.skipIf(process.platform === 'win32')('setup: OpenCode collision commands — behavior (#2629)', () => {
  test('writes namespaced gstack-review.md with subtask: false; leaves builtins and qa alone', () => {
    const { tmp, run, files, read } = installCollisionCommands({
      'gstack-review': 'review',
      'gstack-qa': 'qa',
    }, { 'review.md': 'USER-OWNED-REVIEW\n' });
    try {
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(files).toEqual(['gstack-review.md', 'review.md']);
      expect(read('review.md')).toBe('USER-OWNED-REVIEW\n');
      expect(read('init.md')).toBeNull();
      expect(read('gstack-init.md')).toBeNull();
      expect(read('gstack-qa.md')).toBeNull();
      expect(read('qa.md')).toBeNull();
      assertGeneratedCommand(read('gstack-review.md')!, 'review');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does not mkdir commands/ when no colliding skills are installed', () => {
    const { tmp, commandsDir, run, files } = installCollisionCommands({
      'gstack-qa': 'qa',
    });
    try {
      expect(run.status).toBe(0);
      expect(files).toEqual([]);
      expect(fs.existsSync(commandsDir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('leaves a user-owned gstack-review.md without the generated banner in place', () => {
    const { tmp, run, read } = installCollisionCommands({
      'gstack-review': 'review',
    }, { 'gstack-review.md': '# my own command\n' });
    try {
      expect(run.status).toBe(0);
      expect(read('gstack-review.md')).toBe('# my own command\n');
      expect(run.stderr).toContain('left in place (existing dir not gstack-managed — no generated banner)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refreshes a bannered gstack-review.md on re-run', () => {
    const stale = [
      '---',
      'description: stale',
      'subtask: false',
      '---',
      '',
      `${GENERATED_BANNER} setup — do not edit directly -->`,
      'stale body',
      '',
    ].join('\n');
    const { tmp, run, read } = installCollisionCommands({
      'gstack-review': 'review',
    }, { 'gstack-review.md': stale });
    try {
      expect(run.status).toBe(0);
      const body = read('gstack-review.md')!;
      expect(body).not.toContain('stale body');
      assertGeneratedCommand(body, 'review');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('wires OPENCODE_COMMANDS through a temporary HOME to the canonical commands path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-oc-home-'));
    const home = path.join(tmp, 'home');
    const canonical = path.join(home, '.config', 'opencode', 'commands');
    try {
      const ocSkills = SETUP_SRC.split('\n').find((l) => l.startsWith('OPENCODE_SKILLS='));
      const ocCommands = SETUP_SRC.split('\n').find((l) => l.startsWith('OPENCODE_COMMANDS='));
      if (!ocSkills || !ocCommands) throw new Error('Could not locate OPENCODE_* assignments in setup');

      const script = [
        `HOME="${home}"`,
        ocSkills,
        ocCommands,
        extractFn('install_opencode_collision_commands'),
        'mkdir -p "$OPENCODE_SKILLS/gstack-review"',
        `cat > "$OPENCODE_SKILLS/gstack-review/SKILL.md" <<'SKILL'\n${skillMd('review')}SKILL`,
        'install_opencode_collision_commands "$OPENCODE_SKILLS" "$OPENCODE_COMMANDS"',
      ].join('\n');
      const run = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 15000 });
      expect(run.status).toBe(0);
      expect(fs.existsSync(path.join(canonical, 'gstack-review.md'))).toBe(true);
      expect(fs.existsSync(path.join(canonical, 'review.md'))).toBe(false);
      expect(fs.existsSync(path.join(canonical, 'init.md'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.config', 'opencode', 'NOT-A-REAL-DIR'))).toBe(false);
      assertGeneratedCommand(fs.readFileSync(path.join(canonical, 'gstack-review.md'), 'utf-8'), 'review');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
