/**
 * Derived PR-lane dependencies (scripts/pr-dependencies.ts) and the
 * fail-closed full-gate list (PR_FULL_GATE_FILES): unmapped files select the
 * gate cases whose reference closure reaches them, underivable files and
 * global inputs restore the full gate, and every fallback names its fix.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveDependencies, derivedDependencies, referenceText } from '../scripts/pr-dependencies';
import {
  DERIVABLE_PREFIXES, PERIODIC_ONLY_PR_FILES, PR_FULL_GATE_FILES, PR_PROFILE_MAPS, selectPrProfile, unknownFileLabel,
} from '../scripts/test-pr-profile';
import { buildRunManifest, computePaidCaseSelection } from '../scripts/test-paid-shards';
import { E2E_TIERS } from './helpers/touchfiles-data';
import { matchGlob } from './helpers/test-selection';

const ROOT = path.resolve(import.meta.dir, '..');
const real = derivedDependencies(PR_PROFILE_MAPS, ROOT);
const gate = Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === 'gate');
const FIX = 'docs/TESTING_INTERNALS.md#pr-paid-lane-fallback';

function fixtureRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-deps-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  for (const args of [['init', '-q'], ['add', '-A']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
  return root;
}

describe('reference derivation on a fixture tree', () => {
  const root = fixtureRepo({
    'test/skill-e2e-alpha.test.ts': "import { help } from './helpers/alpha-helper';\nimport { other } from './skill-e2e-beta.test';\n",
    'test/skill-e2e-beta.test.ts': "export const other = 'lib/beta-only.ts';\n",
    'test/helpers/alpha-helper.ts': "import { x } from '../../lib/alpha';\n// prose about lib/commented.ts is not a reference\nexport const help = x;\n",
    'test/helpers/touchfiles-data.ts': "export const MAP = { a: ['lib/listed-only.ts'] };\n",
    'test/helpers/joined.ts': "export const p = path.join(ROOT, 'lib', 'joined.ts');\n", 'lib/joined.ts': '',
    'lib/alpha.ts': "import './../test/helpers/joined';\nexport const x = 1;\n", 'lib/beta-only.ts': '', 'lib/commented.ts': '', 'lib/listed-only.ts': '', 'lib/bin-lib.ts': '', 'lib/unused.ts': '',
    'alpha/SKILL.md.tmpl': '{{GREETING}}\nRun `gstack-tool` then open design/dist/design.\n',
    'bin/gstack-tool': "#!/bin/sh\n# mentions lib/commented.ts only in a comment\nbun run \"$ROOT/lib/bin-lib.ts\"\n",
    'scripts/build.sh': 'bun build --compile design/src/cli.ts --outfile design/dist/design\n',
    'design/src/cli.ts': "import './render';\n", 'design/src/render.ts': '',
    'scripts/resolvers/index.ts': "import { greet } from './greeting';\nexport const RESOLVERS = {\n  GREETING: greet,\n};\n",
    'scripts/resolvers/greeting.ts': "import { tone } from './tone';\nexport const greet = () => tone;\n", 'scripts/resolvers/tone.ts': 'export const tone = 1;\n',
    'hosts/acme.ts': '', 'hosts/zeta.ts': '',
    'package.json': '{"scripts":{}}\n',
  });
  const maps = { e2eTouchfiles: { alpha: ['test/skill-e2e-alpha.test.ts', 'alpha/**'], beta: ['test/skill-e2e-beta.test.ts'] }, judgeTouchfiles: {}, globalTouchfiles: [] };
  const derived = deriveDependencies(maps, root);
  const consumers = (file: string) => [...derived.e2e.get(file) ?? []].sort();

  test('imports, bin invocations, compiled binaries and template placeholders all reach their files', () => {
    expect(consumers('lib/alpha.ts')).toEqual(['alpha']);
    expect(consumers('lib/joined.ts')).toEqual(['alpha']);
    expect(consumers('bin/gstack-tool')).toEqual(['alpha']);
    expect(consumers('lib/bin-lib.ts')).toEqual(['alpha']);
    expect(consumers('design/src/render.ts')).toEqual(['alpha']);
    expect(consumers('scripts/resolvers/tone.ts')).toEqual(['alpha']);
    expect(derived.trace('alpha', 'scripts/resolvers/tone.ts')).toEqual(['alpha/SKILL.md.tmpl', 'scripts/resolvers/greeting.ts', 'scripts/resolvers/tone.ts']);
  });

  test('comments, selection data and other paid test files are not references', () => {
    expect(consumers('lib/commented.ts')).toEqual([]);
    expect(consumers('lib/listed-only.ts')).toEqual([]);
    expect(consumers('lib/beta-only.ts')).toEqual(['beta']);
    expect(consumers('lib/unused.ts')).toEqual([]);
    expect(referenceText('a.ts', '  // lib/x.ts\nconst y = "lib/z.ts"; // trailing lib/w.ts\n')).toContain('lib/z.ts');
    expect(referenceText('a.ts', '  // lib/x.ts\n')).not.toContain('lib/x.ts');
    expect(referenceText('bin/x', '# lib/x.ts\necho lib/y.ts\n')).toBe('\necho lib/y.ts\n');
    expect(referenceText('data.json', '{"a":"lib/x.ts"}')).toBe('');
  });

  test('a host config feeds only cases whose test names the host', () => {
    const named = deriveDependencies({ ...maps, e2eTouchfiles: { ...maps.e2eTouchfiles, beta: ['test/skill-e2e-beta.test.ts'] } },
      fixtureRepo({ 'test/skill-e2e-beta.test.ts': "run({ host: 'acme' });\n", 'hosts/acme.ts': '', 'hosts/zeta.ts': '', 'scripts/build.sh': '', 'scripts/resolvers/index.ts': '', 'package.json': '{}' }));
    expect([...named.e2e.get('hosts/acme.ts') ?? []]).toEqual(['beta']);
    expect(named.e2e.get('hosts/zeta.ts')).toBeUndefined();
  });
});

describe('derived dependencies of this checkout', () => {
  test('a bin script a skill template invokes selects that skill\'s cases', () => {
    const consumers = real.e2e.get('bin/gstack-next-version') ?? new Set();
    expect(consumers.has('review-sql-injection')).toBe(true);
    expect(real.trace('review-sql-injection', 'bin/gstack-next-version')?.[0]).toBe('review/SKILL.md.tmpl');
  });

  test('a compiled design source reaches exactly the cases whose closure names the design binary', () => {
    const consumers = [...real.e2e.get('design/src/evolve.ts') ?? []];
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers.length).toBeLessThan(Object.keys(E2E_TIERS).length);
    for (const id of consumers.slice(0, 5)) expect(real.trace(id, 'design/src/evolve.ts')?.some(file => file === 'design/src/cli.ts' || file.startsWith('design/src/'))).toBe(true);
  });

  test('the paid runner\'s import closure is global, and only that', () => {
    for (const file of ['scripts/test-paid-shards.ts', 'scripts/e2e-shard-reuse.ts', 'test/helpers/session-runner.ts', 'test/helpers/eval-store.ts', 'scripts/lib/shard-engine.ts']) {
      expect(real.global.has(file), file).toBe(true);
    }
    expect(real.global.has('bin/gstack-next-version')).toBe(false);
    expect(real.global.size).toBeLessThan(120);
  });
});

describe('PR selection with derived dependencies', () => {
  const select = (changedFiles: string[]) => computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles, packageVersionOnly: true });

  test('an unmapped file with derived consumers runs every dependent gate case and nothing else', () => {
    const result = select(['design/src/evolve.ts']);
    expect(result.coverage?.mode).toBe('dependents');
    const expected = gate.filter(id => real.e2e.get('design/src/evolve.ts')?.has(id)).sort();
    expect(result.selection.e2e).toEqual(expected);
    expect(result.coverage?.derivedFiles).toEqual([{ file: 'design/src/evolve.ts', e2e: real.e2e.get('design/src/evolve.ts')!.size, judges: real.judges.get('design/src/evolve.ts')?.size ?? 0 }]);
    const manifest = buildRunManifest({ tier: 'gate', profile: 'pr', sliceCount: 2, evalsAll: false, env: {}, changedFiles: ['design/src/evolve.ts'] });
    expect(manifest.prCoverage?.mode).toBe('dependents');
    expect(manifest.entries.some(entry => entry.status === 'planned')).toBe(true);
  });

  test('a tracked file no paid case reaches is exempt; periodic-only workflows never run the PR gate', () => {
    const result = select(['scripts/typecheck-test.ts', ...PERIODIC_ONLY_PR_FILES]);
    expect(result.coverage?.mode).toBe('pr');
    expect(result.coverage?.noConsumerFiles).toEqual(['scripts/typecheck-test.ts']);
    expect(result.selection).toEqual({ e2e: [], judges: [] });
  });

  test('a paid-runner import selects every case, as a global touchfile does', () => {
    const viaClosure = select(['scripts/e2e-shard-reuse.ts']);
    const viaGlobal = select(['scripts/test-paid-shards.ts']);
    expect(viaClosure.coverage?.mode).toBe('pr');
    expect(viaClosure.selection).toEqual(viaGlobal.selection);
  });

  test('derivation is skipped for fixture maps unless passed explicitly', () => {
    const result = selectPrProfile({ maps: { ...PR_PROFILE_MAPS, e2eTouchfiles: { ...PR_PROFILE_MAPS.e2eTouchfiles } }, selectedE2E: [], selectedJudges: [], changedFiles: ['design/src/evolve.ts'] });
    expect(result.mode).toBe('full-fallback');
  });
});

describe('the fail-closed full-gate list', () => {
  const tracked = [...real.tracked];

  test('every entry matches a tracked file', () => {
    const stale = PR_FULL_GATE_FILES.filter(pattern => !tracked.some(file => matchGlob(file, pattern)));
    expect(stale.map(pattern => `${pattern}: matches no tracked file. Fix: delete it from PR_FULL_GATE_FILES in scripts/test-pr-profile.ts (${FIX})`)).toEqual([]);
  });

  test('every entry restores the full gate even when a touchfile or a derived reference also names it', () => {
    for (const pattern of PR_FULL_GATE_FILES) {
      const file = tracked.find(candidate => matchGlob(candidate, pattern))!;
      const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [file], packageVersionOnly: false });
      expect({ file, mode: result.coverage?.mode }).toEqual({ file, mode: 'full-fallback' });
      expect(result.selection.e2e).toEqual(gate.sort());
    }
  });

  test('the setup, preamble, eval policy and PR workflow inputs are on it', () => {
    for (const file of ['setup', 'scripts/resolvers/preamble.ts', 'test/helpers/periodic-exclude-data.ts', '.github/workflows/evals.yml', 'bun.lock']) {
      expect(PR_FULL_GATE_FILES.some(pattern => matchGlob(file, pattern)), file).toBe(true);
    }
  });

  test('a file the derivation cannot place restores the full gate with its fix', () => {
    for (const file of ['ETHOS.md', 'conductor.json']) {
      const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [file], packageVersionOnly: true });
      expect(result.coverage?.mode, file).toBe('full-fallback');
      const label = result.coverage!.unknownFileLabels[0]!;
      expect(label.file).toBe(file);
      expect(label.fix).toContain(file);
      expect(label.fix).toContain('touchfiles-data.ts');
      expect(label.fix).toContain('DERIVABLE_PREFIXES');
    }
    expect(DERIVABLE_PREFIXES).not.toContain('test/fixtures/');
  });

});

describe('deleted files (paths absent from the head tree)', () => {
  const without = (file: string) => ({ ...real, tracked: new Set([...real.tracked].filter(other => other !== file)) });
  const pick = (file: string, derived = without(file)) => selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles: [file], derived });

  test('a deleted file nothing references and no touchfile matches has no dependents', () => {
    const result = pick('scripts/retired-tool-nobody-calls.ts', real);
    expect(result.mode).toBe('pr');
    expect(result.noConsumerFiles).toEqual(['scripts/retired-tool-nobody-calls.ts']);
    expect(result.e2e).toEqual([]);
  });

  test('a deleted file a touchfile matches selects that touchfile\'s cases', () => {
    const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['browse/src/retired-module.ts'], packageVersionOnly: true });
    expect(result.coverage?.unknownFiles).toEqual([]);
    expect(result.coverage?.mode).toBe('pr');
    expect(result.selection.e2e).toContain('browse-basic');
  });

  test('a deleted file live code still references selects the referencing files\' dependents', () => {
    const result = pick('bin/gstack-next-version');
    expect(result.mode).toBe('dependents');
    expect(result.e2e).toContain('review-sql-injection');
    expect(result.derivedFiles[0]?.file).toBe('bin/gstack-next-version');
    expect(real.referencers('bin/gstack-next-version')).toContain('review/SKILL.md.tmpl');
  });

  test('a deleted file a full-gate input still references, or a deleted full-gate entry, restores the full gate', () => {
    expect(real.referencers('bin/gstack-install-registry.sh')).toContain('setup');
    const referenced = pick('bin/gstack-install-registry.sh');
    expect(referenced.mode).toBe('full-fallback');
    expect(referenced.unknownFileLabels[0]).toMatchObject({ file: 'bin/gstack-install-registry.sh', label: 'deleted but still referenced' });
    expect(referenced.unknownFileLabels[0]!.fix).toContain('setup');
    expect(pick('bunfig.toml').mode).toBe('full-fallback');
  });

  test('comments and data files never count as references to a deleted path', () => {
    const root = fixtureRepo({
      'test/skill-e2e-alpha.test.ts': "// lib/gone.ts used to live here\nimport './helpers/h';\n",
      'test/helpers/h.ts': "export const data = 'x';\n", 'data/list.json': '["lib/gone.ts"]',
      'scripts/build.sh': '', 'scripts/resolvers/index.ts': '', 'package.json': '{}',
    });
    const derived = deriveDependencies({ e2eTouchfiles: { alpha: ['test/skill-e2e-alpha.test.ts'] }, judgeTouchfiles: {}, globalTouchfiles: [] }, root);
    expect(derived.referencers('lib/gone.ts')).toEqual([]);
    const relative = fixtureRepo({ 'test/skill-e2e-alpha.test.ts': "import './helpers/gone';\n", 'scripts/build.sh': '', 'scripts/resolvers/index.ts': '', 'package.json': '{}' });
    expect(deriveDependencies({ e2eTouchfiles: { alpha: ['test/skill-e2e-alpha.test.ts'] }, judgeTouchfiles: {}, globalTouchfiles: [] }, relative)
      .referencers('test/helpers/gone.ts')).toEqual(['test/skill-e2e-alpha.test.ts']);
  });
});
