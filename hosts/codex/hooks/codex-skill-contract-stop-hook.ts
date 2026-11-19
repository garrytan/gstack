#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * codex-skill-contract-stop-hook — the skill-contract Stop hook on Codex (GST-3173). It is Claude Code's hook
 * (hosts/claude/hooks/skill-contract-stop-hook.ts) unchanged: Codex sends the same stop_hook_active and
 * last_assistant_message keys and takes the same block answer, and lib/skill-contract.ts reads Codex's rollout file,
 * which it tells from a Claude Code transcript by content. Same switch (skill_contracts), deadline, records and log.
 * Docs: docs/skill-routing-and-contracts.md#codex.
 */
import '../../claude/hooks/skill-contract-stop-hook.ts';
