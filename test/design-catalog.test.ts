/**
 * lib/design-catalog.ts invariants.
 *
 * The catalog is the single source of truth for gstack's design anti-pattern
 * vocabulary. These pins keep it honest against the detector registry fixture
 * (a bracketed id must be one the engine can emit), keep the 11 legacy lines
 * byte-identical to what the generated skills already carry, and keep the
 * module pure enough for bin/ to import at runtime on every host.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  DESIGN_SLOP_CATALOG, HANDOFF_COMMANDS, OVERUSED_FONTS_DISPLAY, BANNED_FONTS, MOCKUP_NEVER_NAMES,
  FONTS_BODY_UI_OK, FONTS_MONO_OK, FONTS_VERIFIED_FREE,
  catalogEntry, catalogEntries, entryForImpeccableId, renderCatalog, selectCatalog, detectorSlopEntries, judgmentTellEntries,
} from '../lib/design-catalog';
import { AI_SLOP_BLACKLIST } from '../scripts/resolvers/constants';

const ROOT = path.join(import.meta.dir, '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'impeccable-antipatterns.json'), 'utf-8'));
const registryById = new Map<string, { id: string; category: string }>(registry.rules.map((r: any) => [r.id, r]));

const CATEGORIES = ['scaffold', 'surface', 'type', 'color', 'layout', 'motion', 'copy', 'states', 'imagery', 'browser-surface'];

describe('catalog shape', () => {
  test('ids are unique kebab-case and every field is in its domain', () => {
    const ids = new Set<string>();
    for (const e of DESIGN_SLOP_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.prose.length).toBeGreaterThan(0);
      expect(CATEGORIES).toContain(e.category);
      expect(['slop', 'quality']).toContain(e.kind);
      expect(e.detect.length).toBeGreaterThan(0);
      for (const d of e.detect) expect(['engine', 'grep', 'render', 'llm']).toContain(d);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(e.confidence);
      expect(['auto-fix', 'ask', 'possible']).toContain(e.tier);
      expect(['high', 'medium', 'polish']).toContain(e.impact);
      expect(['gstack', 'impeccable', 'both']).toContain(e.source);
    }
  });

  test('impeccableId equals id, is unique, and exists in the registry fixture', () => {
    const seen = new Set<string>();
    for (const e of DESIGN_SLOP_CATALOG.filter(x => x.impeccableId)) {
      expect(e.impeccableId).toBe(e.id);
      expect(seen.has(e.impeccableId!)).toBe(false);
      seen.add(e.impeccableId!);
      expect(registryById.has(e.impeccableId!)).toBe(true);
      expect(e.kind).toBe(registryById.get(e.impeccableId!)!.category);
      expect(e.detect).toContain('engine');
      expect(['impeccable', 'both']).toContain(e.source);
    }
  });

  test('every registry rule is mapped: zero unmapped ids from a current engine', () => {
    for (const id of registryById.keys()) {
      expect(entryForImpeccableId(id)?.impeccableId).toBe(id);
    }
    expect(DESIGN_SLOP_CATALOG.filter(e => e.impeccableId).length).toBe(registry.rules.length);
  });

  test('gstack-only entries never claim engine detection or an impeccable source', () => {
    for (const e of DESIGN_SLOP_CATALOG.filter(x => !x.impeccableId)) {
      expect(e.detect).not.toContain('engine');
      expect(e.source).toBe('gstack');
      expect(registryById.has(e.id)).toBe(false);
    }
  });

  test('handoff is one of the eight commands; roles present iff values present', () => {
    expect(HANDOFF_COMMANDS.length).toBe(8);
    for (const e of DESIGN_SLOP_CATALOG) {
      if (e.handoff) expect(HANDOFF_COMMANDS).toContain(e.handoff);
      expect(Boolean(e.values)).toBe(Boolean(e.roles));
    }
  });

  test('grep-detectable entries carry a heuristic; heuristics only on grep entries', () => {
    for (const e of DESIGN_SLOP_CATALOG) {
      expect(Boolean(e.heuristic)).toBe(e.detect.includes('grep'));
    }
  });

  test('auto-fix is reserved for mechanical CSS fixes with HIGH confidence', () => {
    for (const e of DESIGN_SLOP_CATALOG.filter(x => x.tier === 'auto-fix')) {
      expect(e.confidence).toBe('HIGH');
      expect(e.kind).toBe('quality');
    }
    expect(catalogEntry('tiny-text')!.tier).toBe('auto-fix');
  });

  test('advisory em-dash rule is possible/polish so it never blocks', () => {
    const e = catalogEntry('em-dash-overuse')!;
    expect(e.tier).toBe('possible');
    expect(e.impact).toBe('polish');
  });
});

describe('legacy blacklist derivation', () => {
  test('exactly 11 legacy entries whose prose is AI_SLOP_BLACKLIST, in order', () => {
    const legacy = DESIGN_SLOP_CATALOG.filter(e => e.legacyBlacklist);
    expect(legacy.length).toBe(11);
    expect(legacy.map(e => e.prose)).toEqual(AI_SLOP_BLACKLIST);
    expect(AI_SLOP_BLACKLIST[0]).toBe('Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes');
    expect(AI_SLOP_BLACKLIST[1]).toContain('3-column feature grid');
    expect(AI_SLOP_BLACKLIST[7]).toContain('border-left: 3px solid');
  });

  test('legacy lines map to real detector ids where one exists', () => {
    expect(catalogEntry('ai-color-palette')!.legacyBlacklist).toBe(true);
    expect(catalogEntry('side-tab')!.legacyBlacklist).toBe(true);
    expect(catalogEntry('uniform-radius')!.impeccableId).toBeUndefined();
  });
});

describe('fonts', () => {
  test('overused display list is the overused-font entry, role-scoped to display', () => {
    const e = catalogEntry('overused-font')!;
    expect(e.values).toEqual([...OVERUSED_FONTS_DISPLAY]);
    expect(e.roles).toEqual(['display']);
    for (const f of ['Inter', 'Roboto', 'Fraunces', 'Geist', 'Plus Jakarta Sans', 'Space Grotesk', 'DM Sans', 'Instrument Sans', 'IBM Plex Sans']) {
      expect(OVERUSED_FONTS_DISPLAY).toContain(f);
    }
  });

  test('body/UI exceptions are on the overused list; the verified-free faces are not', () => {
    for (const f of FONTS_BODY_UI_OK) expect(OVERUSED_FONTS_DISPLAY).toContain(f);
    for (const f of [...FONTS_VERIFIED_FREE.fontshare, ...FONTS_VERIFIED_FREE.googleFonts]) {
      expect(OVERUSED_FONTS_DISPLAY).not.toContain(f);
      expect(BANNED_FONTS).not.toContain(f);
    }
    expect(FONTS_VERIFIED_FREE.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('banned fonts and overused fonts do not overlap; mono list is mono', () => {
    for (const f of BANNED_FONTS) { expect(OVERUSED_FONTS_DISPLAY).not.toContain(f); expect(f).not.toMatch(/\(/); } // no role qualifiers: banned means every role
    for (const f of FONTS_MONO_OK) expect(f).toMatch(/Mono|Code/);
  });
});

describe('renderCatalog + partitions', () => {
  test('bullets style renders prose only, no ids anywhere', () => {
    const out = renderCatalog({ kind: 'slop' });
    expect(out).not.toMatch(/^- \[/m);
    expect(out.split('\n').length).toBe(selectCatalog({ kind: 'slop' }).length);
    for (const line of AI_SLOP_BLACKLIST) expect(out).toContain(`- ${line}`);
  });

  test('omitImpact filters', () => {
    const noPolish = selectCatalog({ kind: 'slop', omitImpact: ['polish'] });
    expect(noPolish.some(e => e.impact === 'polish')).toBe(false);
    expect(noPolish.length).toBeLessThan(selectCatalog({ kind: 'slop' }).length);
  });

  test('detector-known slop and judgment tells partition the non-legacy slop entries', () => {
    const detector = detectorSlopEntries();
    const tells = judgmentTellEntries();
    expect(detector.every(e => e.impeccableId && !e.legacyBlacklist && e.kind === 'slop')).toBe(true);
    expect(tells.every(e => !e.impeccableId && !e.legacyBlacklist && e.kind === 'slop')).toBe(true);
    expect(detector.length + tells.length + 11).toBe(selectCatalog({ kind: 'slop' }).length);
    expect(detectorSlopEntries({ omitPolish: true }).every(e => e.impact !== 'polish')).toBe(true);
  });

  test('catalogEntries throws with the missing id', () => {
    expect(() => catalogEntries(['nested-cards', 'no-such-id'])).toThrow('no-such-id');
    expect(catalogEntries(['nested-cards'])[0].name).toBe('Nested cards');
  });
});

const MOCKUP_NEVER_IDS = ['kicker-above-heading', 'icon-tile-stack', 'gradient-text', 'ai-color-palette', 'cream-palette', 'nested-cards', 'dark-glow', 'pulsing-dot', 'identical-cards', 'hero-metrics'];

function designHtmlNeverIds(): string[] {
  const tmpl = fs.readFileSync(path.join(ROOT, 'design-html', 'SKILL.md.tmpl'), 'utf-8');
  const start = tmpl.indexOf('**Never include by default (AI slop blacklist):**');
  expect(start).toBeGreaterThan(0);
  const block = tmpl.slice(start, tmpl.indexOf('\n\n', start + 10));
  const lines = block.split('\n').filter(l => l.startsWith('- '));
  expect(lines.length).toBeGreaterThanOrEqual(10);
  const ids: string[] = [];
  for (const line of lines) {
    const found = [...line.matchAll(/<!-- ([a-z0-9-]+) -->/g)].map(m => m[1]);
    expect(found.length, line).toBeGreaterThan(0);
    ids.push(...found);
  }
  return ids;
}

describe('design-html blacklist is derived-by-test (decision 31)', () => {
  test('every <!-- id --> on the Never-include list names a catalog entry', () => {
    for (const id of designHtmlNeverIds()) expect(catalogEntry(id), id).toBeDefined();
  });

  test('every mockupNever entry appears on the Never-include list', () => {
    const ids = new Set(designHtmlNeverIds());
    for (const id of MOCKUP_NEVER_IDS) expect(ids.has(id), id).toBe(true);
  });
});

describe('mockupNever → MOCKUP_NEVER_NAMES (generation-time slop guard)', () => {
  test('exactly the ten agreed ids carry the flag', () => {
    const flagged = DESIGN_SLOP_CATALOG.filter(e => e.mockupNever).map(e => e.id).sort();
    expect(flagged).toEqual([...MOCKUP_NEVER_IDS].sort());
  });

  test('names are deduped plain English with no hyphenated ids', () => {
    expect(new Set(MOCKUP_NEVER_NAMES).size).toBe(MOCKUP_NEVER_NAMES.length);
    expect(MOCKUP_NEVER_NAMES.length).toBe(10);
    for (const n of MOCKUP_NEVER_NAMES) {
      expect(n).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
      expect(n[0]).toMatch(/[A-Z"0-9]/);
    }
  });
});

describe('module purity', () => {
  test('imports nothing (no I/O, no scripts/); loading it prints nothing', () => {
    const file = path.join(ROOT, 'lib', 'design-catalog.ts');
    const src = fs.readFileSync(file, 'utf-8');
    const imports = src.split('\n').filter(l => /^\s*import\s/.test(l));
    for (const line of imports) {
      expect(line).toMatch(/from ['"](\.\/|node:)/);
      expect(line).not.toContain('scripts/');
    }
    const r = spawnSync(process.execPath, ['--no-env-file', '-e', `await import(${JSON.stringify(file)})`], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('carries the Apache-2.0 derivation notice', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'design-catalog.ts'), 'utf-8');
    expect(src).toContain('pbakaus/impeccable (Apache-2.0), modified. See NOTICE.md.');
  });
});
