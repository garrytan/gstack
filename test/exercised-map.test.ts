/**
 * Exercised-path consumer map (W2-A2, shadow mode): edge classes on a
 * synthetic tree, the five variant-c miss shapes as negative controls,
 * union-only refreshes, the refresh contract on unavailable or partial input,
 * shadow-only map data selecting nothing, shadow output that never changes the
 * real selection, MAP_GAP detection, and parity with the
 * measured prototype (docs/TESTING_INTERNALS.md#exercised-path-map).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  deriveDependencies, EXERCISED_MAP_PATH, exercisedConsumers, parseExercisedMap, type ExercisedMap,
} from '../scripts/pr-dependencies';
import {
  formatPrCoverageSummary, PR_FULL_GATE_FILES, PR_PROFILE_MAPS, selectPrProfile,
} from '../scripts/test-pr-profile';
import {
  attributeCommands, blindCases, formatExercisedMap, formatMapGap, formatShadowReplay, mapGaps, mergeExercisedMap, observeRun, readCaseCosts, readShardCommands,
  REFRESH_EXIT, RefreshError, refreshFromReportDirs, refreshFromRun, REPLAY_FIXTURE, replayShadow, type ArtifactDownload, type ReplayRun,
} from '../scripts/exercised-map';
import { reportMapGaps } from '../scripts/lib/paid-report';
import { computePaidCaseSelection } from '../scripts/test-paid-shards';
import { prototypeConsumers } from './helpers/exercised-prototype';

const ROOT = path.resolve(import.meta.dir, '..');

function fixtureRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-map-'));
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

const map = (cases: ExercisedMap['cases'], sourceRuns = ['1'], observedThrough = '2026-10-01T00:00:00Z'): ExercisedMap =>
  ({ schema: 1, generatedAt: observedThrough, observedThrough, sourceRuns, cases });

const FENCE = '```';
const skill = [
  '# alpha', '', 'Prose naming gstack-prose and /gstack-slash is not run.', '', FENCE + 'bash',
  'gstack-start --quiet',
  'echo "see gstack-echoed for details"',
  'echo "now $(gstack-subst --print)"',
  '# gstack-commented',
  'case "$x" in gstack-casepat) true ;; esac',
  'VAR=gstack-bare',
  '"$ROOT/bin/gstack-pathed" run',
  '. "$ROOT/lib/sourced.sh"',
  "cat <<'EOF'", 'gstack-quoted-heredoc', 'EOF',
  'cat <<EOF', '$(gstack-expanding)', 'gstack-heredoc-prose', 'EOF',
  "bash <<'EOF'", 'gstack-interp', 'EOF',
  '$B goto https://example.com',
  'bun run build-thing',
  './setup --quiet',
  FENCE, '',
].join('\n');
const bins = ['echoed', 'subst', 'commented', 'casepat', 'bare', 'pathed', 'quoted-heredoc', 'expanding', 'heredoc-prose', 'interp', 'prose', 'slash', 'observed', 'gapper'];
const tree = {
  'test/skill-e2e-alpha.test.ts': "import './helpers/h';\n",
  'test/helpers/h.ts': "const a = path.join(ROOT, 'lib', 'joined.ts');\nconst b = 'lib/quoted.ts';\nexport { a, b };\n",
  'lib/joined.ts': '', 'lib/quoted.ts': '', 'lib/deep.ts': '', 'lib/sourced.sh': '#!/bin/sh\n', 'lib/unreached.ts': '',
  'alpha/SKILL.md.tmpl': skill,
  'bin/gstack-start': '#!/usr/bin/env bash\ngstack-helper "$@"\n',
  'bin/gstack-helper': "#!/usr/bin/env bun\nimport '../lib/deep';\n",
  'bin/gstack-config': '#!/usr/bin/env bash\necho config\n',
  ...Object.fromEntries(bins.map(name => [`bin/gstack-${name}`, '#!/bin/sh\n'])),
  'test/skill-e2e-beta.test.ts': '', 'test/skill-e2e-gamma.test.ts': '', 'test/skill-e2e-delta.test.ts': '',
  'gamma/SKILL.md.tmpl': `# gamma\n\n${FENCE}bash\ngstack-config get proactive\n${FENCE}\n`,
  'scripts/build.sh': 'bun build --compile browse/src/cli.ts --outfile browse/dist/browse\n', 'browse/src/cli.ts': "import './page';\n", 'browse/src/page.ts': '',
  'scripts/thing.ts': '', 'scripts/resolvers/index.ts': '', 'setup': '#!/usr/bin/env bash\n',
  'package.json': JSON.stringify({ scripts: { 'build-thing': 'bun run scripts/thing.ts' } }),
};
const maps = {
  e2eTouchfiles: {
    alpha: ['test/skill-e2e-alpha.test.ts', 'alpha/**'], beta: ['test/skill-e2e-beta.test.ts'],
    gamma: ['test/skill-e2e-gamma.test.ts', 'gamma/**'], delta: ['test/skill-e2e-delta.test.ts', 'bin/gstack-config', 'lib/deep.ts'],
  },
  judgeTouchfiles: {}, globalTouchfiles: [] as string[],
};
const profileMaps = { ...maps, tiers: { alpha: 'gate', beta: 'gate', gamma: 'gate', delta: 'gate' } as const };
const observed = map({ beta: { observations: 3, withCommands: 2, commands: ['bin/gstack-observed'], costUsd: 2, costRuns: 3 },
  alpha: { observations: 4, withCommands: 4, commands: [], costUsd: 5, costRuns: 4 }, gamma: { observations: 2, withCommands: 0, commands: [] } });

describe('exercised consumers on a synthetic tree', () => {
  const root = fixtureRepo(tree);
  const ex = exercisedConsumers(maps, root, { observed, stopAt: ['setup'] });
  const alpha = ex.closure('alpha');

  test('each kept edge class reaches its file, with its provenance', () => {
    expect(alpha.get('alpha/SKILL.md.tmpl')).toBe('touchfile');
    expect(alpha.get('bin/gstack-start')).toBe('skill bash via bin/gstack-start');
    expect(alpha.get('lib/deep.ts')).toBe('skill bash via bin/gstack-start');
    expect(alpha.get('lib/joined.ts')).toBe('import');
    expect(alpha.get('lib/quoted.ts')).toBe('import');
    for (const file of ['bin/gstack-subst', 'bin/gstack-pathed', 'lib/sourced.sh', 'bin/gstack-expanding', 'bin/gstack-interp', 'browse/src/page.ts', 'scripts/thing.ts', 'setup']) {
      expect(alpha.has(file), file).toBe(true);
    }
    expect(ex.closure('beta').get('bin/gstack-observed')).toBe('observed bin/gstack-observed');
  });

  test('messages, comments, case patterns, bare assignments, quoted and expanded heredoc prose, prose and slash commands are not edges', () => {
    for (const name of ['echoed', 'commented', 'casepat', 'bare', 'quoted-heredoc', 'heredoc-prose', 'prose', 'slash']) {
      expect(alpha.has(`bin/gstack-${name}`), name).toBe(false);
    }
    expect(ex.e2e.get('lib/unreached.ts')).toBeUndefined();
  });

  test('the closure stops at a full-gate file and at the global set', () => {
    const stopped = exercisedConsumers({ ...maps, globalTouchfiles: ['bin/gstack-start'] }, fixtureRepo(tree), { observed, stopAt: ['setup'] });
    expect(stopped.closure('alpha').has('bin/gstack-start')).toBe(true);
    expect(stopped.closure('alpha').has('lib/deep.ts')).toBe(false);
  });

  test('bins in recorded commands: paths, bare names, PTY lines and compiled outfiles', () => {
    expect(ex.binsInCommand('gstack-start --x && "$B" goto y')).toEqual(['bin/gstack-start', 'browse/dist/browse']);
    expect(ex.binsInCommand('PTY:gstack-config-get proactive')).toEqual(['bin/gstack-config']);
    expect(ex.binsInCommand('"$ROOT/bin/gstack-start" --x')).toEqual(['bin/gstack-start']);
    expect(ex.binsInCommand('run /gstack-start next')).toEqual([]);
    expect(ex.commandFiles('browse/dist/browse').sort()).toEqual(['browse/src/cli.ts', 'browse/src/page.ts']);
  });

  test('the variant-c miss shapes stay selected in the shadow (negative controls)', () => {
    const shadow = (changedFiles: string[], selectedE2E: string[]) => selectPrProfile({
      maps: profileMaps, profile: ['alpha', 'beta', 'gamma', 'delta'], selectedE2E, selectedJudges: [], changedFiles,
      derived: deriveDependencies(maps, root), exercised: ex,
    }).shadow!;
    // A preamble hub a touchfile maps only for another case (skill-start/end x3; gstack-config for the PTY case with no observations).
    expect(shadow(['bin/gstack-config'], ['delta']).e2e).toEqual(['delta', 'gamma']);
    expect(observed.cases.gamma!.withCommands).toBe(0);
    // A lib reached only through a bin the skill runs (redact-patterns via gstack-redact).
    expect(shadow(['lib/deep.ts'], ['delta']).e2e).toEqual(['alpha', 'delta']);
    expect(shadow(['lib/deep.ts'], ['delta']).provenance).toEqual([{ file: 'lib/deep.ts', summary: 'selects 2 case(s): skill bash via bin/gstack-start (1), touchfile (1)' }]);
  });
});

describe('the five recorded variant-c misses on this checkout', () => {
  const shadowOf = (file: string) => computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [file], packageVersionOnly: true }).coverage!.shadow!;

  test('skill-start reds stay in the shadow of a gstack-skill-start change', () => {
    const shadow = shadowOf('bin/gstack-skill-start');
    expect(shadow.error).toBeUndefined();
    for (const id of ['qa-functional-webhook-fix', 'qa-functional-cli-report', 'ship-exploratory-plan-checks']) expect(shadow.e2e, id).toContain(id);
  }, 60_000);

  test('gstack-config reaches the PTY case that records no commands; redact-patterns reaches ship-docsync-store', () => {
    expect(shadowOf('bin/gstack-config').e2e).toContain('plan-mode-no-op');
    const committed = parseExercisedMap(fs.readFileSync(path.join(ROOT, EXERCISED_MAP_PATH), 'utf8'));
    const ex = exercisedConsumers(PR_PROFILE_MAPS, ROOT, { observed: committed, stopAt: PR_FULL_GATE_FILES });
    expect(ex.closure('plan-mode-no-op').get('bin/gstack-config')).toStartWith('skill bash via');
    expect(ex.closure('ship-docsync-store').has('lib/redact-patterns.ts')).toBe(true);
  }, 60_000);
});

describe('shadow output never changes the real selection', () => {
  test('mode, cases, judges and reasons equal the selection without a shadow', () => {
    for (const files of [['bin/gstack-config'], ['design/src/evolve.ts'], ['review/SKILL.md.tmpl'], ['lib/fs-utils.ts', 'docs/x.md'], ['ETHOS.md']]) {
      const withShadow = selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles: files });
      const without = selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles: files, exercised: null });
      expect(withShadow.shadow, files.join()).toBeDefined();
      const { shadow, ...rest } = withShadow;
      expect(rest, files.join()).toEqual(without);
      if (withShadow.mode === 'full-fallback') expect(shadow!.e2e).toEqual(withShadow.e2e);
    }
  }, 60_000);

  test('the coverage summary prints one shadow line; a broken map is reported, not fatal', () => {
    const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['design/src/evolve.ts'], packageVersionOnly: true });
    const lines = formatPrCoverageSummary({ profile: 'pr', selection: result.selection, prCoverage: result.coverage });
    expect(lines.filter(line => line.includes('Shadow exercised-path map (not active)'))).toHaveLength(1);
    const broken = selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles: ['design/src/evolve.ts'], exercised: null });
    expect(formatPrCoverageSummary({ prCoverage: { ...broken, shadow: { e2e: broken.e2e, wouldDrop: [], wouldAdd: [], provenance: [], predictedSavingUsd: 0, unpricedCases: 0, unknownCostShare: 0, error: 'bad map' } } })
      .some(line => line.includes('unavailable (bad map); selection unaffected'))).toBe(true);
  });
});

describe('union-only refreshes', () => {
  const base = map({ a: { observations: 2, withCommands: 1, commands: ['bin/x'], costUsd: 4, costRuns: 2 } }, ['1']);

  test('disjoint branches merge to the same union in either order, and nothing is removed', () => {
    const left = map({ a: { observations: 1, withCommands: 1, commands: ['bin/y'] } }, ['2'], '2026-10-02T00:00:00Z');
    const right = map({ b: { observations: 1, withCommands: 1, commands: ['bin/z'], costUsd: 1, costRuns: 1 } }, ['3'], '2026-10-03T00:00:00Z');
    const one = mergeExercisedMap(mergeExercisedMap(base, left, 't'), right, 't');
    const two = mergeExercisedMap(mergeExercisedMap(base, right, 't'), left, 't');
    expect(one).toEqual(two);
    expect(one.cases.a!.commands).toEqual(['bin/x', 'bin/y']);
    expect(one.cases.b!.commands).toEqual(['bin/z']);
    expect(one.sourceRuns).toEqual(['1', '2', '3']);
    expect(one.observedThrough).toBe('2026-10-03T00:00:00Z');
    expect(one.cases.a!.costUsd).toBe(4);
  });

  test('empty or missing artifacts never erase consumers, and a run already merged is not counted twice', () => {
    expect(mergeExercisedMap(base, map({}, ['9']), 't').cases).toEqual(base.cases);
    expect(mergeExercisedMap(base, map({ a: { observations: 1, withCommands: 0, commands: [] } }, ['9']), 't').cases.a!.commands).toEqual(['bin/x']);
    expect(mergeExercisedMap(base, map({ a: { observations: 5, withCommands: 5, commands: ['bin/x'], costUsd: 9, costRuns: 1 } }, ['1']), 't').cases.a)
      .toEqual(base.cases.a!);
    const costed = mergeExercisedMap(base, map({ a: { observations: 1, withCommands: 1, commands: [], costUsd: 7, costRuns: 1 } }, ['4']), 't');
    expect(costed.cases.a).toMatchObject({ observations: 3, costUsd: 5, costRuns: 3 });
    expect(parseExercisedMap(formatExercisedMap(costed))).toEqual(costed);
  });
});

describe('shadow-only map data', () => {
  test('a map-only diff selects no paid case and says why', () => {
    const selection = selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles: [EXERCISED_MAP_PATH] });
    expect(selection).toMatchObject({ mode: 'pr', e2e: [], judges: [], unknownFiles: [], derivedFiles: [], noConsumerFiles: [] });
    expect(selection.shadow!.e2e).toEqual([]);
    expect(selection.reasons).toContain(`${EXERCISED_MAP_PATH} is shadow-only data (it changes no selection yet), so it selects no paid case (docs/TESTING_INTERNALS.md#exercised-path-map)`);
    const plan = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [EXERCISED_MAP_PATH, 'package.json'], packageVersionOnly: true });
    expect(plan.selection.e2e).toEqual([]);
    expect(plan.selection.judges).toEqual([]);
  }, 60_000);
});

describe('refresh contract: unavailable or partial input writes nothing', () => {
  const root = fixtureRepo(tree);
  const ex = exercisedConsumers(maps, root, { observed, stopAt: ['setup'] });
  const report = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-refresh-'));
    for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
    return dir;
  };
  const outcome = (id: string) => JSON.stringify({ case: id, execution: 'executed', cost_usd: 1 });
  const shard = { 'paid-slice-1-a1/shards/skill-e2e-beta/junit.xml': '<testsuite><testcase name="beta"/></testsuite>' };
  const code = (run: () => unknown) => { try { run(); return 0; } catch (error) { return error instanceof RefreshError ? error.exitCode : -1; } };

  test('report directories: missing is unavailable; no shards, no trial outcomes or an executed case without a shard is incomplete', () => {
    expect(code(() => refreshFromReportDirs([path.join(os.tmpdir(), 'no-such-census-dir')], '1', observed, ex, 't', profileMaps))).toBe(REFRESH_EXIT.unavailable);
    expect(code(() => refreshFromReportDirs([report({ 'trial-outcomes.jsonl': outcome('beta') })], '1', observed, ex, 't', profileMaps))).toBe(REFRESH_EXIT.incomplete);
    expect(code(() => refreshFromReportDirs([report(shard)], '1', observed, ex, 't', profileMaps))).toBe(REFRESH_EXIT.incomplete);
    expect(() => refreshFromReportDirs([report({ ...shard, 'trial-outcomes.jsonl': `${outcome('beta')}\n${outcome('alpha')}` })], '1', observed, ex, 't', profileMaps))
      .toThrow('1 executed case(s) have no shard artifact: alpha');
    const { merged } = refreshFromReportDirs([report({ ...shard, 'trial-outcomes.jsonl': outcome('beta') })], '9', observed, ex, 't', profileMaps);
    expect(merged.sourceRuns).toEqual(['1', '9']);
    expect(merged.cases.beta!.observations).toBe(4);
  });

  test('--from-run: a 403, a missing map or a malformed map leaves the target byte-identical; a complete artifact is unioned', () => {
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-target-')), 'exercised-commands.json');
    fs.writeFileSync(target, formatExercisedMap(observed));
    const before = fs.readFileSync(target, 'utf8');
    const artifact = (files: Record<string, string>): ArtifactDownload => (_runId, dir) => {
      for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
      return { status: 0, stderr: '' };
    };
    let forbidden: unknown;
    try { refreshFromRun('42', target, () => ({ status: 1, stderr: 'HTTP 403: Resource not accessible by integration' })); } catch (error) { forbidden = error; }
    expect(forbidden).toBeInstanceOf(RefreshError);
    expect((forbidden as RefreshError).exitCode).toBe(REFRESH_EXIT.unavailable);
    expect((forbidden as Error).message).toContain('pass its directory with --from-dir');
    expect(code(() => refreshFromRun('42', target, artifact({ 'exercised-map-a1/report.md': 'x' })))).toBe(REFRESH_EXIT.incomplete);
    expect(code(() => refreshFromRun('42', target, artifact({ 'exercised-map-a1/exercised-commands.json': '{"schema":1,"cases":' })))).toBe(REFRESH_EXIT.incomplete);
    expect(code(() => refreshFromRun('42', target, artifact({ 'exercised-map-a1/exercised-commands.json': formatExercisedMap(map({}, ['5'])), 'exercised-map-a2/exercised-commands.json': '{}' })))).toBe(REFRESH_EXIT.incomplete);
    expect(code(() => refreshFromRun('not-a-run', target))).toBe(REFRESH_EXIT.unavailable);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    const fresh = map({ beta: { observations: 1, withCommands: 1, commands: ['bin/gstack-new'] } }, ['5'], '2026-10-09T00:00:00Z');
    refreshFromRun('5', target, artifact({ 'exercised-map-a1/exercised-commands.json': formatExercisedMap(fresh) }));
    const after = parseExercisedMap(fs.readFileSync(target, 'utf8'));
    expect(after.cases.beta!.commands).toEqual(['bin/gstack-new', 'bin/gstack-observed']);
    expect(after.sourceRuns).toEqual(['1', '5']);
  });

  test('the CLI exits 2 on usage and 3 on a missing report directory, writing nothing', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-cli-')), 'map.json');
    const cli = (args: string[]) => spawnSync('bun', ['run', path.join(ROOT, 'scripts/exercised-map.ts'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(cli([]).status).toBe(REFRESH_EXIT.usage);
    const missing = cli(['--from-dir', path.join(os.tmpdir(), 'no-such-census-dir'), '--run-id', '1', '--out', out]);
    expect(missing.status).toBe(REFRESH_EXIT.unavailable);
    expect(missing.stderr).toContain('nothing was written, the committed union is unchanged');
    expect(fs.existsSync(out)).toBe(false);
  }, 90_000);
});

describe('recorded commands and MAP_GAP', () => {
  const root = fixtureRepo(tree);
  const ex = exercisedConsumers(maps, root, { observed, stopAt: ['setup'] });
  const report = fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-report-'));
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(report, file)), { recursive: true }); fs.writeFileSync(path.join(report, file), text); };
  write('paid-slice-1-a1/shards/skill-e2e-alpha--alpha.t1/result.json', JSON.stringify({ tests: [{ name: 'alpha', transcript: [{ type: 'tool_use', input: { command: 'gstack-start && $B goto x' } }] }] }));
  write('paid-slice-1-a1/shards/skill-e2e-beta/junit.xml', '<testsuite><testcase name="beta"/></testsuite>');
  write('paid-slice-1-a1/shards/skill-e2e-beta/session.jsonl', `${JSON.stringify({ type: 'tool_use', input: { command: 'bin/gstack-gapper --x' } })}\n`);
  write('paid-slice-1-a1/shards/skill-e2e-gamma/junit.xml', '<testsuite><testcase name="gamma"/></testsuite>');
  write('paid-slice-1-a1/trial-outcomes.jsonl', [{ case: 'alpha', execution: 'executed', cost_usd: 1.5 }, { case: 'alpha', execution: 'executed', cost_usd: 0, cost_known: false }, { case: 'beta', execution: 'reused', cost_usd: 3 }].map(record => JSON.stringify(record)).join('\n'));

  test('commands are read per shard and attributed to their cases', () => {
    const commands = attributeCommands(readShardCommands(report), profileMaps);
    expect(commands.get('alpha')).toEqual(['gstack-start && $B goto x']);
    expect(commands.get('beta')).toEqual(['bin/gstack-gapper --x']);
    expect(commands.get('gamma')).toEqual([]);
    expect(observeRun(commands, ex, { runId: '7', observedAt: 't', costs: readCaseCosts(report) }).cases.alpha)
      .toEqual({ observations: 1, withCommands: 1, commands: ['bin/gstack-start', 'browse/dist/browse'], costUsd: 1.5, costRuns: 1 });
  });

  test('a command outside the static-plus-observed closure is a MAP_GAP; a skill-running case with no commands is blind', () => {
    const commands = attributeCommands(readShardCommands(report), profileMaps);
    expect(mapGaps(commands, ex)).toEqual([{ id: 'beta', command: 'bin/gstack-gapper' }]);
    expect(blindCases(commands, ex)).toEqual(['gamma']);
  });

  test('the paid report writes MAP_GAP lines without failing, and an unreadable checkout degrades to unavailable', () => {
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-live-'));
    const committed = parseExercisedMap(fs.readFileSync(path.join(ROOT, EXERCISED_MAP_PATH), 'utf8'));
    const ex = exercisedConsumers(PR_PROFILE_MAPS, ROOT, { observed: committed, stopAt: PR_FULL_GATE_FILES });
    const outside = fs.readdirSync(path.join(ROOT, 'bin')).map(name => `bin/${name}`).find(file => /^bin\/gstack-[a-z-]+$/.test(file) && !ex.closure('ship-docsync-store').has(file))!;
    fs.mkdirSync(path.join(live, 'paid-slice-2-a1/shards/skill-e2e-ship-docsync--ship-docsync-store.t1'), { recursive: true });
    fs.writeFileSync(path.join(live, 'paid-slice-2-a1/shards/skill-e2e-ship-docsync--ship-docsync-store.t1/r.json'),
      JSON.stringify({ tests: [{ name: 'ship-docsync-store', transcript: [{ type: 'tool_use', input: { command: `${path.basename(outside)} --help` } }] }] }));
    const line = `MAP_GAP ship-docsync-store ${outside}: non-blocking for this PR; the next census refresh widens the map (docs/TESTING_INTERNALS.md#exercised-path-map)`;
    expect(formatMapGap({ id: 'ship-docsync-store', command: outside })).toBe(line);
    expect(reportMapGaps(live, new Set(['ship-docsync-store']), ROOT)).toEqual([line]);
    expect(fs.readFileSync(path.join(live, 'map-gaps.txt'), 'utf8')).toBe(`${line}\n`);
    expect(reportMapGaps(live, new Set(['ship-docsync-store']), path.join(live, 'no-checkout'))).toEqual([]);
    expect(fs.readFileSync(path.join(live, 'map-gaps.txt'), 'utf8')).toStartWith('MAP_GAP unavailable:');
  }, 60_000);
});

describe('parity with the measured prototype', () => {
  /** Files the shipped function reaches beyond the prototype, each with the reviewed edge class behind it. */
  const REVIEWED_SUPERSET: Record<string, string> = {
    setup: './setup, $ROOT/setup and join(..., "setup") exec edges (plan A2-2); setup is a full-gate file, so the closure stops there',
  };

  test('the shipped map equals or is a reviewed superset of the prototype map on this checkout', () => {
    const committed = parseExercisedMap(fs.readFileSync(path.join(ROOT, EXERCISED_MAP_PATH), 'utf8'));
    const prototype = prototypeConsumers(PR_PROFILE_MAPS, ROOT, committed, PR_FULL_GATE_FILES);
    const shipped = exercisedConsumers(PR_PROFILE_MAPS, ROOT, { observed: committed, stopAt: PR_FULL_GATE_FILES });
    const missing = [...prototype].flatMap(([file, ids]) => [...ids].filter(id => !shipped.e2e.get(file)?.has(id)).map(id => `${file} ${id}`));
    expect(missing).toEqual([]);
    const unreviewed = [...new Set([...shipped.e2e].filter(([file, ids]) => [...ids].some(id => !prototype.get(file)?.has(id))).map(([file]) => file))]
      .filter(file => !Object.hasOwn(REVIEWED_SUPERSET, file));
    expect(unreviewed.map(file => `${file}: reached beyond the prototype; review the edge class and add it to REVIEWED_SUPERSET with its reason`)).toEqual([]);
  }, 60_000);
});

describe('replay of the recorded red PR runs', () => {
  test('every recorded failed gate case stays in the shadow selection (the PR receipt: bun run test:exercised-map --replay)', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, REPLAY_FIXTURE), 'utf8')) as { failedGateCases: number; runs: ReplayRun[] };
    expect(fixture.runs.reduce((sum, run) => sum + run.failedGateCases.length, 0)).toBe(fixture.failedGateCases);
    const rows = replayShadow(fixture.runs);
    expect(rows.flatMap(row => row.misses.map(id => `${row.runId}:${id}`))).toEqual([]);
    expect(formatShadowReplay(rows).at(-1)).toBe('- MISSES (failed, not in the shadow selection): 0');
  }, 120_000);

  test('a red the shadow drops is reported as a miss', () => {
    const [row] = replayShadow([{ runId: 1, pr: 1, packageVersionOnly: true, failedGateCases: ['plan-mode-no-op'], changedFiles: ['docs/designs/x.md'] }]);
    expect(row!.misses).toEqual(['plan-mode-no-op']);
    expect(formatShadowReplay([row!]).slice(-2)).toEqual(['- MISSES (failed, not in the shadow selection): 1', '  - 1 #1 plan-mode-no-op']);
  });
});
