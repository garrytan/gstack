import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2287 (@tomfluff): xterm sizes its cell from the first font that resolves.
// On Windows none of the Mac/Linux monospace fonts exist, so Malgun Gothic won
// and every Latin glyph sat in a double-wide cell. Consolas ships with every
// Windows install and must come before the CJK fallbacks in both stacks.
const ROOT = path.resolve(import.meta.dir, '..');
const stacks = {
  'extension/sidepanel-terminal.js': fs.readFileSync(path.join(ROOT, 'extension/sidepanel-terminal.js'), 'utf8').match(/fontFamily:\s*'([^']+)'/)?.[1],
  'extension/sidepanel.css': fs.readFileSync(path.join(ROOT, 'extension/sidepanel.css'), 'utf8').match(/--font-mono:\s*([^;]+);/)?.[1],
};

describe('sidebar mono font stacks put a Windows Latin monospace before the CJK fallbacks (#2287)', () => {
  for (const [file, stack] of Object.entries(stacks)) {
    test(file, () => {
      expect(stack).toBeDefined();
      const fonts = stack!.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, ''));
      const consolas = fonts.indexOf('Consolas');
      expect(consolas).toBeGreaterThanOrEqual(0);
      for (const cjk of ['Noto Sans Mono CJK KR', 'Malgun Gothic']) expect(fonts.indexOf(cjk)).toBeGreaterThan(consolas);
      expect(fonts.at(-1)).toBe('monospace');
    });
  }
});
