import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { repositoryPlanFixtures } from './helpers/carve-plan-fixture';
import { setupSkillDir } from './helpers/auq-sdk-capture';
import { CounterRepository } from './fixtures/carve-existing-repository/src/repository';

test.each(['plan-eng-review', 'plan-devex-review'] as const)('%s fixture supplies its existing implementation, companion reference, and runnable quickstart', skill => {
  const plan = '# Proposed cache\nStore 1000 keys and invalidate on write.\n';
  const fixtures = repositoryPlanFixtures(plan, skill);
  const dir = setupSkillDir({ skillName: skill, skillMd: '# Review', fixtures });
  try {
    expect(fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8')).toBe(fixtures['PLAN.md']);
    const example = Bun.spawnSync([process.execPath, 'run', 'example.ts'], { cwd: dir, timeout: 5000 });
    expect(example.exitCode, example.stderr.toString()).toBe(0);
    expect(example.stdout.toString()).toBe('2 2 undefined\n');
    expect(fixtures['README.md']).toContain('Both known-key reads currently query SQLite');
    expect(fixtures['src/repository.ts']).not.toMatch(/new Map|LRU|cache\./);
    expect(fixtures['src/repository.ts']).not.toContain('getMany(');
    const companion = skill === 'plan-devex-review' ? 'plan-devex-review/dx-hall-of-fame.md' : 'review/TODOS-format.md';
    expect(fs.readFileSync(path.join(dir, companion), 'utf8')).toBe(fs.readFileSync(path.resolve(import.meta.dir, '..', companion), 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing point reads always see committed writes and preserve missing/error distinctions', () => {
  const db = new Database(':memory:');
  try {
    const repo = new CounterRepository(db);
    expect(repo.get('missing')).toBeUndefined();
    repo.set('orders', 2);
    expect(repo.get('orders')).toBe(2);
    repo.set('orders', 3);
    expect(repo.get('orders')).toBe(3);
    expect(() => repo.get('')).toThrow('Counter key');
    expect(() => repo.set('orders', Number.NaN)).toThrow('finite number');
    expect(repo.get('orders')).toBe(3);
  } finally { db.close(); }
  expect(() => new CounterRepository(db)).toThrow();
});


test('engineering scenario proposes ordered batch reads without changing the DX fixture or existing code', () => {
  const plan = '# Proposed cache\nStore 1000 keys and invalidate on write.\n';
  const dir = path.resolve(import.meta.dir, 'fixtures/carve-existing-repository');
  const existing = '\n## Existing project\nRead `README.md` and `src/repository.ts` for the current API and runtime.\nThe change adds the cache to that repository; the existing example must keep working.\n';
  const eng = repositoryPlanFixtures(plan, 'plan-eng-review');
  const dx = repositoryPlanFixtures(plan, 'plan-devex-review');
  const baseline = Object.fromEntries(['README.md', 'src/repository.ts', 'example.ts'].map(file => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
  expect(dx).toEqual({
    'PLAN.md': plan + existing,
    ...baseline,
    'plan-devex-review/dx-hall-of-fame.md': fs.readFileSync(path.resolve(import.meta.dir, '../plan-devex-review/dx-hall-of-fame.md'), 'utf8'),
  });
  // Intentional new scenario contract: this fails on the previous cache fixture,
  // not a reproduction of the native timeout or a claim about model behavior.
  const proposal = eng['PLAN.md'];
  expect(proposal).toContain('getMany(keys: readonly string[]): Array<number | undefined>');
  expect(proposal).toContain('not implemented or approved');
  expect(proposal).toContain('once for each input key, in input order');
  expect(proposal).toContain('retaining duplicate keys');
  expect(proposal).toContain('`undefined` results for absent counters');
  expect(proposal).toContain('empty input returns an empty array');
  expect(proposal).toContain('Propagate the first validation or database error unchanged');
  expect(proposal).toContain('after the database closes must still fail');
  expect(proposal).toContain('not tests\nalready implemented or passing');
  expect(proposal).toContain('do not claim a measured speedup');
  expect(proposal).toContain('a dense `readonly string[]`');
  expect(proposal).toContain('`for...of` loop that pushes `this.get(key)`');
  expect(proposal).toContain("getMany(['orders', 'orders', 'missing'])");
  expect(proposal).toContain('not implementation that\nalready exists or authority to overlook a defect');
  expect(proposal).toContain('it does not add a benchmark project');
  expect(proposal).not.toMatch(/module-wide write token|1000 entries|LRU/);
  expect(eng).toEqual({
    'PLAN.md': fs.readFileSync(path.join(dir, 'engineering-batch-read-plan.md'), 'utf8'),
    ...baseline,
    'README.md': baseline['README.md'].replace('The cache in PLAN.md is proposed work.', 'The batch-read method in PLAN.md is proposed work.'),
    'review/TODOS-format.md': fs.readFileSync(path.resolve(import.meta.dir, '../review/TODOS-format.md'), 'utf8'),
  });
  expect(eng['src/repository.ts']).toBe(dx['src/repository.ts']);
  expect(eng['example.ts']).toBe(dx['example.ts']);
  for (const file of ['README.md', 'src/repository.ts', 'example.ts']) {
    expect(proposal).toContain('`' + file + '`');
    expect(eng[file]).toBeDefined();
  }
});

test('existing repository objects and separate SQLite handles observe each other’s committed writes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-carve-baseline-'));
  const firstDb = new Database(path.join(temp, 'counters.sqlite'));
  const secondDb = new Database(path.join(temp, 'counters.sqlite'));
  try {
    const first = new CounterRepository(firstDb);
    const sibling = new CounterRepository(firstDb);
    const secondHandle = new CounterRepository(secondDb);
    expect(sibling.get('orders')).toBeUndefined();
    expect(secondHandle.get('orders')).toBeUndefined();
    first.set('orders', 2);
    expect(sibling.get('orders')).toBe(2);
    expect(secondHandle.get('orders')).toBe(2);
    secondHandle.set('orders', 3);
    expect(first.get('orders')).toBe(3);
    expect(sibling.get('orders')).toBe(3);
  } finally {
    secondDb.close();
    firstDb.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('engineering fixture fixes the author acceptance recipe without approving the implementation or hiding review defects', () => {
  const plan = repositoryPlanFixtures('# Ignored Eng seed', 'plan-eng-review')['PLAN.md'];
  expect(plan).toContain('accepted requirements to review against');
  expect(plan).toContain('implementation itself remains proposed and unapproved');
  expect(plan).toContain('conflicts with it or a required proof is missing');
  expect(plan).toContain('normal decision procedure');
  expect(plan).toContain('required static proof during review, separate from runtime test execution');
  expect(plan).toContain("const keys = ['orders', 'missing'] as const; repo.getMany(keys)");
  expect(plan).toContain('Explain why that readonly tuple is assignable to `readonly string[]`');
  expect(plan).toContain('Reject a\nmutable `string[]` parameter, a cast that removes readonly, or `any`');
  expect(plan).toContain('assert `[2, undefined]` at runtime');
  expect(plan).toContain('do not claim it proves the static signature or that a\ncompiler ran');
  expect(plan).toContain('No checker dependency, config or future-checker promise replaces\nthis required static proof');
  expect(plan).toContain('A genuine type incompatibility still requires the\nnormal decision procedure');
  for (const boundary of ['fixed implementation package', 'existing CLI call-site integration', 'synchronization of existing contract documentation', 'Interchangeable', 'delegated\nimplementation details', 'Record their\nconcrete findings and disposition', 'does\nnot approve the proposed implementation', 'Optional polish, duplicate contract', 'new instrumentation and independent proof projects remain excluded', 'material contract change, missing required proof', 'conflict with the author', 'report the unresolved\nconflict', 'Preserve every required review section, artifact and verification']) expect(plan).toContain(boundary);
  for (const requirement of [
    "built-in `bun test` runner", '`src/repository.test.ts`',
    'integer, float, zero and negative', 'overwrite',
    'invalid empty, overlong and non-string keys', 'NaN and either infinity',
    'second repository over the same database', 'exit 0 and exactly `2 2 undefined\\n`',
    'empty input returns `[]` on open and closed databases without querying',
    'mixed known/missing results preserve order and length', 'readonly tuple',
    'adjacent and non-adjacent duplicates', 'stored zero differs from an absent key',
    'first, middle and last positions', '128-character key succeeds', '129-character key fails',
    'missing table throws rather than returning `undefined`', '[1]', '[5, 5]',
  ]) expect(plan).toContain(requirement);
  expect(plan).toContain('No dependency, package.json or runner configuration is added');
  expect(plan).toContain('Keep the review\'s complete architecture, code-quality, test and performance');
  expect(plan).toContain('not tests\nalready implemented or passing');
});

test('existing scalar round trips and database errors remain distinct from missing values', () => {
  const db = new Database(':memory:');
  const repo = new CounterRepository(db);
  try {
    repo.set('zero', -0);
    expect(Object.is(repo.get('zero'), 0)).toBe(true);
    expect(Object.is(repo.get('zero'), -0)).toBe(false);
    expect(repo.get('missing')).toBeUndefined();
    repo.set('orders', 2);
    expect(() => repo.set('orders', Number.POSITIVE_INFINITY)).toThrow('finite number');
    expect(repo.get('orders')).toBe(2);
    expect(() => repo.get('')).toThrow('Counter key');
  } finally { db.close(); }
  expect(() => repo.get('zero')).toThrow();
  expect(() => repo.set('orders', 4)).toThrow();
});
