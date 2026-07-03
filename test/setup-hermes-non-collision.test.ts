import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

describe('setup: Hermes non-collision with existing files', () => {
  test('setup does not contain rm -rf of HERMES_GSTACK when it is a real directory', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

    // The bug was: the elif branch did `rm -rf "$HERMES_GSTACK"` on every real
    // directory that wasn't the gen dir. The fix removes that branch so only
    // symlinked roots are unlinked.
    const hermesBlock = content.indexOf('Install for Hermes Agent');
    expect(hermesBlock).toBeGreaterThan(-1);

    const nextBlock = content.indexOf('# 7.', hermesBlock);
    const block = content.slice(hermesBlock, nextBlock);

    // After the fix there must NOT be a path that deletes the whole Hermes
    // runtime root when it is a real directory.
    expect(block).not.toContain('rm -rf "$HERMES_GSTACK"');
  });

  test('behavioral: existing real files in ~/.hermes/skills/gstack survive setup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hermes-collision-'));
    try {
      // Reconstruct the runtime-root creation logic from setup, exercising the
      // fixed branch that preserves a real directory.
      const hermesGstack = path.join(tmp, 'gstack');
      const hermesGenDir = path.join(tmp, 'gen', 'skills');

      fs.mkdirSync(hermesGstack, { recursive: true });
      fs.mkdirSync(hermesGenDir, { recursive: true });

      // User-created pre-existing content
      fs.writeFileSync(path.join(hermesGstack, 'README.txt'), 'user file\n');
      fs.writeFileSync(path.join(hermesGstack, 'preserved.md'), 'keep me\n');
      fs.mkdirSync(path.join(hermesGstack, 'my-custom-skill'));
      fs.writeFileSync(
        path.join(hermesGstack, 'my-custom-skill', 'SKILL.md'),
        '# custom\n'
      );

      // Inline the fixed guard from setup
      const script = `
        HERMES_GSTACK='${hermesGstack}'
        HERMES_GEN_DIR='${hermesGenDir}'

        if [ -L "$HERMES_GSTACK" ]; then
          rm -f "$HERMES_GSTACK"
        fi
        mkdir -p "$HERMES_GSTACK" "$HERMES_GSTACK/browse" "$HERMES_GSTACK/review"
      `;

      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.status).toBe(0);

      // All pre-existing files must survive
      expect(fs.existsSync(path.join(hermesGstack, 'README.txt'))).toBe(true);
      expect(fs.existsSync(path.join(hermesGstack, 'preserved.md'))).toBe(true);
      expect(fs.existsSync(path.join(hermesGstack, 'my-custom-skill'))).toBe(true);
      expect(
        fs.readFileSync(path.join(hermesGstack, 'my-custom-skill', 'SKILL.md'), 'utf-8')
      ).toBe('# custom\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('setup: Hermes generated skill linking', () => {
  test('setup loop uses $_skill_name consistently for the target path', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

    const start = content.indexOf('Link each generated Hermes skill');
    expect(start).toBeGreaterThan(-1);

    const end = content.indexOf('# 7.', start);
    const block = content.slice(start, end);

    // The original bug used an undefined bare $skill_name here, causing every
    // generated child skill to be skipped silently.
    expect(block).toContain('_target="$HERMES_SKILLS/$_skill_name"');
    expect(block).not.toContain('_target="$HERMES_SKILLS/$skill_name"');
  });

  test('behavioral: all generated gstack-* skills are linked into HERMES_SKILLS', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hermes-linking-'));
    try {
      const hermesSkills = path.join(tmp, 'skills');
      const hermesGenDir = path.join(tmp, 'gen', 'skills');

      // Simulate generated Hermes skill docs
      for (const skill of ['gstack', 'gstack-browse', 'gstack-qa']) {
        const dir = path.join(hermesGenDir, skill);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skill}\n`);
      }

      // Inline the sub-skill loop from setup, exercising the variable-name
      // fix so that $_skill_name is used consistently.
      const script = `
        set -e
        mkdir -p "$HERMES_SKILLS"

        _linked=()
        for skill_dir in "$HERMES_GEN_DIR"/gstack*/; do
          if [ -f "$skill_dir/SKILL.md" ]; then
            _skill_name="\$(basename "$skill_dir")"
            [ "$_skill_name" = "gstack" ] && continue
            _target="$HERMES_SKILLS/$_skill_name"
            if [ -d "$_target" ] && [ ! -L "$_target" ]; then
              continue
            fi
            if [ -L "$_target" ]; then
              rm -f "$_target"
            fi
            ln -snf "$skill_dir" "$_target"
            _linked+=("$_skill_name")
          fi
        done

        if [ \${#_linked[@]} -gt 0 ]; then
          echo "linked skills: \${_linked[*]}"
        fi
      `;

      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          ...process.env,
          HERMES_SKILLS: hermesSkills,
          HERMES_GEN_DIR: hermesGenDir,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('gstack-browse');
      expect(result.stdout).toContain('gstack-qa');

      // Each generated child skill should appear under HERMES_SKILLS
      expect(fs.existsSync(path.join(hermesSkills, 'gstack-browse', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(hermesSkills, 'gstack-qa', 'SKILL.md'))).toBe(true);

      // The root gstack skill is handled separately and should be skipped here
      if (fs.existsSync(path.join(hermesSkills, 'gstack'))) {
        expect(fs.lstatSync(path.join(hermesSkills, 'gstack')).isSymbolicLink()).toBe(false);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
