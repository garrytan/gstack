/**
 * setup-gbrain E2E fixture builder — carve-aware (token-reduction Phase 4).
 *
 * setup-gbrain is carved: the generated SKILL.md is a decision-tree skeleton
 * whose STOP-Read pointers reference install paths
 * (`~/.claude/skills/gstack/setup-gbrain/sections/*.md`) that do not exist in
 * a hermetic E2E sandbox. Pointing an agent at the raw skeleton would burn
 * turns on failed Reads and never reach the per-path init procedures under
 * test. This builder reconstructs a runnable single-file fixture, wave-1
 * style (see the codex fixture in test/skill-e2e-workflow.test.ts):
 *
 *   1. slice the skeleton from the skill title (dropping the shared preamble —
 *      CLAUDE.md rule: "E2E test fixtures: extract, don't copy"),
 *   2. cut the Section index table (its sections/ paths don't resolve here),
 *   3. replace each STOP pointer with the section body the test needs, or an
 *      explicit "not needed" stub for the rest, and
 *   4. run a non-empty guard: every needed section's distinctive anchor must
 *      be present in the result, so a renamed/emptied section fails loudly
 *      instead of shipping a silently hollow fixture.
 *
 * Monolith-tolerant: if the generated SKILL.md has no STOP pointers (pre-carve
 * checkout, or a regen that un-carves), the bodies are still inline and the
 * anchor guard passes — the builder works on both shapes.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const SKILL_MD = path.join(ROOT, 'setup-gbrain', 'SKILL.md');
const SECTIONS_DIR = path.join(ROOT, 'setup-gbrain', 'sections');

const TITLE = '# /setup-gbrain — Coding-Agent Onboarding for gbrain';

/** Matches one generated STOP-Read pointer (two lines) and captures the section file name. */
const STOP_POINTER =
  /^> \*\*STOP\.\*\* Before [^\n]*sections\/([a-z0-9-]+\.md)[^\n]*\n> in full\.[^\n]*/gm;

/** Distinctive per-section anchors — the non-empty guard for inlined content. */
export const SECTION_ANCHORS: Record<string, string> = {
  'brain-init.md': '### Path 4 (Remote gbrain MCP',
  'claude-md-persist.md': 'Mode: remote-http',
  'engine-remediation.md': "Your local gbrain engine isn't responding",
  'transcript-gate.md': 'gstack-memory-ingest.ts --probe',
};

/**
 * Build the fixture text: skeleton (preamble dropped, Section index cut) with
 * `neededSections` inlined at their STOP pointers and every other pointer
 * replaced by an explicit not-needed stub. Throws on any missing anchor.
 */
export function buildSetupGbrainFixture(neededSections: string[]): string {
  for (const file of neededSections) {
    if (!(file in SECTION_ANCHORS)) {
      throw new Error(
        `setup-gbrain fixture: unknown section "${file}" — known: ${Object.keys(SECTION_ANCHORS).join(', ')}`,
      );
    }
  }

  let full = fs.readFileSync(SKILL_MD, 'utf-8');

  const titleIdx = full.indexOf(TITLE);
  if (titleIdx < 0) throw new Error(`setup-gbrain fixture: title heading not found: "${TITLE}"`);
  full = full.slice(titleIdx);

  // Cut the Section index table (heading through its closing --- separator).
  const idxStart = full.indexOf('## Section index');
  if (idxStart >= 0) {
    const idxEnd = full.indexOf('\n---\n', idxStart);
    if (idxEnd < 0) throw new Error('setup-gbrain fixture: Section index has no closing ---');
    full = full.slice(0, idxStart) + full.slice(idxEnd + '\n---\n'.length);
  }

  full = full.replace(STOP_POINTER, (_m, file: string) => {
    if (!neededSections.includes(file)) {
      return '_(Section not included in this fixture — not needed for this run. Continue with the next step.)_';
    }
    const secPath = path.join(SECTIONS_DIR, file);
    if (!fs.existsSync(secPath)) {
      throw new Error(
        `setup-gbrain fixture: sections/${file} not generated — run bun run gen:skill-docs`,
      );
    }
    const body = fs
      .readFileSync(secPath, 'utf-8')
      .replace(/^<!--[^\n]*-->\n/gm, '') // strip AUTO-GENERATED header comments
      .trim();
    if (body.length < 500) {
      throw new Error(`setup-gbrain fixture: sections/${file} is unexpectedly small/empty`);
    }
    return body;
  });

  // Non-empty guard on the RESULT — holds for both the carved shape (section
  // inlined above) and the monolith shape (body was never carved out).
  for (const file of neededSections) {
    if (!full.includes(SECTION_ANCHORS[file])) {
      throw new Error(
        `setup-gbrain fixture: needed section "${file}" content missing from fixture ` +
          `(anchor not found: "${SECTION_ANCHORS[file]}")`,
      );
    }
  }

  return full;
}
