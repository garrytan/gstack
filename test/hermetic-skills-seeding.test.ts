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
import * as os from 'os';
import {
  hermeticSkillsConfigDir,
  getHermeticDirs,
  buildSeedConfig,
  seedHermeticRuntimeView,
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

  test('exact skill registry plus the canonical runtime view', () => {
    const seeded = fs.readdirSync(skillsDir).sort();
    expect(seeded).toEqual([...skillCensus(ROOT).registryEntries, 'gstack'].sort());
    const runtime = path.join(skillsDir, 'gstack');
    expect(fs.lstatSync(runtime).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(runtime, 'plan-design-review/sections/review-sections.md'), 'utf8'))
      .toBe(fs.readFileSync(path.join(ROOT, 'plan-design-review/sections/review-sections.md'), 'utf8'));
    for (const rel of ['bin/gstack-config', 'lib/claude-bin.ts', 'SKILL.md', 'ETHOS.md', 'extension/manifest.json',
      'browser-skills/hackernews-frontpage/script.ts', 'browser-skills/hackernews-frontpage/script.test.ts',
      'docs/askuserquestion-split.md', 'docs/askuserquestion-cjk.md',
      'docs/designs/PLAN_TUNING_V0.md', 'docs/designs/PLAN_TUNING_V1.md'])
      expect(fs.realpathSync(path.join(runtime, rel))).toBe(fs.realpathSync(path.join(ROOT, rel)));
    expect(fs.readdirSync(path.join(runtime, 'docs')).sort()).toEqual(['askuserquestion-cjk.md', 'askuserquestion-split.md', 'designs']);
    expect(fs.readdirSync(path.join(runtime, 'docs/designs')).sort()).toEqual(['PLAN_TUNING_V0.md', 'PLAN_TUNING_V1.md']);
    for (const rel of ['.context', '.git', 'node_modules', '.agents', 'hosts', 'test'])
      expect(fs.existsSync(path.join(runtime, rel)), rel).toBe(false);
  });

  test('recursive installed discovery cannot read historical or dependency markdown', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-view-'));
    const source = path.join(fixture, 'source');
    const view = path.join(fixture, 'view');
    const files = {
      'SKILL.md': '---\nname: router\n---\nCurrent router',
      'review/SKILL.md': '---\nname: review\n---\nCurrent review',
      'review/sections/method.md': 'CURRENT METHOD',
      'review/references/example.md': 'CURRENT REFERENCE',
      'bin/tool': '#!/bin/sh\nexit 0\n',
      'lib/helper.ts': 'export const current = true;',
      'browse/dist/browse': 'CURRENT BUILT RUNTIME',
      '.context/old-review.md': 'HISTORICAL SENTINEL',
      '.git/history.md': 'GIT SENTINEL',
      'node_modules/pkg/README.md': 'DEPENDENCY SENTINEL',
      '.agents/skills/review/SKILL.md': 'GENERATED HOST SENTINEL',
      'hosts/review.md': 'HOST SOURCE SENTINEL',
      'review/sections/node_modules/pkg/README.md': 'NESTED DEPENDENCY SENTINEL',
      'review/test/fixture.md': 'TEST SENTINEL',
      'review/sections/method.md.tmpl': 'TEMPLATE SENTINEL',
    };
    try {
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
        fs.writeFileSync(path.join(source, rel), content, { mode: 0o755 });
      }
      fs.symlinkSync(path.join(source, 'review'), path.join(source, 'review-alias'), 'dir');
      seedHermeticRuntimeView(source, view);
      const markdown: string[] = [];
      const scan = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          if (fs.statSync(file).isDirectory()) {
            expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
            scan(file);
          } else {
            expect(fs.realpathSync(file)).toBe(fs.realpathSync(path.join(source, path.relative(view, file))));
            if (name.endsWith('.md')) markdown.push(fs.readFileSync(file, 'utf8'));
          }
        }
      };
      scan(view);
      expect(markdown).toContain('CURRENT METHOD');
      expect(markdown).toContain('CURRENT REFERENCE');
      expect(markdown.some(content => content.includes('SENTINEL'))).toBe(false);
      expect(fs.readFileSync(path.join(view, 'browse/dist/browse'), 'utf8')).toBe('CURRENT BUILT RUNTIME');
      expect(fs.statSync(path.join(view, 'bin/tool')).mode & 0o111).toBe(0o111);
      expect(fs.existsSync(path.join(view, 'review/sections/method.md.tmpl'))).toBe(false);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  test('rejects escaped or circular assets and removes only its partial view', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-view-owned-'));
    try {
      const source = path.join(fixture, 'source');
      fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
      const external = path.join(fixture, 'outside.md');
      fs.writeFileSync(external, 'OUTSIDE');
      fs.symlinkSync(external, path.join(source, 'bin/escape.md'));
      const view = path.join(fixture, 'view');
      expect(() => seedHermeticRuntimeView(source, view)).toThrow('owned checkout');
      expect(fs.existsSync(view)).toBe(false);
      expect(fs.readFileSync(external, 'utf8')).toBe('OUTSIDE');
      fs.unlinkSync(path.join(source, 'bin/escape.md'));
      fs.symlinkSync(source, path.join(source, 'bin/cycle'), 'dir');
      expect(() => seedHermeticRuntimeView(source, view)).toThrow('Circular');
      expect(fs.existsSync(view)).toBe(false);
      fs.mkdirSync(view); fs.writeFileSync(path.join(view, 'owner.md'), 'OWNED ELSEWHERE');
      expect(() => seedHermeticRuntimeView(source, view)).toThrow();
      expect(fs.readFileSync(path.join(view, 'owner.md'), 'utf8')).toBe('OWNED ELSEWHERE');
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  test('ordinary aliases cannot reopen excluded directories or files', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-view-alias-'));
    const source = path.join(fixture, 'source');
    const view = path.join(fixture, 'view');
    try {
      fs.mkdirSync(path.join(source, 'review/sections'), { recursive: true });
      fs.writeFileSync(path.join(source, 'review/SKILL.md'), '---\nname: review\n---\nCURRENT');
      for (const forbidden of ['.context', 'node_modules', 'test', '.agents/skills', 'hosts', 'docs/history']) {
        const hidden = path.join(source, forbidden);
        fs.mkdirSync(hidden, { recursive: true });
        fs.writeFileSync(path.join(hidden, 'sentinel.md'), 'FORBIDDEN HISTORY');
        for (const directory of [true, false]) {
          const alias = path.join(source, 'review/sections', directory ? 'archive' : 'ordinary.md');
          fs.symlinkSync(directory ? hidden : path.join(hidden, 'sentinel.md'), alias, directory ? 'dir' : 'file');
          expect(() => seedHermeticRuntimeView(source, view)).toThrow('excluded tree');
          expect(fs.existsSync(view)).toBe(false);
          expect(fs.readFileSync(path.join(hidden, 'sentinel.md'), 'utf8')).toBe('FORBIDDEN HISTORY');
          fs.unlinkSync(alias);
        }
      }
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
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
