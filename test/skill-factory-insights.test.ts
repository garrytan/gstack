import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { validateSkill, parseFrontmatter } from './helpers/skill-parser';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_DIR = path.join(ROOT, 'factory-insights');
const GENERATED = path.join(SKILL_DIR, 'SKILL.md');

// Factory Insights (docs/designs/FACTORY_INSIGHTS_V0.md, tickets 01 + 02):
// a PURE-PROSE, read-only skill that correlates friction Signals
// (question-log.jsonl clarification/routing/feedback-loop) with skill
// activations (skill-usage.jsonl). The seam agreed in the design review is
// this free static prose contract on the GENERATED skill doc: the runtime
// agent's behavior is driven entirely by these instructions, so the literals
// below pin the exact rules it will follow. Ticket 01's two fixture-gate
// checkboxes (seeded temp project, byte-identical state proof) are NOT
// satisfied by this seam and remain open on the ticket; no paid harness
// exists for v0 either. The mechanical zero-write boundary IS asserted here
// (no write tools, no write-capable helper invocations).

function readGenerated(): string {
  return fs.readFileSync(GENERATED, 'utf-8');
}

// PROSE contracts are matched against WHITESPACE-FOLDED text: the rendered
// SKILL.md reflows line breaks on any prose edit, so single-line regexes on
// raw text fail spuriously (this bit three times across tickets 01 and 02).
// Fold once; every phrase then occupies one logical line. All prose
// assertions go through must()/mustNot(), which on failure report the needle
// and label WITHOUT dumping the whole file (expect's failure print of a 37KB
// received string dominated the last Red-Green loop's token cost).
function prose(): string {
  return readGenerated().replace(/\s+/g, ' ');
}

function must(needle: string | RegExp, label: string): void {
  const md = prose();
  const ok = typeof needle === 'string' ? md.includes(needle) : needle.test(md);
  if (!ok) {
    const shown = typeof needle === 'string' ? `'${needle}'` : `/${needle.source}/`;
    throw new Error(`prose contract [${label}]: ${shown} not found in generated factory-insights/SKILL.md (failure window suppressed; grep the file directly)`);
  }
}

// mustNot scopes to an explicit haystack slice (e.g. the skill body with the
// shared preamble removed), not the whole file.
function mustNot(haystack: string, needle: string, label: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`prose contract [${label}]: forbidden string '${needle}' present (failure window suppressed; grep the file directly)`);
  }
}

function skillBody(): string {
  const md = readGenerated();
  return md.slice(md.indexOf('# Factory Insights'));
}

describe('factory-insights skill (v0 read-only meta loop)', () => {
  test('generated SKILL.md exists — template rendered by gen:skill-docs', () => {
    expect(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md.tmpl'))).toBe(true);
    expect(fs.existsSync(GENERATED)).toBe(true);
  });

  // Raw file: folding would corrupt the YAML offsets parseFrontmatter reads.
  test('frontmatter declares the skill and a read-only tool allowlist', () => {
    const fm = parseFrontmatter(readGenerated());
    expect(fm.name).toBe('factory-insights');
    // Read-only: Reads are needed; Writes and Edits must NOT be granted.
    const allowed = fm['allowed-tools'] as string[];
    expect(allowed).toContain('Read');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Edit');
  });

  test('friction Signals: exactly clarification, routing, feedback-loop; approval and cherry-pick excluded', () => {
    for (const category of ['clarification', 'routing', 'feedback-loop']) {
      must(category, 'friction categories');
    }
    // Excluded categories must be present but only in an exclusion statement.
    must(/approval[^.\n]*excluded|excluded[^.\n]*\bapproval\b/, 'approval excluded');
    must(/cherry-pick[^.\n]*excluded|excluded[^.\n]*cherry-pick/, 'cherry-pick excluded');
  });

  test('reads the question log and the skill usage log as the only v0 Signals', () => {
    must('question-log.jsonl', 'question log source');
    must('skill-usage.jsonl', 'usage log source');
    // Real record-shape fields the prose must reference so counts map to
    // actual data: category + verbatim example text from question log;
    // hook-fire discriminator from skill usage.
    must('question_summary', 'question record shape');
    must('user_choice', 'question record shape');
    must('"hook_fire"', 'hook-fire discriminator');
  });

  test('attribution rule: 30-minute window; hook fires never attributed', () => {
    must('30-minute', 'attribution window');
    must(/never[ .,;][^.\n]*attribut|attribut[a-z]*[^.\n]*\bnever\b/i, 'hook fires never attributed');
  });

  test('default window: last 14 days, and the header must state the window used', () => {
    must('last 14 days', 'default 14-day window');
    must(/state the window|states the window/, 'header states the window');
  });

  test('report shape: at most 3 top friction skills, per-category breakdown, verbatim example', () => {
    must(/at most 3|up to 3|top 3/, 'top-3 cap');
    must('category breakdown', 'per-category breakdown');
    must(/verbatim|one example/, 'verbatim worked example');
  });

  test('multi-attribution: a Signal counts once per attributed skill', () => {
    must('once per skill', 'single count per attributed skill');
  });

  test('read-only boundary: hard gate on writes; no write-capable helper invocations', () => {
    must('HARD GATE', 'write hard gate');
    must(/never writes|never write|do not write|do not create|never creates/i, 'zero-write prose boundary');
    // Mechanical boundary — the writer helpers that mutate project state are
    // in the repo exactly once; this skill's own prose must never invoke any.
    // (The shared preamble's platform sections reference some of these for
    // every skill; assertions therefore scope to the skill body.)
    const body = skillBody();
    for (const writer of [
      'gstack-learnings-log',
      'gstack-question-log',
      'gstack-timeline-log',
      'gstack-decision-log',
    ]) {
      mustNot(body, writer, 'no writer helpers in skill body');
    }
  });

  test('state paths resolve through gstack-paths and gstack-slug with the failing guard', () => {
    must('gstack-paths --get GSTACK_STATE_ROOT', 'state-root invocation');
    must(':?', 'fatal state-root guard');
    must('gstack-slug --get SLUG', 'slug invocation');
  });

  test('generated doc passes the repo skill validator (routing/commands)', () => {
    expect(validateSkill(GENERATED).invalid).toHaveLength(0);
  });
});

describe('factory-insights ticket 02 (sparse-data honesty + /learn suggestions)', () => {
  test('sparse-window rule: fewer than 3 Signals widens to 30 days and states it', () => {
    must(/fewer than 3 [^.\n]*[Ss]ignal/, 'auto-widen threshold');
    must('30 days', 'widened window length');
    must(/state[s]? that it widened|say[s]? that it widened|widened the window/, 'widening is stated, never silent');
  });

  test('honest stop: fewer than 3 Signals even after widening stops, no forced insights', () => {
    must(/not enough ([Ff]riction )?[Ss]ignals|still fewer than 3/, 'honest stop wording');
    // The 0-Signal case widens before any honest stop — the amendment's
    // central clause, previously unpinned.
    must(/zero [Ss]ignals[^.\n]*wider window|widen[^.\n]*zero/, '0-Signal widening clause');
    // The stop only happens after widening had its turn.
    must(/after the sparse-data rule had its turn to widen|only after the sparse-data rule/, 'stop ordering after widening');
    // No manufactured insights — stops rather than inventing conclusions.
    must(/no manufactured|nothing to attribute/i, 'no manufactured insights');
  });

  test('closing section: at most one /learn suggestion per top skill with exact invocation', () => {
    must('/learn', 'learn reference');
    must('at most one', 'one suggestion per top skill');
    // The exact suggested invocation text is shown (the strong guard alone;
    // the removed weak disjunct added noise, not coverage).
    must(/exact [^.\n]*\/learn/, 'exact invocation text shown');
  });

  test('suggestions are displayed, never executed — and the write boundary still holds', () => {
    must(/never execute|displayed as a suggestion|suggestion, never/, 'display-not-execute boundary');
    // Suggestion section must not gain write paths (skill body, preamble excluded).
    mustNot(skillBody(), 'gstack-learnings-log', 'suggestions gain no write paths');
    mustNot(skillBody(), 'gstack-question-log', 'suggestions gain no write paths');
  });

  test('header states widened or not; default remains 14 days', () => {
    must('last 14 days', 'default remains 14 days');
    must(/widened or not|whether it widened/, 'header widened-or-not wording');
  });
});
