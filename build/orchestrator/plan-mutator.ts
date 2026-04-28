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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Phase } from './types';

export interface FlipResult {
  /** True if the line was found unchecked and flipped. */
  flipped: boolean;
  /** True if the line was already `[x]`. Idempotent: not an error. */
  alreadyChecked: boolean;
  /** Set when neither `[ ]` nor `[x]` is at the expected line. */
  error?: string;
}

/**
 * Flip a single checkbox at a 1-based line number. Read-modify-write the
 * whole file; safe against concurrent reads but caller must serialize
 * mutations themselves (the orchestrator runs serially per build).
 *
 * Pure file I/O — does not touch the runtime state machine.
 */
export function flipCheckbox(args: {
  planFile: string;
  lineNumber: number;
  /** Substring expected to follow the checkbox, e.g. "**Implementation".
   * If provided, we verify it appears on the target line before flipping;
   * if not, we error out (the plan was edited under us). */
  expectedMarker?: string;
}): FlipResult {
  const content = fs.readFileSync(args.planFile, 'utf8');
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

  // Match the checkbox precisely. The leading whitespace + `- ` may be
  // any indentation; the bracket pair is what we toggle.
  const checkboxRe = /^(\s*-\s+\[)([ xX])(\])/;
  const m = line.match(checkboxRe);
  if (!m) {
    return {
      flipped: false,
      alreadyChecked: false,
      error: `line ${args.lineNumber} does not look like a checkbox list item: ${JSON.stringify(line.slice(0, 80))}`,
    };
  }

  if (m[2].toLowerCase() === 'x') {
    return { flipped: false, alreadyChecked: true };
  }

  lines[idx] = line.replace(checkboxRe, `$1x$3`);
  // Preserve trailing newline if the original had one.
  const trailingNewline = content.endsWith('\n') ? '\n' : '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const newContent = lines.join(eol) + (trailingNewline && !lines[lines.length - 1] ? '' : trailingNewline);

  // Atomic write: temp + rename in same dir (so rename is atomic on POSIX).
  const dir = path.dirname(args.planFile);
  // Use the OS tmpdir for the temp file ONLY if same-dir is read-only.
  // Default to same-dir to keep rename atomic across filesystems.
  const tmp = path.join(dir, `.${path.basename(args.planFile)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, newContent);
    fs.renameSync(tmp, args.planFile);
  } catch (err) {
    // Clean up temp on error; rethrow.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }

  return { flipped: true, alreadyChecked: false };
}

/**
 * Flip both Implementation and Review checkboxes for one phase. Returns
 * a per-checkbox result. If either reports an error, both are still
 * attempted (so the user sees the full picture).
 */
export function flipPhaseCheckboxes(args: {
  planFile: string;
  implementationLine: number;
  reviewLine: number;
}): { implementation: FlipResult; review: FlipResult } {
  const implementation = flipCheckbox({
    planFile: args.planFile,
    lineNumber: args.implementationLine,
    expectedMarker: '**Implementation',
  });
  const review = flipCheckbox({
    planFile: args.planFile,
    lineNumber: args.reviewLine,
    expectedMarker: '**Review',
  });
  return { implementation, review };
}

/** Helper for tests: write content to a fresh temp plan file and return the path. */
export function _testWritePlan(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mutator-test-'));
  const p = path.join(dir, 'plan.md');
  fs.writeFileSync(p, content);
  return p;
}

/**
 * Flip the Test Specification checkbox for a phase from [ ] to [x].
 * Uses the same atomic write-to-temp-and-rename pattern.
 */
export function flipTestSpecCheckbox(planFile: string, phase: Phase): FlipResult {
  if (phase.testSpecCheckboxLine > 0) {
    return flipCheckbox({
      planFile,
      lineNumber: phase.testSpecCheckboxLine,
      expectedMarker: '**Test Specification',
    });
  }
  return { flipped: false, alreadyChecked: true };
}
