import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const OPENCLAW_NATIVE_SKILLS = [
  'openclaw/skills/gstack-openclaw-investigate/SKILL.md',
  'openclaw/skills/gstack-openclaw-office-hours/SKILL.md',
  'openclaw/skills/gstack-openclaw-ceo-review/SKILL.md',
  'openclaw/skills/gstack-openclaw-retro/SKILL.md',
];

function extractFrontmatter(content: string): string {
  expect(content.startsWith('---\n')).toBe(true);
  const fmEnd = content.indexOf('\n---', 4);
  expect(fmEnd).toBeGreaterThan(0);
  return content.slice(4, fmEnd);
}

// Bun.YAML landed in bun 1.3; older local bun has no in-process strict YAML
// parser (the repo is deliberately zero-dep for YAML). CI pins
// `bun-version: latest`, so coverage is guaranteed there — on an old local
// bun we skip rather than false-fail.
const hasBunYaml = typeof (Bun as any).YAML?.parse === 'function';

describe('OpenClaw native skills', () => {
  test.skipIf(!hasBunYaml)('frontmatter parses as YAML and keeps only name + description', () => {
    for (const skill of OPENCLAW_NATIVE_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      const frontmatter = extractFrontmatter(content);
      const parsed = Bun.YAML.parse(frontmatter) as Record<string, unknown>;

      expect(Object.keys(parsed).sort()).toEqual(['description', 'name']);
      expect(typeof parsed.name).toBe('string');
      expect(typeof parsed.description).toBe('string');
      expect((parsed.name as string).length).toBeGreaterThan(0);
      expect((parsed.description as string).length).toBeGreaterThan(0);
    }
  });
});
