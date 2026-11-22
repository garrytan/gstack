import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { consumersOf } from '../lib/pregate/checks/literals';

const nl = String.fromCharCode(10);
function fixture(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  return root;
}
const tests = (files: Record<string, string>) => Object.keys(files).filter(f => f.startsWith('test/'));

describe('literals: consumers by resolved reference (GBRA-739)', () => {
  // Value: protects=when another repo file shares the changed module's file name, a test counts as its consumer only through a
  //   reference that resolves to it (a relative import, a tsconfig paths alias, a quoted repo path), so tests importing the other
  //   config.ts are not flagged while the real consumer is; fails_when=a path fragment such as `/config'` makes a file a consumer
  //   again (gbrain#10078: DEFAULT_SESSION_TOKEN_BUDGET 2000 -> 8000 in src/core/skills/resolver/config.ts flagged 17 tests of
  //   src/core/config.ts); why_new=fixtures never held a second file with the module's name; seam=none; no_claim=a module name
  //   unique in the repo keeps the fragment rule (previous tests)
  test('a test importing a same-named module elsewhere is not a consumer; one importing the changed file still is', () => {
    const files: Record<string, string> = {
      'src/core/config.ts': "export const LOCK_WAIT_MS = 2000;" + nl,
      'src/core/skills/resolver/config.ts': "export const DEFAULT_SESSION_TOKEN_BUDGET = 8000;" + nl,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'test/config.test.ts': ["import { loadConfig } from '../src/core/config';", "expect(loadConfig({ since: '2000-01-01' }).lockWaitMs).toBe(2000);", ''].join(nl),
      'test/retry-after.test.ts': ["import { parseRetryAfterMs } from '../src/core/config.ts';", "expect(parseRetryAfterMs('2')).toBe(2000);", ''].join(nl),
      'test/alias-other.test.ts': ["import { loadConfig } from '@/core/config';", 'expect(loadConfig().lockWaitMs).toBe(2000);', ''].join(nl),
      'test/budget.test.ts': ["import { sessionBudget } from '../src/core/skills/resolver/config';", 'expect(sessionBudget()).toBe(2000);', ''].join(nl),
      'test/alias-budget.test.ts': ["import { sessionBudget } from '@/core/skills/resolver/config';", 'expect(sessionBudget()).toBe(2000);', ''].join(nl),
      'test/named.test.ts': ['expect(DEFAULT_SESSION_TOKEN_BUDGET).toBe(2000);', ''].join(nl),
    };
    const root = fixture('gstack-literals-twin-', files);
    const change = { name: 'DEFAULT_SESSION_TOKEN_BUDGET', old: '2000', new: '8000', file: 'src/core/skills/resolver/config.ts' };
    expect(consumersOf(root, tests(files), change, undefined, undefined, Object.keys(files))).toEqual(['test/budget.test.ts:2', 'test/alias-budget.test.ts:2', 'test/named.test.ts:1']);
    const unique = ['tsconfig.json', 'src/core/skills/resolver/config.ts', 'src/core/config/README.md', 'test/alias-budget.test.ts', 'test/config.test.ts'];
    expect(consumersOf(root, ['test/alias-budget.test.ts', 'test/config.test.ts'], change, undefined, undefined, unique)).toEqual(['test/alias-budget.test.ts:2', 'test/config.test.ts:2']);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#budget': ['src/core/skills/resolver/config.ts'] } } }));
    fs.writeFileSync(path.join(root, 'test/exact-alias.test.ts'), ["import { sessionBudget } from '#budget';", 'expect(sessionBudget()).toBe(2000);', ''].join(nl));
    expect(consumersOf(root, ['test/exact-alias.test.ts'], change, undefined, undefined, [...unique, 'test/exact-alias.test.ts'])).toEqual(['test/exact-alias.test.ts:2']);
    expect(consumersOf(root, ['test/exact-alias.test.ts'], change)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Value: protects=a JSON file cannot carry a pregate-literal marker, so an old value in it counts only where JSON ties it to the
  //   constant: the value of a key named after the constant, or a record whose string value is the constant's name; fails_when=an
  //   unrelated equal value in a golden is reported again (gbrain#10078: "2000" for LONG_PAGE_DEADLINE_MS in an exports golden),
  //   or a golden that pins the changed constant stops being reported; why_new=JSON hits were unwaivable; seam=none; no_claim=JSON
  //   that pins a derived value under another key
  test('a JSON golden counts only where it ties the old value to the changed constant', () => {
    const record = (name: string, value: string) => ['    {', '      "kind": "variable",', `      "name": "${name}",`, '      "signature": [', `        "${value}"`, '      ]', '    }'];
    const files: Record<string, string> = {
      'test/fixtures/goldens/unrelated.json': ['{', '  "src/core/skills/resolver/config.ts": [', ...record('LONG_PAGE_DEADLINE_MS', '2000'), '  ]', '}', ''].join(nl),
      'test/fixtures/goldens/pinned.json': ['{', '  "src/core/skills/resolver/config.ts": [', ...record('LONG_PAGE_DEADLINE_MS', '2000') .map((l, i) => i === 6 ? l + ',' : l), ...record('DEFAULT_SESSION_TOKEN_BUDGET', '2000'), '  ]', '}', ''].join(nl),
      'test/fixtures/goldens/keyed.json': JSON.stringify({ other: 2000, DEFAULT_SESSION_TOKEN_BUDGET: 2000 }, null, 2) + nl,
      'test/fixtures/goldens/sibling.json': JSON.stringify({ DEFAULT_SESSION_TOKEN_BUDGET: 8000, LONG_PAGE_DEADLINE_MS: 2000 }, null, 2) + nl,
    };
    const root = fixture('gstack-literals-json-', files);
    const change = { name: 'DEFAULT_SESSION_TOKEN_BUDGET', old: '2000', new: '8000', file: 'src/core/skills/resolver/config.ts' };
    expect(consumersOf(root, Object.keys(files), change)).toEqual(['test/fixtures/goldens/pinned.json:14', 'test/fixtures/goldens/keyed.json:3']);
    fs.writeFileSync(path.join(root, 'test/fixtures/goldens/broken.json'), ['{', '  "LONG_PAGE_DEADLINE_MS": 2000,', '  "DEFAULT_SESSION_TOKEN_BUDGET": 2000,', ''].join(nl));
    expect(consumersOf(root, ['test/fixtures/goldens/broken.json'], change)).toEqual(['test/fixtures/goldens/broken.json:3']);
    fs.writeFileSync(path.join(root, 'test/fixtures/run.json'), JSON.stringify({ timeout: 30000 }, null, 2) + nl);
    fs.writeFileSync(path.join(root, 'test/fixtures/runner-run.json'), JSON.stringify({ module: 'lib/runner.ts', timeout: 30000 }, null, 2) + nl);
    expect(consumersOf(root, ['test/fixtures/run.json', 'test/fixtures/runner-run.json'], { name: 'timeout', old: '30000', new: '60000', file: 'lib/runner.ts' })).toEqual(['test/fixtures/runner-run.json:3']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('literals: a one-item list that only gained items (#4714, #4719)', () => {
  // Value: protects=when a one-item list constant only gains items ("investigate" -> "investigate verify"), a test that still names
  //   the unchanged member (a path, a fixture, a membership check) is not a consumer, while an assertion that the whole value is the
  //   old one still is, directly (toBe, toEqual, ===, an assert call, an assignment) or through a binding taken from the module or
  //   the constant; fails_when=member lines are reported again (#4714 carried 13 markers in test/retired-skills.test.ts), or a
  //   whole-value assertion through an alias such as `modes` is missed (#4719's review); why_new=list growth had no rule;
  //   seam=none; no_claim=multi-item old lists, whose quoted old value is the whole value wherever it appears
  test('member uses are not consumers; whole-value assertions, aliases included, still are', () => {
    const files: Record<string, string> = {
      'test/member.test.ts': ["const REGISTRY = path.join(ROOT, 'bin', 'registry.sh');", "fs.mkdirSync(path.join(skills, 'investigate'));", "expect(fs.existsSync(path.join(skills, 'investigate', 'SKILL.md'))).toBe(false);", ''].join(nl),
      'test/contains.test.ts': ["const out = run('bin/registry.sh');", "expect(out.split(' ')).toContain('investigate');", "expect(out.includes('investigate')).toBe(true);", ''].join(nl),
      'test/exact.test.ts': ["const out = run('bin/registry.sh');", "expect(names(out)).toBe('investigate');", ''].join(nl),
      'test/array.test.ts': ["const out = run('bin/registry.sh');", "expect(list(out)).toEqual(['investigate']);", ''].join(nl),
      'test/strict.test.ts': ["const out = run('bin/registry.sh');", "assert.strictEqual(read(out), 'investigate');", ''].join(nl),
      'test/compare.test.ts': ["const out = run('bin/registry.sh');", "if (read(out) !== 'investigate') throw new Error('x');", ''].join(nl),
      'test/assign.test.ts': ["const out = run('bin/registry.sh');", "const expected = 'investigate';", 'expect(read(out)).toBe(expected);', ''].join(nl),
      'test/alias.test.ts': ["import { RETIRED_DEMO_SKILLS as modes } from '../bin/registry.sh';", "expect(check(modes, 'investigate')).toBe(true);", ''].join(nl),
      'test/alias-member.test.ts': ["import { RETIRED_DEMO_SKILLS as modes } from '../bin/registry.sh';", "expect(modes.split(' ')).toContain('investigate');", ''].join(nl),
      'test/derived.test.ts': ["import { RETIRED_DEMO_SKILLS } from '../bin/registry.sh';", 'const modes = RETIRED_DEMO_SKILLS;', "expect(same(modes, 'investigate')).toBe(true);", ''].join(nl),
    };
    const root = fixture('gstack-literals-grew-', files);
    const change = { name: 'RETIRED_DEMO_SKILLS', old: '"investigate"', new: '"investigate verify"', file: 'bin/registry.sh' };
    expect(consumersOf(root, Object.keys(files), change)).toEqual([
      'test/exact.test.ts:2', 'test/array.test.ts:2', 'test/strict.test.ts:2', 'test/compare.test.ts:2', 'test/assign.test.ts:2', 'test/alias.test.ts:2', 'test/derived.test.ts:3',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('only a one-item list that kept its item and gained more gets the rule; prose and multi-item lists keep the old one', () => {
    const files: Record<string, string> = {
      'test/prose.test.ts': ["import { ERR } from '../src/errors';", "expect(log('file not found')).toBe(1);", ''].join(nl),
      'test/modes.test.ts': ["import { MODES as modes } from '../src/modes';", "expect(log('read write')).toBe(1);", "expect(modes.split(' ')).toContain('read');", ''].join(nl),
      'test/swap.test.ts': ["import { MODE } from '../src/mode';", "fs.mkdirSync(path.join(dir, 'fast'));", ''].join(nl),
    };
    const root = fixture('gstack-literals-grew-not-', files);
    expect(consumersOf(root, ['test/prose.test.ts'], { name: 'ERR', old: '"file not found"', new: '"file not found here"', file: 'src/errors.ts' })).toEqual(['test/prose.test.ts:2']);
    expect(consumersOf(root, ['test/modes.test.ts'], { name: 'MODES', old: "'read write'", new: "'read write admin'", file: 'src/modes.ts' })).toEqual(['test/modes.test.ts:2']);
    expect(consumersOf(root, ['test/swap.test.ts'], { name: 'MODE', old: "'fast'", new: "'slow fast'", file: 'src/mode.ts' })).toEqual([]);
    expect(consumersOf(root, ['test/swap.test.ts'], { name: 'MODE', old: "'fast'", new: "'slow'", file: 'src/mode.ts' })).toEqual(['test/swap.test.ts:2']);
    expect(consumersOf(root, ['test/swap.test.ts'], { name: 'MODE', old: "'fast'", new: "'fast!'", file: 'src/mode.ts' })).toEqual(['test/swap.test.ts:2']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
