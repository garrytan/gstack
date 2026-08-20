/**
 * Unit tests for hermeticSkillsConfigDir() — the opt-in hermetic config dir
 * that registers the repo's shipped skills for PTY slash-command children.
 * Free tier — no API calls; exercises the real seeder against the live repo
 * tree (that's the seeder's contract: the skills ARE the subject under test).
 *
 * Pins four contracts:
 * 1. The seeded dir is a valid CLAUDE_CONFIG_DIR (.claude.json present,
 *    /.claude suffix, under the hermetic runRoot).
 * 2. Registration mirrors ./setup exactly: one entry per
 *    skillCensus().registryEntries, each a REAL dir with a SKILL.md symlink
 *    resolving to a real file (plus sections/ when the skill has one).
 * 3. connect-chrome (dir symlink) collapses into open-gstack-browser — no
 *    duplicate, no connect-chrome entry.
 * 4. Per-process idempotence: the second call returns the cached dir.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  hermeticSkillsConfigDir,
  getHermeticDirs,
  buildSeedConfig,
} from './helpers/hermetic-env';
import { skillCensus } from './helpers/skill-census';

const ROOT = path.resolve(__dirname, '..');
const configDir = hermeticSkillsConfigDir();
const skillsDir = path.join(configDir, 'skills');

describe('hermeticSkillsConfigDir', () => {
  test('seeded dir contains .claude.json and ends in /.claude under runRoot', () => {
    expect(fs.existsSync(path.join(configDir, '.claude.json'))).toBe(true);
    expect(path.basename(configDir)).toBe('.claude');
    expect(configDir.startsWith(getHermeticDirs().runRoot + path.sep)).toBe(true);
  });

  test('one registry entry per skillCensus registryEntries, nothing extra', () => {
    const seeded = fs.readdirSync(skillsDir).sort();
    expect(seeded).toEqual(skillCensus(ROOT).registryEntries);
  });

  test('every SKILL.md is a symlink resolving to a real file', () => {
    for (const entry of fs.readdirSync(skillsDir)) {
      const link = path.join(skillsDir, entry, 'SKILL.md');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.statSync(link).isFile()).toBe(true); // follows the link
    }
  });

  test('sections/ symlink registered for skills that ship one', () => {
    // ship/ is a carved skill with a sections/ dir — the registered entry
    // must expose it or runtime "Read sections/<name>.md" 404s.
    expect(fs.existsSync(path.join(ROOT, 'ship', 'sections'))).toBe(true);
    const link = path.join(skillsDir, 'ship', 'sections');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(link).isDirectory()).toBe(true);
  });

  test('connect-chrome collapses into a single open-gstack-browser entry', () => {
    const seeded = fs.readdirSync(skillsDir);
    expect(seeded.filter((n) => n === 'open-gstack-browser')).toHaveLength(1);
    expect(seeded).not.toContain('connect-chrome');
  });

  test('root router registered as _gstack-command pointing at the root SKILL.md', () => {
    const link = path.join(skillsDir, '_gstack-command', 'SKILL.md');
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(ROOT, 'SKILL.md')));
  });

  test('second call returns the cached dir', () => {
    expect(hermeticSkillsConfigDir()).toBe(configDir);
  });

  test('buildSeedConfig with undefined apiKey omits customApiKeyResponses', () => {
    // The seeder passes process.env keys straight through; when the operator
    // has no key exported the seed must stay valid (child fails auth later,
    // not here).
    const seed = buildSeedConfig({ apiKey: undefined, trustedDirs: [ROOT] });
    expect(seed).not.toHaveProperty('customApiKeyResponses');
    expect(seed.hasCompletedOnboarding).toBe(true);
  });
});
