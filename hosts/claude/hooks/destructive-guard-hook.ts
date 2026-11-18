#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * destructive-guard-hook — PreToolUse hook (Bash, PowerShell) that runs /careful's destructive-command check in every
 * Claude Code session, so the check fires without the model loading /careful. On unless destructive_guard is off (env
 * GSTACK_DESTRUCTIVE_GUARD, then config destructive_guard, then SWITCH_DEFAULT).
 *
 *   switch on? -> careful/bin/check-careful.sh with the hook payload on stdin -> its decision, unchanged
 *
 * CONTRACT
 *   - The decision is check-careful.sh's: "ask" for the destructive families, "deny" for the two catastrophic shapes,
 *     nothing for the rest. An "ask" reason, which the person reads, also names this hook and its off switch; a
 *     "deny" reason, which the model reads, does not.
 *   - Always exits 0. With the switch off it prints nothing.
 * Docs: docs/skill-routing-and-contracts.md#destructive-command-check.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { readSkillSwitch } from '../../../lib/skill-route';

export const ASK_NOTE = "(gstack's destructive-command check, on in every session; off: gstack-config set destructive_guard off)";
const CHECK = path.join(import.meta.dir, '..', '..', '..', 'careful', 'bin', 'check-careful.sh');

function main(): void {
  if (!readSkillSwitch('destructive_guard').on) return;
  const r = spawnSync('bash', [CHECK], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', timeout: 8000 });
  const out = (r.stdout ?? '').trim();
  if (!out) return;
  let decision: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  try { decision = JSON.parse(out); } catch { process.stdout.write(out + '\n'); return; }
  const o = decision.hookSpecificOutput;
  if (o?.permissionDecision === 'ask') o.permissionDecisionReason = `${o.permissionDecisionReason ?? ''} ${ASK_NOTE}`.trim();
  process.stdout.write(JSON.stringify(decision) + '\n');
}

if (import.meta.main) {
  main();
  process.exit(0);
}
