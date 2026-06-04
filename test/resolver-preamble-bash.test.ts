import { describe, test, expect } from 'bun:test';
import type { Host, TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';

function makeCtx(host: Host = 'hermes'): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: 2,
  };
}

describe('generatePreambleBash — session marker GC safety', () => {
  test('uses the scoped gstack-session-gc helper', () => {
    const out = generatePreambleBash(makeCtx());
    expect(out).toContain('$GSTACK_BIN/gstack-session-gc 2>/dev/null || true');
  });

  test('does not emit broad shell deletion patterns in generated preamble', () => {
    const out = generatePreambleBash(makeCtx());
    expect(out).not.toContain('-exec rm');
    expect(out).not.toMatch(/find\s+[^\n]*-delete\b/);
  });

  test('preserves active session count without deleting inline', () => {
    const out = generatePreambleBash(makeCtx());
    expect(out).toContain('_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f');
    expect(out).toContain('touch ~/.gstack/sessions/"$PPID"');
  });
});
