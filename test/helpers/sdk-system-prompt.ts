/**
 * The system prompt every Agent SDK caller hands to Claude Code.
 *
 * Without `systemPrompt`, the SDK runs a bare stub instead of Claude Code's
 * own prompt, and the stub drops the "run /skill via Skill" line, so a skill
 * arm never learns how to load its skill. Callers pass the Claude Code preset,
 * or name why they don't: docs/TESTING_INTERNALS.md#agent-sdk-system-prompt.
 * test/sdk-system-prompt-tripwire.test.ts holds every caller to this.
 */

export const CLAUDE_CODE_PRESET = { type: 'preset', preset: 'claude_code' } as const;

export type SystemPromptOption =
  | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }
  | { type: 'sdk-default'; reason: string }
  | { type: 'custom'; text: string; reason: string };

type SdkSystemPrompt = string | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean };

/** The SDK options a caller's choice becomes; throws on a bare, unnamed or unknown prompt. */
export function sdkSystemPrompt(option: SystemPromptOption): { systemPrompt?: SdkSystemPrompt } {
  const fix = 'pass CLAUDE_CODE_PRESET, or { type: "sdk-default" | "custom", reason } naming why not (docs/TESTING_INTERNALS.md#agent-sdk-system-prompt)';
  const o = option as unknown;
  if (!o || typeof o !== 'object') throw new Error(`systemPrompt must be an object, got ${JSON.stringify(o)}: ${fix}`);
  const p = o as Record<string, unknown>;
  if (p.type === 'preset' && p.preset === 'claude_code') return { systemPrompt: option as SdkSystemPrompt };
  if (p.type !== 'sdk-default' && p.type !== 'custom') throw new Error(`unknown systemPrompt ${JSON.stringify(o)}: ${fix}`);
  if (typeof p.reason !== 'string' || !p.reason.trim()) throw new Error(`systemPrompt type "${p.type}" needs a non-empty reason: ${fix}`);
  if (p.type === 'sdk-default') return {};
  if (typeof p.text !== 'string' || !p.text) throw new Error(`systemPrompt type "custom" needs its text: ${fix}`);
  return { systemPrompt: p.text };
}
