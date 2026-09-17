/**
 * No component rule may paint a literal light colour.
 *
 * Twice now the same bug has shipped: a rule written against a white ground
 * hardcodes white, the ground later changes, and the component paints a light
 * slab with light text on it. `.propiq-card` did it on every app route in dark
 * mode (1.05:1, invisible). `.propiq-stage-card` did it to the whole journey
 * section the moment the marketing surface went dark.
 *
 * Both were invisible to the accessibility sweep at the time — one because the
 * sweep ran light-only, the other because the section had moved and nothing was
 * looking at it. So the rule is enforced statically instead: a component that
 * needs a surface asks for the token, and the ground decides.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');

/** Blocks that define a ground are exactly where literals belong. */
const GROUND_DECLARATIONS = /--(surface|text|border|color|seq)-/;

interface Rule {
  readonly selector: string;
  readonly body: string;
}

const rules: readonly Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? '').trim().split('\n').at(-1)?.trim() ?? '',
  body: m[2] ?? '',
}));

describe('component rules take surfaces from tokens', () => {
  const componentRules = rules.filter(
    (r) => r.selector.startsWith('.propiq-') && !GROUND_DECLARATIONS.test(r.body),
  );

  it('finds the component rules to check', () => {
    expect(componentRules.length).toBeGreaterThan(10);
  });

  it('paints no literal near-white background', () => {
    const offenders = componentRules
      .filter((r) =>
        /background(-color)?:[^;]*(#f[0-9a-f]{2}|#fff|rgba?\(\s*25[0-5]\s*,\s*25[0-5]\s*,\s*25[0-5])/i.test(
          r.body,
        ),
      )
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it('paints no literal near-white border', () => {
    const offenders = componentRules
      .filter((r) =>
        /border(-color)?:[^;]*(#f[0-9a-f]{2}\b|#fff|rgba?\(\s*25[0-5]\s*,\s*25[0-5]\s*,\s*25[0-5])/i.test(
          r.body,
        ),
      )
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });
});

describe('what is still allowed', () => {
  it('permits a literal on a fill that carries its own contrast', () => {
    // `--color-*` gradient fills and white-on-gradient text are deliberate:
    // the fill is the ground there, and it is the same fill on every page.
    expect(css).toMatch(/\.propiq-icon-tile[\s\S]{0,200}color: #ffffff/);
  });
});
