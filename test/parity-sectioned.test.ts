/**
 * Unit coverage for the sectioned-parity capability (v2 plan T9, guards the
 * carve). Proves that a carved skill's relocated content still counts (union of
 * skeleton + sections), the always-loaded skeleton shrink is asserted
 * separately (maxSkeletonBytes), and size floors run against the union so they
 * stay meaningful (Codex outside-voice #12). Synthetic fixture — no ship carve
 * needed to validate the logic.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkSkillParity, readSkillForParity, type ParityInvariant } from './helpers/parity-harness';
import type { SkillBaselineEntry } from './helpers/capture-parity-baseline';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-sectioned-'));
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

// Carved "ship": a small skeleton + two sections holding the relocated prose.
fs.mkdirSync(path.join(root, 'ship', 'sections'), { recursive: true });
fs.writeFileSync(path.join(root, 'ship', 'SKILL.md'),
  '## Preamble\nskeleton body, decision tree, VERSION bump step calls the CLI.\n## When to invoke\n');
fs.writeFileSync(path.join(root, 'ship', 'sections', 'changelog.md'), '# Changelog\nWrite the CHANGELOG entry here.\n');
fs.writeFileSync(path.join(root, 'ship', 'sections', 'review-army.md'), '# Review\nDispatch the pre-landing review army.\n');

// A monolith control skill.
fs.mkdirSync(path.join(root, 'mono'), { recursive: true });
fs.writeFileSync(path.join(root, 'mono', 'SKILL.md'), '## Preamble\nVERSION CHANGELOG review all inline here.\n');

const skeletonBytes = Buffer.byteLength(fs.readFileSync(path.join(root, 'ship', 'SKILL.md'), 'utf-8'), 'utf-8');
const unionBytes = readSkillForParity(root, 'ship', true).unionBytes;
const baseline: SkillBaselineEntry = { skillMdBytes: unionBytes } as SkillBaselineEntry;

describe('readSkillForParity', () => {
  test('unions skeleton + sections for carved skills', () => {
    const r = readSkillForParity(root, 'ship', true);
    expect(r.text).toContain('CHANGELOG');       // from changelog.md
    expect(r.text).toContain('review army');      // from review-army.md
    expect(r.skeletonBytes).toBe(skeletonBytes);
    expect(r.unionBytes).toBeGreaterThan(r.skeletonBytes);
  });
  test('monolith text == skeleton, union == skeleton', () => {
    const r = readSkillForParity(root, 'mono', false);
    expect(r.unionBytes).toBe(r.skeletonBytes);
  });
});

describe('checkSkillParity (sectioned)', () => {
  test('finds phrases that moved into sections (union content check)', () => {
    const inv: ParityInvariant = {
      skill: 'ship', sectioned: true,
      mustContain: ['VERSION', 'CHANGELOG', 'review army'],
      mustHaveHeadings: ['## Preamble', '## When to invoke'],
    };
    const res = checkSkillParity(inv, { skillMdBytes: skeletonBytes } as SkillBaselineEntry, baseline, root);
    expect(res.passed).toBe(true);
  });

  test('maxSkeletonBytes catches a skeleton that did not shrink', () => {
    const inv: ParityInvariant = { skill: 'ship', sectioned: true, maxSkeletonBytes: 10 };
    const res = checkSkillParity(inv, { skillMdBytes: skeletonBytes } as SkillBaselineEntry, baseline, root);
    expect(res.passed).toBe(false);
    expect(res.failures.join()).toContain('maxSkeletonBytes');
  });

  test('minBytes runs against the union, not the skeleton (content preserved)', () => {
    // A floor between skeletonBytes and unionBytes must PASS for sectioned skills,
    // because the union (total behavior) is what must not shrink.
    const floor = Math.floor((skeletonBytes + unionBytes) / 2);
    const inv: ParityInvariant = { skill: 'ship', sectioned: true, minBytes: floor };
    const res = checkSkillParity(inv, { skillMdBytes: skeletonBytes } as SkillBaselineEntry, baseline, root);
    expect(res.passed).toBe(true);
  });

  test('flags a phrase that truly went missing', () => {
    const inv: ParityInvariant = { skill: 'ship', sectioned: true, mustContain: ['this-phrase-is-not-anywhere'] };
    const res = checkSkillParity(inv, { skillMdBytes: skeletonBytes } as SkillBaselineEntry, baseline, root);
    expect(res.passed).toBe(false);
    expect(res.failures.join()).toContain('missing required phrase');
  });

  test('maxSizeRatio uses union bytes vs baseline (carve preserves ~total size)', () => {
    const inv: ParityInvariant = { skill: 'ship', sectioned: true, maxSizeRatio: 1.05 };
    const res = checkSkillParity(inv, { skillMdBytes: skeletonBytes } as SkillBaselineEntry, baseline, root);
    expect(res.passed).toBe(true); // union == baseline here → ratio 1.0
  });
});
