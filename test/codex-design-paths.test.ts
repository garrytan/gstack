import { describe, expect, test } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateBrowseSetup } from '../scripts/resolvers/browse';
import { generateDesignMockup, generateDesignSetup } from '../scripts/resolvers/design';

function makeCodexCtx(): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'codex',
    paths: HOST_PATHS.codex,
  };
}

describe('Codex design/browse path generation', () => {
  test('generated Codex browse setup uses GSTACK_BROWSE directly', () => {
    const out = generateBrowseSetup(makeCodexCtx());
    expect(out).toContain('B="$GSTACK_BROWSE/browse"');
    expect(out).not.toContain('$HOME$GSTACK_BROWSE');
  });

  test('generated Codex design setup uses GSTACK_DESIGN and GSTACK_BROWSE directly', () => {
    const out = generateDesignSetup(makeCodexCtx());
    expect(out).toContain('D="$GSTACK_DESIGN/design"');
    expect(out).toContain('B="$GSTACK_BROWSE/browse"');
    expect(out).not.toContain('$HOME$GSTACK_DESIGN');
    expect(out).not.toContain('$HOME$GSTACK_BROWSE');
  });

  test('generated Codex design mockup uses GSTACK_DESIGN directly', () => {
    const out = generateDesignMockup(makeCodexCtx());
    expect(out).toContain('D="$GSTACK_DESIGN/design"');
    expect(out).not.toContain('$HOME$GSTACK_DESIGN');
  });
});
