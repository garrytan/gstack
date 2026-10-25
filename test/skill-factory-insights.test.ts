import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { validateSkill } from './helpers/skill-parser';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_DIR = path.join(ROOT, 'factory-insights');
const GENERATED = path.join(SKILL_DIR, 'SKILL.md');

// Factory Insights v0 (docs/designs/FACTORY_INSIGHTS_V0.md, ticket 01):
// a PURE-PROSE, read-only skill that correlates friction Signals
// (question-log.jsonl clarification/routing/feedback-loop) with skill
// activations (skill-usage.jsonl). The seam agreed in the design review is
// this free static prose contract on the GENERATED skill doc: the runtime
// agent's behavior is driven entirely by these instructions, so the literals
// below pin the exact rules it will follow. Ticket 01's two fixture-gate
// checkboxes (seeded temp project, byte-identical state proof) are NOT
// satisfied by this seam and remain open on the ticket; no paid harness exists
// for v0 either. The mechanical zero-write boundary IS asserted here (no write
// tools, no write-capable helper invocations).

function readGenerated(): string {
  return fs.readFileSync(GENERATED, 'utf-8');
}

function frontmatter(): Record<string, unknown> {
  const md = readGenerated();
  const fmEnd = md.indexOf('\n---', 4);
  return Bun.YAML.parse(md.slice(4, fmEnd)) as Record<string, unknown>;
}

describe('factory-insights skill (v0 read-only meta loop)', () => {
  test('generated SKILL.md exists — template rendered by gen:skill-docs', () => {
    expect(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md.tmpl'))).toBe(true);
    expect(fs.existsSync(GENERATED)).toBe(true);
  });

  test('frontmatter declares the skill and a read-only tool allowlist', () => {
    const fm = frontmatter();
    expect(fm.name).toBe('factory-insights');
    // Read-only: Reads are needed; Writes and Edits must NOT be granted.
    const allowed = fm['allowed-tools'] as string[];
    expect(allowed).toContain('Read');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Edit');
  });

  test('friction Signals: exactly clarification, routing, feedback-loop; approval and cherry-pick excluded', () => {
    const md = readGenerated();
    for (const category of ['clarification', 'routing', 'feedback-loop']) {
      expect(md).toContain(category);
    }
    // Excluded categories must be present but only in an exclusion statement.
    expect(md).toMatch(/approval[^\n]*excluded|excluded[^\n]*\bapproval\b/);
    expect(md).toMatch(/cherry-pick[^\n]*excluded|excluded[^\n]*cherry-pick/);
  });

  test('reads the question log and the skill usage log as the only v0 Signals', () => {
    const md = readGenerated();
    expect(md).toContain('question-log.jsonl');
    expect(md).toContain('skill-usage.jsonl');
    // Real record-shape fields the prose must reference so counts map to
    // actual data: category + verbatim example text from question log;
    // hook-fire discriminator from skill usage.
    expect(md).toContain('question_summary');
    expect(md).toContain('user_choice');
    expect(md).toContain('"hook_fire"');
  });

  test('attribution rule: 30-minute window; hook fires never attributed', () => {
    const md = readGenerated();
    expect(md).toContain('30-minute');
    expect(md).toMatch(/[Nn]ever[^\n]*attribut|attribut[^\n]*\b[Nn]ever\b/);
  });

  test('default window: last 14 days, and the header must state the window used', () => {
    const md = readGenerated();
    expect(md).toContain('last 14 days');
    expect(md).toMatch(/state the window|states the window/);
  });

  test('report shape: at most 3 top friction skills, per-category breakdown, verbatim example', () => {
    const md = readGenerated();
    expect(md).toMatch(/at most 3|up to 3|top 3/);
    expect(md).toContain('category breakdown');
    expect(md).toMatch(/verbatim|one example/);
  });

  test('multi-attribution: a Signal counts once per attributed skill', () => {
    const md = readGenerated();
    expect(md).toContain('once per skill');
  });

  test('read-only boundary: hard gate on writes; no write-capable helper invocations', () => {
    const md = readGenerated();
    const body = md.slice(md.indexOf('# Factory Insights'));
    // Prose boundary — the report flow must instruct zero writes.
    expect(md).toContain('HARD GATE');
    expect(md).toMatch(/[Nn]ever writes|never write|Do NOT write/);
    // Mechanical boundary — the writer helpers that mutate project state are
    // in the repo exactly once; this skill's own prose must never invoke any.
    // (The shared preamble's platform sections reference some of these for
    // every skill; assertions therefore scope to the skill body.)
    for (const writer of [
      'gstack-learnings-log',
      'gstack-question-log',
      'gstack-timeline-log',
      'gstack-decision-log',
    ]) {
      expect(body).not.toContain(writer);
    }
  });

  test('state paths resolve through gstack-paths and gstack-slug with the failing guard', () => {
    const md = readGenerated();
    expect(md).toContain('gstack-paths --get GSTACK_STATE_ROOT');
    expect(md).toContain(':?'); // fatal guard, per the state-root ratchet
    expect(md).toContain('gstack-slug --get SLUG');
  });

  test('generated doc passes the repo skill validator (routing/commands)', () => {
    expect(validateSkill(GENERATED).invalid).toHaveLength(0);
  });
});
