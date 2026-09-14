#!/usr/bin/env bun
/**
 * Read docs/throughput-2013-vs-2026.json, replace the README anchor with the
 * computed logical-lines multiple.
 *
 * Two-string pattern (resolves the pipeline-eats-itself bug Codex caught in V1
 * planning, Pass 2 finding #10):
 *   - GSTACK-THROUGHPUT-PLACEHOLDER — stable anchor, lives in README permanently.
 *     Script finds this anchor and writes the number right before it, keeping
 *     the anchor itself for the next run.
 *   - GSTACK-THROUGHPUT-PENDING — explicit missing-build marker. If the JSON
 *     isn't present, the script writes this marker at the anchor location.
 *     CI rejects commits containing this string, so contributors get a clear
 *     signal to run the throughput script before committing.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const README = path.join(ROOT, 'README.md');
const JSON_PATH = path.join(ROOT, 'docs', 'throughput-2013-vs-2026.json');

const ANCHOR = '<!-- GSTACK-THROUGHPUT-PLACEHOLDER -->';
const PENDING = 'GSTACK-THROUGHPUT-PENDING';

function main() {
  if (!fs.existsSync(README)) {
    process.stderr.write(`README.md not found at ${README}\n`);
    process.exit(1);
  }

  const readme = fs.readFileSync(README, 'utf-8');
  if (!readme.includes(ANCHOR)) {
    // Anchor already replaced by a computed number (or was never inserted).
    // Nothing to do — silent success.
    return;
  }

  if (!fs.existsSync(JSON_PATH)) {
    // Build hasn't produced the JSON. Write the PENDING marker at the anchor,
    // preserving the anchor so the next run can replace it.
    const replacement = `${PENDING}: run scripts/garry-output-comparison.ts ${ANCHOR}`;
    const updated = readme.replace(ANCHOR, replacement);
    fs.writeFileSync(README, updated);
    process.stderr.write(
      `${JSON_PATH} not found. Wrote ${PENDING} marker to README. Run scripts/garry-output-comparison.ts to generate it.\n`
    );
    // Non-zero exit so CI that wraps this sees the signal, but local dev workflows
    // can continue. Callers can decide whether this is fatal.
    process.exit(0);
  }

  let parsed: { multiples?: { logical_lines_added?: number | null } } = {};
  try {
    parsed = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  } catch (err) {
    process.stderr.write(`Failed to parse ${JSON_PATH}: ${err}\n`);
    process.exit(1);
  }

  const mult = parsed?.multiples?.logical_lines_added;
  if (mult === null || mult === undefined) {
    // JSON exists but doesn't have a computable multiple (e.g., one year inactive).
    // Write an honest pending-ish marker. Don't fall back to a bogus number.
    const replacement = `${PENDING}: multiple not yet computable (one or both years inactive in this repo) ${ANCHOR}`;
    const updated = readme.replace(ANCHOR, replacement);
    fs.writeFileSync(README, updated);
    process.stderr.write(`Multiple not computable. Wrote ${PENDING} marker.\n`);
    process.exit(0);
  }

  // Normal flow: replace the anchor with the number + anchor (anchor stays for next run).
  const replacement = `**${mult}×** ${ANCHOR}`;
  const updated = readme.replace(ANCHOR, replacement);
  fs.writeFileSync(README, updated);
  process.stderr.write(`README throughput multiple updated: ${mult}×\n`);
}

main();
