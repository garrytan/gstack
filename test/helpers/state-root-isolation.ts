/**
 * Keeps a test's spawns off the user's real gstack state (GST-1659). The
 * state root comes from a chain (lib/state-root.ts, docs/state-root.md):
 * GSTACK_STATE_ROOT, GSTACK_HOME, GSTACK_STATE_DIR, CLAUDE_PLUGIN_DATA when
 * CLAUDE_PLUGIN_ROOT names gstack, then $HOME/.gstack. test-setup.ts strips
 * two of them, but only when Bun loads this repository's bunfig.toml; a run
 * from another directory or with --config=/dev/null keeps them all.
 * test/state-root-isolation.test.ts runs guarded files with every link of the
 * chain exported to sentinels and fails on any write that reaches one.
 */
import { STATE_ROOT_VARS } from '../../lib/state-root';

/** Every variable the state-root chain reads, CLAUDE_PLUGIN_DATA's gate included. */
export const STATE_CHAIN_VARS = [...STATE_ROOT_VARS, 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'] as const;

/** process.env without the chain and with HOME (USERPROFILE on Windows) at `home`: a spawn on it resolves its state root to home/.gstack. */
export function isolatedEnv(home: string): Record<string, string> {
  const env = { ...process.env, HOME: home, USERPROFILE: home } as Record<string, string>;
  for (const name of STATE_CHAIN_VARS) delete env[name];
  return env;
}
