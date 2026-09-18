/**
 * Context-budget capture — the ratchet's write side.
 *
 * Captures the current ALWAYS-ON + EAGER token ledgers from
 * `lib/context-bill.ts` into `test/fixtures/context-budget.json`, with
 * deliberate headroom baked into every ceiling:
 *
 *   - alwaysOnTotal:       actual × 1.05  (full-frontmatter catalog, aggregate)
 *   - eagerPerInvocation:  actual × 1.10  (per-skill SKILL.md + forced refs)
 *
 * Why these two ledgers and no others: they are the ledgers nothing else
 * measures (plan OV8). The shrink floor lives in skill-size-budget.test.ts,
 * growth ratios + minBytes floors in parity-suite.test.ts, the name+description
 * discovery cap in catalog-budget.test.ts. TOTAL overlaps those guards, so it
 * is deliberately not budgeted here.
 *
 * Ratchet protocol (mirrors catalog-budget.test.ts):
 *   - Legitimate growth (a real feature grew a skill past its ceiling):
 *     re-run `bun test/helpers/capture-context-budget.ts` and commit the
 *     refreshed fixture IN THE SAME COMMIT as the growth, so the diff shows
 *     the conscious decision.
 *   - After a reduction phase lands: re-run the capture so the ceilings
 *     ratchet DOWN and the win is locked.
 *
 * Test-fixture skill trees under test/fixtures/ are excluded — they exist to
 * test context-bill itself and must not couple the ratchet to test data.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildBill, type Bill } from '../../lib/context-bill';

export const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');
export const BUDGET_FIXTURE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'context-budget.json');

export const ALWAYS_ON_HEADROOM = 1.05;
export const EAGER_HEADROOM = 1.10;

/**
 * Skill names come from path.relative in buildBill, which yields backslash
 * separators on Windows. The fixture keys are POSIX. Normalize once here so
 * the filter, the fixture keys, and checkBudget's name matching agree on
 * every platform (the ratchet test runs in the curated Windows lane).
 */
export function toPosixName(name: string): string {
  return name.split(path.sep).join('/');
}

/** Skills that exist only as context-bill test data — never budgeted. */
export function isFixtureSkill(name: string): boolean {
  return toPosixName(name).startsWith('test/fixtures/');
}

export interface ContextBudget {
  _comment: string;
  alwaysOnTotal: number;
  eagerPerInvocation: Record<string, number>;
}

/**
 * The root SKILL.md's bill name falls back to the checkout directory's
 * basename (path.relative gives '' at the root), which is machine-specific:
 * a Conductor worktree named anything but "gstack" would mismatch the fixture
 * key, and the documented "re-run the capture" recovery would then bake the
 * local dirname INTO the committed fixture. Pin it to the skill's frontmatter
 * name instead — stable across every clone.
 */
export const ROOT_SKILL_KEY = 'gstack';

/**
 * The bill the ratchet grades: repo tree minus test-fixture skill dirs, with
 * POSIX-normalized names, the root skill pinned to ROOT_SKILL_KEY, symlink
 * aliases deduped by realpath (connect-chrome -> open-gstack-browser; on
 * Windows checkouts the symlink materializes as a plain file and the alias
 * dir vanishes, so budgeting it would make the stale-ceiling test
 * platform-dependent — same dedupe the skill census uses), and ALL totals
 * rebuilt from the filtered list (a partially-updated totals object would
 * hand fixture-polluted numbers to any future consumer of the
 * perInvocation/totalMd fields).
 */
export function buildRatchetBill(root: string = REPO_ROOT): Bill {
  const bill = buildBill(root);
  const candidates = bill.skills
    .map((s) => ({
      ...s,
      name: s.dir === bill.root ? ROOT_SKILL_KEY : toPosixName(s.name),
    }))
    .filter((s) => !isFixtureSkill(s.name));
  // One ceiling per PHYSICAL skill: group by realpath, prefer the entry whose
  // dir IS the realpath (the real dir) over symlink aliases.
  const byReal = new Map<string, (typeof candidates)[number]>();
  for (const s of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(s.dir);
    } catch {
      real = s.dir;
    }
    const cur = byReal.get(real);
    if (!cur || (s.dir === real && cur.dir !== real)) byReal.set(real, s);
  }
  const kept = new Set(byReal.values());
  const skills = candidates.filter((s) => kept.has(s));
  return {
    ...bill,
    skills,
    totals: {
      skillCount: skills.length,
      alwaysOnBytes: skills.reduce((n, s) => n + s.frontmatterBytes, 0),
      alwaysOnTokens: skills.reduce((n, s) => n + s.frontmatterTokens, 0),
      eagerBytesBySkill: Object.fromEntries(skills.map((s) => [s.name, s.eagerBytes])),
      eagerTokensBySkill: Object.fromEntries(skills.map((s) => [s.name, Math.round(s.eagerTokens)])),
      perInvocationBytesBySkill: Object.fromEntries(skills.map((s) => [s.name, s.perInvocationBytes])),
      perInvocationTokensBySkill: Object.fromEntries(
        skills.map((s) => [s.name, Math.round(s.perInvocationTokens)]),
      ),
      totalMdBytes: skills.reduce((n, s) => n + s.totalMdBytes, 0),
      totalMdTokens: skills.reduce((n, s) => n + s.totalMdTokens, 0),
    },
  };
}

export function captureContextBudget(root: string = REPO_ROOT): ContextBudget {
  const bill = buildRatchetBill(root);
  const eagerPerInvocation: Record<string, number> = {};
  for (const s of [...bill.skills].sort((a, b) => a.name.localeCompare(b.name))) {
    eagerPerInvocation[s.name] = Math.ceil(s.eagerTokens * EAGER_HEADROOM);
  }
  return {
    _comment:
      'Context-budget ratchet ceilings (~tokens). Regenerate: bun test/helpers/capture-context-budget.ts. ' +
      `Headroom: alwaysOnTotal x${ALWAYS_ON_HEADROOM}, eagerPerInvocation x${EAGER_HEADROOM}. ` +
      'Graded by test/context-budget-ratchet.test.ts via lib/context-bill.ts checkBudget.',
    alwaysOnTotal: Math.ceil(bill.totals.alwaysOnTokens * ALWAYS_ON_HEADROOM),
    eagerPerInvocation,
  };
}

// CLI: write the fixture atomically (temp + rename) — an interrupted capture
// must never leave truncated JSON that breaks the suite at module load.
if (import.meta.main) {
  const budget = captureContextBudget();
  const tmp = `${BUDGET_FIXTURE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(budget, null, 2) + '\n');
  fs.renameSync(tmp, BUDGET_FIXTURE_PATH);
  const n = Object.keys(budget.eagerPerInvocation).length;
  console.log(
    `Wrote ${path.relative(REPO_ROOT, BUDGET_FIXTURE_PATH)}: alwaysOnTotal=${budget.alwaysOnTotal} tok, ${n} eager ceilings`,
  );
}
