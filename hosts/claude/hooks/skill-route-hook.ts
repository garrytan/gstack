#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * skill-route-hook — UserPromptSubmit hook that names the gstack skill a prompt
 * fits (GST-1088, lane A). Off unless skill_routing is on (env
 * GSTACK_SKILL_ROUTING, then config skill_routing, then SWITCH_DEFAULT).
 *
 *   stdin (<= 256 KiB, 500 ms) -> switch on? -> JSON object with a prompt?
 *     -> not a /command, not over 8000 chars -> score against installed triggers
 *     -> at or above ROUTE_THRESHOLD: one additionalContext line -> exit 0
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
  appendHookTrace, firstStep, hintLine, hintVariant, installedSkillsDir, readSkillSwitch, readStdinBounded, routePrompt,
  scanInstalledSkills, type RouteCandidate,
} from '../../../lib/skill-route';
import { itemSummary, parseContract } from '../../../lib/skill-contract';

export const DEADLINE_MS = 1500;
const STDIN_CAP_BYTES = 256 * 1024;
const STDIN_DEADLINE_MS = 500;
const SKILL_BODY_MAX_BYTES = 512 * 1024;

let sessionId = '';
const trace = (fields: Record<string, string | number | boolean>, failed = false) => appendHookTrace('skill-route', sessionId, fields, failed);

function variantExtra(route: RouteCandidate, frontmatter: string): string {
  const variant = hintVariant();
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

async function main(): Promise<void> {
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
  const { skills, problems } = scanInstalledSkills(installedSkillsDir());
  if (problems.length) trace({ event: 'skill-problems', problems: problems.join('; ') }, true);
  const decision = routePrompt(p.prompt, skills);
  if (!decision.route) {
    const top = decision.candidates[0];
    return trace({ event: 'no-route', reason: decision.reason, chars: p.prompt.length, top: top ? `${top.skill}:${top.score}` : '-' });
  }
  const route = decision.route;
  const frontmatter = skills.find(s => s.file === route.file)?.frontmatter ?? '';
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hintLine(route, variantExtra(route, frontmatter)) } });
  await new Promise<void>(resolve => process.stdout.write(out, () => resolve()));
  trace({ event: 'routed', skill: route.skill, score: route.score, variant: hintVariant() });
}

main()
  .catch(e => trace({ event: 'error', why: e instanceof Error ? e.message : String(e) }, true))
  .finally(() => process.exit(0));
