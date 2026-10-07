/**
 * The comparison autoplan-schema-canary runs on a fresh Claude Code release:
 * each PreToolUse payload against the journal record of the same call, with
 * the guard's own normalization. A free test feeds it an injected strip.
 */
import { isDeepStrictEqual } from 'node:util';
import { AGENT_KEYS, SCHEMA_STRIPPED, nativeToolInput } from '../../autoplan/bin/phase-publication-hook.ts';

export interface HookPayload { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown>; cwd: string }

/** Problems a release would cause the guard; empty means the guard's assumptions still hold. */
export function schemaDrift(payloads: HookPayload[], journalInputs: Map<string, Record<string, unknown>>): string[] {
  const problems: string[] = [];
  for (const tool of ['Agent', 'Read']) if (!payloads.some(p => p.tool_name === tool)) problems.push(`no ${tool} payload was recorded`);
  for (const payload of payloads) {
    const label = `${payload.tool_name} ${payload.tool_use_id}`;
    const journaled = journalInputs.get(payload.tool_use_id);
    if (!journaled) { problems.push(`${label}: no journal record`); continue; }
    const stripped = SCHEMA_STRIPPED[payload.tool_name] ?? [];
    const journalKeys = Object.keys(journaled).filter(key => !stripped.includes(key)).sort();
    const payloadKeys = Object.keys(payload.tool_input).sort();
    if (!isDeepStrictEqual(journalKeys, payloadKeys))
      problems.push(`${label}: payload keys [${payloadKeys}] differ from journal keys [${journalKeys}] beyond documented strips [${stripped}]`);
    if (payload.tool_name === 'Agent') {
      const outside = payloadKeys.filter(key => !AGENT_KEYS.includes(key));
      if (outside.length) problems.push(`${label}: payload keys outside the guard allowlist: ${outside.join(', ')}`);
    }
    if (!isDeepStrictEqual(nativeToolInput(journaled, payload.cwd, payload.tool_name), nativeToolInput(payload.tool_input, payload.cwd, payload.tool_name)))
      problems.push(`${label}: the guard's comparison does not match the payload to its journal record`);
  }
  return problems;
}
