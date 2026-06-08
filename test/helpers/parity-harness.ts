/**
 * Cathedral parity-eval harness (v1.45.0.0 T0b).
 *
 * Compares CURRENT SKILL.md output to a v1.44.1 golden baseline along three
 * axes: STRUCTURE (frontmatter shape), CONTENT (must-preserve phrases per
 * skill family), and SIZE (per-skill byte budget). The fourth axis —
 * BEHAVIORAL parity via LLM-as-judge — runs on top of this harness in the
 * periodic-tier eval suite (paid, ~$0.20 per skill judge call).
 *
 * The structural + content checks ship in v1.45.0.0 as the foundation; the
 * LLM-judge layer lands in v2.0.0.0 alongside the sections/ pattern. Both
 * use this module's APIs.
 *
 * Why a separate harness from skill-size-budget.test.ts: that one enforces
 * size discipline only. This module supports content invariants per skill
 * family (e.g., cso must preserve OWASP/STRIDE; plan-ceo must preserve
 * mode-selection phrasing) so future compression can't silently strip
 * load-bearing prose even when size stays within ratio.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ParityBaseline, SkillBaselineEntry } from './capture-parity-baseline';
import { captureBaseline } from './capture-parity-baseline';
import { CARVE_GUARDS } from './carve-guards';

export interface ParityInvariant {
  skill: string;
  /** Phrases that MUST appear in the generated SKILL.md (case-insensitive substring). */
  mustContain?: string[];
  /** Markdown H2 headings that MUST appear. */
  mustHaveHeadings?: string[];
  /** Maximum byte size growth ratio vs baseline. 1.0 = no growth allowed. */
  maxSizeRatio?: number;
  /** Minimum byte size (catches over-stripping cliffs). */
  minBytes?: number;
  /**
   * Carved skill (v2 plan T9): the skill is a skeleton SKILL.md plus on-demand
   * sections/*.md. When true:
   *  - mustContain / mustHaveHeadings run against skeleton + ALL sections unioned,
   *    so a phrase that moved into a section still counts (content preserved, just
   *    relocated — that's the whole point of the carve).
   *  - minBytes / maxSizeRatio run against the UNION bytes, not the skeleton alone
   *    (total behavior must not shrink; the win is what's no longer always-loaded,
   *    which the union size deliberately does NOT measure — maxSkeletonBytes does).
   *  - maxSkeletonBytes asserts the always-loaded skeleton actually shrank.
   * Without this, lowering minBytes to fit a 65KB skeleton would make the size
   * floor toothless (Codex outside-voice #12).
   */
  sectioned?: boolean;
  /** Max bytes for the always-loaded skeleton SKILL.md (carved skills only). */
  maxSkeletonBytes?: number;
}

export interface ParityCheckResult {
  skill: string;
  passed: boolean;
  failures: string[];
}

/**
 * Read a skill's check text + sizes. For a carved skill, union the skeleton with
 * every sections/*.md so relocated content still counts and the union size
 * measures total preserved behavior; skeletonBytes is reported separately so the
 * always-loaded shrink can be asserted. For a monolith, text == skeleton.
 */
export function readSkillForParity(
  repoRoot: string,
  skill: string,
  sectioned: boolean,
): { text: string; unionBytes: number; skeletonBytes: number } {
  const skeleton = fs.readFileSync(path.join(repoRoot, skill, 'SKILL.md'), 'utf-8');
  const skeletonBytes = Buffer.byteLength(skeleton, 'utf-8');
  if (!sectioned) return { text: skeleton, unionBytes: skeletonBytes, skeletonBytes };

  let text = skeleton;
  let unionBytes = skeletonBytes;
  const sectionsDir = path.join(repoRoot, skill, 'sections');
  if (fs.existsSync(sectionsDir)) {
    for (const f of fs.readdirSync(sectionsDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const sec = fs.readFileSync(path.join(sectionsDir, f), 'utf-8');
      text += '\n' + sec;
      unionBytes += Buffer.byteLength(sec, 'utf-8');
    }
  }
  return { text, unionBytes, skeletonBytes };
}

export function checkSkillParity(
  invariant: ParityInvariant,
  current: SkillBaselineEntry,
  baseline: SkillBaselineEntry | undefined,
  repoRoot: string,
): ParityCheckResult {
  const failures: string[] = [];
  const needText = !!(invariant.mustContain?.length || invariant.mustHaveHeadings?.length);

  // Resolve the text + size to check against. Carved skills union skeleton +
  // sections; monoliths use the skeleton alone. Read on demand so size-only
  // invariants don't pay for a file read they don't need (monolith path).
  let checkText: string | null = null;
  let checkBytes = current.skillMdBytes;
  if (invariant.sectioned) {
    try {
      const r = readSkillForParity(repoRoot, invariant.skill, true);
      checkText = r.text;
      checkBytes = r.unionBytes;
      if (invariant.maxSkeletonBytes !== undefined && r.skeletonBytes > invariant.maxSkeletonBytes) {
        failures.push(`skeleton ${r.skeletonBytes} > maxSkeletonBytes ${invariant.maxSkeletonBytes}`);
      }
    } catch (err) {
      failures.push(`cannot read carved skill ${invariant.skill}: ${(err as Error).message}`);
    }
  } else if (needText) {
    try {
      checkText = fs.readFileSync(path.join(repoRoot, invariant.skill, 'SKILL.md'), 'utf-8');
    } catch (err) {
      failures.push(`cannot read ${path.join(repoRoot, invariant.skill, 'SKILL.md')}: ${(err as Error).message}`);
    }
  }

  // SIZE checks (union bytes for carved skills, skeleton bytes for monoliths)
  if (invariant.maxSizeRatio !== undefined && baseline) {
    const ratio = checkBytes / baseline.skillMdBytes;
    if (ratio > invariant.maxSizeRatio) {
      failures.push(`size ratio ${ratio.toFixed(3)} > maxSizeRatio ${invariant.maxSizeRatio}`);
    }
  }
  if (invariant.minBytes !== undefined && checkBytes < invariant.minBytes) {
    failures.push(`size ${checkBytes} < minBytes ${invariant.minBytes}`);
  }

  // CONTENT checks
  if (needText && checkText !== null) {
    const lower = checkText.toLowerCase();
    for (const phrase of invariant.mustContain ?? []) {
      if (!lower.includes(phrase.toLowerCase())) {
        failures.push(`missing required phrase: "${phrase}"`);
      }
    }
    for (const heading of invariant.mustHaveHeadings ?? []) {
      if (!checkText.includes(heading)) {
        failures.push(`missing required heading: "${heading}"`);
      }
    }
  }

  return {
    skill: invariant.skill,
    passed: failures.length === 0,
    failures,
  };
}

export interface ParityReport {
  baselineTag: string;
  currentCapturedAt: string;
  totalChecks: number;
  passed: number;
  failed: number;
  details: ParityCheckResult[];
}

export function runParityChecks(opts: {
  repoRoot: string;
  baseline: ParityBaseline;
  invariants: ParityInvariant[];
}): ParityReport {
  const { repoRoot, baseline, invariants } = opts;
  const current = captureBaseline({ repoRoot });
  const details: ParityCheckResult[] = [];
  for (const invariant of invariants) {
    const baselineEntry = baseline.skills[invariant.skill];
    const currentEntry = current.skills[invariant.skill];
    if (!currentEntry) {
      details.push({
        skill: invariant.skill,
        passed: false,
        failures: [`skill removed: ${invariant.skill} present in baseline but not current state`],
      });
      continue;
    }
    details.push(checkSkillParity(invariant, currentEntry, baselineEntry, repoRoot));
  }
  return {
    baselineTag: baseline.tag,
    currentCapturedAt: current.capturedAt,
    totalChecks: details.length,
    passed: details.filter(d => d.passed).length,
    failed: details.filter(d => !d.passed).length,
    details,
  };
}

/**
 * Standard invariant registry — the v1.45.0.0 set.
 *
 * Each entry pins what must-not-break in a skill family. Extend as future
 * skills land. Phase B (v2.0.0.0) adds LLM-judge invariants on top of these.
 */
/**
 * Monolith (non-carved) invariants — hand-written. Carved-skill invariants are
 * generated from CARVE_GUARDS below (single source of truth), so they never drift
 * from the size-budget / static / behavioral guards.
 */
const MONOLITH_INVARIANTS: ParityInvariant[] = [
  // cso is now carved — its invariant is generated from CARVE_GUARDS below.
  {
    skill: 'review',
    mustContain: ['confidence', 'P1', 'P2'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    skill: 'qa',
    mustContain: ['bug', 'browse', 'fix'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 50_000,
  },
  {
    skill: 'investigate',
    mustContain: ['root cause', 'hypothes'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 30_000,
  },
  {
    skill: 'autoplan',
    mustContain: ['ceo', 'eng', 'design'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
];

/**
 * Carved-skill invariants, GENERATED from the canonical CARVE_GUARDS registry
 * (EQ1: single source of truth). Each carve's skeleton-shrink floor
 * (maxSkeletonBytes), union floor (minUnionBytes), and content invariants
 * (mustContain) live in carve-guards.ts; this just projects them into the parity
 * shape. Adding a carve there auto-adds its union guard here — which is how
 * plan-devex-review (previously in SECTIONS_EXTRACTED but missing a sectioned
 * parity invariant) is now guarded.
 */
const CARVED_INVARIANTS: ParityInvariant[] = Object.values(CARVE_GUARDS).map((g) => ({
  skill: g.skill,
  sectioned: true,
  maxSkeletonBytes: g.maxSkeletonBytes,
  minBytes: g.minUnionBytes,
  mustContain: g.mustContain,
  mustHaveHeadings: ['## Preamble', '## When to invoke'],
  maxSizeRatio: g.maxSizeRatio ?? 1.05,
}));

export const PARITY_INVARIANTS: ParityInvariant[] = [
  ...MONOLITH_INVARIANTS,
  ...CARVED_INVARIANTS,
];
