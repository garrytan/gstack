/**
 * Plan D3: investigate recipes and backlog mode. Pins the carve shape (manifest
 * ids, STOP pointers, the Arguments table routing `--backlog`), the tokens each
 * recipe must carry (commands, the `## Flake evidence` section, the four backlog
 * classes, the never-retry rule), the Phase 1 additions, the benchmark
 * `git update-index --refresh` line, and that an external host gets the recipes
 * inlined. Prose is not pinned.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from './helpers/carve-guards';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const RECIPES = ['flake', 'polluter', 'race', 'eval-bisect', 'backlog'] as const;

describe('investigate carve', () => {
  const manifest = JSON.parse(read('investigate/sections/manifest.json')) as { skill: string; sections: Array<{ id: string; file: string; trigger: string }> };
  const skeleton = read('investigate/SKILL.md');
  test('manifest lists the five recipes and the registry guards them', () => {
    expect(manifest.skill).toBe('investigate');
    expect(manifest.sections.map(s => s.id)).toEqual([...RECIPES]);
    expect(CARVE_GUARDS.investigate!.expectedSections).toEqual(manifest.sections.map(s => s.file));
    for (const s of manifest.sections) expect(fs.existsSync(path.join(ROOT, 'investigate', 'sections', `${s.file}.tmpl`))).toBe(true);
  });
  test('the skeleton routes: Arguments table with --backlog before the first STOP, one STOP per recipe, recipes after the Phase 2 pattern table', () => {
    const args = skeleton.indexOf('## Arguments');
    const firstStop = skeleton.indexOf('> **STOP.**');
    expect(args).toBeGreaterThan(0);
    expect(args).toBeLessThan(firstStop);
    expect(skeleton).toMatch(/\| `\/investigate --backlog \[<issue numbers or gh query>\]` \| Read-only triage/);
    for (const id of RECIPES) expect(skeleton).toContain(`sections/${id}.md`);
    expect(skeleton.match(/> \*\*STOP\.\*\*/g)!.length).toBe(RECIPES.length);
    const recipes = skeleton.indexOf('### Recipes');
    expect(recipes).toBeGreaterThan(skeleton.indexOf('## Phase 2: Pattern Analysis'));
    expect(recipes).toBeLessThan(skeleton.indexOf('## Phase 3: Hypothesis Testing'));
    expect(skeleton).not.toContain('## Flake recipe');
  });
  test('Phase 1 additions: call sites before calling two queries duplicates; update-index before timing git in a worktree (investigate and benchmark)', () => {
    const phase1 = skeleton.slice(skeleton.indexOf('## Phase 1: Root Cause Investigation'), skeleton.indexOf('## Scope Lock'));
    expect(phase1).toMatch(/Before calling two queries, helpers or code paths duplicates, read their call sites/);
    expect(phase1).toContain('`git update-index --refresh`');
    const benchmark = read('benchmark/SKILL.md');
    expect(benchmark).toContain('git update-index --refresh >/dev/null 2>&1 || true');
    expect(benchmark).toMatch(/before timing anything that spawns git/);
  });
});

describe('recipe tokens', () => {
  test('flake: reproduce on main, N runs, gh run list, forced probe, never loosen, rerun rule, Flake evidence section, paid evals never retried', () => {
    const flake = read('investigate/sections/flake.md');
    expect(flake).toContain('## Flake recipe');
    expect(flake).toContain('git worktree add <dir> origin/<base>');
    expect(flake).toContain('ship-measure.ts free --files <file> --reruns N');
    expect(flake).toContain('gh run list --branch <branch> --workflow <workflow> --status success --limit N');
    expect(flake).toContain('**Forced probe.**');
    expect(flake).toContain('**Never loosen.**');
    expect(flake).toContain('P(fail | regression)');
    expect(flake).toContain('RH-15');
    expect(flake).toContain('**A rerun only when the cause is known and outside the PR**');
    expect(flake).toContain('`## Flake evidence` in the PR body (required for any flake fix)');
    expect(flake).toMatch(/Paid evals\s+are never retried \(`EVAL_POLICY`/);
    expect(flake).toContain('routing note');
  });
  test('polluter: CI file order, ship-measure free --files bisect, the leak list, the POLLUTER report line', () => {
    const polluter = read('investigate/sections/polluter.md');
    expect(polluter).toContain('bun run scripts/ship-measure.ts free --shard <I>');
    expect(polluter).toContain('--files <earlier-1>,<earlier-2>,…,<victim> --reruns 3');
    expect(polluter).toContain('**Bisect the earlier files.**');
    expect(polluter).toContain('POLLUTER: <file> leaked <what> into <victim>; fixed by <change>');
    expect(polluter).toContain('**Fix the polluter, not the victim.**');
  });
  test('race: timing probes, forced interleaving, the concurrent-writer template', () => {
    const race = read('investigate/sections/race.md');
    expect(race).toContain('**Timing probes.**');
    expect(race).toContain('**Forced interleaving.**');
    expect(race).toContain('Promise.allSettled(Array.from({ length: N }, (_, i) => writer(i)))');
    expect(race).toMatch(/N ≥ 8/);
  });
  test('eval-bisect: distinct revisions, cached cheap scorer, detached runs with the sentinel, never retry a paid case', () => {
    const bisect = read('investigate/sections/eval-bisect.md');
    expect(bisect).toContain('**Distinct revisions only.**');
    expect(bisect).toContain('.gstack/tmp/eval-bisect/');
    expect(bisect).toContain('### gstack-detach EXIT=<code> ###');
    expect(bisect).toContain('Never retry a paid case');
  });
  test('backlog: the four classes, repro required for still_open, contributor PRs evidence only, read-only table, no closing', () => {
    const backlog = read('investigate/sections/backlog.md');
    for (const cls of ['`still_open`', '`already_fixed <commit>`', '`partially_fixed`', '`owned_elsewhere`']) expect(backlog).toContain(cls);
    expect(backlog).toMatch(/A reproduction is\s+required/);
    expect(backlog).toContain('`repro needed`');
    expect(backlog).toContain('**Contributor PRs are evidence only.**');
    expect(backlog).toContain('| issue | class | receipt (commit / repro / link) | contributor PR (evidence) | next |');
    expect(backlog).toMatch(/no `gh issue close`/);
    expect(backlog).not.toMatch(/gh issue close <n>/);
  });
});

describe('external hosts inline the recipes', () => {
  const codex = path.join(ROOT, '.agents', 'skills', 'gstack-investigate', 'SKILL.md');
  test.skipIf(!fs.existsSync(codex))('the codex render carries every recipe heading and no section pointer', () => {
    const text = fs.readFileSync(codex, 'utf8');
    for (const heading of ['## Flake recipe', '## Polluter recipe', '## Race recipe', '## Eval bisect recipe', '## Backlog mode']) expect(text).toContain(heading);
    expect(text).not.toContain('sections/flake.md');
  });
});
