import type { FactoryRunPlan, PhaseConcurrency, PlannedPhase } from './factory-core';

export interface FactoryScheduleBatch {
  readonly id: string;
  readonly concurrency: PhaseConcurrency;
  readonly phases: readonly PlannedPhase[];
}

export function planFactoryScheduleBatches(plan: FactoryRunPlan): readonly FactoryScheduleBatch[] {
  const batches: FactoryScheduleBatch[] = [];
  let index = 0;

  while (index < plan.phases.length) {
    const phase = plan.phases[index];
    if (phase.concurrency === 'serial' || phase.gates.length > 0) {
      batches.push(batchFor(batches.length, phase.concurrency, [phase]));
      index += 1;
      continue;
    }

    const group: PlannedPhase[] = [];
    while (index < plan.phases.length) {
      const candidate = plan.phases[index];
      if (candidate.concurrency !== phase.concurrency || candidate.gates.length > 0) break;
      group.push(candidate);
      index += 1;
    }

    if (phase.concurrency === 'isolated-worktree') {
      const width = Math.max(1, plan.policy.maxParallelWriteTimelines);
      for (let start = 0; start < group.length; start += width) {
        batches.push(batchFor(batches.length, phase.concurrency, group.slice(start, start + width)));
      }
    } else {
      batches.push(batchFor(batches.length, phase.concurrency, group));
    }
  }

  return batches;
}

export function schedulerCapabilitiesFor(concurrency: PhaseConcurrency): readonly string[] {
  if (concurrency === 'parallel-readonly') return ['subagent-session'];
  if (concurrency === 'isolated-worktree') return ['subagent-session', 'worktree'];
  return [];
}

function batchFor(index: number, concurrency: PhaseConcurrency, phases: readonly PlannedPhase[]): FactoryScheduleBatch {
  return {
    id: `batch-${index + 1}`,
    concurrency,
    phases,
  };
}
