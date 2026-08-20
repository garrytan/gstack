/**
 * Pure carve-guard check functions, with an injectable `root` (codex
 * outside-voice #5, refined-plan pass) so the negative tests (T5) can point the
 * REAL guards at a broken fixture dir instead of testing a wrapper.
 *
 * Used by:
 *   - test/carve-section-ordering.test.ts    (E2)  → checkOrdering
 *   - test/carve-guard-completeness.test.ts  (E1)  → discoverCarvedSkills + checkCompleteness
 *   - test/carve-guards-negative.test.ts     (T5)  → both, against a fixture root
 *
 * Imports only the leaf data module (carve-guards.ts) + node stdlib — no cycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CARVE_GUARDS, type CarveGuard } from './carve-guards';

/** Every dir under `root` that owns a sections/manifest.json. Injectable for tests. */
export function discoverCarvedSkills(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(root, name, 'sections', 'manifest.json')))
    .sort();
}

function readSkeleton(root: string, skill: string): string {
  return fs.readFileSync(path.join(root, skill, 'SKILL.md'), 'utf-8');
}

/** Skeleton + every sections/*.md unioned (relocated content still counts). */
function readUnion(root: string, skill: string): string {
  let text = readSkeleton(root, skill);
  const dir = path.join(root, skill, 'sections');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.md') && !f.endsWith('.md.tmpl')) {
        text += '\n' + fs.readFileSync(path.join(dir, f), 'utf-8');
      }
    }
  }
  return text;
}

const STOP = '> **STOP.**';

/**
 * Static ordering invariants for one carved skill. Returns a list of failure
 * strings (empty = pass). Pure: takes `root` so it runs against the real repo or
 * a fixture identically.
 */
export function checkOrdering(root: string, guard: CarveGuard): string[] {
  const failures: string[] = [];
  let skeleton: string;
  try {
    skeleton = readSkeleton(root, guard.skill);
  } catch (err) {
    return [`cannot read ${guard.skill}/SKILL.md: ${(err as Error).message}`];
  }
  const union = readUnion(root, guard.skill);

  // 1. The skeleton routes to sections via a Section index + STOP-Read directives.
  if (!skeleton.includes('## Section index')) {
    failures.push('skeleton is missing the "## Section index" table');
  }
  if (!skeleton.includes(STOP)) {
    failures.push('skeleton has no STOP-Read directive');
  }

  // 2. Every expected section is referenced by path AND generated (AUTO-GENERATED).
  for (const file of guard.expectedSections) {
    if (!skeleton.includes(`sections/${file}`)) {
      failures.push(`skeleton does not reference sections/${file}`);
    }
    const secPath = path.join(root, guard.skill, 'sections', file);
    if (!fs.existsSync(secPath)) {
      failures.push(`section file missing: sections/${file}`);
    } else if (!fs.readFileSync(secPath, 'utf-8').slice(0, 200).includes('AUTO-GENERATED')) {
      failures.push(`sections/${file} is hand-edited (no AUTO-GENERATED header)`);
    }
  }

  // 3. Pre-STOP anchors stay in the skeleton.
  for (const anchor of guard.staticInvariants.mustStayInSkeleton) {
    if (!skeleton.includes(anchor)) {
      failures.push(`mustStayInSkeleton anchor missing from skeleton: "${anchor}"`);
    }
  }

  // 3b. Earliest-use: dispatch directives must appear BEFORE the first STOP
  // (codex #6 — a directive that governs which sections to read can't sit after
  // the STOP that reads them).
  const firstStopIdx = skeleton.indexOf(STOP);
  for (const anchor of guard.staticInvariants.mustPrecedeStop ?? []) {
    const at = skeleton.indexOf(anchor);
    if (at < 0) {
      failures.push(`mustPrecedeStop anchor missing from skeleton: "${anchor}"`);
    } else if (firstStopIdx >= 0 && at > firstStopIdx) {
      failures.push(`mustPrecedeStop anchor "${anchor}" appears AFTER the STOP (stranded)`);
    }
  }

  // 4. Heavy body moved out of the skeleton but is preserved in the union.
  for (const moved of guard.staticInvariants.mustMoveToSection) {
    if (skeleton.includes(moved)) {
      failures.push(`mustMoveToSection marker is still in the skeleton: "${moved}"`);
    }
    if (!union.includes(moved)) {
      failures.push(`mustMoveToSection marker absent from the union (lost): "${moved}"`);
    }
  }

  // 5. The post-STOP gate fires after the last STOP (review skills).
  const gate = guard.staticInvariants.gateAfterStop;
  if (gate) {
    // Gate must fire after the LAST STOP (once all section work returns), not just
    // the first — for multi-STOP skeletons a gate between two STOPs is stranded.
    const lastStop = skeleton.lastIndexOf(STOP);
    const lastGate = skeleton.lastIndexOf(gate);
    if (lastGate < 0) {
      failures.push(`gateAfterStop marker missing from skeleton: "${gate}"`);
    } else if (lastStop >= 0 && lastGate < lastStop) {
      failures.push(`gateAfterStop "${gate}" appears before the last STOP (stranded above it)`);
    }
  }

  return failures;
}

/**
 * Completeness (E1): the filesystem carved set must equal the registry set, both
 * directions, and every registry entry must be internally consistent. Pure:
 * takes `root`.
 */
export function checkCompleteness(root: string): string[] {
  const failures: string[] = [];
  const discovered = new Set(discoverCarvedSkills(root));
  const registered = new Set(Object.keys(CARVE_GUARDS));

  for (const skill of discovered) {
    if (!registered.has(skill)) {
      failures.push(`carved on disk but NOT in CARVE_GUARDS (unguarded carve): ${skill}`);
    }
  }
  for (const skill of registered) {
    if (!discovered.has(skill)) {
      failures.push(`in CARVE_GUARDS but not carved on disk (stale registry entry): ${skill}`);
    }
  }

  for (const [skill, g] of Object.entries(CARVE_GUARDS)) {
    if (g.expectedSections.length === 0) {
      failures.push(`${skill}: expectedSections is empty`);
    }
    if (g.requiredReads.length === 0) {
      failures.push(`${skill}: requiredReads is empty (behavioral guard would be decorative)`);
    }
    for (const r of g.requiredReads) {
      if (!g.expectedSections.includes(r)) {
        failures.push(`${skill}: requiredRead "${r}" is not in expectedSections`);
      }
    }
    // Behavioral guard exists: 'plan'/'prompt' are covered structurally by the
    // data-driven loop (registry membership IS coverage); 'external' must name a
    // dedicated test file that actually exists on disk.
    if (g.behavioral === 'external') {
      if (!g.externalTest) {
        failures.push(`${skill}: behavioral 'external' but no externalTest path`);
      } else if (!fs.existsSync(path.join(root, g.externalTest))) {
        failures.push(`${skill}: externalTest missing on disk: ${g.externalTest}`);
      }
    }
  }

  return failures;
}
