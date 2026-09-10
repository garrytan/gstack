/**
 * review/design-checklist.md is generated from lib/design-catalog.ts by
 * scripts/resolvers/design-checklist.ts. These pins keep the committed file
 * in sync with the generator, keep the generator host-scoped (Claude only)
 * and --out-dir aware, and keep the two load-bearing strings other code keys
 * on (the title and the slop heading) in place.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  generateDesignChecklistMd, checklistSlopEntries,
  DESIGN_CHECKLIST_HEADER, DESIGN_CHECKLIST_TITLE, DESIGN_CHECKLIST_SLOP_HEADING, autoFixEntries,
} from '../scripts/resolvers/design-checklist';
import { DESIGN_SLOP_CATALOG, BANNED_FONTS } from '../lib/design-catalog';
import { AI_SLOP_BLACKLIST } from '../scripts/resolvers/constants';

const ROOT = path.join(import.meta.dir, '..');
const CHECKLIST = path.join(ROOT, 'review', 'design-checklist.md');
const GEN = path.join(ROOT, 'scripts', 'gen-skill-docs.ts');

function runGen(args: string[]) {
  return spawnSync(process.execPath, ['run', GEN, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 240_000 });
}

describe('review/design-checklist.md is generated', () => {
  test('committed file equals the generator output', () => {
    expect(fs.readFileSync(CHECKLIST, 'utf-8')).toBe(generateDesignChecklistMd());
  });

  test('carries the GENERATED header, the title, and the slop heading', () => {
    const md = fs.readFileSync(CHECKLIST, 'utf-8');
    expect(md.startsWith(DESIGN_CHECKLIST_HEADER + '\n')).toBe(true);
    expect(md).toContain(`# ${DESIGN_CHECKLIST_TITLE}`);
    expect(md).toContain(`### 1. ${DESIGN_CHECKLIST_SLOP_HEADING} (`);
    // Fixed sections other readers depend on.
    for (const h of ['## Instructions', '## Confidence Tiers', '## Classification', '## Output Format', '## Categories', '## Suppressions']) {
      expect(md).toContain(h);
    }
  });

  test('the Classification AUTO-FIX list renders every auto-fix catalog entry with its id', () => {
    const md = generateDesignChecklistMd();
    const block = md.slice(md.indexOf('**AUTO-FIX**'), md.indexOf('**ASK**'));
    const entries = autoFixEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.tier).toBe('auto-fix');
      expect(block).toContain(`- [${e.impeccableId}] ${e.prose}`);
    }
  });

  test('category 1 renders every grep-detectable slop entry and every legacy line', () => {
    const md = generateDesignChecklistMd();
    const entries = checklistSlopEntries();
    expect(md).toContain(`(${entries.length} items)`);
    for (const e of entries) {
      expect(md).toContain(`**[${e.confidence}]**${e.impeccableId ? ` [${e.impeccableId}]` : ''} `);
      if (e.heuristic) expect(md).toContain(e.heuristic);
    }
    for (const line of AI_SLOP_BLACKLIST) {
      expect(md).toContain(line.replace(/\.$/, ''));
    }
    // Sorted HIGH → MEDIUM → LOW.
    const tiers = entries.map(e => e.confidence);
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    for (let i = 1; i < tiers.length; i++) expect(order[tiers[i]]).toBeGreaterThanOrEqual(order[tiers[i - 1]]);
  });

  test('brackets only detector-known ids; quality entries stay out of category 1', () => {
    const md = generateDesignChecklistMd();
    for (const e of DESIGN_SLOP_CATALOG.filter(x => !x.impeccableId)) expect(md).not.toContain(`[${e.id}]`);
    for (const e of checklistSlopEntries()) expect(e.kind).toBe('slop');
    expect(md).toContain('[side-tab]');
    expect(md).toContain('[overused-font]');
    expect(md).toContain('Faces: Inter, Roboto');
  });

  test('font blacklist renders from BANNED_FONTS without role qualifiers', () => {
    const md = generateDesignChecklistMd();
    expect(md).toContain('Blacklisted fonts: Papyrus, Comic Sans');
    expect(md).toContain('Courier New.');
    expect(md).not.toContain('(for body)');
    expect(BANNED_FONTS.length).toBeGreaterThan(5);
  });
});

// gen-skill-docs prints repo-relative paths with the OS separator (Windows: `review\\design-checklist.md`).
const fwd = (s: string) => s.replace(/\\/g, '/');

describe('gen-skill-docs writes the checklist for the Claude host only', () => {
  test('--host claude --out-dir renders it under the out dir; --host codex --out-dir does not', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-checklist-'));
    try {
      const before = fs.statSync(CHECKLIST).mtimeMs;
      const claude = runGen(['--host', 'claude', '--out-dir', out]);
      expect(claude.status).toBe(0);
      expect(fwd(claude.stdout)).toContain('GENERATED: review/design-checklist.md');
      expect(fs.readFileSync(path.join(out, 'review', 'design-checklist.md'), 'utf-8')).toBe(generateDesignChecklistMd());

      fs.rmSync(path.join(out, 'review'), { recursive: true, force: true });
      const codex = runGen(['--host', 'codex', '--out-dir', out]);
      expect(codex.status).toBe(0);
      expect(fwd(codex.stdout)).not.toContain('design-checklist.md');
      expect(fs.existsSync(path.join(out, 'review', 'design-checklist.md'))).toBe(false);

      // The tracked file was never touched by either --out-dir render.
      expect(fs.statSync(CHECKLIST).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);

  test('--host claude --out-dir also renders lib/dom-dump.js; a modified out-dir copy flips --dry-run to STALE', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-assets-'));
    try {
      const claude = runGen(['--host', 'claude', '--out-dir', out]);
      expect(claude.status).toBe(0);
      expect(fwd(claude.stdout)).toContain('GENERATED: lib/dom-dump.js');
      const dump = fs.readFileSync(path.join(out, 'lib', 'dom-dump.js'), 'utf-8');
      expect(dump).toBe(fs.readFileSync(path.join(ROOT, 'lib', 'dom-dump.js'), 'utf-8'));
      const fresh = runGen(['--host', 'claude', '--out-dir', out, '--dry-run']);
      expect(fwd(fresh.stdout)).toContain('FRESH: lib/dom-dump.js');
      expect(fwd(fresh.stdout)).toContain('FRESH: review/design-checklist.md');
      fs.appendFileSync(path.join(out, 'review', 'design-checklist.md'), '\nhand edit\n');
      fs.writeFileSync(path.join(out, 'lib', 'dom-dump.js'), '// tampered\n');
      const stale = runGen(['--host', 'claude', '--out-dir', out, '--dry-run']);
      expect(fwd(stale.stdout)).toContain('STALE: review/design-checklist.md');
      expect(fwd(stale.stdout)).toContain('STALE: lib/dom-dump.js');
      expect(stale.status).not.toBe(0);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);

  test('--dry-run reports the checklist FRESH', () => {
    const r = runGen(['--dry-run']);
    expect(fwd(r.stdout)).toContain('FRESH: review/design-checklist.md');
    expect(fwd(r.stdout)).not.toContain('STALE: review/design-checklist.md');
  }, 240_000);
});
