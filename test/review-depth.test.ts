import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyDiff, classifyPath, depthFor, depthOfCommitInput, diffCommand, nextStep, planReview, reviewPlanLine, scanNumbers, DEPTH_RULES, FULL_PASS_CAP, SCOPED_RANGE_LINES, type DepthError, type PlanInput } from '../lib/review-depth';
import { summarizeReviewLoop } from '../lib/review-scope';

const ROOT = path.join(import.meta.dir, '..');
const none = scanNumbers({});
const base = (o: Partial<PlanInput>): PlanInput => ({ paths: ['src/app.ts'], scope: { SCOPE_BACKEND: 'true', SCOPE_STATE_MACHINE: 'false' }, gateTagged: 0, diffLines: 120, history: { fullPasses: 0, last: 'none' }, numbers: none, ...o });
const roles = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}:${d.effort}`);

describe('classifyPath: agent-read markdown is code', () => {
  test.each([
    ['README.md', 'docs'], ['CHANGELOG.md', 'docs'], ['docs/howto-x.md', 'docs'], ['TODOS.md', 'docs'],
    ['ship/SKILL.md.tmpl', 'code'], ['review/SKILL.md', 'code'], ['ship/sections/review-army.md', 'code'], ['scripts/resolvers/review-army.ts', 'code'],
    ['docs/review-policy.md', 'code'], ['autoplan/DRIVER.md.tmpl', 'code'], ['captain/templates/brief.md', 'code'], ['AGENTS.md', 'code'], ['review/specialists/security.md', 'code'],
    ['test/review-depth.test.ts', 'tests'], ['src/a.test.ts', 'tests'], ['pkg/x_test.go', 'tests'], ['test/fixtures/a.json', 'tests'],
    ['lib/review-depth.ts', 'code'], ['package.json', 'code'],
  ])('%s -> %s', (p, c) => expect(classifyPath(p)).toBe(c as any));
});

describe('classifyDiff', () => {
  test('docs only stays docs', () => expect(classifyDiff({ paths: ['README.md', 'docs/a.md'], gateTagged: null }).class).toBe('docs'));
  test('a skill-template-only diff is code, not docs', () => expect(classifyDiff({ paths: ['ship/SKILL.md.tmpl'], gateTagged: 0 }).class).toBe('code'));
  test('mixed diff takes the most restrictive class', () => {
    expect(classifyDiff({ paths: ['README.md', 'test/a.test.ts'], gateTagged: 0 }).class).toBe('tests');
    expect(classifyDiff({ paths: ['README.md', 'lib/a.ts'], gateTagged: 0 }).class).toBe('code');
  });
  test('a scope error fails closed to code', () => expect(classifyDiff({ paths: ['README.md'], scope: { SCOPE_ERROR: 'unmatched' }, gateTagged: 0 }).class).toBe('code'));
  test('code with the gate scan unavailable fails closed to gate', () => expect(classifyDiff({ paths: ['lib/a.ts'], gateTagged: null }).class).toBe('gate'));
  test.each([
    [{ scope: { SCOPE_AUTH: 'true' } }], [{ scope: { SCOPE_MIGRATIONS: 'true' } }], [{ gateTagged: 2 }],
    [{ paths: ['lib/a.ts', '.github/workflows/ci.yml'] }], [{ paths: ['lib/a.ts', 'lib/credentials.ts'] }], [{ deleted: ['lib/old.ts'] }],
  ])('gate signal %j raises code to gate', (o: any) => expect(classifyDiff({ paths: ['lib/a.ts'], gateTagged: 0, ...o }).class).toBe('gate'));
  test('docs never become gate from code-only signals', () => expect(classifyDiff({ paths: ['README.md'], gateTagged: null, deleted: ['docs/old.md'] }).class).toBe('docs'));
});

describe('nextStep: the transition table', () => {
  test('pass 1 is full', () => expect(nextStep({ fullPasses: 0, last: 'none' }).step).toBe('full'));
  test('no edits is done', () => expect(nextStep({ fullPasses: 1, last: 'full' }).step).toBe('done'));
  test('a fixed blocker earns full pass 2', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBlocking: true }).step).toBe('full'));
  test('below-floor fixes earn one fix-check', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true }).step).toBe('fix-check'));
  test('a fix touching gate code earns a full pass instead of a fix-check', () => expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, touchedGate: true }).step).toBe('full'));
  test('at the full-pass cap a fixed blocker gets a fix-check', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true }).step).toBe('fix-check'));
  test('at the cap a gate-touching fix still gets a fix-check, never a third full pass', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', fixedBlocking: true, touchedGate: true }).step).toBe('fix-check'));
  test('a blocker open at the cap stops', () => expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', blockingOpen: true }).step).toBe('stop'));
  test('a blocker open with no fix stops', () => expect(nextStep({ fullPasses: 1, last: 'full', blockingOpen: true }).step).toBe('stop'));
  test('a fix-check that finds a blocker stops, never a third full pass', () => {
    expect(nextStep({ fullPasses: 1, last: 'fix-check', blockingOpen: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: 2, last: 'fix-check', fixedBlocking: true }).step).toBe('stop');
  });
  test('a clean fix-check is done', () => expect(nextStep({ fullPasses: 1, last: 'fix-check' }).step).toBe('done'));
});

describe('scanNumbers', () => {
  test('finds claims and fingerprints them', () => {
    const a = scanNumbers({ 'docs/bench.md': ['Median dropped 48% to 1.2s', 'no numbers here'] });
    expect(a).toMatchObject({ publishes: true, claims: 1 });
    expect(scanNumbers({ 'docs/bench.md': ['Median dropped 47% to 1.2s'] }).fingerprint).not.toBe(a.fingerprint);
  });
  test('versions, dates, issue and step numbers and plain prose are not claims', () => expect(scanNumbers({ 'CHANGELOG.md': ['## [1.91.283.0] - 2026-10-27', 'Fixes the ship loop (#3516), see Step 9.4 and rule 23.'] }).publishes).toBe(false));
  test.each([
    ['the smallest two-sided p with 16 clusters is 2 x 0.5^6 = 0.031'],
    ['the miss split is 10/52'], ['p falls to 3.05e-5'], ['median 1.4 passes per PR'], ['Hot-memory hits: 10 of 62'],
  ])('a bare numeric claim counts: %s', line => expect(scanNumbers({ 'docs/comparing-runs.md': [line] }).publishes).toBe(true));
});

describe('planReview', () => {
  test('docs class: core only, no outside voice', () => {
    const p = planReview(base({ paths: ['README.md'], scope: {}, gateTagged: null, diffLines: 300 }));
    expect(p.class).toBe('docs');
    expect(p.dispatches).toEqual([]);
  });
  test('docs class with numeric claims keeps the outside voice', () => {
    const p = planReview(base({ paths: ['docs/bench.md'], scope: {}, numbers: scanNumbers({ 'docs/bench.md': ['3x faster'] }) }));
    expect(roles(p)).toEqual(['outside-voice:outside-voice:host']);
  });
  test('tests class: runtime 0 is light, core only (Behavior changes: no Testing specialist)', () => {
    const p = planReview(base({ paths: ['test/a.test.ts'], scope: { SCOPE_TESTS: 'true' } }));
    expect(p.depth).toBe('light');
    expect(roles(p)).toEqual([]);
  });
  test('code class pass 1: every reviewer at full effort, the outside voice at its own', () => {
    const p = planReview(base({}));
    expect(roles(p)).toEqual(['specialist:testing:full', 'specialist:maintainability:full', 'specialist:security:full', 'specialist:performance:full', 'specialist:simplification:full', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
  });
  test('gate class forces red team and ignores hit-rate gating', () => {
    const p = planReview(base({ gateTagged: 1, gated: ['security'] }));
    expect(roles(p)).toContain('red-team:red-team:full');
    expect(roles(p)).toContain('specialist:security:full');
  });
  test('code class honours hit-rate gating and small-diff skip', () => {
    expect(roles(planReview(base({ gated: ['simplification'] })))).not.toContain('specialist:simplification:full');
    expect(planReview(base({ diffLines: 20 })).dispatches.filter(d => d.role === 'specialist').map(d => d.name)).toEqual(['batched']);
  });
  test('pass 2 reruns the army on the range but not the adversarial or outside voice once Step 11 ran', () => {
    const p = planReview(base({ adversarialRan: true, history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(p.next.step).toBe('full');
    expect(roles(p).some(r => r.startsWith('outside-voice') || r.startsWith('adversarial'))).toBe(false);
  });
  test('a repeat that became code class keeps the adversarial pass Step 11 has not run yet', () => {
    const p = planReview(base({ history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(roles(p)).toContain('adversarial-native:adversarial:full');
    expect(planReview(base({ paths: ['docs/a.md'], history: { fullPasses: 1, last: 'full', fixedBlocking: true } })).dispatches.some(d => d.role === 'adversarial-native')).toBe(false);
  });
  test('a fix-check is one full-effort dispatch', () => {
    expect(roles(planReview(base({ history: { fullPasses: 1, last: 'full', fixedBelow: true } })))).toEqual(['fix-check:fix-check:full']);
  });
  test('changed numeric claims rerun only the outside voice', () => {
    const numbers = scanNumbers({ 'docs/bench.md': ['3x faster'] });
    const p = planReview(base({ numbers, reviewedNumbers: 'old', history: { fullPasses: 1, last: 'full', fixedBelow: true } }));
    expect(roles(p)).toEqual(['fix-check:fix-check:full', 'outside-voice:outside-voice (numbers changed):host']);
  });
  test('no reviewer runs below full effort (GSTA-131 eval: a light fix-check missed a fail-open a full one caught)', () => {
    for (const h of [{ fullPasses: 0, last: 'none' }, { fullPasses: 1, last: 'full', fixedBelow: true }, { fullPasses: 1, last: 'full', fixedBlocking: true }] as const)
      expect(planReview(base({ gateTagged: 1, history: h })).dispatches.filter(d => d.role !== 'outside-voice').every(d => d.effort === 'full')).toBe(true);
  });
  test('done dispatches nothing', () => expect(planReview(base({ history: { fullPasses: 1, last: 'full' } })).dispatches).toEqual([]));
});

describe('GSTA-131 pass-1 review repairs', () => {
  test('rule docs agents follow are code, and markdown inside a skill directory is code when the root is known', () => {
    for (const p of ['docs/captain.md', 'docs/unattended.md', 'docs/pregate.md']) expect(classifyPath(p)).toBe('code');
    expect(classifyPath('autoplan/notes.md')).toBe('docs');
    expect(classifyPath('autoplan/notes.md', ROOT)).toBe('code');
    expect(classifyPath('docs/howto-x.md', ROOT)).toBe('docs');
  });
  test.each([
    [{ gateTagged: 3 }], [{ gateTagged: null }], [{ deleted: ['test/old.test.ts'] }],
  ])('a tests-only diff with gate signal %j is gate class', (o: any) => expect(classifyDiff({ paths: ['test/a.test.ts'], gateTagged: 0, ...o }).class).toBe('gate'));
  test('a version-only package.json stays docs; the same path with any other edit is code', () => {
    expect(classifyDiff({ paths: ['package.json', 'CHANGELOG.md'], stampOnly: ['package.json'], gateTagged: 0 }).class).toBe('docs');
    expect(classifyDiff({ paths: ['package.json', 'CHANGELOG.md'], gateTagged: 0 }).class).toBe('code');
  });
  test('an open blocker never routes to a fix-check, even when other fixes landed', () => {
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBelow: true, blockingOpen: true }).step).toBe('stop');
    expect(nextStep({ fullPasses: 1, last: 'full', fixedBlocking: true, blockingOpen: true }).step).toBe('stop');
  });
  test('code and test source publish no numbers; prose and data files do', () => {
    expect(scanNumbers({ 'test/a.test.ts': ['const n = 3;', 'for (let i = 0; i < 10; i++)', 'expect(x).toBe(0.5)'] }).publishes).toBe(false);
    expect(scanNumbers({ 'test/fixtures/bench.json': ['{ "ratio": 0.74 }'] }).publishes).toBe(true);
  });
  test('--all-specialists forces every specialist; a code diff past 200 lines or with a CRITICAL adds the Red Team', () => {
    expect(planReview(base({ force: 'all' })).dispatches.filter(d => d.role === 'specialist').length).toBe(9);
    const has = (o: Partial<PlanInput>) => roles(planReview(base(o))).some(r => r.startsWith('red-team'));
    expect(has({ diffLines: 120 })).toBe(false);
    expect(has({ diffLines: 201 })).toBe(true);
    expect(has({ diffLines: 120, criticalFound: true })).toBe(true);
  });
});

describe('GSTA-131 coverage: Red Team and specialist arms', () => {
  const roles = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}`);
  test('Red Team runs on code past 200 lines or after a CRITICAL, and on every gate diff', () => {
    expect(roles(planReview(base({ diffLines: 120 })))).not.toContain('red-team:red-team');
    expect(roles(planReview(base({ diffLines: 201 })))).toContain('red-team:red-team');
    expect(roles(planReview(base({ diffLines: 120, criticalFound: true })))).toContain('red-team:red-team');
    expect(roles(planReview(base({ diffLines: 20, gateTagged: 1 })))).toContain('red-team:red-team');
  });
  test('scope arms select their specialist, state machines default on when scope is unknown, and --force all reaches docs class', () => {
    const picked = (scope: Record<string, string>) => roles(planReview(base({ scope: { SCOPE_STATE_MACHINE: 'false', ...scope } })));
    expect(picked({ SCOPE_MIGRATIONS: 'true' })).toContain('specialist:data-migration');
    expect(picked({ SCOPE_API: 'true' })).toContain('specialist:api-contract');
    expect(picked({ SCOPE_FRONTEND: 'true' })).toContain('specialist:design');
    expect(roles(planReview(base({ scope: {} })))).toContain('specialist:state-machines');
    expect(roles(planReview(base({ scope: { SCOPE_STATE_MACHINE: 'false' } })))).not.toContain('specialist:state-machines');
    const docsAll = planReview(base({ paths: ['docs/a.md'], force: 'all' }));
    expect(docsAll.class).toBe('docs');
    expect(docsAll.dispatches.filter(d => d.role === 'specialist').length).toBeGreaterThan(5);
    expect(roles(planReview(base({ paths: ['docs/a.md'], force: ['security'] })))).toEqual(['specialist:security']);
  });
});

const per = (o: Record<string, number>) => Object.entries(o).map(([p, lines]) => ({ path: p, lines, binary: false }));
const mixed = (o: Partial<PlanInput> = {}) => base({ paths: Object.keys(o.perPath ? Object.fromEntries(o.perPath.map(e => [e.path, 1])) : {}), ...o });
const err = (code: DepthError['code'], result?: DepthError['result']): DepthError => ({ code, detail: 'd', input: 'i', repair: 'r', ...(result ? { result } : {}) });

describe('review depth: the matrix', () => {
  test('runtime 0 (tests and docs only) is light: core only, nothing dispatched', () => {
    const p = planReview(mixed({ perPath: per({ 'test/a.test.ts': 300, 'docs/a.md': 40 }), diffLines: 340 }));
    expect([p.depth, p.runtimeLines, p.dispatches]).toEqual(['light', 0, []]);
  });
  test('runtime 1-50 is light plus one batched specialist: the fixed set, scope picks and the Red Team in one context', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 48, 'test/a.test.ts': 190, 'docs/a.md': 9 }), diffLines: 247 }));
    expect([p.depth, p.runtimeLines]).toEqual(['light', 48]);
    expect(p.dispatches).toEqual([
      { role: 'specialist', name: 'batched', effort: 'full', exclude: [':(exclude)docs/a.md'], checklists: ['testing', 'maintainability', 'security', 'performance', 'red-team'] },
      { role: 'adversarial-native', name: 'adversarial', effort: 'full', exclude: [], reason: 'backtest inconclusive (GSTA-147 D5)' },
    ]);
    expect(p.skipped.join('; ')).toContain('red-team (light depth');
    expect(planReview(mixed({ perPath: per({ 'src/app.ts': 48 }), adversarialRan: true, history: { fullPasses: 1, last: 'full', touchedGate: true, fixedBelow: true } })).dispatches.some(d => d.role === 'adversarial-native')).toBe(false);
  });
  test('runtime 51 is standard: thresholds read runtime lines, reviewers read their own hunks', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 51, 'test/a.test.ts': 400, 'README.md': 3 }), diffLines: 454 }));
    expect([p.depth, p.runtimeLines]).toEqual(['standard', 51]);
    expect(roles(p)).toEqual(['specialist:testing:full', 'specialist:maintainability:full', 'specialist:performance:full', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
    const ex = Object.fromEntries(p.dispatches.map(d => [d.name, d.exclude]));
    expect(ex.testing).toEqual([':(exclude)README.md']);
    expect(ex.maintainability).toEqual([':(exclude)README.md', ':(exclude)test/a.test.ts']);
    expect([ex.adversarial, ex['outside-voice']]).toEqual([[], []]);
  });
  test.each([
    ['scope error', { scope: { SCOPE_ERROR: 'boom' } }, 'scope_error', []],
    ['gate scan unavailable', { gateTagged: null }, 'gate_scan_unavailable', []],
    ['base registry invalid', { registry: { sha: 'abc', outputs: [], error: err('registry_invalid', 'REGEN_REGISTRY_INVALID') } }, 'registry_invalid', ['REGEN_REGISTRY_INVALID']],
    ['base registry unavailable', { registry: { sha: null, outputs: [], error: err('registry_unavailable') } }, 'registry_unavailable', []],
    ['numstat failure', { errors: [err('numstat_failed')] }, 'numstat_failed', []],
    ['binary code path', { perPath: [...per({ 'src/app.ts': 5 }), { path: 'lib/x.wasm', lines: 0, binary: true }], paths: ['src/app.ts', 'lib/x.wasm'] }, 'binary_code_path', []],
  ] as const)('%s fails closed to full with its code', (_n, o, code, codes) => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 5 }), ...(o as Partial<PlanInput>) }));
    expect(p.depth).toBe('full');
    expect(p.errors.map(e => e.code)).toContain(code);
    expect(p.codes).toEqual([...codes]);
    expect(roles(p)).toContain('red-team:red-team:full');
  });
  test.each([
    ['a gate path', { paths: ['src/app.ts', '.github/workflows/ci.yml'] }],
    ['a gate tag', { gateTagged: 1 }],
    ['a deleted test', { deleted: ['test/old.test.ts'] }],
    ['an edit to the registry', { paths: ['.gstack/generated.json'] }],
    ['an edit to SMALL_DIFF_LINES', { paths: ['lib/review-depth.ts'] }],
    ['the collector', { paths: ['lib/review-collect.ts'] }],
    ['the plan CLI', { paths: ['bin/gstack-review-plan'] }],
    ['the queue', { paths: ['lib/ship-queue-train.ts'] }],
    ['the Step 9 template', { paths: ['ship/sections/review-army.md.tmpl'] }],
  ] as const)('%s is full', (_n, o) => {
    const paths = (o as any).paths ?? ['src/app.ts'];
    expect(planReview(mixed({ perPath: per(Object.fromEntries(paths.map((p: string) => [p, 2]))), ...(o as Partial<PlanInput>) })).depth).toBe('full');
  });
  test('a registered glob output is excluded from runtime; a .tmpl edit plus its generated SKILL.md counts the tmpl only', () => {
    const p = planReview(mixed({ perPath: per({ 'ship/SKILL.md.tmpl': 30, 'ship/SKILL.md': 200 }), registry: { sha: 'abc', outputs: ['*/SKILL.md'] } }));
    expect([p.depth, p.runtimeLines]).toEqual(['light', 30]);
    expect(p.dispatches[0]!.exclude).toEqual([':(exclude)ship/SKILL.md']);
  });
  test('a path no base-registry entry names stays runtime', () => {
    expect(planReview(mixed({ perPath: per({ 'src/gen.ts': 60 }), registry: { sha: 'abc', outputs: ['lib/dom.js'] } })).runtimeLines).toBe(60);
  });
  test('numbers in light dispatch the outside voice with an empty exclude', () => {
    const p = planReview(mixed({ perPath: per({ 'docs/bench.md': 4 }), numbers: scanNumbers({ 'docs/bench.md': ['3x faster'] }) }));
    expect(p.depth).toBe('light');
    expect(p.dispatches).toEqual([{ role: 'outside-voice', name: 'outside-voice', effort: 'host', exclude: [] }]);
  });
  test('a fixed blocker in light raises the next full step to the standard set, Red Team included', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 30 }), history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect([p.depth, p.stepDepth]).toEqual(['light', 'standard']);
    expect(roles(p)).toEqual(['specialist:testing:full', 'specialist:maintainability:full', 'specialist:performance:full', 'red-team:red-team:full', 'adversarial-native:adversarial:full', 'outside-voice:outside-voice:host']);
  });
  test('--depth-floor raises and never lowers', () => {
    expect(depthFor({ cls: 'code', runtimeLines: 10, errors: [], floor: 'full' })).toBe('full');
    expect(depthFor({ cls: 'code', runtimeLines: 10, errors: [], floor: 'standard' })).toBe('standard');
    expect(depthFor({ cls: 'gate', runtimeLines: 10, errors: [], floor: 'standard' })).toBe('full');
    expect(depthFor({ cls: 'code', runtimeLines: 80, errors: [] })).toBe('standard');
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 10 }), floor: 'full' }));
    expect(p.depth).toBe('full');
    expect(p.depthReasons).toContain('floor:full');
  });
  test('depthOfCommitInput gives the same depth as the plan for the same input', () => {
    const i = { paths: ['src/app.ts', 'test/a.test.ts'], perPath: per({ 'src/app.ts': 51, 'test/a.test.ts': 9 }), gateTagged: 0 };
    expect(depthOfCommitInput(i)).toMatchObject({ depth: 'standard', runtimeLines: 51, rules: DEPTH_RULES, errors: [] });
    expect(depthOfCommitInput({ ...i, gateTagged: null }).depth).toBe('full');
  });
});

describe('review depth: diff commands and the rules hash', () => {
  test('DIFF_CMD shell-quotes each pathspec; a glob character makes the pathspec literal', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 10, "docs/my notes*.md": 3, "docs/it's.md": 1 }) }));
    const ex = p.dispatches[0]!.exclude;
    expect(ex).toEqual([':(exclude,literal)docs/my notes*.md', ":(exclude)docs/it's.md"]);
    expect(diffCommand(p.dispatches[0]!)).toBe("git diff <diff-base> -- . ':(exclude,literal)docs/my notes*.md' ':(exclude)docs/it'\\''s.md'");
    expect(diffCommand({ role: 'red-team', name: 'red-team', effort: 'full', exclude: [] })).toBe('git diff <diff-base>');
  });
  test('DEPTH_RULES hashes the deciding constants: a comment-only edit keeps it, a threshold edit changes it', () => {
    expect(DEPTH_RULES).toMatch(/^[0-9a-f]{16}$/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-rules-'));
    try {
      const src = fs.readFileSync(path.join(ROOT, 'lib/review-depth.ts'), 'utf8');
      fs.symlinkSync(path.join(ROOT, 'lib/ship-policy.ts'), path.join(dir, 'ship-policy.ts'));
      const hashOf = (text: string) => {
        fs.writeFileSync(path.join(dir, 'review-depth.ts'), text);
        fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
        const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      expect(hashOf('// a comment-only edit\n' + src)).toBe(DEPTH_RULES);
      expect(hashOf(src.replace('SMALL_DIFF_LINES = 50', 'SMALL_DIFF_LINES = 60'))).not.toBe(DEPTH_RULES);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('D6: the scoped second pass after a blocking fix (GSTA-152 PR B)', () => {
  const r = (p: ReturnType<typeof planReview>) => p.dispatches.map(d => `${d.role}:${d.name}`);
  const fixed = (rangeRuntimeLines: number | null | undefined, o: Partial<PlanInput['history']> = {}): PlanInput['history'] => ({ fullPasses: 1, last: 'full', fixedBlocking: true, rangeRuntimeLines, ...o });
  // gstack-evals#19: a standard diff, pass 1 fixed one CRITICAL from a QA probe, the fix range was 3 files +18/-6 of runtime.
  const n19 = (o: Partial<PlanInput> = {}) => mixed({ perPath: per({ 'src/a.ts': 300, 'src/b.ts': 100, 'src/c.ts': 60, 'test/a.test.ts': 80 }), diffLines: 540, scope: { SCOPE_BACKEND: 'true' }, history: fixed(24), adversarialRan: true, ...o });

  test('the #19 shape plans one fix-check, the Red Team and the native adversarial pass, not the specialist army', () => {
    const before = planReview(n19({ history: { fullPasses: 1, last: 'full', fixedBlocking: true } }));
    expect(before.next.step).toBe('full');
    expect(before.dispatches.length).toBeGreaterThanOrEqual(6);
    const p = planReview(n19());
    expect(p.next.step).toBe('scoped');
    expect(p.next.reason).toContain('24 runtime lines');
    expect(r(p)).toEqual(['fix-check:fix-check', 'red-team:red-team', 'adversarial-native:adversarial']);
    expect(p.dispatches.every(d => d.effort === 'full' && d.exclude.length === 0)).toBe(true);
  });
  test('Step 11 voices that have not run yet stay listed, as on a full pass 2', () => {
    const p = planReview(n19({ adversarialRan: false }));
    expect(r(p)).toEqual(['fix-check:fix-check', 'red-team:red-team', 'adversarial-native:adversarial', 'outside-voice:outside-voice']);
    expect(p.skipped).toContain('specialists (scoped pass)');
    expect(planReview(n19()).skipped).toEqual(expect.arrayContaining(['specialists (scoped pass)', 'outside-voice (scoped pass)']));
    expect(planReview(n19({ force: ['security'] })).skipped).toContain('specialists (scoped pass; forced ones dispatched)');
  });
  test.each([
    ['full depth (a gate tag)', { gateTagged: 1 }],
    ['a fail-closed classification', { gateTagged: null }],
    ['--depth-floor full', { floor: 'full' as const }],
    ['a 151-line range', { history: fixed(151) }],
    ['a missing range', { history: fixed(undefined) }],
    ['an unread range', { history: fixed(null) }],
    ['a fix that touched a gate-class path', { history: fixed(10, { touchedGate: true }) }],
  ])('%s keeps the full pass 2', (_n, o) => {
    const p = planReview(n19(o as Partial<PlanInput>));
    expect(p.next.step).toBe('full');
    expect(p.dispatches.some(d => d.role === 'specialist')).toBe(true);
  });
  test('a force-included specialist and changed published numbers keep their reviewers', () => {
    expect(r(planReview(n19({ force: ['security'] })))).toEqual(['fix-check:fix-check', 'specialist:security', 'red-team:red-team', 'adversarial-native:adversarial']);
    const numbers = scanNumbers({ 'docs/bench.md': ['3x faster'] });
    expect(r(planReview(n19({ numbers, reviewedNumbers: 'old' })))).toContain('outside-voice:outside-voice (numbers changed)');
    expect(r(planReview(n19({ numbers, reviewedNumbers: numbers.fingerprint })))).not.toContain('outside-voice:outside-voice (numbers changed)');
  });
  test('150 is scoped, 151 is full, and a docs-only range is scoped without the native adversarial pass', () => {
    expect(SCOPED_RANGE_LINES).toBe(150);
    expect(planReview(n19({ history: fixed(150) })).next.step).toBe('scoped');
    expect(planReview(n19({ history: fixed(151) })).next.step).toBe('full');
    const docs = planReview(n19({ history: fixed(0) }));
    expect(docs.next.step).toBe('scoped');
    expect(r(docs)).toEqual(['fix-check:fix-check', 'red-team:red-team']);
  });
  test('a light diff with a fixed blocker gets the scoped set: the raise adds the Red Team, never the standard army', () => {
    const p = planReview(mixed({ perPath: per({ 'src/app.ts': 30 }), history: fixed(12), adversarialRan: true }));
    expect(p.next.step).toBe('scoped');
    expect(r(p)).toEqual(['fix-check:fix-check', 'red-team:red-team', 'adversarial-native:adversarial']);
  });
  test('the scoped pass counts toward the cap, and a blocker it leaves stops for the owner', () => {
    expect(nextStep(fixed(10, { fullPasses: FULL_PASS_CAP }), 'standard').step).toBe('fix-check');
    expect(nextStep({ fullPasses: FULL_PASS_CAP, last: 'full', blockingOpen: true, rangeRuntimeLines: 10 }, 'light').step).toBe('stop');
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 10, m)).toISOString();
    const rows = [
      { skill: 'review', via: 'ship', timestamp: at(1), pass: 1, dispatches: [{ role: 'specialist' }, { role: 'adversarial-native' }] },
      { skill: 'review', via: 'ship', timestamp: at(2), pass: 2, scope: 'scoped', dispatches: [{ role: 'fix-check' }, { role: 'red-team' }, { role: 'adversarial-native' }] },
    ];
    const s = summarizeReviewLoop(rows, at(0));
    expect(s.passes).toBe(2);
    expect(s.fix_checks).toBeUndefined();
    expect(s.dispatches).toEqual({ specialist: 1, 'adversarial-native': 2, 'fix-check': 1, 'red-team': 1 });
  });
  test('nextStep without a depth keeps the full pass (planReview is where depth is known)', () => {
    expect(nextStep(fixed(10)).step).toBe('full');
    expect(nextStep(fixed(10), 'full').step).toBe('full');
    expect(nextStep(fixed(10), 'standard').step).toBe('scoped');
  });
  test('REVIEW_PLAN prints the chosen step and its reason', () => {
    const line = reviewPlanLine(planReview(n19()), 2);
    expect(line).toMatch(/^REVIEW_PLAN: class=code pass=2 next=scoped dispatches=3 numbers=no fingerprint=none reason="[^"]*24 runtime lines[^"]*"$/);
    expect(reviewPlanLine(planReview(n19({ history: fixed(151) })), 2)).toContain('reason="a blocking finding was fixed');
  });
  test('DEPTH_RULES changes when the scoped-range constant does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-rules-scoped-'));
    try {
      const src = fs.readFileSync(path.join(ROOT, 'lib/review-depth.ts'), 'utf8');
      expect(src).toContain('SCOPED_RANGE_LINES = 150');
      fs.symlinkSync(path.join(ROOT, 'lib/ship-policy.ts'), path.join(dir, 'ship-policy.ts'));
      fs.writeFileSync(path.join(dir, 'review-depth.ts'), src.replace('SCOPED_RANGE_LINES = 150', 'SCOPED_RANGE_LINES = 151'));
      fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
      const res = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).not.toBe(DEPTH_RULES);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('consumers name the scoped step: the Step 9 template and the transitions table', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md.tmpl'), 'utf8');
    expect(tmpl).toContain('--range-base $PASS_HEAD');
    expect(tmpl).toContain('`scoped` is 3 too.');
    expect(tmpl).toContain('"scope":"scoped"');
    expect(tmpl).toContain('raised_by');
    const policy = fs.readFileSync(path.join(ROOT, 'docs/review-policy.md'), 'utf8');
    expect(policy).toContain('| a full pass that fixed a blocking finding, below the cap, on a diff below full depth with a fix range of at most 150 runtime lines | scoped pass on the range |');
  });
});
