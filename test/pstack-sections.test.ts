/**
 * pstack absorb (GSTA-116 plan, items 6 and 9): benchmark's vet-the-number
 * section and plan-eng-review's design-twice pass. Pins the carve shape
 * (manifest ids, STOP pointers, where each pointer sits) and the tokens each
 * section must carry; prose is not pinned.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from './helpers/carve-guards';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('benchmark carve: vet the number', () => {
  const skeleton = read('benchmark/SKILL.md');
  const section = read('benchmark/sections/vet-the-number.md');
  const manifest = JSON.parse(read('benchmark/sections/manifest.json')) as { skill: string; sections: Array<{ id: string; file: string }> };

  test('one section, registered, pointed to at the top of Phase 5 before any comparison is written', () => {
    expect(manifest.skill).toBe('benchmark');
    expect(manifest.sections.map(s => s.id)).toEqual(['vet-the-number']);
    expect(CARVE_GUARDS.benchmark!.expectedSections).toEqual(['vet-the-number.md']);
    const phase5 = skeleton.indexOf('### Phase 5: Comparison');
    const stop = skeleton.indexOf('> **STOP.**');
    expect(skeleton.indexOf('## Arguments')).toBeLessThan(stop);
    expect(stop).toBeGreaterThan(phase5);
    expect(stop).toBeLessThan(skeleton.indexOf('If baseline exists, compare current metrics against it'));
    expect(skeleton.match(/> \*\*STOP\.\*\*/g)).toHaveLength(1);
    expect(skeleton).toContain('sections/vet-the-number.md');
    expect(skeleton).toMatch(/\*\*Vet every number before reporting it\.\*\*/);
  });

  test('the seven questions, the one-run ballpark rule, the 11% arithmetic, alternating runs, and the inconclusive verdict', () => {
    expect(section).toContain('## Vet the number');
    const questions = ['**Why not double?**', '**Was it tuned?**', '**Did it break a limit?**', '**Did it error?**', '**Does it reproduce?**', '**Does it matter?**', '**Did it even happen?**'];
    let last = -1;
    for (const q of questions) {
      const at = section.indexOf(q);
      expect(at, q).toBeGreaterThan(last);
      last = at;
    }
    expect(section).toContain('Name the limiter');
    expect(section).toMatch(/one run,\s+still answer questions 4 and 7/);
    expect(section).toMatch(/10%[\s\S]*at most about 11% faster/);
    expect(section).toMatch(/alternating A, B, A, B/);
    expect(section).toContain('A gap smaller than the run-to-run');
    expect(section).toMatch(/faster, slower, no measurable difference, or\s+inconclusive/);
    expect(section).toMatch(/cannot name the limiter/);
  });
});

describe('plan-eng-review: two shapes before one inside Section 1 of the lazy review section', () => {
  const skeleton = read('plan-eng-review/SKILL.md');
  const section = read('plan-eng-review/sections/review-sections.md');
  const manifest = JSON.parse(read('plan-eng-review/sections/manifest.json')) as { sections: Array<{ id: string }> };

  test('the pass lives in review-sections.md between Sections 1 and 2, the skeleton and manifest are unchanged, and the checklist maps it', () => {
    expect(manifest.sections.map(s => s.id)).toEqual(['review-sections', 'checklist']);
    expect(CARVE_GUARDS['plan-eng-review']!.expectedSections).toEqual(['review-sections.md']);
    expect(skeleton).not.toContain('design-twice');
    expect(skeleton.match(/> \*\*STOP\.\*\*/g)).toHaveLength(1);
    const one = section.indexOf('### 1. Architecture review');
    const pass = section.indexOf('### Two shapes before one (design-twice)');
    const two = section.indexOf('### 2. Code quality review');
    expect(one).toBeGreaterThan(0);
    expect(pass).toBeGreaterThan(one);
    expect(two).toBeGreaterThan(pass);
    expect(section.slice(pass, two)).toMatch(/only when the plan introduces a new module, service, package or\s+boundary/);
    expect(read('plan-eng-review/sections/checklist.md')).toContain('Two shapes before one (design-twice)');
  });

  test('a second structurally distinct shape, interface depth, the agent-contributor assumption, and the eight red flags in order', () => {
    const pass = section.slice(section.indexOf('### Two shapes before one (design-twice)'), section.indexOf('### 2. Code quality review'));
    expect(pass).toContain('**Ask for the second shape.**');
    expect(pass).toMatch(/require a second\s+shape that is structurally different/);
    expect(pass).toMatch(/A point fix inside\s+the first shape is not a second candidate\./);
    expect(pass).toContain('interface depth');
    expect(pass).toContain('A deep module is not a deep call chain');
    expect(pass).toMatch(/an agent that sees only the files it opened,\s+copies the nearest example and takes the shortest path that compiles/);
    const flags = ['**Shallow module.**', '**Information leakage.**', '**Temporal decomposition.**', '**Pass-through method.**', '**Split ownership.**', '**Two ways to do one task.**', '**Importable internals.**', '**Hand-synced list.**'];
    let last = pass.indexOf('**The eight red flags.**');
    expect(last).toBeGreaterThan(0);
    for (const f of flags) {
      const at = pass.indexOf(f);
      expect(at, f).toBeGreaterThan(last);
      last = at;
    }
  });
});

describe('every pstack-derived section carries its credit line', () => {
  const credited = {
    'context-restore/sections/transcripts.md.tmpl': 0,
    'benchmark/sections/vet-the-number.md.tmpl': 0,
    // The design-twice pass lives inside an existing section; its credit sits on the line above its heading.
    'plan-eng-review/sections/review-sections.md.tmpl': '### Two shapes before one (design-twice)',
  } as const;
  for (const [rel, where] of Object.entries(credited)) {
    test(rel, () => {
      const lines = read(rel).split('\n');
      const at = typeof where === 'number' ? where : lines.indexOf(where) - 1;
      expect(at).toBeGreaterThanOrEqual(0);
      const credit = lines[at]!;
      expect(credit.startsWith('<!--')).toBe(true);
      expect(credit).toContain('pstack');
      expect(credit).toContain('MIT');
      expect(credit).toContain('rewritten');
      expect(credit).toContain('See NOTICE.md');
      expect(read('NOTICE.md')).toContain(rel.replace('.tmpl', ''));
    });
  }
});
