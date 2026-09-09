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
 *    resolving to a real file (plus sections/ when the skill has one), and the
 *    same canonical gstack runtime checkout used by lazy-section paths.
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

  test('exact skill registry plus the canonical runtime checkout', () => {
    const seeded = fs.readdirSync(skillsDir).sort();
    expect(seeded).toEqual([...skillCensus(ROOT).registryEntries, 'gstack'].sort());
    const runtime = path.join(skillsDir, 'gstack');
    expect(fs.lstatSync(runtime).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(runtime)).toBe(fs.realpathSync(ROOT));
    expect(fs.readFileSync(path.join(runtime, 'plan-design-review/sections/review-sections.md'), 'utf8'))
      .toBe(fs.readFileSync(path.join(ROOT, 'plan-design-review/sections/review-sections.md'), 'utf8'));
  });

  test('every SKILL.md is a symlink resolving to a real file', () => {
    for (const entry of skillCensus(ROOT).registryEntries) {
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

  test('all installed runtime assets are discoverable beside the skill', () => {
    // Match setup's runtime exclusion contract, rather than whitelisting
    // sections: DevEx also reads dx-hall-of-fame.md, review reads checklists,
    // and other skills ship templates and executable helpers.
    for (const rel of skillCensus(ROOT).physicalSkillFiles) {
      if (rel === 'SKILL.md') continue;
      const source = path.dirname(path.join(ROOT, rel));
      const registry = fs.readdirSync(skillsDir).find(name =>
        fs.realpathSync(path.join(skillsDir, name, 'SKILL.md')) === fs.realpathSync(path.join(ROOT, rel)));
      expect(registry, rel).toBeDefined();
      const assets = fs.readdirSync(source).filter(name =>
        !name.startsWith('.') && !['SKILL.md', 'node_modules', 'dist', 'test'].includes(name) &&
        !name.endsWith('.tmpl') && fs.existsSync(path.join(source, name)));
      expect(fs.readdirSync(path.join(skillsDir, registry!)).sort()).toEqual(['SKILL.md', ...assets].sort());
      for (const asset of assets) {
        expect(fs.realpathSync(path.join(skillsDir, registry!, asset))).toBe(fs.realpathSync(path.join(source, asset)));
      }
    }
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
