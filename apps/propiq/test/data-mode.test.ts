/**
 * The declared data mode.
 *
 * The contract being pinned: there is exactly one way to serve synthetic
 * figures from a production deployment, and it is the way that also labels
 * them. Everything else about this module is bookkeeping; that sentence is the
 * product rule.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTER_FOR_MODE, DATA_MODES, DATA_MODE_COPY, MODE_FOR_ADAPTER } from '@/lib/data-mode';

const ROOT = process.cwd();
const env = readFileSync(join(ROOT, 'src/lib/env.ts'), 'utf-8');

/**
 * `clientEnv` is evaluated once at module load and `NEXT_PUBLIC_*` is inlined
 * at build time, so the resolution branches cannot be exercised by mutating
 * `process.env` from a test. They are read out of the source instead — the same
 * approach `production-guards.test.ts` takes, and for the same reason.
 */
describe('mode ↔ adapter mapping', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DATA_MODE;
  });

  it('is a total, round-tripping bijection', () => {
    for (const mode of DATA_MODES) {
      expect(MODE_FOR_ADAPTER[ADAPTER_FOR_MODE[mode]]).toBe(mode);
    }
    expect(new Set(Object.values(ADAPTER_FOR_MODE)).size).toBe(DATA_MODES.length);
  });

  it('gives every mode but live something to say', () => {
    // Live needs no chip: the absence of one is the claim that it is real.
    expect(DATA_MODE_COPY.live).toBeUndefined();
    expect(DATA_MODE_COPY.demo?.badge).toBeTruthy();
    expect(DATA_MODE_COPY.empty?.badge).toBeTruthy();
  });

  it('never calls demo data anything but demo data', () => {
    const line = DATA_MODE_COPY.demo?.line ?? '';
    expect(line).toMatch(/synthetic/i);
    // The one true thing in the demo set is the locality names, and the copy
    // has to say which half is which or it is worse than saying nothing.
    expect(line).toMatch(/locality names are real/i);
  });

  it('uses no adapter vocabulary in copy a visitor reads', () => {
    for (const mode of DATA_MODES) {
      const copy = DATA_MODE_COPY[mode];
      if (!copy) continue;
      for (const word of ['fixture', 'adapter', 'NOT BUILT', 'PROPIQ_DATA_ADAPTER']) {
        expect(`${copy.badge} ${copy.line}`).not.toContain(word);
      }
    }
  });
});

describe('production configuration', () => {
  it('still refuses the quiet path to demo data in production', () => {
    expect(env).toMatch(/PROPIQ_DATA_ADAPTER=fixture is not permitted when NODE_ENV=production/);
    expect(env).toMatch(/pinned === 'fixture' && declared !== 'demo'/);
  });

  it('opens the declared path, and only the declared path', () => {
    // Declaring the mode is what renders the badge, so the deployment that
    // serves synthetic prices is the deployment that says it does.
    expect(env).toMatch(/NEXT_PUBLIC_DATA_MODE=demo/);
    expect(env).toMatch(/const declared = clientEnv\.NEXT_PUBLIC_DATA_MODE/);
  });

  it('refuses a declaration that disagrees with the adapter under it', () => {
    expect(env).toMatch(/ADAPTER_FOR_MODE\[declared\] !== pinned/);
    expect(env).toMatch(/must agree/);
  });

  it('keeps the empty default for an unconfigured production deployment', () => {
    expect(env).toMatch(/NODE_ENV === 'production' \? 'none' : 'fixture'/);
  });
});
