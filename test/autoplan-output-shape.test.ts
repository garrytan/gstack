/**
 * Unit 9: locks the `/autoplan` output contract that `/implement` reads.
 *
 * The fixture at test/fixtures/autoplan-output.expected.md is the canonical
 * shape. Three coupled artifacts must agree:
 *   1. test/fixtures/autoplan-output.expected.md (this fixture)
 *   2. implement/SKILL.md.tmpl Phase 0.2 (the parser prose Claude reads)
 *   3. autoplan/SKILL.md.tmpl emission instructions (Phase B+ — currently
 *      autoplan does not yet emit ACs in this exact shape; this fixture
 *      is the spec it must adopt)
 *
 * Editing the fixture is editing the contract. Drift in any of these three
 * artifacts without updating the others = silent breakage of the /build
 * chain.
 *
 * No real LLM call. No real /autoplan invocation. Pure shape tests on the
 * fixture + prose tests on the skill templates.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'autoplan-output.expected.md');
const IMPLEMENT_TMPL = path.join(ROOT, 'implement', 'SKILL.md.tmpl');

const fixture = fs.readFileSync(FIXTURE, 'utf-8');

// ---------------------------------------------------------------------------
// Inline AC parser — mirrors what /implement's Phase 0.2 prose tells Claude
// to do. Lives here as a TS reference so the test pins down both the parser
// behavior AND the fixture's compliance with it.
// ---------------------------------------------------------------------------

interface ParsedAC {
  index: number;
  title: string;
  files: string[];
  testCommand: string | null;
  dependsOn: number[];
  filesAtSha: string | null;
  bodyLines: string[];
}

function parseAcSection(plan: string): ParsedAC[] {
  // Locate the AC section: from "## Acceptance Criteria" to next ## heading or EOF.
  const headingMatch = plan.match(/^## Acceptance Criteria\s*$/m);
  if (!headingMatch) throw new Error('no "## Acceptance Criteria" heading found');
  const startIdx = headingMatch.index! + headingMatch[0].length;
  const restAfterHeading = plan.slice(startIdx);
  const nextH2 = restAfterHeading.match(/^## (?!#)/m);
  const acSection = nextH2 ? restAfterHeading.slice(0, nextH2.index!) : restAfterHeading;

  // Each AC: ### AC<N>: <title>\n  body until next ### or end-of-section
  const acRegex = /^### AC(\d+):\s+(.+?)$/gm;
  const positions: Array<{ index: number; title: string; from: number; to: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = acRegex.exec(acSection)) !== null) {
    positions.push({ index: parseInt(m[1], 10), title: m[2].trim(), from: m.index, to: 0 });
  }
  for (let i = 0; i < positions.length; i++) {
    positions[i].to = i + 1 < positions.length ? positions[i + 1].from : acSection.length;
  }

  return positions.map((pos) => {
    const block = acSection.slice(pos.from, pos.to);
    const filesMatch = block.match(/^- \*\*Files\*\*:\s*(.+)$/m);
    const testMatch = block.match(/^- \*\*Test\*\*:\s*(.+)$/m);
    const dependsMatch = block.match(/^- \*\*Depends on\*\*:\s*(.+)$/m);
    const shaMatch = block.match(/^- \*\*Files@SHA\*\*:\s*`?([a-f0-9]+)`?\s*$/m);
    const files = filesMatch
      ? filesMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^`|`$/g, ''))
          .filter(Boolean)
      : [];
    const dependsOn = dependsMatch
      ? Array.from(dependsMatch[1].matchAll(/AC(\d+)/g)).map((dm) => parseInt(dm[1], 10))
      : [];
    return {
      index: pos.index,
      title: pos.title,
      files,
      testCommand: testMatch ? testMatch[1].trim() : null,
      dependsOn,
      filesAtSha: shaMatch ? shaMatch[1] : null,
      bodyLines: block.split('\n').slice(1).filter((l) => l.trim()),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoplan output shape: fixture compliance', () => {
  const acs = parseAcSection(fixture);

  test('case 1: fixture parses cleanly through the AC parser', () => {
    expect(acs.length).toBeGreaterThanOrEqual(2);
    for (const ac of acs) {
      expect(typeof ac.index).toBe('number');
      expect(ac.title.length).toBeGreaterThan(0);
    }
  });

  test('case 2: exactly one "## Acceptance Criteria" heading, case-sensitive, anchored', () => {
    const matches = fixture.match(/^## Acceptance Criteria\s*$/gm) ?? [];
    expect(matches.length).toBe(1);
    // Wrong-case variants must NOT appear (case-sensitivity is part of the contract)
    expect(/^## acceptance criteria\b/m.test(fixture)).toBe(false);
    expect(/^### Acceptance Criteria\b/m.test(fixture)).toBe(false);
  });

  test('case 3: AC numbering has no gaps and starts at 1', () => {
    const indices = acs.map((a) => a.index).sort((a, b) => a - b);
    expect(indices[0]).toBe(1);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBe(i + 1);
    }
  });

  test('case 4: every AC has a non-empty **Files** list (no design-only ACs in fixture)', () => {
    for (const ac of acs) {
      expect(ac.files.length).toBeGreaterThan(0);
      // Files should look like path-like strings (no spaces in them, no quotes leaked)
      for (const f of ac.files) {
        expect(f).toMatch(/^[a-zA-Z0-9_./-]+$/);
        expect(f.startsWith('`')).toBe(false);
        expect(f.endsWith('`')).toBe(false);
      }
    }
  });

  test('case 5: **Depends on** references only valid prior AC numbers (no forward refs, no missing)', () => {
    const knownIndices = new Set(acs.map((a) => a.index));
    for (const ac of acs) {
      for (const dep of ac.dependsOn) {
        expect(knownIndices.has(dep)).toBe(true);
        expect(dep).toBeLessThan(ac.index); // forward refs forbidden
      }
    }
  });

  test('case 6: **Files@SHA** values are exactly 7 lowercase hex chars when present', () => {
    for (const ac of acs) {
      if (ac.filesAtSha !== null) {
        expect(ac.filesAtSha).toMatch(/^[a-f0-9]{7}$/);
      }
    }
  });

  test('case 7: no Windows line endings (CRLF breaks the parser silently)', () => {
    expect(fixture.includes('\r\n')).toBe(false);
    // Trailing whitespace on a heading line would also break the anchored regex
    expect(/^## Acceptance Criteria[ \t]+$/m.test(fixture)).toBe(false);
  });
});

describe('autoplan output shape: skill-template prose alignment', () => {
  const implTmpl = fs.readFileSync(IMPLEMENT_TMPL, 'utf-8');

  test('case 8: implement/SKILL.md.tmpl Phase 0.2 documents the same heading + AC pattern', () => {
    // /implement's parser prose must literally name "## Acceptance Criteria"
    // and "### AC<N>:" — if a refactor renames either, this test fails.
    expect(implTmpl).toContain('## Acceptance Criteria');
    expect(/###\s+AC<N>/.test(implTmpl)).toBe(true);
    // The four optional fields must be named in the prose
    expect(implTmpl).toContain('**Files**');
    expect(implTmpl).toContain('**Test**');
    expect(implTmpl).toContain('**Depends on**');
    expect(implTmpl).toContain('**Files@SHA**');
  });

  test('case 9: implement/SKILL.md.tmpl mentions the case-sensitive heading match', () => {
    // The prose must explicitly call out case sensitivity — silent
    // case-insensitive parsing is exactly the kind of drift this test catches.
    const looksCaseSensitive =
      /case-sensitive/i.test(implTmpl) || /anchored heading/i.test(implTmpl);
    expect(looksCaseSensitive).toBe(true);
  });
});
