/**
 * lib/design-md.ts + bin/gstack-design-md.ts + design/src/memory.ts (DESIGN.md writer).
 *
 * Pins the open DESIGN.md format rules gstack depends on: eight canonical
 * sections in order, only the five token groups in front matter, `{path}`
 * references resolving to primitives, extras surviving a round trip, the
 * format marker's placement (YAML comment on line 2 for spec files, HTML
 * comment on line 1 for legacy), body-only upserts that never re-emit front
 * matter bytes, and a legacy → spec conversion of gstack's own DESIGN.md.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  parseDesignMd, detectFormat, renderDesignMd, upsertSection, convertLegacy, tokensFlat,
  emitYamlBlock, specSkeleton, spliceSection, insertMarker, DesignMdEditRefused, CANONICAL_SECTIONS, TOKEN_GROUPS, isLegacyGstackFormat,
} from '../lib/design-md';
import { updateDesignMd, readDesignConstraints } from '../design/src/memory';

const ROOT = path.join(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-md.ts');
const runBin = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, ['--no-env-file', 'run', BIN, ...args], { cwd, encoding: 'utf-8', timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
// gstack's own DESIGN.md is now in the open format; its pre-conversion form is the legacy fixture.
const LEGACY = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'design-md-legacy.md'), 'utf-8');

const SPEC = `---
# gstack: design-md-format=spec
name: Heritage
colors:
  primary: "#1A1C1E"
  accent: "#B8422E"
  cta: "{colors.accent}"
typography:
  display:
    fontFamily: Public Sans
    fontSize: 3rem
rounded:
  md: 8px
spacing:
  md: 16px
components:
  button-primary:
    backgroundColor: "{colors.cta}"
    textColor: "{colors.primary}"
---

# Heritage

## Overview

Architectural minimalism.

## Colors

Ink and clay.

## Typography

Public Sans everywhere.

## Motion

One authored moment.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-08 | spec format | portable |
`;

describe('parse + detect', () => {
  test('spec file: front matter bytes preserved, marker read from line 2, sections classified', () => {
    const doc = parseDesignMd(SPEC);
    expect(doc.marker).toBe('spec');
    expect(doc.frontmatter?.name).toBe('Heritage');
    expect(doc.frontmatterText).toContain('primary: "#1A1C1E"');
    expect(doc.preamble).toBe('# Heritage');
    expect(doc.sections.map(s => s.canonical ?? s.heading)).toEqual(['Overview', 'Colors', 'Typography', 'Motion', 'Decisions Log']);
    expect(detectFormat(doc)).toEqual({ format: 'spec', code: 'spec' });
  });

  test("the legacy fixture is legacy, gstack's own DESIGN.md is spec; a fresh file is unknown; nothing is missing", () => {
    const doc = parseDesignMd(LEGACY);
    expect(isLegacyGstackFormat(doc)).toBe(true);
    expect(detectFormat(doc)).toEqual({ format: 'legacy', code: 'legacy' });
    const own = parseDesignMd(fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf-8'));
    expect(detectFormat(own)).toEqual({ format: 'spec', code: 'spec' });
    expect(own.marker).toBe('spec');
    expect(tokensFlat(own.frontmatter).errors).toEqual([]);
    expect(detectFormat(parseDesignMd('# Hello\n\nJust prose.\n')).format).toBe('unknown');
    expect(detectFormat(null)).toEqual({ format: 'missing', code: 'missing' });
  });

  test('malformed front matter is unknown with a reason, never a throw', () => {
    const doc = parseDesignMd('---\ncolors: [unclosed\n---\n\n## Overview\n\nx\n');
    expect(doc.frontmatter).toBeNull();
    const d = detectFormat(doc);
    expect(d.format).toBe('unknown');
    expect(d.reason).toMatch(/front matter does not parse/);
  });

  test('legacy headings plus front matter is ambiguous', () => {
    const d = detectFormat(parseDesignMd('---\nname: x\ncolors:\n  a: "#fff"\n---\n\n## Product Context\n\nx\n\n## Aesthetic Direction\n\ny\n'));
    expect(d.format).toBe('unknown');
    expect(d.reason).toMatch(/^ambiguous/);
  });

  test('a ## inside a code fence is not a section', () => {
    const doc = parseDesignMd('## Overview\n\n```md\n## Not a section\n```\n\n## Colors\n\nx\n');
    expect(doc.sections.map(s => s.heading)).toEqual(['Overview', 'Colors']);
  });

  test('legacy marker on line 1 is read and survives a render', () => {
    const doc = parseDesignMd('<!-- gstack: design-md-format=legacy-keep -->\n# Design System — X\n\n## Product Context\n\n- a\n\n## Color\n\n- **Primary:** #fff\n');
    expect(doc.marker).toBe('legacy-keep');
    const out = renderDesignMd(doc);
    expect(out.split('\n')[0]).toBe('<!-- gstack: design-md-format=legacy-keep -->');
    expect(out).toContain('# Design System — X');
  });
});

describe('render + upsert', () => {
  test('round trip is stable and keeps canonical order with extras after', () => {
    const once = renderDesignMd(parseDesignMd(SPEC));
    expect(renderDesignMd(parseDesignMd(once))).toBe(once);
    const headings = [...once.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(['Overview', 'Colors', 'Typography', 'Motion', 'Decisions Log']);
    expect(once.split('\n')[0]).toBe('---');
    expect(once.split('\n')[1]).toBe('# gstack: design-md-format=spec');
  });

  test('canonical sections re-sort into spec order when the file had them shuffled', () => {
    const shuffled = '---\nname: x\ncolors:\n  a: "#fff"\n---\n\n## Typography\n\nt\n\n## Overview\n\no\n\n## Shapes\n\ns\n\n## Colors\n\nc\n\n## Custom\n\nz\n';
    const out = renderDesignMd(parseDesignMd(shuffled));
    const headings = [...out.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(['Overview', 'Colors', 'Typography', 'Shapes', 'Custom']);
    const order = headings.filter(h => (CANONICAL_SECTIONS as readonly string[]).includes(h)).map(h => CANONICAL_SECTIONS.indexOf(h as any));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('aliases map to canonical names (Brand & Style → Overview, Elevation → Elevation & Depth); a spec-shaped file renders them canonically, a plain file keeps its words', () => {
    const plain = parseDesignMd('## Brand & Style\n\nx\n\n## Elevation\n\ny\n');
    expect(plain.sections.map(s => s.canonical)).toEqual(['Overview', 'Elevation & Depth']);
    expect(renderDesignMd(plain)).toContain('## Elevation\n'); // no front matter: the user's headings stay
    const spec = parseDesignMd('---\nname: x\ncolors:\n  a: "#fff"\n---\n\n## Elevation\n\ny\n\n## Brand & Style\n\nx\n');
    const out = renderDesignMd(spec);
    expect(out).toContain('## Elevation & Depth');
    expect(out.indexOf('## Overview')).toBeLessThan(out.indexOf('## Elevation & Depth'));
  });

  test('upsertSection splices the body only: front matter bytes are identical before and after', () => {
    const doc = parseDesignMd(SPEC);
    const next = upsertSection(upsertSection(doc, 'Colors', 'Ink, clay, and one more.'), 'Extracted Design Language', 'from a mockup');
    const out = renderDesignMd(next);
    const fmBefore = SPEC.slice(0, SPEC.indexOf('\n---\n', 4) + 5);
    expect(out.startsWith(fmBefore)).toBe(true);
    expect(out).toContain('## Colors\n\nInk, clay, and one more.');
    const headings = [...out.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(['Overview', 'Colors', 'Typography', 'Motion', 'Decisions Log', 'Extracted Design Language']);
  });

  test('a legacy or unknown file renders in its own section order; only spec-shaped files sort canonically', () => {
    const legacy = parseDesignMd(LEGACY);
    const out = renderDesignMd(legacy);
    const headings = (s: string) => [...s.matchAll(/^## (.+)$/gm)].map(x => x[1]);
    expect(headings(out)).toEqual(headings(LEGACY));
  });

  test('spliceSection replaces or appends one section and leaves every other byte alone', () => {
    const once = spliceSection(SPEC, 'Extracted Design Language', 'from a mockup');
    expect(once.startsWith(SPEC.replace(/\s*$/, ''))).toBe(true);
    expect(once.endsWith('## Extracted Design Language\n\nfrom a mockup\n')).toBe(true);
    const twice = spliceSection(once, 'Extracted Design Language', 'second pass');
    expect(twice.split('## Extracted Design Language').length - 1).toBe(1);
    expect(twice).toContain('second pass');
    expect(twice).not.toContain('from a mockup');
    expect(twice.slice(0, twice.indexOf('## Extracted'))).toBe(once.slice(0, once.indexOf('## Extracted')));
    // replacing a middle section keeps what follows
    const mid = spliceSection(SPEC, 'Colors', 'Ink only.');
    expect(mid).toContain('## Colors\n\nInk only.\n\n## Typography');
    expect(mid).toContain('## Decisions Log');
  });

  test('insertMarker adds or replaces the marker only: line 2 YAML comment for front matter, line 1 HTML comment otherwise', () => {
    const noMarker = SPEC.replace('# gstack: design-md-format=spec\n', '');
    expect(insertMarker(noMarker, 'spec')).toBe(SPEC);
    expect(insertMarker(SPEC, 'spec')).toBe(SPEC);
    const kept = insertMarker(LEGACY, 'legacy-keep');
    expect(kept).toBe('<!-- gstack: design-md-format=legacy-keep -->\n' + LEGACY);
    expect(insertMarker(kept, 'legacy-keep')).toBe(kept);
  });

  test('a marker on the parsed doc renders as the YAML comment on line 2 and nothing else moves', () => {
    const noMarker = SPEC.replace('# gstack: design-md-format=spec\n', '');
    const out = renderDesignMd({ ...parseDesignMd(noMarker), marker: 'spec' });
    expect(out.split('\n').slice(0, 3)).toEqual(['---', '# gstack: design-md-format=spec', 'name: Heritage']);
  });
});

describe('tokens', () => {
  test('flattens the five groups and resolves {path} references to primitives', () => {
    const { tokens, errors } = tokensFlat(parseDesignMd(SPEC).frontmatter);
    expect(errors).toEqual([]);
    expect(tokens['colors.primary']).toBe('#1A1C1E');
    expect(tokens['colors.cta']).toBe('#B8422E');
    expect(tokens['components.button-primary.backgroundColor']).toBe('#B8422E');
    expect(tokens['components.button-primary.textColor']).toBe('#1A1C1E');
    expect(tokens['typography.display.fontSize']).toBe('3rem');
    expect(Object.keys(tokens).every(k => TOKEN_GROUPS.some(g => k.startsWith(g + '.')))).toBe(true);
    expect('name' in tokens).toBe(false);
  });

  test('group refs, self refs, and dangling refs are DESIGN_MD_TOKEN_REF_INVALID', () => {
    const fm = { colors: { a: '#111', group: '{colors}', self: '{colors.self}', gone: '{colors.nope}' }, components: { btn: { bg: '{colors}' } } };
    const { tokens, errors } = tokensFlat(fm);
    expect(tokens['colors.a']).toBe('#111');
    expect(errors.filter(e => e.startsWith('DESIGN_MD_TOKEN_REF_INVALID: ')).length).toBe(4);
    expect(errors.join('\n')).toContain('{colors} (refers to a group');
    expect(errors.join('\n')).toContain('{colors.self} (self-reference)');
    expect(errors.join('\n')).toContain('{colors.nope} (no such token)');
  });

  test('emitYamlBlock writes block style that Bun.YAML parses back identically', () => {
    const obj = { name: 'X: y', colors: { primary: '#fff', 'on-primary': '#000', weird: 'yes' }, spacing: { '2xs': '2px', md: 16 }, list: ['a', 'b'] };
    const yaml = emitYamlBlock(obj);
    expect(yaml).not.toContain('{');
    expect(yaml).toContain('colors:\n  primary: "#fff"');
    expect((Bun as any).YAML.parse(yaml)).toEqual(obj);
  });
});

describe('convertLegacy on the legacy fixture (gstack\'s pre-conversion DESIGN.md)', () => {
  const converted = convertLegacy(parseDesignMd(LEGACY));
  const out = renderDesignMd(converted, { emitFrontmatter: true });

  test('produces a spec file with the marker on line 2 and only the five token groups plus name', () => {
    const doc = parseDesignMd(out);
    expect(detectFormat(doc)).toEqual({ format: 'spec', code: 'spec' });
    expect(out.split('\n')[1]).toBe('# gstack: design-md-format=spec');
    for (const k of Object.keys(doc.frontmatter!)) expect(['name', ...TOKEN_GROUPS]).toContain(k);
    expect(doc.frontmatter!.name).toBe('gstack');
  });

  test('maps roles, colors, spacing, and radii into tokens', () => {
    const { tokens, errors } = tokensFlat(parseDesignMd(out).frontmatter);
    expect(errors).toEqual([]);
    expect(tokens['typography.display.fontFamily']).toBe('Satoshi');
    expect(tokens['typography.body.fontFamily']).toBe('DM Sans');
    expect(tokens['typography.label.fontFamily']).toBe('DM Sans');
    expect(tokens['typography.mono.fontFamily']).toBe('JetBrains Mono');
    expect(tokens['typography.mono.fontFeature']).toBe('tnum');
    expect(tokens['colors.primary-dark-mode']).toBe('#F59E0B');
    expect(tokens['colors.primary-light-mode']).toBe('#D97706');
    expect(tokens['colors.success']).toBe('#22C55E');
    expect(tokens['colors.semantic']).toBeUndefined();
    expect(tokens['spacing.md']).toBe('16px');
    expect(tokens['spacing.2xs']).toBe('2px');
    expect(tokens['rounded.lg']).toBe('12px');
    expect(tokens['rounded.full']).toBe('9999px');
  });

  test('intro prose under the title survives conversion', () => {
    const withIntro = LEGACY.replace('# Design System — gstack\n', '# Design System — gstack\n\nAn intro paragraph that must not vanish.\n');
    const out2 = renderDesignMd(convertLegacy(parseDesignMd(withIntro)), { emitFrontmatter: true });
    expect(out2).toContain('An intro paragraph that must not vanish.');
    expect(out2).toContain('# Design System — gstack');
  });

  test('folds Product Context and Aesthetic Direction into Overview; Motion, Grain Texture, Decisions Log survive as extras in order', () => {
    const headings = [...out.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(['Overview', 'Colors', 'Typography', 'Layout', 'Motion', 'Grain Texture', 'Decisions Log']);
    expect(out).toContain('**What this is:**');
    expect(out).toContain('**Direction:** Industrial/Utilitarian');
    expect(out).toContain('| 2026-03-21 | Grain texture |');
    expect(out).toContain('### Spacing');
  });

  test('re-rendering the converted file is stable (idempotent write)', () => {
    expect(renderDesignMd(parseDesignMd(out))).toBe(out);
  });
});

describe('coverage: parser and token edges', () => {
  test('CRLF input parses to the same document; front matter closing at EOF without a newline parses; an unclosed fence is body', () => {
    const lf = parseDesignMd(SPEC);
    const crlf = parseDesignMd(SPEC.replace(/\n/g, '\r\n'));
    expect(crlf.frontmatter).toEqual(lf.frontmatter);
    expect(crlf.sections.map(s => s.heading)).toEqual(lf.sections.map(s => s.heading));
    const eof = parseDesignMd('---\nname: x\ncolors:\n  a: "#fff"\n---');
    expect(eof.frontmatter?.name).toBe('x');
    expect(eof.sections).toEqual([]);
    const unclosed = parseDesignMd('---\nname: x\n\n## Overview\n\nbody\n');
    expect(unclosed.frontmatterText).toBeNull();
    expect(unclosed.sections.map(s => s.heading)).toEqual(['Overview']);
  });

  test('detectFormat: front matter without a token group is unknown with its reason; name-only is spec; one legacy heading is unknown', () => {
    expect(detectFormat(parseDesignMd('---\nfoo: 1\n---\n\n## Overview\n\nx\n'))).toEqual({ format: 'unknown', code: 'no-token-groups', reason: 'front matter carries none of the five token groups' });
    expect(detectFormat(parseDesignMd('---\nname: X\n---\n\n## Overview\n\nx\n')).format).toBe('spec');
    expect(detectFormat(parseDesignMd('# T\n\n## Product Context\n\nx\n')).format).toBe('unknown');
  });

  test('tokensFlat: reference cycles error, arrays are skipped, numbers stringify, deep chains resolve up to the hop limit', () => {
    const cyc = tokensFlat({ colors: { a: '{colors.b}', b: '{colors.a}' } });
    expect(cyc.errors.join('\n')).toContain('(reference cycle)');
    const arr = tokensFlat({ colors: { list: ['#111', '#222'], a: '#333' }, spacing: { md: 16 } });
    expect(arr.tokens['colors.list']).toBeUndefined();
    expect(arr.tokens['colors.a']).toBe('#333');
    expect(arr.tokens['spacing.md']).toBe('16');
    const chain: Record<string, string> = { base: '#000' };
    for (let i = 1; i <= 7; i++) chain[`c${i}`] = `{colors.${i === 1 ? 'base' : `c${i - 1}`}}`;
    expect(tokensFlat({ colors: chain }).tokens['colors.c7']).toBe('#000');
  });

  test('convertLegacy: no title → name "Design System"; opts.name wins; a doc without Color/Spacing/Layout gets Overview only plus extras; rem units survive; "## Colors" alias is consumed', () => {
    const bare = parseDesignMd('## Product Context\n\n- **What this is:** x\n\n## Aesthetic Direction\n\n- **Direction:** y\n\n## Motion\n\n- **Approach:** z\n');
    const conv = convertLegacy(bare);
    expect(conv.frontmatter?.name).toBe('Design System');
    expect(convertLegacy(bare, { name: 'Custom' }).frontmatter?.name).toBe('Custom');
    expect(conv.sections.map(s => s.canonical ?? s.heading)).toEqual(['Overview', 'Motion']);
    expect(conv.sections[0].body).toContain('**What this is:** x');
    const rem = parseDesignMd('# T\n\n## Product Context\n\n- **What this is:** x\n\n## Colors\n\n- **Primary:** #111111\n\n## Spacing\n\n- **Scale:** sm(0.5rem) md(1rem) lg(2)\n');
    const t = tokensFlat(convertLegacy(rem).frontmatter);
    expect(t.tokens['spacing.sm']).toBe('0.5rem');
    expect(t.tokens['spacing.lg']).toBe('2px');
    expect(t.tokens['colors.primary']).toBe('#111111');
    expect(convertLegacy(rem).sections.map(s => s.canonical ?? s.heading)).toEqual(['Overview', 'Colors', 'Layout']);
    const empty = parseDesignMd('## Nothing\n\nx\n');
    expect(convertLegacy(empty).sections[0].body).toBe('(no product context recorded)');
  });

  test('renderDesignMd with emitFrontmatter and unparsable front matter falls back to the preserved bytes', () => {
    const doc = parseDesignMd('---\ncolors: [unclosed\n---\n\n## Overview\n\nx\n');
    expect(doc.frontmatter).toBeNull();
    const out = renderDesignMd(doc, { emitFrontmatter: true });
    expect(out).toContain('colors: [unclosed');
  });

  test('YAML scalars: null → "", numeric-looking and empty strings quoted, hex quoted, dashed keys unquoted; all parse back', () => {
    const obj = { a: null as unknown as string, b: '16', c: '', d: '#fff', 'on-primary': 'x', e: 'yes', f: 'plain text', g: 3 };
    const yaml = emitYamlBlock(obj as Record<string, unknown>);
    expect(yaml).toContain('a: ""');
    expect(yaml).toContain('b: "16"');
    expect(yaml).toContain('c: ""');
    expect(yaml).toContain('d: "#fff"');
    expect(yaml).toContain('on-primary: x');
    expect(yaml).toContain('e: "yes"');
    expect(yaml).toContain('f: plain text');
    expect(yaml).toContain('g: 3');
    const back = (Bun as any).YAML.parse(yaml);
    expect(back.b).toBe('16');
    expect(back.d).toBe('#fff');
    expect(back.e).toBe('yes');
    expect(back.g).toBe(3);
  });
});

describe('coverage: bin verbs and the memory writer edges', () => {
  const run = runBin;

  test('mark spec on an unmarked spec file; mark on a missing file; tokens on a missing file and with invalid refs; explicit path; no verb', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), SPEC.replace('# gstack: design-md-format=spec\n', ''));
      expect(run(['check'], dir).out).toContain('DESIGN_MD_MARKER: none');
      expect(run(['mark', 'spec'], dir).code).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8').split('\n')[1]).toBe('# gstack: design-md-format=spec');
      const missing = run(['mark', 'legacy-keep', 'nope.md'], dir);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain('DESIGN_MD_FORMAT: missing');
      const t0 = JSON.parse(run(['tokens', 'nope.md'], dir).out);
      expect(t0.format).toBe('missing');
      expect(t0.tokens).toEqual({});
      fs.writeFileSync(path.join(dir, 'other.md'), '---\nname: x\ncolors:\n  a: "{colors}"\n  b: "#000"\n---\n\n## Overview\n\nx\n');
      const t1 = run(['tokens', 'other.md'], dir);
      expect(t1.code).toBe(0);
      expect(t1.err).toContain('DESIGN_MD_TOKEN_REF_INVALID: {colors}');
      expect(JSON.parse(t1.out).tokens['colors.b']).toBe('#000');
      expect(run(['check', 'other.md'], dir).out).toContain('DESIGN_MD_FORMAT: spec');
      const usage = run([], dir);
      expect(usage.code).toBe(2);
      expect(usage.err).toContain('usage:');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('updateDesignMd: non-hex colors and duplicate roles are dropped on a new file; a headingless file gains the section; unparsable front matter is preserved byte-for-byte', () => {
    const extracted = {
      colors: [{ name: 'Primary', hex: 'rgb(1,2,3)', usage: 'x' }, { name: 'Surface', hex: '#141414', usage: 'y' }],
      typography: [{ role: 'heading', family: 'Satoshi', size: '48px', weight: '900' }, { role: 'heading', family: 'Inter', size: '1px', weight: '100' }],
      spacing: [], layout: [], mood: 'm',
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      updateDesignMd(dir, extracted, '/tmp/m.png');
      const fresh = parseDesignMd(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8'));
      const tokens = tokensFlat(fresh.frontmatter).tokens;
      expect(tokens['colors.primary']).toBeUndefined();
      expect(tokens['colors.surface']).toBe('#141414');
      expect(tokens['typography.heading.fontFamily']).toBe('Satoshi');

      fs.writeFileSync(path.join(dir, 'DESIGN.md'), '# Just a title\n\nSome prose without sections.\n');
      updateDesignMd(dir, extracted, '/tmp/m.png');
      const headless = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(headless.startsWith('# Just a title')).toBe(true);
      expect(headless).toContain('## Extracted Design Language');

      const broken = '---\ncolors: [unclosed\n---\n\n## Overview\n\nx\n';
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), broken);
      updateDesignMd(dir, extracted, '/tmp/m.png');
      const after = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(after.startsWith('---\ncolors: [unclosed\n---\n')).toBe(true);
      expect(after).toContain('## Extracted Design Language');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('bin/gstack-design-md.ts', () => {
  const run = runBin;

  test('check reports format + marker for spec, legacy, unknown, missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      expect(run(['check'], dir).out).toContain('DESIGN_MD_FORMAT: missing');
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), SPEC);
      expect(run(['check'], dir).out).toBe('DESIGN_MD_FORMAT: spec\nDESIGN_MD_MARKER: spec\n');
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), LEGACY);
      expect(run(['check'], dir).out).toBe('DESIGN_MD_FORMAT: legacy\nDESIGN_MD_MARKER: none\n');
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), '---\n: bad: [\n---\n');
      const bad = run(['check'], dir);
      expect(bad.out).toContain('DESIGN_MD_FORMAT: unknown');
      expect(bad.out).toContain('DESIGN_MD_REASON: front matter does not parse');
      expect(bad.code).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('convert --write backs up, writes atomically, refuses ambiguous and non-legacy input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), LEGACY);
      const dry = run(['convert'], dir);
      expect(dry.code).toBe(0);
      expect(dry.out.split('\n')[1]).toBe('# gstack: design-md-format=spec');
      expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8')).toBe(LEGACY);
      const wr = run(['convert', '--write'], dir);
      expect(wr.code).toBe(0);
      expect(wr.out).toContain('DESIGN_MD_WRITTEN:');
      expect(fs.readFileSync(path.join(dir, 'DESIGN.md.legacy.bak'), 'utf-8')).toBe(LEGACY);
      expect(run(['check'], dir).out).toContain('DESIGN_MD_FORMAT: spec');
      expect(fs.readdirSync(dir).some(f => f.includes('.tmp-'))).toBe(false);
      // already spec → refused as non-legacy (exit 1), not clobbered
      const again = run(['convert', '--write'], dir);
      expect(again.code).toBe(1);
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), '---\nname: x\ncolors:\n  a: "#fff"\n---\n\n## Product Context\n\nx\n\n## Aesthetic Direction\n\ny\n');
      const amb = run(['convert', '--write'], dir);
      expect(amb.code).toBe(2);
      expect(amb.err).toContain('DESIGN_MD_CONVERT_REFUSED: ambiguous');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('tokens prints the flat map; mark persists the choice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), SPEC);
      const t = JSON.parse(run(['tokens'], dir).out);
      expect(t.tokens['colors.cta']).toBe('#B8422E');
      expect(t.errors).toEqual([]);
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), LEGACY);
      const m = run(['mark', 'legacy-keep'], dir);
      expect(m.code).toBe(0);
      const text = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(text).toBe('<!-- gstack: design-md-format=legacy-keep -->\n' + LEGACY); // byte-identical apart from line 1
      expect(run(['check'], dir).out).toBe('DESIGN_MD_FORMAT: legacy\nDESIGN_MD_MARKER: legacy-keep\n');
      expect(run(['mark', 'maybe'], dir).code).toBe(2);
      // a choice that contradicts the file is refused and the file is unchanged
      const bad = run(['mark', 'spec'], dir);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain('DESIGN_MD_CONVERT_REFUSED: mark spec contradicts');
      expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8')).toBe(text);
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), SPEC);
      expect(run(['mark', 'legacy-keep'], dir).code).toBe(2);
      expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8')).toBe(SPEC);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('design binary: updateDesignMd is frontmatter-safe', () => {
  const extracted = {
    colors: [{ name: 'Primary', hex: '#F59E0B', usage: 'buttons' }, { name: 'Surface', hex: '#141414', usage: 'cards' }],
    typography: [{ role: 'heading', family: 'Satoshi', size: '48px', weight: '900' }],
    spacing: ['8px base unit'],
    layout: ['max-width 1200px'],
    mood: 'Serious tool built with care.',
  };

  test('spec input: section appended after the canonical ones, front matter bytes untouched, replaces on rerun', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), SPEC);
      updateDesignMd(dir, extracted, '/tmp/mock.png');
      const once = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(once.startsWith(SPEC.slice(0, SPEC.indexOf('\n---\n', 4) + 5))).toBe(true);
      expect([...once.matchAll(/^## (.+)$/gm)].map(m => m[1]).at(-1)).toBe('Extracted Design Language');
      expect(once.split('## Extracted Design Language').length - 1).toBe(1);
      updateDesignMd(dir, { ...extracted, mood: 'second pass' }, '/tmp/mock2.png');
      const twice = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(twice.split('## Extracted Design Language').length - 1).toBe(1);
      expect(twice).toContain('second pass');
      expect(twice).not.toContain('Serious tool built with care.');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('legacy input: sections preserved, extracted section added at the end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), LEGACY);
      updateDesignMd(dir, extracted, '/tmp/mock.png');
      const out = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(out.startsWith(LEGACY.replace(/\s*$/, ''))).toBe(true); // every original byte kept, in order
      expect([...out.matchAll(/^## (.+)$/gm)].map(m => m[1]).at(-1)).toBe('Extracted Design Language');
      expect(detectFormat(parseDesignMd(out)).format).toBe('legacy');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('absent input: a spec skeleton with tokens from the extraction; readDesignConstraints leads with tokens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-'));
    try {
      updateDesignMd(dir, extracted, '/tmp/mock.png');
      const out = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      const doc = parseDesignMd(out);
      expect(detectFormat(doc).format).toBe('spec');
      expect(out.split('\n').slice(0, 2)).toEqual(['---', '# gstack: design-md-format=spec']);
      const { tokens } = tokensFlat(doc.frontmatter);
      expect(tokens['colors.primary']).toBe('#F59E0B');
      expect(tokens['typography.heading.fontFamily']).toBe('Satoshi');
      expect([...out.matchAll(/^## (.+)$/gm)].map(m => m[1])).toEqual(['Overview', 'Extracted Design Language']);
      const constraints = readDesignConstraints(dir)!;
      expect(constraints.startsWith('Tokens: colors.primary: #F59E0B')).toBe(true);
      expect(constraints).toContain('Serious tool built with care.');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('text-level editors keep line endings and respect fences', () => {
  const SPEC_LF = ['---', 'name: x', 'colors:', '  a: "#fff"', '---', '', '## Overview', '', 'o', '', '## Colors', '', 'c', ''].join('\n');

  test('insertMarker and spliceSection preserve CRLF line endings', () => {
    const crlf = SPEC_LF.replace(/\n/g, '\r\n');
    const marked = insertMarker(crlf, 'spec');
    expect(marked).toBe(crlf.replace('---\r\n', '---\r\n# gstack: design-md-format=spec\r\n'));
    expect(marked).not.toMatch(/[^\r]\n/);
    const legacyCrlf = '# T\r\n\r\n## Product Context\r\n\r\np\r\n';
    expect(insertMarker(legacyCrlf, 'legacy-keep')).toBe('<!-- gstack: design-md-format=legacy-keep -->\r\n' + legacyCrlf);
    const spliced = spliceSection(crlf, 'Colors', 'Ink only.');
    expect(spliced).toBe(SPEC_LF.replace('## Colors\n\nc\n', '## Colors\n\nInk only.\n').replace(/\n/g, '\r\n'));
    expect(spliceSection(SPEC_LF, 'Colors', 'Ink only.')).not.toContain('\r');
  });

  test('a fenced ## inside a section does not end it; an unclosed fence runs to EOF for readers and refuses the edit', () => {
    const src = '## A\n\nbody\n\n```md\n## Not a heading\n```\n\n## B\n\nb body\n';
    expect(spliceSection(src, 'A', 'x')).toBe('## A\n\nx\n\n## B\n\nb body\n');
    expect(parseDesignMd(src).sections.map(s => s.heading)).toEqual(['A', 'B']);
    const unclosed = '## A\n\nbody\n\n```\nunclosed\n\n## B\n\nb body\n';
    expect(parseDesignMd(unclosed).sections.map(s => s.heading)).toEqual(['A']); // markdown: everything after the fence is code
    expect(() => spliceSection(unclosed, 'A', 'x')).toThrow(DesignMdEditRefused);
    expect(() => spliceSection(unclosed, 'A', 'x')).toThrow(/DESIGN_MD_EDIT_REFUSED: unclosed code fence/);
    // the design binary skips the write and says why, rather than editing an ambiguous file
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-fence-'));
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), unclosed);
    updateDesignMd(dir, { colors: [{ name: 'Ink', hex: '#111111', usage: 'text' }], typography: [], spacing: [], layout: [], mood: '' }, 'm.png');
    expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8')).toBe(unclosed);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('re-marking a marked spec file changes nothing; a stray CRLF does not flip an LF file; a BOM stays at byte 0', () => {
    const marked = insertMarker(SPEC_LF, 'spec');
    expect(insertMarker(marked, 'spec')).toBe(marked); // the old regex ate the blank line after the marker
    expect(insertMarker(marked, 'legacy-keep')).toBe(marked.replace('design-md-format=spec', 'design-md-format=legacy-keep'));
    const stray = SPEC_LF.replace('name: x\n', 'name: x\r\n');
    expect(spliceSection(stray, 'Colors', 'c2')).not.toContain('\r'); // majority LF wins; the one stray CRLF is normalized, nothing else flips
    const bom = '\uFEFF' + SPEC_LF;
    expect(insertMarker(bom, 'spec')).toBe('\uFEFF' + insertMarker(SPEC_LF, 'spec'));
    expect(spliceSection(bom, 'Colors', 'c2')).toBe('\uFEFF' + spliceSection(SPEC_LF, 'Colors', 'c2'));
    expect(parseDesignMd(bom).frontmatterText).not.toBeNull();
    expect(detectFormat(parseDesignMd(bom)).format).toBe('spec');
  });

  test('a scalar with a space-hash (an inline comment shape) is quoted and parses back', () => {
    const yaml = emitYamlBlock({ colors: { amber: 'amber #F59E0B' } });
    expect(Bun.YAML.parse(yaml)).toEqual({ colors: { amber: 'amber #F59E0B' } });
  });

  test('a token value with an embedded newline is quoted and parses back', () => {
    const yaml = emitYamlBlock({ typography: { body: { fontFamily: 'Foo\nBar', fontSize: '16px\tx' } } });
    expect(Bun.YAML.parse(yaml)).toEqual({ typography: { body: { fontFamily: 'Foo\nBar', fontSize: '16px\tx' } } });
  });
});

describe('bin/gstack-design-md.ts follows a symlinked DESIGN.md', () => {
  test('mark edits the target file and leaves the link a link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-link-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    const legacy = '# T\n\n## Product Context\n\np\n\n## Aesthetic Direction\n\na\n';
    fs.writeFileSync(path.join(dir, 'docs', 'DESIGN.md'), legacy);
    fs.symlinkSync(path.join('docs', 'DESIGN.md'), path.join(dir, 'DESIGN.md'));
    try {
      const r = spawnSync(process.execPath, ['--no-env-file', 'run', BIN, 'mark', 'legacy-keep', 'DESIGN.md'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
      expect(r.status).toBe(0);
      expect(fs.lstatSync(path.join(dir, 'DESIGN.md')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'docs', 'DESIGN.md'), 'utf-8')).toBe('<!-- gstack: design-md-format=legacy-keep -->\n' + legacy);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adversarial round: markdown edge cases the editors must survive', () => {
  test('a legacy file that opens with a horizontal rule gets the HTML-comment marker, and the marker is read back', () => {
    const legacy = '---\n\n# Design\n\n## Product Context\n\np\n\n## Aesthetic Direction\n\na\n';
    expect(detectFormat(parseDesignMd(legacy)).format).toBe('legacy');
    const marked = insertMarker(legacy, 'legacy-keep');
    expect(marked).toBe('<!-- gstack: design-md-format=legacy-keep -->\n' + legacy);
    expect(parseDesignMd(marked).marker).toBe('legacy-keep');
  });

  test('a closing front-matter fence with trailing spaces still closes; a `---x` value line does not', () => {
    const doc = parseDesignMd('---\nname: x\ncolors:\n  a: "#fff"\n---  \n\n## Overview\n\no\n');
    expect(doc.frontmatterText).toBe('name: x\ncolors:\n  a: "#fff"\n');
    expect(detectFormat(doc).format).toBe('spec');
    expect(doc.sections.map(s => s.heading)).toEqual(['Overview']);
    const odd = parseDesignMd('---\nname: x\ndescription: ---x\ncolors:\n  a: "#fff"\n---\n\n## Overview\n\no\n');
    expect(odd.frontmatter).toEqual({ name: 'x', description: '---x', colors: { a: '#fff' } });
  });

  test('~~~ fences hide headings like ``` fences, and only the same kind closes an opener', () => {
    const src = '## Overview\n\n~~~\n## Fake\n```\nstill inside\n~~~\n\n## Colors\n\nc\n';
    expect(parseDesignMd(src).sections.map(s => s.heading)).toEqual(['Overview', 'Colors']);
    expect(spliceSection(src, 'Overview', 'NEW')).toBe('## Overview\n\nNEW\n\n## Colors\n\nc\n');
  });

  test('YAML 1.2 numeric shapes and nested array items are handled by the emitter', () => {
    const yaml = emitYamlBlock({ typography: { body: { fontSize: '0x1F', fontWeight: '.inf', lineHeight: '0o17' } } });
    expect(Bun.YAML.parse(yaml)).toEqual({ typography: { body: { fontSize: '0x1F', fontWeight: '.inf', lineHeight: '0o17' } } });
    expect(() => emitYamlBlock({ components: [{ a: 1 }] } as never)).toThrow(/array items must be scalars/);
  });

  test('convert refuses a legacy file whose consumed heading repeats, instead of dropping a body', () => {
    const dup = '# T\n\n## Product Context\n\np\n\n## Aesthetic Direction\n\na\n\n## Layout\n\nl1\n\n## Layout\n\nl2\n';
    expect(() => convertLegacy(parseDesignMd(dup))).toThrow(/appears more than once/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-dup-'));
    try {
      fs.writeFileSync(path.join(dir, 'DESIGN.md'), dup);
      const r = runBin(['convert', 'DESIGN.md', '--write'], dir);
      expect(r.code).toBe(2);
      expect(r.err).toContain('DESIGN_MD_CONVERT_REFUSED: legacy heading "## Layout" appears more than once');
      expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8')).toBe(dup);
      expect(fs.existsSync(path.join(dir, 'DESIGN.md.legacy.bak'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the design binary tolerates unvalidated extraction output (null names, missing arrays)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-md-null-'));
    try {
      updateDesignMd(dir, { colors: [{ name: null, hex: '#111111', usage: null }], typography: [{ role: null, family: 'X', size: null, weight: null }], spacing: [], layout: [], mood: '' } as never, 'm.png');
      const out = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
      expect(out.startsWith('---\n')).toBe(true);
      expect(Bun.YAML.parse(parseDesignMd(out).frontmatterText!)).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
