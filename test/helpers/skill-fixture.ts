/**
 * Skill fixture extraction — enforces the CLAUDE.md rule "E2E test fixtures:
 * extract, don't copy".
 *
 * Full SKILL.md files are 1000-1900 lines. When `claude -p` (or `codex exec`)
 * reads a file that large, context bloat causes timeouts, flaky turn limits,
 * and tests that take 5-10x longer than necessary. Every E2E fixture that
 * needs skill content should extract ONLY the sections the test actually
 * exercises, through one of the three helpers here:
 *
 *   - extractSkillSections(skillDir, sections)
 *       frontmatter + the named `## <section>` blocks, concatenated in the
 *       order given. For tests that exercise specific workflow steps.
 *   - extractSkillBody(skillDir)
 *       frontmatter + intro + everything AFTER the shared generated preamble
 *       ("## Preamble (run first)" .. end of "## Plan Status Footer").
 *       For tests that exercise the skill's ENTIRE specific flow but never
 *       touch the ~780-line shared preamble.
 *   - extractSkillHead(skillDir, bodyLineCount)
 *       frontmatter + the first N body lines. For ROUTING / discovery tests,
 *       where the agent only reads the frontmatter (name + description) to
 *       decide which skill to invoke.
 *
 * Failure polarity: every extraction failure (missing file, missing
 * frontmatter, renamed section) THROWS with the offending name — a fixture is
 * never silently written empty. test/skill-fixture.test.ts pins the exported
 * section lists against the real generated SKILL.md files, so a section
 * rename fails the FREE suite instead of a paid E2E run.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Section lists shared by E2E fixtures and the free pin test ────────────
// Keep these verbatim against the H2 headings in the generated SKILL.md files.
// If gen-skill-docs renames a heading, test/skill-fixture.test.ts fails free.

/** /review E2E (sql-injection, enum-completeness, design-lite): the core
 *  review workflow without the shared preamble, Review Army, or Fix-First. */
export const REVIEW_E2E_SECTIONS = [
  'When to invoke this skill',
  'Step 0: Detect platform and base branch',
  'Step 1: Check branch',
  'Step 2: Read the checklist',
  'Step 2.5: Check for Greptile review comments',
  'Step 3: Get the diff',
  'Step 4: Critical pass (core review)',
  'Confidence Calibration',
  'Important Rules',
];

/** Review Army E2E: core workflow + Scope Drift / Plan Completion Audit
 *  (delivery-audit test) + Step 4.5 specialist dispatch (quality score,
 *  JSON findings schema, MULTI-SPECIALIST consensus, Red Team). */
export const REVIEW_ARMY_E2E_SECTIONS = [
  'When to invoke this skill',
  'Step 0: Detect platform and base branch',
  'Step 1: Check branch',
  'Step 1.5: Scope Drift Detection',
  'Step 2: Read the checklist',
  'Step 2.5: Check for Greptile review comments',
  'Step 3: Get the diff',
  'Step 4: Critical pass (core review)',
  'Confidence Calibration',
  'Step 4.5: Review Army — Specialist Dispatch',
  'Important Rules',
];

/** /retro E2E (retro, retro-base-branch): the repo-scoped retro flow
 *  (Steps 0-14 live under Instructions/Prior Learnings/Capture Learnings)
 *  + the narrative report template. Global mode and Compare mode are not
 *  exercised by the E2E tests and are dropped. */
export const RETRO_E2E_SECTIONS = [
  'When to invoke this skill',
  'Step 0: Detect platform and base branch',
  'User-invocable',
  'Arguments',
  'Instructions',
  'Prior Learnings',
  'Capture Learnings',
  'Engineering Retro: [date range]',
  'Tone',
  'Important Rules',
];

/** codex-review-findings E2E against the Codex host variant
 *  (.agents/skills/gstack-review/SKILL.md). Same core workflow as
 *  REVIEW_E2E_SECTIONS, minus "When to invoke this skill" (the Codex host
 *  adapter does not emit that section). */
export const CODEX_REVIEW_E2E_SECTIONS = [
  'Step 0: Detect platform and base branch',
  'Step 1: Check branch',
  'Step 2: Read the checklist',
  'Step 3: Get the diff',
  'Step 4: Critical pass (core review)',
  'Confidence Calibration',
  'Important Rules',
];

// ─── Parsing internals ──────────────────────────────────────────────────────

/** First/last H2 headings of the shared preamble block that gen-skill-docs
 *  emits into every tier >= 2 skill. extractSkillBody drops this range. */
const SHARED_PREAMBLE_FIRST = 'Preamble (run first)';
const SHARED_PREAMBLE_LAST = 'Plan Status Footer';

interface H2Section {
  heading: string;
  /** index of the heading line within bodyLines */
  start: number;
  /** one past the last line of the section (start of next H2, or EOF) */
  end: number;
}

/** Accept either a skill directory or a direct path to a .md file. */
function resolveSkillMd(skillDirOrFile: string): string {
  const file = skillDirOrFile.endsWith('.md')
    ? skillDirOrFile
    : path.join(skillDirOrFile, 'SKILL.md');
  if (!fs.existsSync(file)) {
    throw new Error(`skill-fixture: no SKILL.md at ${file}`);
  }
  return file;
}

function splitFrontmatter(raw: string, file: string): { frontmatter: string; bodyLines: string[] } {
  const lines = raw.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error(`skill-fixture: ${file} does not start with YAML frontmatter ('---')`);
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close === -1) {
    throw new Error(`skill-fixture: ${file} frontmatter never closes ('---' missing)`);
  }
  return {
    frontmatter: lines.slice(0, close + 1).join('\n'),
    bodyLines: lines.slice(close + 1),
  };
}

/**
 * Scan body lines for H2 sections, fence-aware: `## `-prefixed lines inside
 * ``` / ~~~ code fences are template content (e.g. the PLAN COMPLETION AUDIT
 * output format, the /context-save checkpoint template), NOT section
 * boundaries. Fences close only on a matching char of >= opening length,
 * per CommonMark, so 4-backtick fences embedding 3-backtick blocks work.
 */
function scanH2Sections(bodyLines: string[]): H2Section[] {
  const sections: H2Section[] = [];
  let fence: { ch: string; len: number } | null = null;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (!fence) {
        fence = { ch, len };
      } else if (fence.ch === ch && len >= fence.len && m[2].trim() === '') {
        fence = null;
      }
      continue;
    }
    if (!fence && line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), start: i, end: bodyLines.length });
    }
  }
  for (let s = 0; s < sections.length - 1; s++) {
    sections[s].end = sections[s + 1].start;
  }
  return sections;
}

function loadSkill(skillDirOrFile: string): {
  file: string;
  frontmatter: string;
  bodyLines: string[];
  sections: H2Section[];
} {
  const file = resolveSkillMd(skillDirOrFile);
  const raw = fs.readFileSync(file, 'utf-8');
  const { frontmatter, bodyLines } = splitFrontmatter(raw, file);
  return { file, frontmatter, bodyLines, sections: scanH2Sections(bodyLines) };
}

function findSection(sections: H2Section[], name: string, file: string): H2Section {
  const hit = sections.find((s) => s.heading === name)
    ?? sections.find((s) => s.heading.startsWith(name));
  if (!hit) {
    const available = sections.map((s) => `  ## ${s.heading}`).join('\n');
    throw new Error(
      `skill-fixture: section "## ${name}" not found in ${file}.\n`
      + 'The section may have been renamed — update the fixture section list '
      + '(see test/helpers/skill-fixture.ts).\n'
      + `Available H2 sections:\n${available}`,
    );
  }
  return hit;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read the real SKILL.md under `skillDir` (or a direct .md path), slice each
 * requested `## <section>` block, and return frontmatter + the sections
 * concatenated in the order given. Throws loudly on a missing section.
 */
export function extractSkillSections(skillDir: string, sections: string[]): string {
  const { file, frontmatter, bodyLines, sections: all } = loadSkill(skillDir);
  const parts: string[] = [frontmatter, ''];
  for (const name of sections) {
    const hit = findSection(all, name, file);
    parts.push(bodyLines.slice(hit.start, hit.end).join('\n').trimEnd(), '');
  }
  return parts.join('\n');
}

/**
 * Frontmatter + intro (everything before "## Preamble (run first)") + the
 * full skill-specific body (everything after the "## Plan Status Footer"
 * section). Use when a test exercises the whole skill flow: this drops the
 * ~780-line shared generated preamble and nothing else.
 */
export function extractSkillBody(skillDir: string): string {
  const { file, frontmatter, bodyLines, sections: all } = loadSkill(skillDir);
  const first = findSection(all, SHARED_PREAMBLE_FIRST, file);
  const last = findSection(all, SHARED_PREAMBLE_LAST, file);
  const intro = bodyLines.slice(0, first.start).join('\n').trimEnd();
  const tail = bodyLines.slice(last.end).join('\n').trimEnd();
  if (!tail) {
    throw new Error(
      `skill-fixture: ${file} has no content after "## ${SHARED_PREAMBLE_LAST}" — `
      + 'refusing to write a preamble-only fixture.',
    );
  }
  return [frontmatter, '', intro, '', tail, ''].join('\n');
}

/**
 * Frontmatter + the first `bodyLineCount` body lines. For routing/discovery
 * fixtures: skill selection reads the frontmatter name + description, so the
 * body is intentionally truncated.
 */
export function extractSkillHead(skillDir: string, bodyLineCount = 30): string {
  const { frontmatter, bodyLines } = loadSkill(skillDir);
  const head = bodyLines.slice(0, bodyLineCount).join('\n').trimEnd();
  return `${frontmatter}\n${head}\n\n<!-- body truncated by test/helpers/skill-fixture.ts — routing fixture needs frontmatter only -->\n`;
}
