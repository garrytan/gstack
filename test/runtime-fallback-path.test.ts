/**
 * Regression tests for runtime binary fallback path resolution.
 *
 * Guards garrytan/gstack#1159: env-var hosts (codex, hermes) export their
 * runtime roots as shell variables ($GSTACK_DESIGN, $GSTACK_BROWSE,
 * $GSTACK_MAKE_PDF). The global-fallback path builder used to unconditionally
 * prepend $HOME, producing invalid paths like `$HOME$GSTACK_DESIGN/design`
 * that never resolve — so the design/browse/make-pdf binaries were reported
 * NOT_AVAILABLE on those hosts even when installed.
 *
 * The fix: a `$`-prefixed dir is an absolute root and is used verbatim; only
 * `~`-style dirs (Claude) get $HOME substituted for the leading tilde.
 */

import { describe, test, expect } from 'bun:test';
import { HOST_PATHS, runtimeFallbackPath } from '../scripts/resolvers/types';
import { generateDesignSetup } from '../scripts/resolvers/design';
import { generateMakePdfSetup } from '../scripts/resolvers/make-pdf';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import type { TemplateContext } from '../scripts/resolvers/types';

function makeCtx(host: string): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: '/tmp/test/SKILL.md.tmpl',
    host: host as TemplateContext['host'],
    paths: HOST_PATHS[host],
  };
}

describe('runtimeFallbackPath', () => {
  test('env-var ($-prefixed) roots are used verbatim, never $HOME-prefixed', () => {
    expect(runtimeFallbackPath('$GSTACK_DESIGN', 'design')).toBe('$GSTACK_DESIGN/design');
    expect(runtimeFallbackPath('$GSTACK_BROWSE', 'browse')).toBe('$GSTACK_BROWSE/browse');
    expect(runtimeFallbackPath('$GSTACK_MAKE_PDF', 'pdf')).toBe('$GSTACK_MAKE_PDF/pdf');
  });

  test('~-style roots get $HOME substituted for the leading tilde', () => {
    expect(runtimeFallbackPath('~/.claude/skills/gstack/design/dist', 'design')).toBe(
      '$HOME/.claude/skills/gstack/design/dist/design',
    );
  });

  test('never produces the malformed $HOME$GSTACK_* shape', () => {
    expect(runtimeFallbackPath('$GSTACK_DESIGN', 'design')).not.toContain('$HOME$GSTACK');
  });
});

describe('generated setup blocks — env-var hosts (#1159)', () => {
  const envVarHosts = ALL_HOST_CONFIGS.filter(c => c.usesEnvVars).map(c => c.name);

  test('at least codex and hermes are env-var hosts', () => {
    expect(envVarHosts).toEqual(expect.arrayContaining(['codex', 'hermes']));
  });

  for (const host of envVarHosts) {
    test(`${host}: no setup block emits the malformed $HOME$GSTACK_* path`, () => {
      const ctx = makeCtx(host);
      // generateDesignSetup emits both the design (D=) and browse (B=) fallbacks.
      const blocks = generateDesignSetup(ctx) + generateMakePdfSetup(ctx);
      expect(blocks).not.toContain('$HOME$GSTACK_DESIGN');
      expect(blocks).not.toContain('$HOME$GSTACK_BROWSE');
      expect(blocks).not.toContain('$HOME$GSTACK_MAKE_PDF');
    });

    test(`${host}: design + browse fallbacks resolve under their env-var roots`, () => {
      const setup = generateDesignSetup(makeCtx(host));
      expect(setup).toContain('D="$GSTACK_DESIGN/design"');
      expect(setup).toContain('B="$GSTACK_BROWSE/browse"');
    });

    test(`${host}: make-pdf fallback resolves to $GSTACK_MAKE_PDF/pdf`, () => {
      const setup = generateMakePdfSetup(makeCtx(host));
      expect(setup).toContain('P="$GSTACK_MAKE_PDF/pdf"');
    });
  }
});

describe('generated setup blocks — Claude host unaffected', () => {
  test('design fallback still resolves under $HOME', () => {
    const setup = generateDesignSetup(makeCtx('claude'));
    expect(setup).toContain('D="$HOME/.claude/skills/gstack/design/dist/design"');
    expect(setup).not.toContain('$HOME$');
  });
});
