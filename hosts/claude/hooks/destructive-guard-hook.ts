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
 *   - With nobody to answer an ask, an "ask" becomes a warning (systemMessage) and no decision, so the command runs as
 *     it would with no guard loaded. A "deny" stays a deny. Nobody answers in claude -p (CLAUDE_CODE_ENTRYPOINT=sdk-cli),
 *     in an Agent SDK session (sdk-py, sdk-ts), where an ask with no permission callback is denied outright (checked
 *     with a real SDK run, GST-3169), or in a session gstack-session-kind calls headless, unattended or spawned. An SDK
 *     host with a person answering says so with CONDUCTOR_* (Conductor) or GSTACK_SESSION_KIND=interactive.
 *   - Always exits 0. With the switch off it prints nothing.
 * Docs: docs/skill-routing-and-contracts.md#destructive-command-check.
 */
import * as path from 'path';
import { resolveWindowsBashCached, runScriptSync } from '../../../lib/script-invocation';
import { readSkillSwitch } from '../../../lib/skill-route';
import { resolveStateRoot } from '../../../lib/state-root';
import { sessionKind } from './spawn-bin';

export const ASK_NOTE = "(gstack's destructive-command check, on in every session; off: gstack-config set destructive_guard off)";
const CHECK = path.join(import.meta.dir, '..', '..', '..', 'careful', 'bin', 'check-careful.sh');

function main(): void {
  if (!readSkillSwitch('destructive_guard').on) return;
  const r = runScriptSync(CHECK, [], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', timeout: 8000 }, {
    resolve: () => resolveWindowsBashCached(path.join(resolveStateRoot(), 'cache', 'windows-bash.json')),
  });
  const out = (r.stdout ?? '').trim();
  if (!out) return;
  let decision: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  try { decision = JSON.parse(out); } catch { process.stdout.write(out + '\n'); return; }
  const o = decision.hookSpecificOutput;
  if (o?.permissionDecision === 'ask') {
    const reason = `${o.permissionDecisionReason ?? ''} ${ASK_NOTE}`.trim();
    const ep = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
    const sdkHostAnswers = !!(process.env.CONDUCTOR_WORKSPACE_PATH || process.env.CONDUCTOR_PORT) || process.env.GSTACK_SESSION_KIND === 'interactive';
    const kind = ep === 'sdk-cli' || (ep.startsWith('sdk-') && !sdkHostAnswers) ? 'headless' : sessionKind(2000);
    if (kind && kind !== 'interactive') {
      process.stdout.write(JSON.stringify({ systemMessage: `${reason} Allowed without asking: this ${kind} session has nobody to answer.` }) + '\n');
      return;
    }
    o.permissionDecisionReason = reason;
  }
  process.stdout.write(JSON.stringify(decision) + '\n');
}

if (import.meta.main) {
  main();
  process.exit(0);
}
