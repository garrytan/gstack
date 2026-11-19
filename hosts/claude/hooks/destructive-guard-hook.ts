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
 *   - With nobody to answer an ask (claude -p, which Claude Code marks CLAUDE_CODE_ENTRYPOINT=sdk-cli, or a session
 *     gstack-session-kind calls headless, unattended or spawned), an "ask" becomes a warning (systemMessage) and no
 *     decision, so the command runs as it would with no guard loaded. A "deny" stays a deny.
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

export type CarefulDecision = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

/**
 * check-careful.sh's answer to the hook payload (input, else this process's stdin): its JSON, its raw text when that is
 * not JSON, or null when the switch is off or it printed nothing. Shared with the Codex wrapper (hosts/codex/hooks).
 */
export function carefulDecision(input?: string): { decision: CarefulDecision } | { raw: string } | null {
  if (!readSkillSwitch('destructive_guard').on) return null;
  const r = runScriptSync(CHECK, [], { stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'], input, encoding: 'utf8', timeout: 8000 }, {
    resolve: () => resolveWindowsBashCached(path.join(resolveStateRoot(), 'cache', 'windows-bash.json')),
  });
  const out = (r.stdout ?? '').trim();
  if (!out) return null;
  try { return { decision: JSON.parse(out) }; } catch { return { raw: out }; }
}

function main(): void {
  const careful = carefulDecision();
  if (!careful) return;
  if ('raw' in careful) { process.stdout.write(careful.raw + '\n'); return; }
  const decision = careful.decision;
  const o = decision.hookSpecificOutput;
  if (o?.permissionDecision === 'ask') {
    const reason = `${o.permissionDecisionReason ?? ''} ${ASK_NOTE}`.trim();
    const kind = process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli' ? 'headless' : sessionKind(2000);
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
