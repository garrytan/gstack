#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * codex-destructive-guard-hook — /careful's destructive-command check as a Codex PreToolUse hook (matcher Bash),
 * GST-3172. The decision is check-careful.sh's, through the Claude Code hook's carefulDecision, mapped onto what
 * Codex accepts:
 *
 *   deny -> deny, its reason unchanged.
 *   ask  -> Codex 0.170 has no ask (its output parser rejects permissionDecision "ask" and runs the command), so:
 *           in a session gstack-session-kind calls interactive, a deny whose reason tells the model to stop and
 *           ask the user, who can run the command themselves with `!` (Codex runs `!` commands without hooks);
 *           in any other session (codex exec, CI, unattended), a systemMessage warning and no decision, the same
 *           as Claude Code with nobody to answer.
 *
 * Every ask category check-careful.sh has, or adds later, takes the same path: nothing here names one.
 * Codex starts hooks without CODEX_THREAD_ID, which gstack-session-kind needs to find a `codex exec` parent, so the
 * payload's session_id stands in for it. Always exits 0; with the switch off it prints nothing.
 * Docs: docs/skill-routing-and-contracts.md#codex.
 */
import { ASK_NOTE, carefulDecision } from '../../claude/hooks/destructive-guard-hook.ts';
import { sessionKind } from '../../claude/hooks/spawn-bin';

export const CODEX_ASK_NOTE = 'Codex hooks cannot ask, so gstack blocked this command: stop and ask the user whether to run it. '
  + 'If they want it, they can run it themselves by typing ! followed by the command in Codex, '
  + 'or turn this check off with gstack-config set destructive_guard off.';

type CodexOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } } | { systemMessage: string };

/** What Codex gets for check-careful.sh's answer in a session of this kind; null prints nothing. */
export function codexDecision(careful: ReturnType<typeof carefulDecision>, kind: string): CodexOutput | null {
  if (!careful || 'raw' in careful) return null;
  const o = careful.decision.hookSpecificOutput;
  const reason = (o?.permissionDecisionReason ?? '').trim();
  const deny = (why: string): CodexOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
  if (o?.permissionDecision === 'deny') return deny(reason || '[careful] Blocked a destructive command.');
  if (o?.permissionDecision !== 'ask') return null;
  if (kind && kind !== 'interactive') {
    return { systemMessage: `${reason} ${ASK_NOTE} Allowed without asking: this ${kind} session has nobody to answer.`.trim() };
  }
  return deny(`${reason} ${CODEX_ASK_NOTE}`.trim());
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8');
  const careful = carefulDecision(input);
  if (!careful || 'raw' in careful) return;
  if (careful.decision.hookSpecificOutput?.permissionDecision === 'ask' && !process.env.CODEX_THREAD_ID) {
    try {
      const id = JSON.parse(input).session_id;
      if (typeof id === 'string' && id) process.env.CODEX_THREAD_ID = id;
    } catch { /* check-careful.sh already read the payload; no id means no exec signal */ }
  }
  const kind = careful.decision.hookSpecificOutput?.permissionDecision === 'ask' ? sessionKind(2000) : '';
  const out = codexDecision(careful, kind);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

if (import.meta.main) {
  main().catch(() => {}).finally(() => process.exit(0));
}
