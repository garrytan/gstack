import { describe, expect, test } from 'bun:test';
import { generateBrowseSetup } from '../scripts/resolvers/browse';
import { generateDesignMockup, generateDesignSetup } from '../scripts/resolvers/design';
import { generateMakePdfSetup } from '../scripts/resolvers/make-pdf';
import { HOST_PATHS, shellRuntimePath, type TemplateContext } from '../scripts/resolvers/types';

function context(host: 'claude' | 'codex'): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test/SKILL.md.tmpl',
    host,
    paths: HOST_PATHS[host],
  };
}

describe('generated runtime executable paths', () => {
  test('expands home-relative paths without changing env-var roots', () => {
    expect(shellRuntimePath('~/.claude/skills/gstack/browse/dist'))
      .toBe('$HOME/.claude/skills/gstack/browse/dist');
    expect(shellRuntimePath('$GSTACK_BROWSE')).toBe('$GSTACK_BROWSE');
  });

  test('Codex setup blocks never prepend HOME to GSTACK env vars', () => {
    const ctx = context('codex');
    const output = [
      generateBrowseSetup(ctx),
      generateDesignSetup(ctx),
      generateDesignMockup(ctx),
      generateMakePdfSetup(ctx),
    ].join('\n');

    expect(output).toContain('B="$GSTACK_BROWSE/browse"');
    expect(output).toContain('D="$GSTACK_DESIGN/design"');
    expect(output).toContain('P="$GSTACK_MAKE_PDF/pdf"');
    expect(output).not.toContain('$HOME$GSTACK_');
  });

  test('Claude setup blocks still expand tilde paths through HOME', () => {
    const ctx = context('claude');
    expect(generateBrowseSetup(ctx))
      .toContain('B="$HOME/.claude/skills/gstack/browse/dist/browse"');
    expect(generateDesignSetup(ctx))
      .toContain('D="$HOME/.claude/skills/gstack/design/dist/design"');
    expect(generateMakePdfSetup(ctx))
      .toContain('P="$HOME/.claude/skills/gstack/make-pdf/dist/pdf"');
  });
});
