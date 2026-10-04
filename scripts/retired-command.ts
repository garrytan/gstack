#!/usr/bin/env bun
/**
 * One-release stubs for retired package scripts. Each retired name in
 * package.json runs `bun run scripts/retired-command.ts <name>`, which prints
 * the replacement and exits 1, so an old command in an agent's memory or a
 * stale doc fails loudly instead of running zero cases or the wrong lane.
 *
 * CONTRIBUTING.md "Retired commands" carries the same table. TODOS.md
 * "Remove one-release command stubs" deletes this file and the stub entries
 * in the next release.
 */

export interface RetiredCommand {
  replacement: string;
  reason: string;
}

export const RETIRED_COMMANDS: Record<string, RetiredCommand> = {
  'test:evals': { replacement: 'bun run eval:bg:pr', reason: 'tierless run skipped every tier-gated paid file' },
  'test:evals:all': { replacement: 'bun run eval:bg:release', reason: 'tierless run skipped every tier-gated paid file' },
  'test:e2e': { replacement: 'bun run eval:bg:pr', reason: 'tierless run skipped every tier-gated paid file' },
  'test:e2e:all': { replacement: 'bun run eval:bg:release', reason: 'tierless run skipped every tier-gated paid file' },
  'test:gate': { replacement: 'bun run test:gate:sharded', reason: 'the single-process fan-out never completed a run' },
  'test:periodic': { replacement: 'bun run test:periodic:sharded', reason: 'the single-process fan-out never completed a run' },
  'test:codex': { replacement: 'bun run test:periodic:sharded', reason: 'it set no EVALS_TIER, so both periodic-tier Codex files ran zero cases' },
  'test:codex:all': { replacement: 'bun run test:periodic:sharded', reason: 'it set no EVALS_TIER, so both periodic-tier Codex files ran zero cases' },
  'eval:bg': { replacement: 'bun run eval:bg:pr', reason: 'it detached the retired tierless test:evals' },
  'eval:bg:all': { replacement: 'bun run eval:bg:release', reason: 'it detached the retired tierless test:evals:all' },
  'eval:flake-rank': { replacement: 'bun run eval:pass-rates', reason: 'it was a second name for the same script' },
  'eval:watch': { replacement: 'tail the gstack-detach log under ~/.gstack-dev/eval-runs/, or `gh run watch <run-id>` for a CI run', reason: 'it read a file only the unsharded runner wrote, so it showed nothing for sharded runs' },
  'test:audit': { replacement: 'bun run test', reason: 'test/audit-compliance.test.ts already runs in the free suite' },
};

export function retiredMessage(name: string): string | null {
  const entry = RETIRED_COMMANDS[name];
  if (!entry) return null;
  return `\`bun run ${name}\` is retired (${entry.reason}).\nUse instead: ${entry.replacement}\nSee CONTRIBUTING.md "Retired commands" for the full table.`;
}

if (import.meta.main) {
  const name = process.argv[2] ?? '';
  const message = retiredMessage(name);
  if (!message) {
    console.error(`retired-command: unknown name "${name}". Known: ${Object.keys(RETIRED_COMMANDS).join(', ')}`);
    process.exit(2);
  }
  console.error(message);
  process.exit(1);
}
