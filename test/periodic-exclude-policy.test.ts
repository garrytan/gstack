/**
 * The periodic exclude list is a set of DECISIONS, not a place tests go to
 * die: every entry names a real file (a deleted/renamed file must drop its
 * entry) and carries a non-empty reason + tracking pointer (the re-entry
 * condition lives there). The runner surfaces each exclusion per run, and
 * removing an entry re-activates the file on the next weekly lane.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PERIODIC_CI_EXCLUDE } from './helpers/periodic-exclude-data';
import { isPaidTestFile } from './helpers/paid-test-set';
import { selectPaidTestFiles } from '../scripts/test-paid-shards';

const ROOT = path.resolve(__dirname, '..');

describe('periodic exclude policy', () => {
  test('every entry names a real paid file and carries reason + tracking', () => {
    const entries = Object.entries(PERIODIC_CI_EXCLUDE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, meta] of entries) {
      expect(fs.existsSync(path.join(ROOT, file)), `stale exclude entry: ${file}`).toBe(true);
      expect(isPaidTestFile(file), `${file} is not a paid file — exclusion is meaningless`).toBe(true);
      expect(meta.reason.length, `${file}: empty reason`).toBeGreaterThan(20);
      expect(meta.tracking.length, `${file}: empty tracking pointer`).toBeGreaterThan(5);
    }
  });

  test('exclusions apply to the periodic tier only, with the reason surfaced', () => {
    const files = Object.keys(PERIODIC_CI_EXCLUDE);
    const periodic = selectPaidTestFiles(files, 'periodic');
    expect(periodic.selected).toEqual([]);
    for (const { reason } of periodic.excluded) {
      expect(reason).toStartWith('excluded: ');
      expect(reason).toContain('[');
    }
    // Gate tier ignores the list (these files are periodic-tier anyway; the
    // list must never leak into gate semantics).
    const gate = selectPaidTestFiles(files, 'gate');
    for (const { reason } of gate.excluded) {
      expect(reason).not.toStartWith('excluded: ');
    }
  });
});
