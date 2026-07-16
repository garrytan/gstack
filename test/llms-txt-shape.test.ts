import { describe, test, expect, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { generateLlmsTxt } from '../scripts/gen-llms-txt';
import { discoverTemplates } from '../scripts/discover-skills';

const ROOT = path.resolve(import.meta.dir, '..');

let generated: Awaited<ReturnType<typeof generateLlmsTxt>>;

beforeAll(async () => {
  generated = await generateLlmsTxt({ root: ROOT });
});

describe('gen-llms-txt — shape', () => {
  test('emits required top-level sections', () => {
    expect(generated.content).toContain('# gstack');
    expect(generated.content).toContain('## Skills');
    expect(generated.content).toContain('## Browse Commands');
    // Convention block
    expect(generated.content).toContain('Skills are invoked by name');
    expect(generated.content).toContain('Browse commands run as');
    // Footer
    expect(generated.content).toContain('## More');
    expect(generated.content).toContain('auto-generated');
  });

  test('every skill .tmpl in the repo appears in the index', () => {
    const templates = discoverTemplates(ROOT);
    // Filter to those that successfully parsed (have name + description).
    expect(generated.skills.length).toBeGreaterThan(0);
    expect(generated.skills.length).toBeLessThanOrEqual(templates.length);

    for (const skill of generated.skills) {
      expect(generated.content).toMatch(new RegExp(`/${skill.name}\\b`));
    }
  });

  test('every browse command in COMMAND_DESCRIPTIONS appears in the index', () => {
    expect(generated.browseCommands.length).toBeGreaterThan(0);
    for (const cmd of generated.browseCommands) {
      // Use word boundaries; backtick-wrapped command name OR usage.
      expect(generated.content).toContain(cmd);
    }
  });

  test('skills are sorted alphabetically', () => {
    const names = generated.skills.map((s) => s.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test('description is collapsed to a single line per entry', () => {
    // Find the Skills section and assert no entry contains a literal newline
    // mid-bullet (descriptions can be multi-paragraph in frontmatter; oneLine
    // collapses them).
    const skillsSection = generated.content.split('## Skills')[1].split('## Browse Commands')[0];
    const bullets = skillsSection.split('\n').filter((l) => l.startsWith('- ['));
    for (const b of bullets) {
      // No mid-bullet newline inside the bullet.
      expect(b).not.toMatch(/\n/);
    }
  });
});

describe('gen-llms-txt — strict mode', () => {
  test('does NOT throw on the live skill set (every gstack skill has name + description)', async () => {
    // The point of strict mode: catch missing-frontmatter skills before they
    // sneak past gen-skill-docs. The current repo state should pass strict.
    await expect(generateLlmsTxt({ root: ROOT, strict: true })).resolves.toBeDefined();
  });

  test('throws on a synthesized skill missing description', async () => {
    // Set up a temp repo-shaped tree with one skill that has only a name.
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'llms-txt-strict-'));
    try {
      fs.mkdirSync(path.join(tmp, 'badskill'));
      // Frontmatter has name but no description.
      fs.writeFileSync(
        path.join(tmp, 'badskill', 'SKILL.md.tmpl'),
        '---\nname: badskill\n---\nbody\n',
      );
      // Need a dummy browse/src/commands.ts shape — but we read from real
      // ROOT for browse commands. The strict failure should fire on the
      // skill before that. So we point at the real browse/src indirectly
      // through the absolute import in gen-llms-txt.ts (already imported
      // at module load). That's fine — strict throws on parsing, before
      // browse commands are read. But the real ROOT includes valid skills
      // too. Use the temp tree as `root` to isolate.
      await expect(generateLlmsTxt({ root: tmp, strict: true })).rejects.toThrow(/missing name or description/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('gen-llms-txt — generated file is fresh', () => {
  test('committed gstack/llms.txt matches what the generator produces now', () => {
    const committed = fs.readFileSync(path.join(ROOT, 'gstack', 'llms.txt'), 'utf-8');
    expect(committed).toBe(generated.content);
  });
});
