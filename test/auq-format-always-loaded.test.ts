/**
 * AUQ format is ALWAYS-LOADED — the token-reduction safety net (gate, free).
 *
 * The anxiety this kills: carving a skill into a small skeleton + on-demand
 * `sections/*.md` could strand the AskUserQuestion decision-brief format (or a
 * per-skill AUQ rule) in a section that is NOT in context when a question
 * fires. The user would then see an AUQ with no ELI10, no Recommendation, no
 * Pros/Cons — exactly the degradation we must guarantee never happens.
 *
 * The guarantee, made mechanical and per-PR:
 *   1. UNIVERSAL — every interactive skill (anything that ships the
 *      `## AskUserQuestion Format` block, i.e. preamble tier >= 2) carries the
 *      FULL format spec in its always-loaded `SKILL.md` skeleton, NOT only in a
 *      section. The preamble is always in context, so the format spec is present
 *      the instant ANY question fires — Step 0, mode select, or a review finding.
 *   2. REGRESSION — a known roster of interactive skills MUST still ship the
 *      block. A botched carve that drops `{{PREAMBLE}}` from a skeleton fails
 *      here in milliseconds instead of surfacing as a garbled question weeks
 *      later.
 *   3. CARVE-SAFETY — for skills that ARE carved (have a `sections/` dir), the
 *      format block must live in `SKILL.md`, and any per-skill review-cadence
 *      rule that moved into a section must still exist somewhere in the
 *      skeleton+sections union (dropped-entirely is the failure).
 *
 * This is deterministic and free, so it runs on every `bun test`. It is the
 * floor under the paid behavioral/substance/consistency E2Es.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/** Mandatory elements of the AskUserQuestion decision-brief format. Each is a
 * label/marker the preamble resolver emits (generate-ask-user-format.ts) and
 * that the model needs in context to render a compliant question. */
const MANDATORY: Array<{ name: string; re: RegExp }> = [
  { name: '## AskUserQuestion Format header', re: /##\s*AskUserQuestion Format/i },
  { name: 'ELI10 label', re: /ELI10\s*:/i },
  { name: 'Stakes-if-we-pick-wrong line', re: /Stakes if we pick wrong/i },
  { name: 'Recommendation line (mandatory)', re: /Recommendation\s*:/i },
  { name: '(recommended) label', re: /\(recommended\)/i },
  { name: 'Pros / cons header', re: /Pros\s*\/\s*cons/i },
  { name: '✅ pro bullet', re: /✅/ },
  { name: '❌ con bullet', re: /❌/ },
  { name: 'Net: synthesis line', re: /Net\s*:/i },
  { name: 'Completeness coverage rule', re: /Completeness\s*:/i },
  { name: 'kind-vs-coverage rule', re: /options differ in kind/i },
  { name: 'Self-check checklist', re: /Self-check before emitting/i },
  // The runtime-failure fallback must be ALWAYS-LOADED too: when an AUQ call errors
  // mid-skill, the model needs the prose-fallback rule in context that instant, not
  // stranded in an on-demand section. Same guarantee as the format spec above.
  { name: 'AUQ-failure fallback subsection', re: /When AskUserQuestion is unavailable or a call fails/i },
  { name: 'fallback SESSION_KIND branch', re: /SESSION_KIND/ },
];

/** Per-skill AUQ rules that govern review-finding cadence. A carve may move
 * these into a section (they fire only once the section is loaded), but they
 * must never be DROPPED. Asserted against the skeleton+sections union. */
const PER_SKILL_RULES: Record<string, RegExp[]> = {
  'plan-ceo-review': [/One issue = one AskUserQuestion call/i],
  'plan-eng-review': [/One issue = one AskUserQuestion call/i],
  'plan-design-review': [/One issue = one AskUserQuestion call/i],
  'plan-devex-review': [/One issue = one AskUserQuestion call/i],
  // /codex emits its recommendation as prose; the instruction MUST stay in the
  // always-loaded skeleton because codex has no on-demand section.
  codex: [/Synthesis recommendation \(REQUIRED\)/i, /Recommendation\s*:\s*<action>\s*because/i],
};

/** Discover every repo-root skill dir that ships a generated SKILL.md. */
function discoverSkills(): Array<{ skill: string; skillMd: string; sectionsDir: string | null }> {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(skill => fs.existsSync(path.join(ROOT, skill, 'SKILL.md')))
    .map(skill => {
      const sectionsDir = path.join(ROOT, skill, 'sections');
      return {
        skill,
        skillMd: path.join(ROOT, skill, 'SKILL.md'),
        sectionsDir: fs.existsSync(sectionsDir) ? sectionsDir : null,
      };
    });
}

const skills = discoverSkills();
/** A skill is "interactive" if its always-loaded SKILL.md ships the format
 * block. That is the population that must be fully compliant. */
const interactive = skills.filter(s =>
  /##\s*AskUserQuestion Format/i.test(fs.readFileSync(s.skillMd, 'utf-8')),
);

/** Roster guard: these interactive skills MUST keep shipping the format block.
 * If a carve/refactor drops it, this list still expects them and the membership
 * test below fails. Derived from "fires AUQ at the user" — the plan/review/
 * advisory skills plus codex. */
const EXPECTED_INTERACTIVE = [
  'plan-ceo-review',
  'plan-eng-review',
  'plan-design-review',
  'plan-devex-review',
  'office-hours',
  'ship',
  'review',
  'qa',
  'qa-only',
  'codex',
  'autoplan',
  'cso',
  'investigate',
  'retro',
  'design-review',
  'design-consultation',
  'spec',
  'land-and-deploy',
];

describe('AUQ format is always-loaded (token-reduction safety net)', () => {
  test('discovered a sane number of interactive skills', () => {
    // Guards against a glob/path regression that would make the per-skill
    // loop vacuously pass with zero skills.
    expect(interactive.length).toBeGreaterThanOrEqual(15);
  });

  test('every expected interactive skill still ships the AUQ format block', () => {
    const names = new Set(interactive.map(s => s.skill));
    const missing = EXPECTED_INTERACTIVE.filter(s => !names.has(s));
    if (missing.length > 0) {
      throw new Error(
        `These skills lost their always-loaded AskUserQuestion format block ` +
          `(a carve or refactor likely dropped {{PREAMBLE}} from the skeleton):\n` +
          missing.map(s => `  - ${s}/SKILL.md`).join('\n'),
      );
    }
  });

  for (const { skill, skillMd } of interactive) {
    test(`${skill}: full AUQ format spec present in always-loaded SKILL.md`, () => {
      const body = fs.readFileSync(skillMd, 'utf-8');
      const gaps = MANDATORY.filter(m => !m.re.test(body));
      if (gaps.length > 0) {
        throw new Error(
          `${skill}/SKILL.md (the always-loaded skeleton) is missing ${gaps.length} ` +
            `mandatory AUQ format element(s) — a question firing here would degrade:\n` +
            gaps.map(g => `  - ${g.name} (${g.re.source})`).join('\n'),
        );
      }
    });
  }

  // CARVE-SAFETY: for carved skills, the format block must be in the SKELETON,
  // not only a section. (The per-skill loop above already reads SKILL.md, so
  // this is an explicit, named guard for the exact failure mode.)
  for (const { skill, skillMd, sectionsDir } of skills.filter(s => s.sectionsDir)) {
    test(`${skill} (carved): AUQ format block lives in the skeleton, not only sections/`, () => {
      const body = fs.readFileSync(skillMd, 'utf-8');
      expect(body).toMatch(/##\s*AskUserQuestion Format/i);
      expect(body).toMatch(/ELI10\s*:/i);
      expect(body).toMatch(/Recommendation\s*:/i);
      // sanity: confirm there really is a section dir we're guarding against
      expect(fs.readdirSync(sectionsDir!).some(f => f.endsWith('.md'))).toBe(true);
    });
  }

  // PER-SKILL RULES: review-cadence rules may move into a section, but must
  // never be dropped from the skeleton+sections union.
  for (const [skill, rules] of Object.entries(PER_SKILL_RULES)) {
    test(`${skill}: per-skill AUQ rules survive in skeleton+sections union`, () => {
      const skillDir = path.join(ROOT, skill);
      if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
        throw new Error(`${skill}/SKILL.md not found — roster is stale`);
      }
      let union = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
      const secDir = path.join(skillDir, 'sections');
      if (fs.existsSync(secDir)) {
        for (const f of fs.readdirSync(secDir).filter(f => f.endsWith('.md') && !f.endsWith('.md.tmpl'))) {
          union += '\n' + fs.readFileSync(path.join(secDir, f), 'utf-8');
        }
      }
      const dropped = rules.filter(re => !re.test(union));
      if (dropped.length > 0) {
        throw new Error(
          `${skill}: per-skill AUQ rule(s) dropped from skeleton+sections union:\n` +
            dropped.map(re => `  - ${re.source}`).join('\n'),
        );
      }
    });
  }
});
