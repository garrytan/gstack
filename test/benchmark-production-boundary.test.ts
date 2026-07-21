import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PRODUCTION_ROOTS = [path.join(ROOT, 'bin'), path.join(ROOT, 'lib')];
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const TEST_SEGMENT = /(?:^|\/)tests?(?:\/|$)/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    if (dir === path.join(ROOT, 'bin') || /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

test('production modules do not import from test directories', () => {
  const violations: string[] = [];

  for (const file of PRODUCTION_ROOTS.flatMap(sourceFiles)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1].replaceAll('\\', '/');
      if (TEST_SEGMENT.test(specifier)) {
        violations.push(`${path.relative(ROOT, file)} -> ${match[1]}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

test('former test-helper paths re-export the production benchmark API', async () => {
  const [
    pricing,
    helperPricing,
    claude,
    helperClaude,
    gpt,
    helperGpt,
    gemini,
    helperGemini,
  ] = await Promise.all([
    import('../lib/model-benchmark/pricing'),
    import('./helpers/pricing'),
    import('../lib/model-benchmark/providers/claude'),
    import('./helpers/providers/claude'),
    import('../lib/model-benchmark/providers/gpt'),
    import('./helpers/providers/gpt'),
    import('../lib/model-benchmark/providers/gemini'),
    import('./helpers/providers/gemini'),
  ]);

  expect(helperPricing.estimateCostUsd).toBe(pricing.estimateCostUsd);
  expect(helperClaude.ClaudeAdapter).toBe(claude.ClaudeAdapter);
  expect(helperGpt.GptAdapter).toBe(gpt.GptAdapter);
  expect(helperGemini.GeminiAdapter).toBe(gemini.GeminiAdapter);
});
