/**
 * Question Tuning registry path must be absolute (#2489).
 *
 * The preamble told agents to choose question_id from a RELATIVE
 * `scripts/question-registry.ts` — which never resolves from a user's
 * project cwd (the file lives only under the gstack install root). The
 * lookup silently failed and agents fabricated ids via the {skill}-{slug}
 * fallback (one observed /plan-eng-review session: 21/21 unregistered).
 *
 * The resolver now interpolates the installed path the same way ${bin}
 * paths are interpolated: ctx.paths.skillRoot (a `~`-rooted path on Claude,
 * $GSTACK_ROOT on env-var hosts).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateQuestionTuning } from '../scripts/resolvers/question-tuning';

const ROOT = path.join(import.meta.dir, '..');

function makeCtx(host: 'claude' | 'codex'): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: 2,
  };
}

describe('question-tuning registry path is absolute (#2489)', () => {
  test('claude host renders the installed registry path', () => {
    const out = generateQuestionTuning(makeCtx('claude'));
    expect(out).toContain('`~/.claude/skills/gstack/scripts/question-registry.ts`');
  });

  test('env-var host renders $GSTACK_ROOT-anchored registry path', () => {
    const out = generateQuestionTuning(makeCtx('codex'));
    expect(out).toContain('`$GSTACK_ROOT/scripts/question-registry.ts`');
  });

  test('no host renders a bare relative registry path', () => {
    for (const host of ['claude', 'codex'] as const) {
      const out = generateQuestionTuning(makeCtx(host));
      // A backtick immediately before `scripts/` means the path renders
      // relative — exactly the shape that never resolves from a project cwd.
      expect(out).not.toContain('`scripts/question-registry.ts`');
    }
  });

  test('question identity covers prose and ad hoc IDs without enabling disabled tuning', () => {
    for (const host of ['claude', 'codex'] as const) {
      const out = generateQuestionTuning(makeCtx(host));
      expect(out).toContain('skip entirely if `QUESTION_TUNING: false`');
      expect(out).toMatch(/Before each decision brief[\s\S]*AskUserQuestion[\s\S]*Conductor\/fallback prose/);
      expect(out).toMatch(/every asked brief[\s\S]*including ad hoc IDs/);
      expect(out).toMatch(/same ID for its preference check, question marker, and log/);
      expect(out).toContain('`<gstack-qid:{question_id}>` once in the question text itself');
      expect(out).toMatch(/On prose paths, use the explicit reply line/);
    }
  });

  test('the interpolated path points at a file that exists in the install tree', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'question-registry.ts'))).toBe(true);
  });

  test('rendered SKILL.md carries the absolute path', () => {
    const rendered = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');
    expect(rendered).toContain('~/.claude/skills/gstack/scripts/question-registry.ts');
    expect(rendered).not.toContain('`scripts/question-registry.ts`');
  });
});
