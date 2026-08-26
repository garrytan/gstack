/**
 * Unit + pin tests for test/helpers/skill-fixture.ts (free tier, no EVALS).
 *
 * Two layers:
 *   1. Semantics against a synthetic SKILL.md: frontmatter always included,
 *      sections concatenated in caller order, missing section throws with the
 *      section name, fenced `## ` template headings do not split sections,
 *      body extraction drops exactly the shared preamble block, head
 *      extraction truncates the body.
 *   2. Pins against the REAL generated SKILL.md files: every exported section
 *      list extracts cleanly from the skill it targets, and the body/head
 *      helpers work for every skill the E2E fixtures feed through them. A
 *      heading rename in gen-skill-docs fails HERE (free, <1s) instead of
 *      mid-flight in a paid E2E run.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractSkillSections,
  extractSkillBody,
  extractSkillHead,
  REVIEW_E2E_SECTIONS,
  REVIEW_ARMY_E2E_SECTIONS,
  RETRO_E2E_SECTIONS,
  CODEX_REVIEW_E2E_SECTIONS,
} from './helpers/skill-fixture';

const ROOT = path.resolve(import.meta.dir, '..');

// ─── Synthetic fixture ──────────────────────────────────────────────────────

const SYNTHETIC_SKILL = `---
name: fixture-test
description: synthetic skill for skill-fixture unit tests
---
Intro line before any section.

## When to invoke this skill
Invoke text.

## Preamble (run first)
preamble junk that fixtures must drop

## AskUserQuestion Format
more shared-preamble junk

## Plan Status Footer
footer junk, last shared-preamble section

## Step 1 — Do the thing
step one body
\`\`\`markdown
## Embedded Template Heading
template content inside a fence
\`\`\`
step one continues after the fence

## Step 2 — Other
step two body
`;

let tmpDir: string;
let skillDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-fixture-test-'));
  skillDir = path.join(tmpDir, 'fixture-test');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SYNTHETIC_SKILL);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('extractSkillSections (synthetic)', () => {
  test('always includes frontmatter and concatenates sections in caller order', () => {
    const out = extractSkillSections(skillDir, ['Step 2 — Other', 'Step 1 — Do the thing']);
    expect(out.startsWith('---\nname: fixture-test')).toBe(true);
    expect(out).toContain('## Step 1 — Do the thing');
    expect(out).toContain('## Step 2 — Other');
    // Caller order preserved: Step 2 requested first, so it appears first.
    expect(out.indexOf('## Step 2 — Other')).toBeLessThan(out.indexOf('## Step 1 — Do the thing'));
    // Unrequested sections are dropped.
    expect(out).not.toContain('preamble junk');
    expect(out).not.toContain('Intro line before any section');
  });

  test('fenced ## headings do not terminate a section', () => {
    const out = extractSkillSections(skillDir, ['Step 1 — Do the thing']);
    expect(out).toContain('template content inside a fence');
    expect(out).toContain('step one continues after the fence');
    expect(out).not.toContain('step two body');
  });

  test('missing section throws with the section name and the file path', () => {
    expect(() => extractSkillSections(skillDir, ['Step 99 — Renamed'])).toThrow(/Step 99 — Renamed/);
    expect(() => extractSkillSections(skillDir, ['Step 99 — Renamed'])).toThrow(/SKILL\.md/);
  });

  test('a fenced heading is not findable as a section', () => {
    expect(() => extractSkillSections(skillDir, ['Embedded Template Heading'])).toThrow(/not found/);
  });
});

describe('extractSkillBody (synthetic)', () => {
  test('keeps frontmatter + intro + full body, drops the shared preamble block', () => {
    const out = extractSkillBody(skillDir);
    expect(out.startsWith('---\nname: fixture-test')).toBe(true);
    expect(out).toContain('Intro line before any section');
    expect(out).toContain('## When to invoke this skill');
    expect(out).toContain('## Step 1 — Do the thing');
    expect(out).toContain('template content inside a fence');
    expect(out).toContain('## Step 2 — Other');
    expect(out).not.toContain('preamble junk');
    expect(out).not.toContain('shared-preamble junk');
    expect(out).not.toContain('footer junk');
  });

  test('throws when the preamble markers are missing', () => {
    const bare = path.join(tmpDir, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'SKILL.md'), '---\nname: bare\n---\n## Only Section\nbody\n');
    expect(() => extractSkillBody(bare)).toThrow(/Preamble \(run first\)/);
  });
});

describe('extractSkillHead (synthetic)', () => {
  test('keeps frontmatter + first N body lines only', () => {
    const out = extractSkillHead(skillDir, 3);
    expect(out.startsWith('---\nname: fixture-test')).toBe(true);
    expect(out).toContain('Intro line before any section');
    expect(out).toContain('## When to invoke this skill');
    expect(out).not.toContain('## Step 1 — Do the thing');
    expect(out).toContain('body truncated by test/helpers/skill-fixture.ts');
  });
});

describe('error polarity', () => {
  test('missing SKILL.md throws (never writes an empty fixture)', () => {
    expect(() => extractSkillSections(path.join(tmpDir, 'nope'), ['x'])).toThrow(/no SKILL\.md/);
  });

  test('file without frontmatter throws', () => {
    const nofm = path.join(tmpDir, 'nofm');
    fs.mkdirSync(nofm, { recursive: true });
    fs.writeFileSync(path.join(nofm, 'SKILL.md'), '# no frontmatter\n## Section\n');
    expect(() => extractSkillHead(nofm)).toThrow(/frontmatter/);
  });
});

// ─── Pins against the real generated SKILL.md files ─────────────────────────
// These turn "someone renamed a section in gen-skill-docs" into a FREE test
// failure instead of a paid E2E setup throw.

describe('real-skill pins: section lists used by E2E fixtures', () => {
  test('REVIEW_E2E_SECTIONS extracts from review/SKILL.md', () => {
    const out = extractSkillSections(path.join(ROOT, 'review'), REVIEW_E2E_SECTIONS);
    expect(out).toContain('## Step 4: Critical pass (core review)');
    expect(out).toContain('## Important Rules');
    // Drops the shared preamble and the untested workflow tail.
    expect(out).not.toContain('## Telemetry (run last)');
    expect(out).not.toContain('## Step 5: Fix-First Review');
    // Meaningfully smaller than the source.
    const full = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(out.length).toBeLessThan(full.length * 0.5);
  });

  test('REVIEW_ARMY_E2E_SECTIONS extracts from review/SKILL.md', () => {
    const out = extractSkillSections(path.join(ROOT, 'review'), REVIEW_ARMY_E2E_SECTIONS);
    // The army tests reference the Plan Completion Audit (inside Step 1.5)
    // and the Step 4.5 merge machinery (quality score, JSON schema, consensus).
    expect(out).toContain('PLAN COMPLETION AUDIT');
    expect(out).toContain('## Step 4.5: Review Army — Specialist Dispatch');
    expect(out).toContain('quality_score');
    expect(out).toContain('MULTI-SPECIALIST CONFIRMED');
    expect(out).not.toContain('## Telemetry (run last)');
  });

  test('RETRO_E2E_SECTIONS extracts from retro/SKILL.md', () => {
    const out = extractSkillSections(path.join(ROOT, 'retro'), RETRO_E2E_SECTIONS);
    // Steps 0.5-14 live under Prior Learnings / Capture Learnings.
    expect(out).toContain('### Step 1: Gather Raw Data');
    expect(out).toContain('### Step 14: Write the Narrative');
    expect(out).toContain('## Engineering Retro: [date range]');
    expect(out).not.toContain('## Global Retrospective Mode');
    expect(out).not.toContain('## Telemetry (run last)');
  });

  test('CODEX_REVIEW_E2E_SECTIONS extracts from the Codex host variant when present', () => {
    const codexReview = path.join(ROOT, '.agents', 'skills', 'gstack-review');
    if (!fs.existsSync(path.join(codexReview, 'SKILL.md'))) return; // gitignored artifact, absent in fresh checkouts
    const out = extractSkillSections(codexReview, CODEX_REVIEW_E2E_SECTIONS);
    expect(out).toContain('## Step 4: Critical pass (core review)');
    expect(out).not.toContain('## Telemetry (run last)');
  });
});

describe('real-skill pins: body/head extraction used by E2E fixtures', () => {
  // scrape/skillify/context-*: skill-e2e-skillify + skill-e2e-context-skills.
  // review/plan-eng-review/ship: skill-e2e-coverage-audit + skill-e2e-triage.
  const BODY_EXTRACTED_SKILLS = [
    'scrape', 'skillify', 'context-save', 'context-restore',
    'review', 'plan-eng-review', 'ship',
  ];

  for (const skill of BODY_EXTRACTED_SKILLS) {
    test(`extractSkillBody(${skill}) drops the shared preamble, keeps the flow`, () => {
      const out = extractSkillBody(path.join(ROOT, skill));
      expect(out).not.toContain('## Preamble (run first)');
      expect(out).not.toContain('## Telemetry (run last)');
      const full = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(out.length).toBeLessThan(full.length * 0.75);
      expect(out.length).toBeGreaterThan(500);
    });
  }

  test('body extraction keeps the sections the skillify/context E2E tests assert on', () => {
    expect(extractSkillBody(path.join(ROOT, 'skillify'))).toContain('## Step 1 — Provenance guard (D1)');
    expect(extractSkillBody(path.join(ROOT, 'scrape'))).toContain('## Step 4 — Prototype phase');
    expect(extractSkillBody(path.join(ROOT, 'context-save'))).toContain('## List flow');
    expect(extractSkillBody(path.join(ROOT, 'context-restore'))).toContain('## If no saved contexts exist');
  });

  // The union of skills installed by the routing + opus-47 discovery fixtures.
  const HEAD_EXTRACTED_SKILLS = [
    '', 'qa', 'qa-only', 'ship', 'review', 'plan-ceo-review', 'plan-eng-review',
    'plan-design-review', 'design-review', 'design-consultation', 'retro',
    'document-release', 'investigate', 'office-hours', 'browse',
    'setup-browser-cookies', 'gstack-upgrade', 'humanizer',
  ];

  test('extractSkillHead works for every discovery-fixture skill', () => {
    for (const skill of HEAD_EXTRACTED_SKILLS) {
      const src = path.join(ROOT, skill, 'SKILL.md');
      if (!fs.existsSync(src)) continue; // mirrors the fixtures' existsSync guard
      const out = extractSkillHead(src);
      expect(out.startsWith('---\n')).toBe(true);
      expect(out).toContain('description:');
      // Frontmatter length varies (allowed-tools + triggers); the invariant
      // is "frontmatter + 30 body lines + marker", never the full body.
      const fullLines = fs.readFileSync(src, 'utf-8').split('\n').length;
      expect(out.split('\n').length).toBeLessThan(Math.min(150, fullLines));
    }
  });
});
