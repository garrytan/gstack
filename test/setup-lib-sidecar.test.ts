/**
 * Static invariant: runtime sidecar roots (codex, factory, opencode) that link
 * bin/ MUST also link lib/, because bin/ scripts import from ../lib/ via
 * relative paths (e.g. gstack-learnings-log imports lib/jsonl-store.ts).
 *
 * Without lib/ beside bin/ in the sidecar, those imports resolve to nothing and
 * the script crashes at runtime.
 *
 * Issue: #2305
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SETUP = fs.readFileSync(path.join(import.meta.dir, '..', 'setup'), 'utf-8');

describe('setup links lib/ beside bin/ in runtime sidecars', () => {
  const SIDECAR_VARS = ['codex_gstack', 'factory_gstack', 'opencode_gstack'];

  for (const sidecar of SIDECAR_VARS) {
    test(`${sidecar} links lib/ when bin/ is linked`, () => {
      const binPattern = new RegExp(
        `_link_or_copy "\\$gstack_dir/bin" "\\$${sidecar}/bin"`,
      );
      const libPattern = new RegExp(
        `_link_or_copy "\\$gstack_dir/lib" "\\$${sidecar}/lib"`,
      );

      const hasBin = binPattern.test(SETUP);
      const hasLib = libPattern.test(SETUP);

      expect(hasBin).toBe(true);
      expect(hasLib).toBe(true);
    });
  }

  test('lib/ link uses _link_or_copy (not raw ln)', () => {
    const libLines = SETUP.split('\n').filter(
      (l) => l.includes('/lib"') && /\bln\s+-/.test(l),
    );
    expect(libLines).toEqual([]);
  });

  test('lib/ link is guarded by -d check', () => {
    const libGuards = SETUP.split('\n').filter((l) =>
      l.includes('if [ -d "$gstack_dir/lib" ]'),
    );
    expect(libGuards.length).toBeGreaterThanOrEqual(3);
  });
});
