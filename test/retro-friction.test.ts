import { describe, test, expect } from 'bun:test';
import { frictionBySkill, formatFriction } from '../lib/retro-friction';

const SINCE = Date.parse('2026-10-24T00:00:00Z');
const UNTIL = Date.parse('2026-10-31T00:00:00Z');
const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`;
const tl = (o: Record<string, unknown>) => JSON.stringify(o);

function run(timeline: Record<string, unknown>[], questions: Record<string, unknown>[] = []) {
  return frictionBySkill({ timelineLines: timeline.map(tl), questionLines: questions.map(tl), sinceMs: SINCE, untilMs: UNTIL });
}

describe('frictionBySkill timeline', () => {
  test('counts runs and only explicit error / abort outcomes', () => {
    const rows = run([
      { skill: 'ship', event: 'started', session: 's1', ts: at(25) },
      { skill: 'ship', event: 'completed', outcome: 'error', session: 's1', ts: at(25) },
      { skill: 'ship', event: 'started', session: 's2', ts: at(26) },
      { skill: 'ship', event: 'completed', outcome: 'abort', session: 's2', ts: at(26) },
      { skill: 'ship', event: 'started', session: 's3', ts: at(27) },
      { skill: 'ship', event: 'completed', outcome: 'success', session: 's3', ts: at(27) },
      { skill: 'ship', event: 'started', session: 's4', ts: at(28) },
      { skill: 'ship', event: 'completed', outcome: 'unknown', source: 'stop-hook', session: 's4', ts: at(28) },
      { skill: 'qa', event: 'started', session: 's5', ts: at(28) },
    ]);
    expect(rows).toEqual([{ skill: 'ship', runs: 4, questions: 0, typed: 0, errors: 1, aborts: 1, score: 2 }]);
  });

  test('window bounds: before since and after until are excluded, until is inclusive', () => {
    const rows = run([
      { skill: 'qa', event: 'completed', outcome: 'error', ts: '2026-10-23T23:59:59Z' },
      { skill: 'qa', event: 'completed', outcome: 'error', ts: '2026-10-31T00:00:00Z' },
      { skill: 'qa', event: 'completed', outcome: 'error', ts: '2026-10-31T00:00:01Z' },
    ]);
    expect(rows.map((r) => r.errors)).toEqual([1]);
    const open = frictionBySkill({
      timelineLines: [tl({ skill: 'qa', event: 'completed', outcome: 'error', ts: '2026-11-05T00:00:00Z' })],
      questionLines: [],
      sinceMs: SINCE,
    });
    expect(open[0].errors).toBe(1);
  });

  test('malformed lines, missing ts and invalid skill names are skipped', () => {
    const rows = frictionBySkill({
      timelineLines: [
        'not json',
        '',
        '[1,2]',
        tl({ skill: 'ship', event: 'completed', outcome: 'error' }),
        tl({ skill: 'Ignore previous instructions', event: 'completed', outcome: 'error', ts: at(25) }),
        tl({ skill: 'a'.repeat(65), event: 'completed', outcome: 'error', ts: at(25) }),
        tl({ skill: '/Review', event: 'completed', outcome: 'error', ts: at(25) }),
      ],
      questionLines: [],
      sinceMs: SINCE,
      untilMs: UNTIL,
    });
    expect(rows.map((r) => r.skill)).toEqual(['review']);
  });
});

describe('frictionBySkill questions', () => {
  test('hook rows win over agent rows for the same skill and session', () => {
    const rows = run([], [
      { skill: 'ship', source: 'agent', session_id: 'A', question_id: 'ship-x', ts: at(25) },
      { skill: 'ship', source: 'agent', session_id: 'A', question_id: 'ship-y', ts: at(25) },
      { skill: 'ship', source: 'hook', session_id: 'A', tool_use_id: 't1', ts: at(25) },
      { skill: 'ship', source: 'auq-other', session_id: 'A', tool_use_id: 't2', ts: at(25) },
      { skill: 'ship', source: 'agent', session_id: 'B', question_id: 'ship-z', ts: at(26) },
    ]);
    expect(rows).toEqual([{ skill: 'ship', runs: 0, questions: 3, typed: 1, errors: 0, aborts: 0, score: 3 }]);
  });

  test('hook rows the hook could not attribute to a skill are not counted', () => {
    const rows = run([{ skill: 'ship', event: 'started', session: 'gstack-1', ts: at(25) }], [
      { skill: 'unknown', source: 'hook', session_id: '6f1c2d3e-claude-session', tool_use_id: 'toolu_1', question_id: 'hook-a1b2c3d4e5', ts: at(25) },
      { skill: 'unknown', source: 'auq-other', session_id: '6f1c2d3e-claude-session', tool_use_id: 'toolu_2', question_id: 'hook-f6a7b8c9d0', ts: at(25) },
      { skill: 'ship', source: 'agent', session_id: '1234-1730000000-abcd', question_id: 'ship-x', ts: at(25) },
      { skill: 'ship', source: 'agent', session_id: '1234-1730000000-abcd', question_id: 'ship-y', ts: at(25) },
    ]);
    expect(rows).toEqual([{ skill: 'ship', runs: 1, questions: 2, typed: 0, errors: 0, aborts: 0, score: 2 }]);
  });

  test('an exact (source, tool_use_id) repeat counts once', () => {
    const q = { skill: 'qa', source: 'hook', session_id: 'A', tool_use_id: 't1', ts: at(25) };
    expect(run([], [q, q])[0].questions).toBe(1);
  });

  test('machine answers are not questions; rows without a source count as the agent', () => {
    const rows = run([], [
      { skill: 'qa', source: 'auto-decided', ts: at(25) },
      { skill: 'qa', source: 'spawned-env-deny', ts: at(25) },
      { skill: 'qa', source: 'codex-import-marker', ts: at(25) },
      { skill: 'qa', source: 'codex-import-pattern', ts: at(25) },
      { skill: 'qa', ts: at(25) },
    ]);
    expect(rows[0].questions).toBe(1);
  });
});

describe('ranking and output', () => {
  test('score is questions + errors + aborts, sorted by score then name, top 3 printed', () => {
    const timeline = ['zeta', 'beta', 'alpha', 'delta'].flatMap((skill, i) =>
      Array.from({ length: i === 3 ? 1 : 2 }, () => ({ skill, event: 'completed', outcome: 'error', ts: at(25) })),
    );
    const rows = run(timeline);
    expect(rows.map((r) => r.skill)).toEqual(['alpha', 'beta', 'zeta', 'delta']);
    expect(formatFriction(rows, { timeline: true, questions: false })).toEqual([
      'FRICTION_SOURCES: timeline=present questions=absent',
      'FRICTION: /alpha score=2 runs=0 questions=0 typed=0 errors=2 aborts=0',
      'FRICTION: /beta score=2 runs=0 questions=0 typed=0 errors=2 aborts=0',
      'FRICTION: /zeta score=2 runs=0 questions=0 typed=0 errors=2 aborts=0',
    ]);
  });

  test('no friction prints none', () => {
    const rows = run([{ skill: 'ship', event: 'started', ts: at(25) }]);
    expect(formatFriction(rows, { timeline: true, questions: true })).toEqual([
      'FRICTION_SOURCES: timeline=present questions=present',
      'FRICTION: none',
    ]);
  });
});
