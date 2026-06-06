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
export const PARITY_INVARIANTS: ParityInvariant[] = [
  {
    skill: 'cso',
    mustContain: ['OWASP', 'STRIDE', 'daily', 'comprehensive', 'verif'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 30_000,
  },
  {
    // Carved (v2 plan T9): skeleton SKILL.md + sections/*.md. Content checks run
    // against the union (relocated phrases still count); size floors run against
    // the union (total behavior preserved); maxSkeletonBytes asserts the
    // always-loaded skeleton actually shrank from the ~167KB monolith.
    skill: 'ship',
    sectioned: true,
    maxSkeletonBytes: 90_000,
    mustContain: [
      'VERSION',
      'CHANGELOG',
      'review',
      'merge',
      'PR',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 120_000,
  },
  {
    // Carved (v2 plan T9): skeleton SKILL.md + sections/review-sections.md.
    // Content + size floors run against the union (relocated prose still counts);
    // maxSkeletonBytes asserts the always-loaded skeleton shrank from the ~138KB
    // monolith to ~81KB (measured 80,731 B, -42%). Headroom to 90KB so a small
    // skeleton edit doesn't trip CI, but a 10KB regression does.
    skill: 'plan-ceo-review',
    sectioned: true,
    maxSkeletonBytes: 90_000,
    mustContain: [
      'SCOPE EXPANSION',
      'SELECTIVE EXPANSION',
      'HOLD SCOPE',
      'SCOPE REDUCTION',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 80_000,
  },
  {
    // Carved (v2 plan T9): skeleton + sections/review-sections.md. The 4-section
    // review, outside voice, and required outputs moved to the section; content
    // checks run against the union. Skeleton shrank 106,984 -> 54,892 B (-48.7%);
    // maxSkeletonBytes 62KB = measured + headroom.
    skill: 'plan-eng-review',
    sectioned: true,
    maxSkeletonBytes: 62_000,
    mustContain: [
      'Architecture',
      'Code Quality',
      'Test',
      'Performance',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    // Carved (v2 plan T9): skeleton + sections/review-sections.md. The 7 design
    // passes + required outputs moved to the section; content checks run against
    // the union. Skeleton shrank 112,057 -> 76,024 B (-32.2%); maxSkeletonBytes
    // 82KB = measured + headroom.
    skill: 'plan-design-review',
    sectioned: true,
    maxSkeletonBytes: 82_000,
    mustContain: [
      'design',
      'visual',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
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
    // Carved (v2 plan T9): skeleton SKILL.md + sections/design-and-handoff.md.
    // Phase 5 (design doc) + Phase 6 (handoff) moved into the section, so
    // 'design doc' / 'problem statement' now live there — content checks run
    // against the union. maxSkeletonBytes asserts the always-loaded skeleton
    // shrank from the ~118KB monolith to ~89KB (measured 88,975 B, -24.8%);
    // headroom to 96KB so a small skeleton edit doesn't trip CI.
    skill: 'office-hours',
    sectioned: true,
    maxSkeletonBytes: 96_000,
    mustContain: ['design doc', 'problem statement'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    skill: 'autoplan',
    mustContain: ['ceo', 'eng', 'design'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
];
