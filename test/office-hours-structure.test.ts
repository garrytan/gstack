/**
 * office-hours/SKILL.md structural guards (deterministic, free — no LLM).
 *
 * These lock down load-bearing invariants that were previously enforced only by
 * paid evals or not at all: the resource-pool/dedup-gate coupling, required
 * design-doc sections, the privacy gate, the Phase-4 STOP gate, mode-switch and
 * escape-hatch rules, smart-routing question integrity, cross-platform opening,
 * and the profile write-through contract (no regression to raw JSONL appends).
 *
 * Reads the GENERATED SKILL.md (what actually ships); run `bun run gen:skill-docs`
 * if this drifts.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = path.join(ROOT, 'office-hours', 'SKILL.md');

let content = '';
beforeAll(() => {
  content = fs.readFileSync(SKILL, 'utf-8');
});

describe('resource pool integrity', () => {
  function poolUrls(): string[] {
    const start = content.indexOf('**Resource Pool**');
    const end = content.indexOf('**After presenting resources', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = content.slice(start, end);
    return (slice.match(/https?:\/\/[^\s)]+/g) || []);
  }

  test('pool has no duplicate URLs', () => {
    const urls = poolUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test('dedup-gate threshold and header count both equal the pool size', () => {
    const urls = poolUrls();
    const gate = content.match(/currently (\d+)\)/);
    const header = content.match(/\*\*Resource Pool\*\*\s*\((\d+) entries/);
    expect(gate).not.toBeNull();
    expect(header).not.toBeNull();
    expect(Number(gate![1])).toBe(urls.length);
    expect(Number(header![1])).toBe(urls.length);
  });
});

describe('profile write-through contract (P0 regression guard)', () => {
  test('uses the append subcommands, not raw JSONL appends', () => {
    expect(content).toContain('--append-session');
    expect(content).toContain('--append-resources');
  });

  test('never appends raw JSON to builder-profile.jsonl (the data-loss path)', () => {
    expect(content).not.toMatch(/>>\s*"?\$?\{?GSTACK_STATE_ROOT[^\n]*builder-profile\.jsonl/);
    expect(content).not.toContain('builder-profile.jsonl');
  });
});

describe('required design-doc sections', () => {
  for (const section of ['## Distribution Plan', '## The Assignment', '## Success Criteria', '## Problem Statement', '## Recommended Approach']) {
    test(`present: ${section}`, () => {
      expect(content).toContain(section);
    });
  }

  test('both design-doc templates carry a Distribution Plan', () => {
    const count = (content.match(/## Distribution Plan/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('privacy gate', () => {
  test('generalized-terms instruction and the gate prompt survive', () => {
    expect(content).toContain('generalized category terms');
    expect(content).toContain('OK to proceed?');
    expect(content.toLowerCase()).toContain("never the user");
  });
});

describe('Phase 4 STOP gate', () => {
  test('section anchors and the stop sentence are intact', () => {
    expect(content).toContain('## Phase 4: Alternatives Generation');
    expect(content).toContain('## Phase 4.5');
    expect(content).toContain('Do NOT proceed to Phase 4.5');
  });
});

describe('mode-switch and escape-hatch rules', () => {
  test('vibe-shift upgrade survives', () => {
    expect(content).toContain('upgrade to Startup mode');
  });
  test("anti-nagging 'don't ask a third time' rule survives", () => {
    expect(content).toContain("Don't ask a third time");
  });
  test('builder escape hatch still runs Premise Challenge (does not skip to Phase 4)', () => {
    // Guard against reverting to "fast-track to Phase 4" which skipped Phase 3.
    expect(content).not.toContain('fast-track to Phase 4 (Alternatives Generation)');
  });
});

describe('smart-routing question integrity', () => {
  test('every Qn referenced in the routing table has a definition, and stages are wired', () => {
    const start = content.indexOf('Smart routing based on product stage');
    const firstQ = content.indexOf('#### Q1:', start);
    expect(start).toBeGreaterThan(-1);
    expect(firstQ).toBeGreaterThan(start);
    const region = content.slice(start, firstQ);
    const nums = new Set([...region.matchAll(/\bQ(\d)\b/g)].map((m) => m[1]));
    expect(nums.size).toBeGreaterThan(0);
    for (const n of nums) {
      expect(content).toContain(`#### Q${n}:`);
    }
    for (const stage of ['Pre-product', 'Has users', 'Has paying customers', 'Pure engineering/infra']) {
      expect(region).toContain(stage);
    }
  });

  test('every routing stage is a selectable Phase 1 product-stage option', () => {
    const stageStart = content.indexOf('Assess product stage');
    const stageRegion = content.slice(stageStart, stageStart + 600);
    for (const stage of ['Pre-product', 'Has users', 'Has paying customers', 'Pure engineering/infra']) {
      expect(stageRegion).toContain(stage);
    }
  });
});

describe('cross-platform opening', () => {
  test('uses gstack-open-url and never &&-chains bare open', () => {
    expect(content).toContain('gstack-open-url');
    expect(content).not.toMatch(/&&\s*open\s+URL/);
    expect(content).not.toMatch(/\bopen\s+"\$GSTACK_STATE_ROOT\/builder-journey\.md"/);
  });
});
