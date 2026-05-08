/**
 * browser-skills E2E — exercise the full dispatch path against the bundled
 * `hackernews-frontpage` reference skill. Verifies:
 *
 *   - $B skill list resolves the bundled tier and surfaces hackernews-frontpage
 *   - $B skill show returns the SKILL.md
 *   - $B skill test runs script.test.ts (which itself runs against the bundled
 *     fixture) and reports pass
 *
 * Coverage gap intentionally NOT here: $B skill run end-to-end against the
 * bundled skill goes to live news.ycombinator.com and would be flaky. The
 * spawnSkill lifecycle (env scrub, scoped token, timeout, stdout cap) is
 * already covered by browse/test/browser-skill-commands.test.ts using inline
 * scripts.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { handleSkillCommand } from '../src/browser-skill-commands';
import { listBrowserSkills, defaultTierPaths } from '../src/browser-skills';
import { initRegistry, rotateRoot } from '../src/token-registry';

beforeAll(() => {
  // Some preceding tests may have rotated the registry; ensure we have a root.
  rotateRoot();
  initRegistry('e2e-root-token');
});

describe('browser-skills E2E — bundled hackernews-frontpage', () => {
  test('defaultTierPaths resolves bundled tier to <repo>/browser-skills/', () => {
    const tiers = defaultTierPaths();
    expect(tiers.bundled).toMatch(/\/browser-skills$/);
    // Bundled tier should exist on disk (the reference skill is shipped).
    expect(require('fs').existsSync(tiers.bundled)).toBe(true);
  });

  test('listBrowserSkills() returns hackernews-frontpage at bundled tier', () => {
    const skills = listBrowserSkills();
    const hn = skills.find(s => s.name === 'hackernews-frontpage');
    expect(hn).toBeTruthy();
    expect(hn!.tier).toBe('bundled');
    expect(hn!.frontmatter.host).toBe('news.ycombinator.com');
    expect(hn!.frontmatter.trusted).toBe(true);
    expect(hn!.frontmatter.triggers).toContain('scrape hn frontpage');
  });

  test('$B skill list dispatches and includes hackernews-frontpage', async () => {
    const result = await handleSkillCommand(['list'], { port: 0 });
    expect(result).toContain('hackernews-frontpage');
    expect(result).toContain('bundled');
    expect(result).toContain('news.ycombinator.com');
  });

  test('$B skill show hackernews-frontpage prints the SKILL.md', async () => {
    const result = await handleSkillCommand(['show', 'hackernews-frontpage'], { port: 0 });
    expect(result).toContain('host: news.ycombinator.com');
    expect(result).toContain('trusted: true');
    expect(result).toContain('Hacker News front-page scraper');
    expect(result).toContain('triggers:');
  });

  test('$B skill show <missing> errors clearly', async () => {
    await expect(handleSkillCommand(['show', 'nonexistent-skill-xyz'], { port: 0 }))
      .rejects.toThrow(/not found in any tier/);
  });

  test('$B skill help prints usage', async () => {
    const result = await handleSkillCommand([], { port: 0 });
    expect(result).toContain('Usage');
    expect(result).toContain('list');
    expect(result).toContain('show');
    expect(result).toContain('run');
  });

  test('$B skill rm cannot tombstone bundled tier (read-only)', async () => {
    // The bundled hackernews-frontpage skill is shipped read-only; rm targets
    // user tiers (project default, --global). Attempting rm on a name that
    // only exists in bundled should error with "not found".
    await expect(handleSkillCommand(['rm', 'hackernews-frontpage', '--global'], { port: 0 }))
      .rejects.toThrow(/not found/);
  });

  // The `test` subcommand spawns `bun test script.test.ts` in the skill dir.
  // It takes ~1s. Run it last so other assertions are quick.
  test('$B skill test hackernews-frontpage runs script.test.ts and reports pass', async () => {
    const result = await handleSkillCommand(['test', 'hackernews-frontpage'], { port: 0 });
    // bun test prints summary to stderr; handleSkillCommand returns stderr || stdout
    expect(result).toMatch(/13 pass|0 fail|tests passed/);
  }, 30_000);
});
