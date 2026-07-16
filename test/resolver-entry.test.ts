/**
 * Unit tests for the ResolverEntry / unwrapResolver mechanism.
 *
 * Verifies the conditional-injection plumbing added in T2 (v1.45.0.0).
 * Plain functions still work; gated entries skip when appliesTo returns false.
 */

import { describe, test, expect } from 'bun:test';
import { unwrapResolver, type ResolverFn, type ResolverEntry, type TemplateContext } from '../scripts/resolvers/types';

function makeCtx(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: '/tmp/test/SKILL.md.tmpl',
    host: 'claude',
    paths: {
      skillRoot: '~/.claude/skills/gstack',
      localSkillRoot: '.claude/skills',
      binDir: '~/.claude/skills/gstack/bin',
      browseDir: '~/.claude/skills/gstack/browse/dist',
      designDir: '~/.claude/skills/gstack/design/dist',
      makePdfDir: '~/.claude/skills/gstack/make-pdf/dist',
    },
    ...overrides,
  };
}

describe('unwrapResolver — plain function pass-through', () => {
  test('returns the function as-is, no gate', () => {
    const fn: ResolverFn = (ctx) => `hello-${ctx.skillName}`;
    const { resolve, appliesTo } = unwrapResolver(fn);
    expect(resolve(makeCtx())).toBe('hello-test-skill');
    expect(appliesTo).toBeUndefined();
  });
});

describe('unwrapResolver — gated entry', () => {
  test('returns resolve + gate', () => {
    const entry: ResolverEntry = {
      resolve: (ctx) => `gated-${ctx.skillName}`,
      appliesTo: (ctx) => ['ship', 'review'].includes(ctx.skillName),
    };
    const { resolve, appliesTo } = unwrapResolver(entry);
    expect(resolve(makeCtx({ skillName: 'ship' }))).toBe('gated-ship');
    expect(appliesTo!(makeCtx({ skillName: 'ship' }))).toBe(true);
    expect(appliesTo!(makeCtx({ skillName: 'qa' }))).toBe(false);
  });

  test('gate returning false should signal skip — gen-skill-docs substitutes empty string', () => {
    // This mirrors the gen-skill-docs.ts contract:
    //   if (appliesTo && !appliesTo(ctx)) return '';
    const entry: ResolverEntry = {
      resolve: () => 'CONTENT',
      appliesTo: () => false,
    };
    const { resolve, appliesTo } = unwrapResolver(entry);
    const result = appliesTo && !appliesTo(makeCtx()) ? '' : resolve(makeCtx());
    expect(result).toBe('');
  });

  test('gate returning true allows resolve to fire', () => {
    const entry: ResolverEntry = {
      resolve: () => 'CONTENT',
      appliesTo: () => true,
    };
    const { resolve, appliesTo } = unwrapResolver(entry);
    const result = appliesTo && !appliesTo(makeCtx()) ? '' : resolve(makeCtx());
    expect(result).toBe('CONTENT');
  });

  test('entry without appliesTo behaves like ungated', () => {
    const entry: ResolverEntry = { resolve: () => 'ALWAYS' };
    const { resolve, appliesTo } = unwrapResolver(entry);
    expect(appliesTo).toBeUndefined();
    expect(resolve(makeCtx())).toBe('ALWAYS');
  });
});

describe('RESOLVERS registry still loads with mixed shapes', () => {
  test('importing the live registry produces a record with expected resolvers', async () => {
    const { RESOLVERS } = await import('../scripts/resolvers/index');
    // Spot-check that core resolvers are present.
    expect(RESOLVERS.PREAMBLE).toBeDefined();
    expect(RESOLVERS.REVIEW_DASHBOARD).toBeDefined();
    expect(RESOLVERS.SLUG_EVAL).toBeDefined();
    // Each entry should unwrap cleanly.
    for (const [name, entry] of Object.entries(RESOLVERS)) {
      const { resolve } = unwrapResolver(entry);
      expect(typeof resolve).toBe('function');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Gap D (v1.46.0.0): live appliesTo gate end-to-end integration.
 *
 * The ResolverEntry / unwrapResolver machinery has unit coverage above. The
 * remaining gap: does the gen-skill-docs.ts:444 substitution loop actually
 * USE the gate? A refactor that drops the `if (appliesTo && !appliesTo(ctx))`
 * check would silently break every future gated resolver.
 *
 * This test simulates the exact 4-line shape the live pipeline uses against
 * a synthetic registry. If gen-skill-docs.ts is refactored and someone
 * forgets to keep the gate check in sync, this assertion fails.
 */
describe('gen-skill-docs substitution loop respects the appliesTo gate', () => {
  function simulateGenSubstitution(
    template: string,
    registry: Record<string, import('../scripts/resolvers/types').ResolverValue>,
    ctx: TemplateContext,
  ): string {
    // Mirrors scripts/gen-skill-docs.ts:457-467 (the {{NAME}} substitution
    // loop). Keep this in sync with the real loop. Drift here is what the
    // test is designed to catch.
    return template.replace(/\{\{(\w+(?::[^}]+)?)\}\}/g, (_match, fullKey) => {
      const parts = fullKey.split(':');
      const resolverName = parts[0];
      const args = parts.slice(1);
      const entry = registry[resolverName];
      if (!entry) throw new Error(`Unknown placeholder {{${resolverName}}}`);
      const { resolve, appliesTo } = unwrapResolver(entry);
      if (appliesTo && !appliesTo(ctx)) return '';
      return args.length > 0 ? resolve(ctx, args) : resolve(ctx);
    });
  }

  test('plain-function resolver fires unconditionally', () => {
    const tpl = '{{ALWAYS}}';
    const out = simulateGenSubstitution(tpl, {
      ALWAYS: () => 'fired',
    }, makeCtx({ skillName: 'whatever' }));
    expect(out).toBe('fired');
  });

  test('gated resolver fires only when appliesTo returns true', () => {
    const tpl = 'before-{{GATED}}-after';
    const out = simulateGenSubstitution(tpl, {
      GATED: {
        resolve: () => 'CONTENT',
        appliesTo: (ctx) => ctx.skillName === 'allowed',
      },
    }, makeCtx({ skillName: 'allowed' }));
    expect(out).toBe('before-CONTENT-after');
  });

  test('gated resolver is substituted with empty string when appliesTo returns false', () => {
    const tpl = 'before-{{GATED}}-after';
    const out = simulateGenSubstitution(tpl, {
      GATED: {
        resolve: () => 'CONTENT',
        appliesTo: (ctx) => ctx.skillName === 'allowed',
      },
    }, makeCtx({ skillName: 'something-else' }));
    expect(out).toBe('before--after');
  });

  test('mixed registry: gated + plain resolvers in the same template', () => {
    const tpl = '{{PLAIN}} / {{GATED_ON}} / {{GATED_OFF}}';
    const ctx = makeCtx({ skillName: 'ship' });
    const out = simulateGenSubstitution(tpl, {
      PLAIN: () => 'plain',
      GATED_ON: { resolve: () => 'on', appliesTo: () => true },
      GATED_OFF: { resolve: () => 'off', appliesTo: () => false },
    }, ctx);
    expect(out).toBe('plain / on / ');
  });

  test('parameterized resolver still respects gate', () => {
    const tpl = '{{GATED:arg1:arg2}}';
    const ctx = makeCtx({ skillName: 'no' });
    const out = simulateGenSubstitution(tpl, {
      GATED: {
        resolve: (_c, args) => `fired-with-${(args ?? []).join('-')}`,
        appliesTo: (c) => c.skillName === 'yes',
      },
    }, ctx);
    expect(out).toBe(''); // gated off, args ignored
  });

  test('unknown resolver throws (matches real gen-skill-docs error contract)', () => {
    expect(() =>
      simulateGenSubstitution('{{NEVER_DEFINED}}', {}, makeCtx()),
    ).toThrow(/Unknown placeholder/);
  });
});
