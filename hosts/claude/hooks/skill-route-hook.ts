#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * skill-route-hook — UserPromptSubmit hook (Claude Code, and Codex through hosts/codex/hooks) that names the skill a prompt fits,
 * or the two that fit best (GST-1088, lane A; installed skills, GST-3123). On unless skill_routing is off (env
 * GSTACK_SKILL_ROUTING, then config skill_routing, then SWITCH_DEFAULT).
 *
 *   stdin (<= 256 KiB, 500 ms) -> switch on? -> JSON object with a prompt?
 *     -> not a /command -> score its head and tail windows against installed triggers
 *     -> at or above ROUTE_THRESHOLD: one additionalContext line naming up to MAX_ROUTES skills -> exit 0
 *
 * CONTRACT
 *   - Always exits 0 and never exits 2: it can never block a prompt. Any error
 *     prints nothing at all, not even on stderr.
 *   - Deterministic: it reads the installed SKILL.md frontmatter (lib/skill-route.ts);
 *     no model call, no network.
 *   - An internal deadline (DEADLINE_MS) stays well under the registered 5 s timeout.
 *   - Every decision and failure is one line in $GSTACK_STATE_ROOT/hooks/skill-route.log
 *     (never the prompt text), with a per-session failure counter.
 * Docs: docs/skill-routing-and-contracts.md.
 */
import * as fs from 'fs';
import {
  appendHookTrace, codexSkillsDir, firstStep, hintLine, hintVariant, hookHost, installedSkillsDir, readSkillSwitch, readStdinBounded,
  routePrompt, scanCodexSkills, scanInstalledSkills, type HookHost, type RouteCandidate,
} from '../../../lib/skill-route';
import { itemSummary, parseContract } from '../../../lib/skill-contract';

export const DEADLINE_MS = 1500;
const STDIN_CAP_BYTES = 256 * 1024;
const STDIN_DEADLINE_MS = 500;
const SKILL_BODY_MAX_BYTES = 512 * 1024;

let sessionId = '';
const trace = (fields: Record<string, string | number | boolean>, failed = false) => appendHookTrace('skill-route', sessionId, fields, failed);

/** The pilot's first-step or contract text, for gstack's own skills only: another skill's text is never quoted (GST-3142). */
function variantExtra(route: RouteCandidate, frontmatter: string): string {
  const variant = hintVariant();
  if (!route.gstack) return '';
  if (variant === 'step') {
    const fd = fs.openSync(route.file, 'r');
    try {
      const buf = Buffer.alloc(SKILL_BODY_MAX_BYTES);
      const step = firstStep(buf.subarray(0, fs.readSync(fd, buf, 0, SKILL_BODY_MAX_BYTES, 0)).toString('utf8'));
      return step ? `Its first step: ${step}` : '';
    } finally {
      fs.closeSync(fd);
    }
  }
  if (variant === 'contract') {
    const parsed = parseContract(frontmatter);
    return parsed && 'contract' in parsed ? `Done means: ${parsed.contract.items.map(itemSummary).join('; ')}.` : '';
  }
  return '';
}

async function main(host: HookHost): Promise<void> {
  setTimeout(() => { trace({ event: 'deadline', ms: DEADLINE_MS }, true); process.exit(0); }, DEADLINE_MS);
  const sw = readSkillSwitch('skill_routing');
  if (!sw.on) {
    if (sw.invalid !== undefined) trace({ event: 'switch-invalid', source: sw.source }, true);
    return;
  }
  const stdin = await readStdinBounded(STDIN_CAP_BYTES, STDIN_DEADLINE_MS);
  if (stdin.overCap) return trace({ event: 'stdin-over-cap', cap: STDIN_CAP_BYTES }, true);
  let payload: unknown;
  try { payload = JSON.parse(stdin.text); } catch { return trace({ event: 'bad-json' }, true); }
  if (typeof payload !== 'object' || payload === null) return trace({ event: 'bad-json' }, true);
  const p = payload as Record<string, unknown>;
  sessionId = typeof p.session_id === 'string' ? p.session_id : '';
  if (typeof p.prompt !== 'string') return trace({ event: 'no-prompt' }, true);
  const hostField: Record<string, string> = host === 'codex' ? { host } : {};
  const { skills, problems } = host === 'codex' ? scanCodexSkills(codexSkillsDir()) : scanInstalledSkills(installedSkillsDir());
  if (problems.length) trace({ event: 'skill-problems', problems: problems.join('; '), ...hostField }, true);
  const decision = routePrompt(p.prompt, skills, undefined, host);
  if (!decision.route) {
    const top = decision.candidates[0];
    return trace({ event: 'no-route', reason: decision.reason, chars: p.prompt.length, top: top ? `${top.skill}:${top.score}` : '-', ...hostField });
  }
  const route = decision.route;
  const frontmatter = skills.find(s => s.file === route.file)?.frontmatter ?? '';
  const also = decision.routes[1];
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hintLine(route, variantExtra(route, frontmatter), also, host) } });
  await new Promise<void>(resolve => process.stdout.write(out, () => resolve()));
  trace({
    event: 'routed', skill: route.skill, score: route.score, source: route.gstack ? 'gstack' : route.file, variant: hintVariant(),
    ...(also ? { also: also.skill, also_score: also.score, also_source: also.gstack ? 'gstack' : also.file } : {}), ...hostField,
  });
}

/** Runs the hook for one host and exits 0; the Codex wrapper (hosts/codex/hooks/codex-skill-route-hook.ts) passes codex. */
export function runSkillRouteHook(host: HookHost = hookHost()): void {
  main(host)
    .catch(e => trace({ event: 'error', why: e instanceof Error ? e.message : String(e) }, true))
    .finally(() => process.exit(0));
}

if (import.meta.main) runSkillRouteHook();
