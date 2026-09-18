/** Measurements for the overlay experiment. SDK events are fragments, not turns. */
import type { AgentSdkResult } from './agent-sdk-runner';

/**
 * Count distinct tool calls in the first complete assistant message. Thinking,
 * text, and tool blocks can arrive in separate events with interleaved results.
 * This measures message batching; it does not establish execution concurrency.
 */
export function firstAssistantMessageToolCount(result: AgentSdkResult): number {
  if (!result.assistantTurns.length) return 0;
  const init = result.events.find(event => event.type === 'system' && event.subtype === 'init');
  const sessionId = init?.session_id;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('SDK init has no session_id');
  // The runner retains child and parent events. Only this session's parent
  // message can establish the first response or contribute its fragments.
  const owned = (event: AgentSdkResult['assistantTurns'][number]) =>
    event.session_id === sessionId && event.parent_tool_use_id === null && event.message?.role === 'assistant';
  const first = result.assistantTurns.find(owned);
  if (!first) return 0;
  const firstId = first.message?.id;
  if (!firstId) throw new Error('first assistant event has no message.id');
  const calls = new Set<string>();
  for (const event of result.assistantTurns) {
    if (!owned(event) || event.message?.id !== firstId) continue;
    for (const block of event.message.content) {
      if (block.type !== 'tool_use') continue;
      if (!block.id) throw new Error('first-message tool call has no id');
      calls.add(block.id);
    }
  }
  return calls.size;
}

/** Authoritative reported reasoning tokens, never inferred from lookup count. */
export function reportedThinkingTokens(result: AgentSdkResult): number {
  const terminal = result.events.findLast((event) => event.type === 'result');
  const usage = (terminal as { usage?: { output_tokens_details?: { thinking_tokens?: number } } } | undefined)?.usage;
  const count = usage?.output_tokens_details?.thinking_tokens;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new Error('terminal result is missing valid usage.output_tokens_details.thinking_tokens');
  }
  return count;
}

export type ComparisonStatus =
  | 'improved'
  | 'baseline_saturated'
  | 'no_measured_improvement'
  | 'regressed'
  | 'unsupported_hypothesis'
  | 'incomplete';

export interface ComparisonSpec {
  direction: 'higher_is_better' | 'lower_is_better';
  minimum: number;
  maximum?: number;
  /** An absent nudge cannot support an efficacy claim even when numbers differ. */
  unsupportedHypothesis?: string;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function assessComparison(
  arms: { overlay: number[]; off: number[] },
  expectedTrials: number,
  spec: ComparisonSpec,
  criterion: (arms: { overlay: number[]; off: number[] }) => boolean,
): { status: ComparisonStatus; criterionMet: boolean; meanOn: number; meanOff: number; explanation?: string } {
  const meanOn = mean(arms.overlay);
  const meanOff = mean(arms.off);
  const base = { meanOn, meanOff };
  if ([arms.overlay, arms.off].some((values) => values.length !== expectedTrials || values.some((n) => !Number.isFinite(n) || n < spec.minimum || (spec.maximum !== undefined && n > spec.maximum)))) {
    return { ...base, status: 'incomplete', criterionMet: false };
  }
  const criterionMet = criterion(arms);
  if (spec.unsupportedHypothesis) {
    return { ...base, status: 'unsupported_hypothesis', criterionMet: false, explanation: spec.unsupportedHypothesis };
  }
  const regression = spec.direction === 'higher_is_better' ? meanOn < meanOff : meanOn > meanOff;
  if (regression) return { ...base, status: 'regressed', criterionMet: false };
  const optimum = spec.direction === 'higher_is_better' ? spec.maximum : spec.minimum;
  if (optimum !== undefined && arms.off.every((n) => n === optimum)) {
    return { ...base, status: 'baseline_saturated', criterionMet: false };
  }
  return { ...base, status: criterionMet ? 'improved' : 'no_measured_improvement', criterionMet };
}

/** A native success event is necessary but not sufficient for correctness. */
export function assertSuccessfulExecution(result: AgentSdkResult): void {
  if (result.exitReason !== 'success') throw new Error(`SDK execution failed: ${result.exitReason}`);
  const terminals = result.events.filter((event) => event.type === 'result');
  if (terminals.length !== 1 || (terminals[0] as { subtype?: string }).subtype !== 'success' ||
    (terminals[0] as { is_error?: boolean }).is_error === true) {
    throw new Error('expected exactly one successful SDK terminal result');
  }
  if (!result.output.trim()) throw new Error('SDK execution returned no assistant answer');
}

/** Collision-free across Bun retries; the process/run directory owns uniqueness. */
export function trialArtifactStem(fixtureId: string, attempt: number, arm: 'overlay-on' | 'overlay-off', trial: number): string {
  if (!/^[a-z0-9-]+$/.test(fixtureId) || !Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(trial) || trial < 0) {
    throw new Error('invalid overlay artifact identity');
  }
  return `${fixtureId}-attempt-${attempt}-${arm}-${trial}`;
}
