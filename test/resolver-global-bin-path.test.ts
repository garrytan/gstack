// ABOUTME: Verifies the global-install binary fallback paths emitted by the
// ABOUTME: browse/design/make-pdf setup resolvers for env-var and literal hosts.
import { describe, test, expect } from 'bun:test';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateBrowseSetup } from '../scripts/resolvers/browse';
import { generateDesignSetup, generateDesignMockup } from '../scripts/resolvers/design';
import { generateMakePdfSetup } from '../scripts/resolvers/make-pdf';

function ctxFor(host: 'codex' | 'claude'): TemplateContext {
  return { skillName: 'browse', tmplPath: 'browse/SKILL.md.tmpl', host, paths: HOST_PATHS[host] };
}

describe('global binary fallback paths', () => {
  test('env-var hosts use the env var directly, never prefixed with $HOME', () => {
    const ctx = ctxFor('codex');
    const outputs = [
      generateBrowseSetup(ctx),
      generateDesignSetup(ctx),
      generateDesignMockup(ctx),
      generateMakePdfSetup(ctx),
    ];
    for (const out of outputs) {
      expect(out).not.toContain('$HOME$GSTACK');
    }
    expect(generateBrowseSetup(ctx)).toContain('B="$GSTACK_BROWSE/browse"');
    expect(generateDesignSetup(ctx)).toContain('D="$GSTACK_DESIGN/design"');
    expect(generateDesignSetup(ctx)).toContain('B="$GSTACK_BROWSE/browse"');
    expect(generateDesignMockup(ctx)).toContain('D="$GSTACK_DESIGN/design"');
    expect(generateMakePdfSetup(ctx)).toContain('P="$GSTACK_MAKE_PDF/pdf"');
  });

  test('literal hosts expand ~ to $HOME', () => {
    const ctx = ctxFor('claude');
    expect(generateBrowseSetup(ctx)).toContain('B="$HOME/.claude/skills/gstack/browse/dist/browse"');
    expect(generateDesignSetup(ctx)).toContain('D="$HOME/.claude/skills/gstack/design/dist/design"');
    expect(generateMakePdfSetup(ctx)).toContain('P="$HOME/.claude/skills/gstack/make-pdf/dist/pdf"');
  });
});
