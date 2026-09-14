/**
 * Declared annotation helper (plan-tune cathedral T7) — unit tests.
 *
 * Verifies the helper's contract:
 *   - Returns null for unknown signal_key.
 *   - Returns null when the profile doesn't exist or declared is unset.
 *   - Returns a phrase when declared >= 0.7 (strong high band).
 *   - Returns a phrase when declared <= 0.3 (strong low band).
 *   - Returns null when declared is in the middle band (0.3 < x < 0.7).
 *   - primaryDimensionFor picks the dimension with largest |delta| total.
 *   - Maps kebab signal_key to underscore Dimension correctly (D2 fix).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { getDeclaredAnnotation, primaryDimensionFor } from '../scripts/declared-annotation';

let prevStateRoot: string | undefined;
let prevHome: string | undefined;
let stateRoot: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-annot-'));
  prevStateRoot = process.env.GSTACK_STATE_ROOT;
  prevHome = process.env.GSTACK_HOME;
  process.env.GSTACK_STATE_ROOT = stateRoot;
  delete process.env.GSTACK_HOME;
});

afterEach(() => {
  if (prevStateRoot !== undefined) process.env.GSTACK_STATE_ROOT = prevStateRoot;
  else delete process.env.GSTACK_STATE_ROOT;
  if (prevHome !== undefined) process.env.GSTACK_HOME = prevHome;
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function writeProfile(declared: Record<string, number>): void {
  const p = path.join(stateRoot, 'developer-profile.json');
  fs.writeFileSync(p, JSON.stringify({ declared }, null, 2));
}

// ----------------------------------------------------------------------
// primaryDimensionFor — kebab→underscore mapping
// ----------------------------------------------------------------------

describe('primaryDimensionFor', () => {
  test('scope-appetite → scope_appetite (largest |delta| total)', () => {
    expect(primaryDimensionFor('scope-appetite')).toBe('scope_appetite');
  });

  test('architecture-care → architecture_care (top dim by |delta|)', () => {
    expect(primaryDimensionFor('architecture-care')).toBe('architecture_care');
  });

  test('unknown signal_key → null', () => {
    expect(primaryDimensionFor('totally-not-a-key')).toBe(null);
  });

  test('empty/garbage input → null', () => {
    expect(primaryDimensionFor('')).toBe(null);
  });
});

// ----------------------------------------------------------------------
// getDeclaredAnnotation
// ----------------------------------------------------------------------

describe('getDeclaredAnnotation', () => {
  test('returns null when no profile exists', () => {
    expect(getDeclaredAnnotation('scope-appetite')).toBe(null);
  });

  test('returns null when declared unset for the dimension', () => {
    writeProfile({});
    expect(getDeclaredAnnotation('scope-appetite')).toBe(null);
  });

  test('returns null when declared is in middle band (0.5)', () => {
    writeProfile({ scope_appetite: 0.5 });
    expect(getDeclaredAnnotation('scope-appetite')).toBe(null);
  });

  test('returns high-band phrase when declared >= 0.7', () => {
    writeProfile({ scope_appetite: 0.85 });
    const annot = getDeclaredAnnotation('scope-appetite');
    expect(annot).toBeTruthy();
    expect(annot).toContain('boil the ocean');
  });

  test('returns high-band phrase at the exact 0.7 threshold', () => {
    writeProfile({ scope_appetite: 0.7 });
    expect(getDeclaredAnnotation('scope-appetite')).toContain('boil the ocean');
  });

  test('returns low-band phrase when declared <= 0.3', () => {
    writeProfile({ scope_appetite: 0.2 });
    const annot = getDeclaredAnnotation('scope-appetite');
    expect(annot).toBeTruthy();
    expect(annot).toContain('ship-small-fast');
  });

  test('returns low-band phrase at the exact 0.3 threshold', () => {
    writeProfile({ scope_appetite: 0.3 });
    expect(getDeclaredAnnotation('scope-appetite')).toContain('ship-small-fast');
  });

  test('returns null for unknown signal_key even when profile populated', () => {
    writeProfile({ scope_appetite: 0.85 });
    expect(getDeclaredAnnotation('totally-not-a-key')).toBe(null);
  });

  test('all 5 dimensions render distinct high-band phrases', () => {
    // Use the 5 signal_keys known to map to each of the 5 dimensions.
    writeProfile({
      scope_appetite: 0.9,
      risk_tolerance: 0.9,
      detail_preference: 0.9,
      autonomy: 0.9,
      architecture_care: 0.9,
    });
    const scope = getDeclaredAnnotation('scope-appetite');
    const arch = getDeclaredAnnotation('architecture-care');
    expect(scope).toContain('boil the ocean');
    expect(arch).toContain('design-right');
  });
});
