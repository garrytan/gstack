import { describe, expect, test } from 'bun:test';
import { compileRunPlan, type WorkflowSpec } from '../lib/factory-core';
import { planFactoryScheduleBatches, schedulerCapabilitiesFor } from '../lib/factory-scheduler';

const workflow: WorkflowSpec = {
  id: 'scheduled-build',
  title: 'Scheduled Build',
  description: 'Exercise scheduler batch calculations.',
  phases: [
    phase('intake', 'serial'),
    phase('read-a', 'parallel-readonly'),
    phase('read-b', 'parallel-readonly'),
    { ...phase('approval', 'parallel-readonly'), gates: [{ id: 'approve', title: 'Approve', description: 'Approve next work.', kind: 'human-decision' }] },
    phase('write-a', 'isolated-worktree', { owner: 'write-a', integrationStrategy: 'artifact-only' }),
    phase('write-b', 'isolated-worktree', { owner: 'write-b', integrationStrategy: 'artifact-only' }),
    phase('write-c', 'isolated-worktree', { owner: 'write-c', integrationStrategy: 'artifact-only' }),
  ],
};

describe('factory scheduler calculations', () => {
  test('groups contiguous parallel phases and keeps gate phases as barriers', () => {
    const plan = compileRunPlan(workflow, {
      workflow: 'scheduled-build',
      goal: 'Schedule work',
      mode: 'build',
      policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write', maxParallelWriteTimelines: 2 },
    }, 'run-scheduled');

    const batches = planFactoryScheduleBatches(plan);
    expect(batches.map(batch => ({ concurrency: batch.concurrency, phases: batch.phases.map(phase => phase.id) }))).toEqual([
      { concurrency: 'serial', phases: ['intake'] },
      { concurrency: 'parallel-readonly', phases: ['read-a', 'read-b'] },
      { concurrency: 'parallel-readonly', phases: ['approval'] },
      { concurrency: 'isolated-worktree', phases: ['write-a', 'write-b'] },
      { concurrency: 'isolated-worktree', phases: ['write-c'] },
    ]);
  });

  test('clamps invalid parallel write widths to one isolated worktree phase per batch', () => {
    for (const maxParallelWriteTimelines of [0, -2]) {
      const plan = compileRunPlan(workflow, {
        workflow: 'scheduled-build',
        goal: 'Schedule work',
        mode: 'build',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write', maxParallelWriteTimelines },
      }, `run-scheduled-${maxParallelWriteTimelines}`);

      const writeBatches = planFactoryScheduleBatches(plan).filter(batch => batch.concurrency === 'isolated-worktree');
      expect(writeBatches.map(batch => batch.phases.map(phase => phase.id))).toEqual([['write-a'], ['write-b'], ['write-c']]);
    }
  });

  test('declares scheduler capability requirements by concurrency mode', () => {
    expect(schedulerCapabilitiesFor('serial')).toEqual([]);
    expect(schedulerCapabilitiesFor('parallel-readonly')).toEqual(['subagent-session']);
    expect(schedulerCapabilitiesFor('isolated-worktree')).toEqual(['subagent-session', 'worktree']);
  });
});

function phase(id: string, concurrency: 'serial' | 'parallel-readonly' | 'isolated-worktree', worktree?: { owner: string; integrationStrategy: 'merge' | 'cherry-pick' | 'artifact-only' }): WorkflowSpec['phases'][number] {
  return {
    id,
    title: id,
    role: { id: `${id}-role`, title: `${id} Role` },
    objective: `Run ${id}.`,
    concurrency,
    worktree,
    outputs: [{ id: `${id}-artifact`, kind: concurrency === 'isolated-worktree' ? 'diff' : 'plan', description: `${id} output.` }],
    modes: ['build'],
  };
}
