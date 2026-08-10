/**
 * scripts/resolvers/tasks-section.ts + scripts/task-emission-schema.ts —
 * the Implementation Tasks emission/aggregation resolvers (#1454).
 *
 * Neither module had any test coverage. Both encode contracts that break
 * silently when edited:
 *   - EMIT is parameterized (`{{TASKS_SECTION_EMIT:<phase>}}`); an unknown or
 *     missing phase must fail the build, not render a skill that writes its
 *     JSONL to `tasks--<datetime>.jsonl`.
 *   - The emitted bash must interpolate the phase into both the filename and
 *     the `--arg phase` value, or the autoplan aggregator silently drops the
 *     phase (it filters records by `.phase`).
 *   - `dedupKey` is the aggregator's collapse key: files must be sorted so
 *     the same task listed in a different file order dedupes.
 */

import { describe, test, expect } from 'bun:test';
import {
  generateTasksSectionEmit,
  generateTasksSectionAggregate,
} from '../scripts/resolvers/tasks-section';
import { dedupKey, type ImplementationTask, type TaskPhase } from '../scripts/task-emission-schema';
import { RESOLVERS } from '../scripts/resolvers';
import { unwrapResolver, HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const PHASES: TaskPhase[] = ['ceo-review', 'design-review', 'eng-review', 'devex-review'];

const ctx: TemplateContext = {
  skillName: 'plan-eng-review',
  tmplPath: 'plan-eng-review/SKILL.md.tmpl',
  host: 'claude',
  paths: HOST_PATHS.claude!,
};

describe('generateTasksSectionEmit', () => {
  test('rejects a missing phase argument', () => {
    expect(() => generateTasksSectionEmit(ctx)).toThrow(/TASKS_SECTION_EMIT requires one of/);
    expect(() => generateTasksSectionEmit(ctx, [])).toThrow(/got undefined/);
  });

  test('rejects an unknown phase and names the valid ones', () => {
    expect(() => generateTasksSectionEmit(ctx, ['qa-review'])).toThrow(/got qa-review/);
    for (const phase of PHASES) {
      expect(() => generateTasksSectionEmit(ctx, ['bogus'])).toThrow(new RegExp(phase));
    }
  });

  test.each(PHASES)('%s renders the phase into both the filename and the jq --arg', phase => {
    const out = generateTasksSectionEmit(ctx, [phase]);
    expect(out).toContain(`tasks-${phase}-$(date +%Y%m%d-%H%M%S).jsonl`);
    expect(out).toContain(`--arg phase '${phase}'`);
  });

  test('extra args past the phase are ignored', () => {
    expect(generateTasksSectionEmit(ctx, ['eng-review', 'junk'])).toBe(
      generateTasksSectionEmit(ctx, ['eng-review']),
    );
  });

  test('emits the markdown section plus the JSONL write instructions', () => {
    const out = generateTasksSectionEmit(ctx, ['ceo-review']);
    expect(out.startsWith('## Implementation Tasks')).toBe(true);
    expect(out).toContain('### Markdown section (always emit)');
    expect(out).toContain('### JSONL artifact (always write, even if zero tasks)');
    // Zero-task runs must still touch the file so "ran, no findings" stays
    // distinguishable from "didn't run".
    expect(out).toContain(': > "$TASKS_FILE"');
  });

  test('every schema field is present in the jq object', () => {
    const out = generateTasksSectionEmit(ctx, ['design-review']);
    const fields: Array<keyof ImplementationTask> = [
      'phase',
      'run_id',
      'branch',
      'commit',
      'id',
      'priority',
      'component',
      'files',
      'effort_human',
      'effort_cc',
      'title',
      'source_finding',
    ];
    for (const field of fields) expect(out).toContain(`${field}:$${field}`);
  });

  test('builds JSONL with jq, never hand-rolled echo/printf', () => {
    const out = generateTasksSectionEmit(ctx, ['eng-review']);
    expect(out).toContain('jq -nc');
    expect(out).toContain('Never hand-roll JSONL.');
    expect(out).toContain('--argjson files "$FILES_JSON"');
  });

  test('degrades explicitly when jq is absent', () => {
    expect(generateTasksSectionEmit(ctx, ['devex-review'])).toContain('If `jq` is not installed');
  });
});

describe('generateTasksSectionAggregate', () => {
  const out = generateTasksSectionAggregate(ctx);

  test('scopes aggregation to the current branch and a 5-commit window', () => {
    expect(out).toContain('git log --format=%H -n 5');
    expect(out).toContain('.branch == $branch');
  });

  test('reads every phase the emitter can write', () => {
    expect(out).toContain('for phase in ceo-review design-review eng-review devex-review');
    for (const phase of PHASES) {
      expect(out).toContain(`tasks-$phase-*.jsonl`);
    }
  });

  test('dedup groups on the same tuple as dedupKey (component, sorted files, title)', () => {
    expect(out).toContain('group_by([.component, (.files | sort), .title])');
  });

  test('uses find rather than glob expansion so a phase with no files is not an error', () => {
    expect(out).toContain('find "$TASKS_DIR" -maxdepth 1 -name "tasks-$phase-*.jsonl"');
  });

  test('falls back to a visible notice when jq is missing', () => {
    expect(out).toContain('jq not installed');
  });

  test('handles the empty case with prose instead of an empty section', () => {
    expect(out).toContain('_No actionable tasks emitted from any phase._');
    expect(out).toContain('No per-phase task lists found');
  });
});

describe('resolver registration', () => {
  test('both placeholders are wired into RESOLVERS', () => {
    expect(unwrapResolver(RESOLVERS.TASKS_SECTION_EMIT!).resolve).toBe(generateTasksSectionEmit);
    expect(unwrapResolver(RESOLVERS.TASKS_SECTION_AGGREGATE!).resolve).toBe(
      generateTasksSectionAggregate,
    );
  });
});

describe('dedupKey', () => {
  const base = {
    component: 'browse/sanitizer',
    files: ['browse/src/sanitize.ts', 'browse/src/server.ts'],
    title: 'Add commandResult-level sanitization',
  };

  test('file order does not affect the key', () => {
    expect(dedupKey({ ...base, files: [...base.files].reverse() })).toBe(dedupKey(base));
  });

  test('does not mutate the caller’s files array', () => {
    const files = ['b.ts', 'a.ts'];
    dedupKey({ ...base, files });
    expect(files).toEqual(['b.ts', 'a.ts']);
  });

  test('differing component, title, or file set produce different keys', () => {
    expect(dedupKey({ ...base, component: 'browse/server' })).not.toBe(dedupKey(base));
    expect(dedupKey({ ...base, title: `${base.title} everywhere` })).not.toBe(dedupKey(base));
    expect(dedupKey({ ...base, files: [base.files[0]!] })).not.toBe(dedupKey(base));
  });

  test('ignores fields outside the collapse tuple (phase, priority, effort)', () => {
    const task: ImplementationTask = {
      phase: 'eng-review',
      run_id: '20250101T000000Z-1',
      branch: 'main',
      commit: 'abc123',
      id: 'T1',
      priority: 'P1',
      effort_human: '2h',
      effort_cc: '15min',
      source_finding: 'Section 3',
      ...base,
    };
    expect(dedupKey(task)).toBe(dedupKey(base));
    expect(dedupKey({ ...task, phase: 'ceo-review', priority: 'P3', id: 'T9' })).toBe(
      dedupKey(base),
    );
  });

  test('key is stable JSON (same input → byte-identical output)', () => {
    expect(dedupKey(base)).toBe(dedupKey({ ...base }));
    expect(JSON.parse(dedupKey(base))).toEqual({
      component: base.component,
      files: ['browse/src/sanitize.ts', 'browse/src/server.ts'],
      title: base.title,
    });
  });
});
