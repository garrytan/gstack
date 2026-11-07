/**
 * gstack on Capy (crew/README.md): a pull request's free-suite plan carries
 * crew/test only when the change touches crew/ or a file crew code imports
 * (scripts/lib/crew-tests.ts, --crew-base on scripts/test-free-shards.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { crewImportClosure, crewTestSelection, isCrewTestFile } from '../scripts/lib/crew-tests';
import { createFreeCiPlan, parseCliOptions, TEST_ROOTS, validateFreeCiPlan } from '../scripts/test-free-shards';

let repo: string;
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-crew-tests-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write('crew/lib/train.ts', "import { b } from '../../lib/b';\nexport const t = b;\n");
  write('crew/bin/gstack-crew-tool', "#!/usr/bin/env bun\nimport { t } from '../lib/train';\nconsole.log(t);\n");
  write('crew/test/train.test.ts', "import { t } from '../lib/train';\nimport { h } from '../../test/helpers/h';\n");
  write('lib/b.ts', "export { c as b } from './c';\n");
  write('lib/c.ts', 'export const c = 1;\n');
  write('lib/unrelated.ts', 'export const u = 1;\n');
  write('test/helpers/h.ts', 'export const h = 1;\n');
  write('ship/SKILL.md', '# ship\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const change = (file: string) => {
  write(file, fs.readFileSync(path.join(repo, file), 'utf8') + '// edit\n');
  git('commit', '-qam', 'change ' + file);
};

test('the closure follows relative imports out of crew/, transitively, and stops there', () => {
  const closure = crewImportClosure(repo, ['crew/lib/train.ts', 'crew/bin/gstack-crew-tool', 'crew/test/train.test.ts']);
  expect([...closure].filter(f => !f.startsWith('crew/')).sort()).toEqual(['lib/b.ts', 'lib/c.ts', 'test/helpers/h.ts']);
});

describe('crewTestSelection', () => {
  test('a skill-only or unrelated change skips the crew tests', () => {
    const base = git('rev-parse', 'HEAD');
    change('ship/SKILL.md');
    change('lib/unrelated.ts');
    expect(crewTestSelection(repo, base)).toEqual({ planned: false, reason: `nothing under crew/ or in what crew code imports changed since ${base}` });
  });

  test('a change under crew/ plans them', () => {
    const base = git('rev-parse', 'HEAD');
    change('crew/bin/gstack-crew-tool');
    expect(crewTestSelection(repo, base)).toEqual({ planned: true, reason: 'crew/bin/gstack-crew-tool changed' });
  });

  test('a change to a file crew code reaches only indirectly plans them', () => {
    const base = git('rev-parse', 'HEAD');
    change('lib/c.ts');
    expect(crewTestSelection(repo, base)).toEqual({ planned: true, reason: 'lib/c.ts changed' });
  });

  test('a base git cannot read plans them', () => {
    expect(crewTestSelection(repo, 'no-such-ref').planned).toBe(true);
  });
});

describe('the free CI plan', () => {
  const files = ['crew/test/train.test.ts', 'test/a.test.ts', 'test/b.test.ts'];

  test('crew/test is a free-suite root', () => {
    expect(TEST_ROOTS).toContain('crew/test');
    expect(isCrewTestFile('crew/test/train.test.ts')).toBe(true);
    expect(isCrewTestFile('test/crew-skills-on-capy.test.ts')).toBe(false);
  });

  test('a plan that skipped the crew tests still validates against every discovered file', () => {
    const plan = createFreeCiPlan(files.filter(f => !isCrewTestFile(f)), 2, {}, 'r1', 1, true);
    expect(plan.crewTests).toBe('skipped');
    expect(() => validateFreeCiPlan(plan, files, 'r1')).not.toThrow();
  });

  test('a plan without the mark must cover the crew tests, and the mark is part of its identity', () => {
    const partial = createFreeCiPlan(files.filter(f => !isCrewTestFile(f)), 2, {}, 'r1');
    expect(() => validateFreeCiPlan(partial, files, 'r1')).toThrow('cover every free file');
    const marked = createFreeCiPlan(files.filter(f => !isCrewTestFile(f)), 2, {}, 'r1', 1, true);
    expect(() => validateFreeCiPlan({ ...marked, crewTests: undefined }, files, 'r1')).toThrow('identity');
  });

  test('--crew-base belongs to a Linux --ci-plan only', () => {
    expect(parseCliOptions(['--ci-plan', 'p.json', '--crew-base', 'abc']).crewBase).toBe('abc');
    expect(() => parseCliOptions(['--crew-base', 'abc'])).toThrow('--crew-base applies only');
    expect(() => parseCliOptions(['--ci-plan', 'p.json', '--windows-only', '--crew-base', 'abc'])).toThrow('--crew-base applies only');
    expect(() => parseCliOptions(['--ci-plan', 'p.json', '--crew-base'])).toThrow('Missing ref');
  });
});
