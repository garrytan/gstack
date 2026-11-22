/**
 * Fixture for the test value bar evals (test/skill-e2e-test-value.test.ts).
 *
 * A tiny Bun project. The feature branch adds three tests:
 *   - test/pricing-source.test.ts greps src/pricing.ts for a function name
 *     (low value: exact source grep, no declared contract);
 *   - test/pricing-reset.test.ts exists only to call _resetPriceCacheForTests,
 *     a test-only export with no production caller (low value);
 *   - test/skill-golden.test.ts compares generated SKILL.md bytes with a golden
 *     file (a generated-output contract the retention bar keeps).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoverageAuditFixture } from '../fixtures/coverage-audit-fixture';

export const LOW_VALUE_TESTS = {
  sourceGrep: 'test/pricing-source.test.ts',
  testOnlyExport: 'test/pricing-reset.test.ts',
  golden: 'test/skill-golden.test.ts',
  testOnlySymbol: '_resetPriceCacheForTests',
} as const;

function write(dir: string, relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  fs.writeFileSync(path.join(dir, relative), content);
}

function git(dir: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

export function createTestValueFixture(dir: string): void {
  write(dir, 'package.json', JSON.stringify({ name: 'pricing-app', version: '1.0.0', type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n');
  write(dir, 'src/pricing.ts', `const cache = new Map<string, number>();

export function applyDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new Error('Invalid discount');
  const key = \`\${price}:\${percent}\`;
  if (!cache.has(key)) cache.set(key, Math.round(price * (100 - percent)) / 100);
  return cache.get(key)!;
}
`);
  write(dir, 'src/checkout.ts', `import { applyDiscount } from './pricing';

export function total(prices: number[], percent: number): number {
  return prices.reduce((sum, price) => sum + applyDiscount(price, percent), 0);
}
`);
  write(dir, 'scripts/gen-skill.ts', `export function renderSkill(name: string): string {
  return \`# \${name}\\n\\nRun \\\`/\${name}\\\` to start.\\n\`;
}
`);
  write(dir, 'test/fixtures/golden/SKILL.md', '# pricing\n\nRun `/pricing` to start.\n');
  write(dir, 'test/pricing.test.ts', `import { test, expect } from 'bun:test';
import { applyDiscount } from '../src/pricing';
import { total } from '../src/checkout';

test('applies a discount and rejects an invalid percent', () => {
  expect(applyDiscount(100, 25)).toBe(75);
  expect(() => applyDiscount(100, 101)).toThrow('Invalid discount');
  expect(total([100, 50], 10)).toBe(135);
});
`);
  write(dir, 'CLAUDE.md', '# pricing-app\n\n## Testing\n\nRun `bun test`.\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial pricing app']);
  git(dir, ['checkout', '-q', '-b', 'feature/pricing-cache']);

  fs.appendFileSync(path.join(dir, 'src/pricing.ts'), `
export function ${LOW_VALUE_TESTS.testOnlySymbol}(): void {
  cache.clear();
}
`);
  write(dir, LOW_VALUE_TESTS.sourceGrep, `import { test, expect } from 'bun:test';
import * as fs from 'node:fs';

test('pricing module defines applyDiscount', () => {
  const source = fs.readFileSync(new URL('../src/pricing.ts', import.meta.url), 'utf8');
  expect(source).toContain('export function applyDiscount');
});
`);
  write(dir, LOW_VALUE_TESTS.testOnlyExport, `import { test, expect } from 'bun:test';
import { ${LOW_VALUE_TESTS.testOnlySymbol} } from '../src/pricing';

test('cache reset helper is callable', () => {
  expect(() => ${LOW_VALUE_TESTS.testOnlySymbol}()).not.toThrow();
});
`);
  write(dir, LOW_VALUE_TESTS.golden, `import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import { renderSkill } from '../scripts/gen-skill';

test('generated SKILL.md matches the golden bytes', () => {
  const golden = fs.readFileSync(new URL('./fixtures/golden/SKILL.md', import.meta.url), 'utf8');
  expect(renderSkill('pricing')).toBe(golden);
});
`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add pricing cache and tests']);
}

export function lastJsonLine(output: string): any {
  const lines = output.trim().split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.replace(/^`+|`+$/g, '');
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch {}
  }
  return undefined;
}

export function jsonFindings(output: string): any[] {
  return output.split('\n').map(line => line.trim()).filter(line => line.startsWith('{') && line.includes('"severity"')).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/**
 * A test-only-export finding records its non_test_callers count and how the
 * callers were searched. Any repository search counts (git grep, rg, grep -r,
 * the Grep tool); the specific command is not graded.
 */
export function recordsNonTestCallerSearch(finding: { evidence?: unknown }): boolean {
  const evidence = JSON.stringify(finding.evidence ?? '');
  return /non_test_callers/.test(evidence) && /\bgit grep\b|\brg\b|\bgrep\b|\bGrep\b|\bag\b|\back\b/.test(evidence);
}

const REFUND_SMOKE_TEST = `
import { refundPayment } from '../src/billing';
test('refundPayment does not throw', () => {
  expect(() => refundPayment('pay_1', 'duplicate')).not.toThrow();
});
`;

/** ship-coverage-value: the coverage-audit billing fixture plus a ★-only refundPayment smoke test. */
export function createShipCoverageValueFixture(dir: string): void {
  createCoverageAuditFixture(dir);
  fs.appendFileSync(path.join(dir, 'test/billing.test.ts'), REFUND_SMOKE_TEST);
}

/** The header of the innermost function or test/it/describe call whose braces span a `file:line` reference under cwd, or null. */
export function enclosingDeclaration(cwd: string, ref: unknown): string | null {
  const match = String(ref ?? '').match(/^(.+?):(\d+)(?:-\d+)?$/);
  if (!match || !fs.existsSync(path.resolve(cwd, match[1]!))) return null;
  const lines = fs.readFileSync(path.resolve(cwd, match[1]!), 'utf8').split('\n');
  const target = Number(match[2]) - 1;
  for (let start = Math.min(target, lines.length - 1); start >= 0; start--) {
    if (!/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*(?:test|it|describe)\s*\(/.test(lines[start]!)) continue;
    let depth = 0;
    for (let end = start; end < lines.length; end++) {
      depth += (lines[end]!.match(/\{/g) ?? []).length - (lines[end]!.match(/\}/g) ?? []).length;
      if (depth > 0) continue;
      if (target <= end) return lines[start]!.trim();
      break;
    }
  }
  return null;
}

/**
 * A weak_gaps row for symbol: named in the row, or a star_one row whose path:line
 * lies inside the symbol's function and whose existing_test:line lies inside a test
 * naming it. The Step 7 schema has no function-name field, so a file:line row counts.
 */
export function weakGapCovers(gap: any, cwd: string, symbol: RegExp): boolean {
  if (symbol.test(JSON.stringify(gap))) return true;
  return gap?.reason === 'star_one'
    && symbol.test(enclosingDeclaration(cwd, gap.path) ?? '')
    && symbol.test(enclosingDeclaration(cwd, gap.existing_test) ?? '');
}
