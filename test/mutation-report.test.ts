import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTROL_LINE, CONTROL_MESSAGE, STRYKER_PACKAGES, plantControl, rankChurn, renderMarkdown, summarize, type Mutant } from '../scripts/mutation-report';

const ROOT = path.resolve(import.meta.dir, '..');
const mutant = (status: string, line: number, replacement = 'false'): Mutant => ({ mutatorName: 'BooleanLiteral', replacement, status, location: { start: { line, column: 1 } } });

describe('mutation-report', () => {
  test('ranks existing non-test lib files by landings', () => {
    const log = ['lib/a.ts', 'lib/b.ts', '', 'lib/a.ts', 'lib/gone.ts', 'lib/gone.ts', 'lib/gone.ts', 'test/a.test.ts', 'lib/x.test.ts', 'lib/types.d.ts', 'bin/tool', 'lib/b.ts', 'lib/c.ts'].join('\n');
    expect(rankChurn(log, f => f !== 'lib/gone.ts', 2)).toEqual([{ file: 'lib/a.ts', commits: 2 }, { file: 'lib/b.ts', commits: 2 }]);
  });

  test('the positive control throws before the file body runs', () => {
    expect(plantControl('export const x = 1;\n')).toBe(CONTROL_LINE + 'export const x = 1;\n');
    expect(CONTROL_LINE).toBe(`throw new Error('${CONTROL_MESSAGE}');\n`);
  });

  test('scores killed and timed-out mutants against survivors and uncovered ones', () => {
    const s = summarize([mutant('Killed', 3), mutant('Timeout', 4), mutant('Survived', 9), mutant('Survived', 2), mutant('NoCoverage', 5), mutant('Ignored', 6)]);
    expect(s.counts).toEqual({ Killed: 1, Timeout: 1, Survived: 2, NoCoverage: 1, Ignored: 1 });
    expect(s.score).toBeCloseTo(2 / 5);
    expect(s.survivors.map(m => m.location.start.line)).toEqual([2, 9]);
    expect(summarize([mutant('Ignored', 1)]).score).toBeUndefined();
  });

  test('renders a table row per file and escapes mutant text', () => {
    const md = renderMarkdown([
      { file: 'lib/a.ts', commits: 7, tests: ['test/a.test.ts'], testsFound: 1, testSource: 'direct', outcome: 'scored', ...summarize([mutant('Killed', 1), mutant('Survived', 2, 'a | `b`')]), minutes: 3 },
      { file: 'lib/b.ts', commits: 5, tests: ['test/b.test.ts'], testsFound: 1, testSource: 'direct', outcome: 'control survived', detail: 'the selected tests did not fail on the planted throw' },
      { file: 'lib/c.ts', commits: 4, tests: Array.from({ length: 20 }, (_, i) => `test/c${i}.test.ts`), testsFound: 31, testSource: 'transitive', outcome: 'unfinished', detail: 'stopped at the 45-minute file budget', minutes: 46 },
    ], { sinceDays: 90, head: 'abcdef0123456789', packages: STRYKER_PACKAGES });
    expect(md).toContain('| `lib/a.ts` | 7 | 1 (direct) | scored | 1 | 1 | 0 | 0 | 50.0% | 3 |');
    expect(md).toContain('| `lib/b.ts` | 5 | 1 (direct) | control survived: the selected tests did not fail on the planted throw | - | - | - | - | - | - |');
    expect(md).toContain('| `lib/c.ts` | 4 | 20 of 31 (transitive) | unfinished: stopped at the 45-minute file budget | - | - | - | - | - | 46 |');
    expect(md).toContain('- line 2: BooleanLiteral → `a ? ?b?`');
  });

  test('pins Stryker and its runner to exact versions', () => {
    for (const p of STRYKER_PACKAGES) expect(p).toMatch(/^@[a-z-]+\/[a-z-]+@\d+\.\d+\.\d+$/);
  });

  test('refuses to run without --throwaway-checkout', () => {
    const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'scripts/mutation-report.ts'), '--stryker-dir', '/nonexistent', '--out-dir', '/nonexistent'], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--throwaway-checkout');
  });

  test('the workflow is scheduled, read-only and never runs on pull requests', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/mutation-report.yml'), 'utf-8');
    expect(wf).toMatch(/^on:\n  schedule:\n/m);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).not.toMatch(/pull_request|push:/);
    expect(wf).toMatch(/^permissions:\n  contents: read\n/m);
    expect(wf).toMatch(/persist-credentials[:] false/);
    expect(wf).toContain('--throwaway-checkout');
    expect(wf).not.toContain('secrets.');
  });
});
