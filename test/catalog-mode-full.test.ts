/** Catalog mode is a CLI contract: default/explicit trim and both full flag
 * forms must produce the intended frontmatter, with no worktree writes. */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SHIP_SKILL = path.join(ROOT, 'ship', 'SKILL.md');

function render(args: string[]) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-catalog-mode-'));
  const before = fs.readFileSync(SHIP_SKILL, 'utf-8');
  try {
    const result = spawnSync('bun', ['run', 'gen:skill-docs', ...args, '--out-dir', outDir], {
      cwd: ROOT, encoding: 'utf-8', timeout: 60_000,
    });
    const output = path.join(outDir, 'ship', 'SKILL.md');
    const content = fs.existsSync(output) ? fs.readFileSync(output, 'utf-8') : '';
    expect(fs.readFileSync(SHIP_SKILL, 'utf-8')).toBe(before);
    return { status: result.status, stderr: result.stderr, content, files: fs.readdirSync(outDir) };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function frontmatter(content: string): string {
  return content.slice(0, content.indexOf('\n---', 4));
}

describe('catalog mode CLI behavior', () => {
  let defaultContent: string;
  beforeAll(() => {
    const result = render([]);
    expect(result.status, result.stderr).toBe(0);
    defaultContent = result.content;
  });

  test('omitting the flag defaults to trim', () => {
    expect(frontmatter(defaultContent)).toMatch(/^description: "?Ship workflow:[^\n]*\(gstack\)"?$/m);
    expect(frontmatter(defaultContent)).not.toMatch(/Use when asked to/i);
    expect(defaultContent).toContain('## When to invoke this skill');
  });

  for (const form of ['equals', 'separate'] as const) {
    const args = (value: string) => form === 'equals' ? [`--catalog-mode=${value}`] : ['--catalog-mode', value];

    test(`${form} flag form accepts full and preserves routing prose in frontmatter`, () => {
      const result = render(args('full'));
      expect(result.status, result.stderr).toBe(0);
      const fm = frontmatter(result.content);
      expect(fm).toMatch(/^description: \|\s*$/m);
      expect(fm).toMatch(/Use when asked to/i);
      expect(fm).not.toBe(frontmatter(defaultContent));
      expect(result.content.slice(fm.length)).not.toContain('## When to invoke this skill');
    });

    test(`${form} flag form accepts explicit trim and matches the default catalog`, () => {
      const result = render(args('trim'));
      expect(result.status, result.stderr).toBe(0);
      expect(frontmatter(result.content)).toBe(frontmatter(defaultContent));
      expect(result.content).toContain('## When to invoke this skill');
    });

    test(`${form} flag form rejects invalid modes before writing output`, () => {
      const result = render(args('invalid'));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown catalog mode: invalid');
      expect(result.files).toEqual([]);
    });
  }
});
