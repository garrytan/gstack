/**
 * cso security-guidance preservation test.
 *
 * cso carries load-bearing security prose: OWASP Top 10 mappings, STRIDE
 * threat-model phrasing, mode dispatch, and false-positive-filtering exceptions
 * that must NOT be auto-discarded.
 *
 * cso is now carved (skeleton SKILL.md + sections/audit-phases.md). The
 * scope-dependent audit phases (2-11) moved to the section; the mode dispatch
 * (## Arguments, ## Mode Resolution), the always-run phases (0, 1), and the
 * FP-filtering exceptions (Phase 12) stay always-loaded in the skeleton.
 *
 * Two distinct guarantees (codex outside-voice #5 — earliest-use, not loose
 * substrings):
 *  1. PRESERVATION — the security phrases survive somewhere in the union
 *     (skeleton + sections); a carve relocates, it never drops.
 *  2. ALWAYS-LOADED CONTRACT — dispatch + FP-filtering directives stay in the
 *     skeleton, and mode dispatch precedes any STOP-Read (a directive that
 *     decides which sections to read can't sit behind the STOP that reads them).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const CSO_DIR = path.join(REPO_ROOT, 'cso');
const CSO_SKELETON = path.join(CSO_DIR, 'SKILL.md');

function readSkeleton(): string {
  return fs.readFileSync(CSO_SKELETON, 'utf-8');
}
function readUnion(): string {
  let text = readSkeleton();
  const dir = path.join(CSO_DIR, 'sections');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.md') && !f.endsWith('.md.tmpl')) {
        text += '\n' + fs.readFileSync(path.join(dir, f), 'utf-8');
      }
    }
  }
  return text;
}

// Security content that must survive the carve (checked against the UNION).
const MUST_PRESERVE_PHRASES = ['OWASP', 'STRIDE', 'daily', 'comprehensive', 'confidence', 'verif'];

describe('cso skill preserves load-bearing security guidance', () => {
  test('cso skeleton exists and is non-trivial', () => {
    expect(fs.existsSync(CSO_SKELETON)).toBe(true);
    // Skeleton stays substantial: dispatch + always-run phases + FP filtering +
    // report phases are all always-loaded. Under 30 KB means too much moved out.
    expect(readSkeleton().length).toBeGreaterThan(30_000);
  });

  test('security phrases survive in the union (skeleton + sections)', () => {
    const union = readUnion().toLowerCase();
    const missing = MUST_PRESERVE_PHRASES.filter((p) => !union.includes(p.toLowerCase()));
    if (missing.length > 0) {
      throw new Error(
        `cso union is missing required security phrases: ${missing.join(', ')}. ` +
        `These are load-bearing. A carve relocates them; it must not drop them.`,
      );
    }
  });

  test('ALWAYS-LOADED: mode dispatch + FP-filtering stay in the skeleton', () => {
    const skeleton = readSkeleton();
    // Dispatch must be always-loaded — the agent resolves scope before reading sections.
    expect(skeleton).toContain('## Arguments');
    expect(skeleton).toContain('## Mode Resolution');
    // FP-filtering with its critical exceptions is mandatory and must not be on-demand.
    expect(skeleton).toContain('Phase 12');
    // The "SKILL.md files are NOT documentation" exception is a must-not-miss
    // security directive (skill supply-chain findings); it stays always-loaded.
    expect(skeleton).toContain('NOT documentation');
  });

  test('EARLIEST-USE: mode dispatch precedes any STOP-Read directive (codex #6)', () => {
    const skeleton = readSkeleton();
    const stop = skeleton.indexOf('> **STOP.**');
    const modeRes = skeleton.indexOf('## Mode Resolution');
    const args = skeleton.indexOf('## Arguments');
    expect(modeRes).toBeGreaterThan(-1);
    expect(args).toBeGreaterThan(-1);
    if (stop >= 0) {
      // A dispatch directive stranded after the STOP can't govern which sections to read.
      expect(args).toBeLessThan(stop);
      expect(modeRes).toBeLessThan(stop);
    }
  });

  test('cso catalog trim landed (frontmatter description ≤ 200 chars)', () => {
    const content = readSkeleton();
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const desc = fmMatch![1].match(/^description:\s+(.+)$/m);
    expect(desc).not.toBeNull();
    expect(desc![1].trim().length).toBeLessThanOrEqual(200);
    expect(desc![1]).toContain('(gstack)');
  });

  test('cso routing prose moved to "## When to invoke" body section', () => {
    expect(readSkeleton()).toContain('## When to invoke this skill');
  });
});
