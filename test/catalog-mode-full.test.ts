/**
 * Gap B (v1.46.0.0): --catalog-mode=full opt-out behavior.
 *
 * The catalog trim is the default. The opt-out (`--catalog-mode=full`)
 * preserves v1.44 multi-line frontmatter descriptions for users / hosts
 * that depend on the legacy fat catalog. Without this test, someone could
 * break the conditional `if (host === 'claude' && CATALOG_MODE === 'trim')`
 * and silently turn the opt-out path into a no-op — users with the flag
 * still get trim'd output, the v1.44 behavior is gone.
 *
 * Two layers:
 *   1. Static: the CATALOG_MODE flag is wired into gen-skill-docs.ts and
 *      the conditional gate is in the pipeline.
 *   2. Smoke: running with --catalog-mode=full produces a frontmatter
 *      `description: |` block (multi-line) instead of the trim'd one-line
 *      `description: ...(gstack)` form.
 *
 * The smoke test mutates the working tree mid-run. It restores the default
 * trim'd state in a finally block so a crash mid-test still leaves a clean
 * working tree.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const GEN_SKILL_DOCS = path.join(REPO_ROOT, 'scripts', 'gen-skill-docs.ts');
const SHIP_SKILL = path.join(REPO_ROOT, 'ship', 'SKILL.md');

describe('--catalog-mode=full opt-out wiring (static)', () => {
  test('CATALOG_MODE_ARG parsing is wired into gen-skill-docs.ts', () => {
    const src = fs.readFileSync(GEN_SKILL_DOCS, 'utf-8');
    expect(src).toContain('CATALOG_MODE_ARG');
    expect(src).toContain("a.startsWith('--catalog-mode')");
  });

  test('CATALOG_MODE accepts only "trim" or "full" — anything else throws', () => {
    const src = fs.readFileSync(GEN_SKILL_DOCS, 'utf-8');
    expect(src).toMatch(/val !== 'trim' && val !== 'full'/);
    expect(src).toContain('Unknown catalog mode');
  });

  test('catalog trim only fires when CATALOG_MODE === "trim"', () => {
    const src = fs.readFileSync(GEN_SKILL_DOCS, 'utf-8');
    // The applyCatalogTrim call is gated by both host and CATALOG_MODE checks.
    expect(src).toMatch(/CATALOG_MODE === 'trim'/);
    expect(src).toContain('applyCatalogTrim(content, skillName)');
  });

  test('default CATALOG_MODE is "trim" (opt-out, not opt-in)', () => {
    const src = fs.readFileSync(GEN_SKILL_DOCS, 'utf-8');
    // The const initializer falls back to 'trim' when --catalog-mode is unset.
    expect(src).toMatch(/if \(!CATALOG_MODE_ARG\) return 'trim'/);
  });
});

describe('--catalog-mode=full opt-out behavior (smoke)', () => {
  test('--catalog-mode=full produces multi-line description in frontmatter', () => {
    // Save the trim'd state so we can restore it.
    const trimmedShip = fs.readFileSync(SHIP_SKILL, 'utf-8');
    // #1778: the trimmed ship description has an interior colon ("Ship workflow:")
    // and is now YAML-quoted — tolerate the optional surrounding quotes.
    expect(trimmedShip).toMatch(/^description: "?Ship workflow:[^\n]*\(gstack\)"?\n/m);

    try {
      // Run with --catalog-mode=full. Mutates working tree.
      const result = spawnSync('bun', ['run', 'gen:skill-docs', '--catalog-mode=full'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      expect(result.status).toBe(0);

      // After --catalog-mode=full, frontmatter description is the legacy
      // multi-line block, not the trim'd one-line form.
      const fullShip = fs.readFileSync(SHIP_SKILL, 'utf-8');
      expect(fullShip).toMatch(/^description: \|\s*$/m); // YAML block scalar
      // Legacy multi-line content includes "Use when asked to..." in the
      // frontmatter (in trim mode this lives in the body section).
      const fmEnd = fullShip.indexOf('\n---', 4);
      const fm = fullShip.slice(0, fmEnd);
      expect(fm).toMatch(/Use when asked to/i);

      // "When to invoke" body section should NOT be present in full mode
      // (because the routing prose stayed in frontmatter).
      const body = fullShip.slice(fmEnd);
      expect(body).not.toContain('## When to invoke this skill');
    } finally {
      // Restore default trim state regardless of test outcome.
      const restore = spawnSync('bun', ['run', 'gen:skill-docs'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      if (restore.status !== 0) {
        // eslint-disable-next-line no-console
        console.error(
          'CRITICAL: failed to restore default trim state. Run `bun run gen:skill-docs` to clean up.',
        );
      }
      // Sanity-check the restored state matches what we saw at the start.
      const restoredShip = fs.readFileSync(SHIP_SKILL, 'utf-8');
      // #1778: restored trim state has the YAML-quoted (interior-colon) description.
      expect(restoredShip).toMatch(/^description: "?Ship workflow:[^\n]*\(gstack\)"?\n/m);
    }
  }, 180_000);

  test('--catalog-mode=invalid throws a clear error', () => {
    const result = spawnSync('bun', ['run', 'gen:skill-docs', '--catalog-mode=invalid'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    const stderr = result.stderr?.toString() ?? '';
    expect(stderr).toMatch(/Unknown catalog mode/);
    expect(stderr).toMatch(/invalid/);
  });
});
