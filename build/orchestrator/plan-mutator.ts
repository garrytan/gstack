/**
 * Plan file mutator — atomic checkbox flips.
 *
 * After a phase completes, we need to flip both `- [ ] **Implementation`
 * and `- [ ] **Review` to `[x]` in the plan markdown. This must be:
 *
 *   1. Atomic: temp-file + rename, never edit-in-place. A crash between
 *      truncate and full-write would leave the plan corrupted.
 *   2. Verified: re-check the target line still has `[ ]` before flipping.
 *      The user might have manually edited the file between parse and
 *      mutate; we don't want to silently overwrite their work.
 *   3. Targeted: only flip the specific line numbers the parser recorded.
 *      A naive regex over the whole file could flip checkboxes in code
 *      blocks or unrelated phases.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Phase, PhaseKind } from "./types";

export interface FlipResult {
  /** True if the line was found unchecked and flipped. */
  flipped: boolean;
  /** True if the line was already `[x]`. Idempotent: not an error. */
  alreadyChecked: boolean;
  /** Set when neither `[ ]` nor `[x]` is at the expected line. */
  error?: string;
}

export interface StatusNoteResult {
  /** True when the note was changed (added, replaced, or removed). */
  updated: boolean;
  /** True when the line already had the exact same note (idempotent). */
  alreadyPresent: boolean;
  /** Set when the target line can't be located or isn't a checkbox. */
  error?: string;
}

/**
 * Atomic plan-file write: write to a temp file in the same directory then
 * rename. POSIX rename is atomic — readers see either the old or the new
 * content, never a partial write.
 */
function writePlanContentAtomic(planFile: string, content: string): void {
  const dir = path.dirname(planFile);
  const tmp = path.join(
    dir,
    `.${path.basename(planFile)}.tmp.${process.pid}.${Date.now()}`,
  );
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, planFile);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Reconstruct file content from split lines, preserving original EOL style
 * and trailing newline.
 */
function joinPlanLines(original: string, lines: string[]): string {
  const trailingNewline = original.endsWith("\n") ? "\n" : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  return (
    lines.join(eol) +
    (trailingNewline && !lines[lines.length - 1] ? "" : trailingNewline)
  );
}

/**
 * Set a checkbox at a 1-based line number to a specific state (checked or
 * unchecked). Handles both the "flip to checked" and "flip to unchecked"
 * directions, enabling plan reconciliation in both directions.
 *
 * Returns a FlipResult where:
 *   flipped=true   → line was changed
 *   alreadyChecked=true → line was already in the requested state (idempotent)
 */
export function setCheckboxState(args: {
  planFile: string;
  lineNumber: number;
  checked: boolean;
  expectedMarker?: string;
}): FlipResult {
  const content = fs.readFileSync(args.planFile, "utf8");
  const lines = content.split(/\r?\n/);

  if (args.lineNumber < 1 || args.lineNumber > lines.length) {
    return {
      flipped: false,
      alreadyChecked: false,
      error: `line ${args.lineNumber} out of range (file has ${lines.length} lines)`,
    };
  }
  const idx = args.lineNumber - 1;
  const line = lines[idx];

  if (args.expectedMarker && !line.includes(args.expectedMarker)) {
    return {
      flipped: false,
      alreadyChecked: false,
      error: `line ${args.lineNumber} no longer contains "${args.expectedMarker}" — plan was edited externally; re-parse and try again`,
    };
  }

  const checkboxRe = /^(\s*-\s+\[)([ xX])(\])/;
  const m = line.match(checkboxRe);
  if (!m) {
    return {
      flipped: false,
      alreadyChecked: false,
      error: `line ${args.lineNumber} does not look like a checkbox list item: ${JSON.stringify(line.slice(0, 80))}`,
    };
  }

  const isChecked = m[2].toLowerCase() === "x";
  if (isChecked === args.checked) {
    return { flipped: false, alreadyChecked: true };
  }

  lines[idx] = line.replace(checkboxRe, `$1${args.checked ? "x" : " "}$3`);
  writePlanContentAtomic(args.planFile, joinPlanLines(content, lines));
  return { flipped: true, alreadyChecked: false };
}

/**
 * Append or replace the _(status note)_ suffix on a checkbox line. Pass
 * `note: ""` to remove an existing note. Uses the same atomic write pattern
 * as the rest of this module.
 */
export function setCheckboxStatusNote(args: {
  planFile: string;
  lineNumber: number;
  expectedMarker?: string;
  note: string;
}): StatusNoteResult {
  const content = fs.readFileSync(args.planFile, "utf8");
  const lines = content.split(/\r?\n/);

  if (args.lineNumber < 1 || args.lineNumber > lines.length) {
    return {
      updated: false,
      alreadyPresent: false,
      error: `line ${args.lineNumber} out of range (file has ${lines.length} lines)`,
    };
  }
  const idx = args.lineNumber - 1;
  const line = lines[idx];

  if (args.expectedMarker && !line.includes(args.expectedMarker)) {
    return {
      updated: false,
      alreadyPresent: false,
      error: `line ${args.lineNumber} no longer contains "${args.expectedMarker}" — plan was edited externally; re-parse and try again`,
    };
  }

  if (!/^(\s*-\s+\[)([ xX])(\])/.test(line)) {
    return {
      updated: false,
      alreadyPresent: false,
      error: `line ${args.lineNumber} does not look like a checkbox list item: ${JSON.stringify(line.slice(0, 80))}`,
    };
  }

  // Strip any existing _(note)_ suffix, then re-append if note is non-empty.
  const withoutNote = line.replace(/\s+_\([^)]*\)_\s*$/, "");
  const nextLine = args.note ? `${withoutNote} _(${args.note})_` : withoutNote;

  if (nextLine === line) {
    return { updated: false, alreadyPresent: true };
  }

  lines[idx] = nextLine;
  writePlanContentAtomic(args.planFile, joinPlanLines(content, lines));
  return { updated: true, alreadyPresent: false };
}

/**
 * Flip a single checkbox at a 1-based line number from [ ] to [x].
 * Thin wrapper around setCheckboxState kept for API compatibility;
 * prefer setCheckboxState for new callers.
 */
export function flipCheckbox(args: {
  planFile: string;
  lineNumber: number;
  /** Substring expected to follow the checkbox, e.g. "**Implementation".
   * If provided, we verify it appears on the target line before flipping;
   * if not, we error out (the plan was edited under us). */
  expectedMarker?: string;
}): FlipResult {
  return setCheckboxState({ ...args, checked: true });
}

/** Kind-to-marker lookup for implementation checkboxes. */
const IMPL_MARKER_BY_KIND: Record<PhaseKind, string> = {
  code: "**Implementation",
  writing: "**Draft",
  experiment: "**Execute",
  research: "**Explore",
  manual: "**Action Required",
};

/** Kind-to-marker lookup for review checkboxes. */
const REVIEW_MARKER_BY_KIND: Record<PhaseKind, string> = {
  code: "**Review",
  writing: "**Review",
  experiment: "**Review",
  research: "**Review",
  manual: "**Verify Completion",
};

/**
 * Flip both Implementation and Review checkboxes for one phase. Returns
 * a per-checkbox result. If either reports an error, both are still
 * attempted (so the user sees the full picture).
 */
export function flipPhaseCheckboxes(args: {
  planFile: string;
  implementationLine: number;
  reviewLine: number;
  /** Phase kind — determines the expected checkbox label. Defaults to "code". */
  kind?: PhaseKind;
}): { implementation: FlipResult; review: FlipResult } {
  const implMarker = IMPL_MARKER_BY_KIND[args.kind ?? "code"];
  const reviewMarker = REVIEW_MARKER_BY_KIND[args.kind ?? "code"];
  const implementation = flipCheckbox({
    planFile: args.planFile,
    lineNumber: args.implementationLine,
    expectedMarker: implMarker,
  });
  const review = flipCheckbox({
    planFile: args.planFile,
    lineNumber: args.reviewLine,
    expectedMarker: reviewMarker,
  });
  return { implementation, review };
}

/** Helper for tests: write content to a fresh temp plan file and return the path. */
export function _testWritePlan(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mutator-test-"));
  const p = path.join(dir, "plan.md");
  fs.writeFileSync(p, content);
  return p;
}

/** Marker string that must follow the test-spec checkbox in the plan file. */
export const TEST_SPEC_MARKER = "**Test Specification";

/**
 * Flip the Test Specification checkbox for a phase from [ ] to [x].
 * Uses the same atomic write-to-temp-and-rename pattern.
 */
export function flipTestSpecCheckbox(
  planFile: string,
  phase: Phase,
): FlipResult {
  if (phase.testSpecCheckboxLine > 0) {
    return flipCheckbox({
      planFile,
      lineNumber: phase.testSpecCheckboxLine,
      expectedMarker: TEST_SPEC_MARKER,
    });
  }
  return { flipped: false, alreadyChecked: true };
}

/**
 * Append phase blocks to a named feature in the plan file. Used by
 * the FEATURE_NEEDS_PHASES verdict path: when the feature reviewer
 * says "you also need to do X", the orchestrator writes new phase
 * headings under the matching `## Feature N:` block and re-parses.
 *
 * Insertion point is the line BEFORE the next `## Feature ...` heading
 * (or end-of-file when this is the last feature). Atomic temp+rename
 * matches the rest of the module — concurrent reads see either the
 * pre- or post-insertion content, never a partial write.
 *
 * Returns the line number (1-based) where insertion began, or throws
 * on irrecoverable errors (feature heading not found in plan).
 */
export interface AppendFeaturePhasesArgs {
  planFile: string;
  /** Feature.number (string, matching the plan heading e.g. "1", "2"). */
  featureNumber: string;
  /**
   * Verbatim markdown to insert. Should start with `### Phase N.review-K`
   * heading(s); caller is responsible for shape. The block is inserted
   * with one blank line of padding above and below.
   */
  phasesMd: string;
}

export function appendFeaturePhases(args: AppendFeaturePhasesArgs): {
  insertedAtLine: number;
} {
  const content = fs.readFileSync(args.planFile, "utf8");
  const lines = content.split(/\r?\n/);

  // Find the target `## Feature N:` heading. Match exact number with
  // word-boundary so "Feature 1" doesn't also match "Feature 10".
  // The heading regex is intentionally flexible on whitespace + colon
  // style ("## Feature 1: foo" vs "##  Feature  1 :  foo").
  const target = new RegExp(
    `^##\\s*Feature\\s+${args.featureNumber.replace(/[.*+?^${}()|[\\]/g, "\\$&")}\\b`,
  );
  let featureLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (target.test(lines[i])) {
      featureLineIdx = i;
      break;
    }
  }
  if (featureLineIdx === -1) {
    throw new Error(
      `appendFeaturePhases: could not find "## Feature ${args.featureNumber}" heading in ${args.planFile}`,
    );
  }

  // Find the next `## Feature ...` heading after our target — that's
  // the upper bound of our feature's body. If no next feature heading,
  // append at end-of-file.
  let nextFeatureLineIdx = lines.length;
  for (let i = featureLineIdx + 1; i < lines.length; i++) {
    if (/^##\s*Feature\s+/i.test(lines[i])) {
      nextFeatureLineIdx = i;
      break;
    }
  }

  // Trim trailing blank lines from our feature's body so the insertion
  // gets exactly one blank line of separation, regardless of how the
  // user authored the gap before the next feature. We walk up from the
  // next-feature index, skipping blanks; `before` keeps only the
  // non-blank tail of the feature body, and `after` starts at the next
  // feature heading so the consumed blanks are dropped (not duplicated
  // alongside the inserted padding).
  let trimEnd = nextFeatureLineIdx;
  while (trimEnd > featureLineIdx + 1 && lines[trimEnd - 1].trim() === "") {
    trimEnd--;
  }

  const block = args.phasesMd.replace(/\s+$/, ""); // strip trailing whitespace
  const padded = ["", block, ""];
  const before = lines.slice(0, trimEnd);
  const after = lines.slice(nextFeatureLineIdx);
  const merged = [...before, ...padded, ...after];
  const insertIdx = trimEnd;

  // Preserve EOL style.
  const trailingNewline = content.endsWith("\n") ? "\n" : "";
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const newContent =
    merged.join(eol) +
    (trailingNewline && !merged[merged.length - 1] ? "" : trailingNewline);

  // Atomic write via temp+rename in same dir.
  const dir = path.dirname(args.planFile);
  const tmp = path.join(
    dir,
    `.${path.basename(args.planFile)}.tmp.${process.pid}.${Date.now()}`,
  );
  try {
    fs.writeFileSync(tmp, newContent);
    fs.renameSync(tmp, args.planFile);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }

  return { insertedAtLine: insertIdx + 1 };
}

/**
 * Flip all checkboxes for a single phase. Used by both the startup
 * reconcile (cli.ts) and the one-shot backfill CLI. Returns the count
 * of boxes flipped and any error strings so callers can log differently.
 */
export function reconcilePhaseCheckboxes(
  planFile: string,
  phase: Phase,
): { flipped: number; errors: string[] } {
  const errors: string[] = [];
  let flipped = 0;

  if (phase.testSpecCheckboxLine !== -1) {
    const r = flipCheckbox({
      planFile,
      lineNumber: phase.testSpecCheckboxLine,
      expectedMarker: TEST_SPEC_MARKER,
    });
    if (r.error) errors.push(`test-spec: ${r.error}`);
    else if (r.flipped) flipped++;
  }

  const result = flipPhaseCheckboxes({
    planFile,
    implementationLine: phase.implementationCheckboxLine,
    reviewLine: phase.reviewCheckboxLine,
    kind: phase.kind,
  });
  if (result.implementation.error)
    errors.push(`impl: ${result.implementation.error}`);
  else if (result.implementation.flipped) flipped++;
  if (result.review.error) errors.push(`review: ${result.review.error}`);
  else if (result.review.flipped) flipped++;

  return { flipped, errors };
}
