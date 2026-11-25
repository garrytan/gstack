/**
 * state-root — the one owner of where gstack keeps its state (TS twin of
 * bin/gstack-state-root.sh; test/state-root-parity.test.ts keeps them equal).
 * Add a caller: `join(resolveStateRoot(), 'analytics')` instead of joining
 * homedir() with '.gstack'; read a config key with `readConfigKey('telemetry')`.
 * Chain: GSTACK_STATE_ROOT → GSTACK_HOME → GSTACK_STATE_DIR → CLAUDE_PLUGIN_DATA
 * (only when CLAUDE_PLUGIN_ROOT contains "gstack") → $HOME/.gstack → .gstack.
 * Enforced by test/state-root-ratchet.test.ts. Replaces the hand-rolled chains
 * formerly in browse/src/config.ts and the removed /cso helper. Docs: docs/state-root.md.
 */
import * as fs from 'node:fs';

export type StateRootEnv = Record<string, string | undefined>;

export const STATE_ROOT_VARS = ['GSTACK_STATE_ROOT', 'GSTACK_HOME', 'GSTACK_STATE_DIR'] as const;

function userHome(env: StateRootEnv, platform: NodeJS.Platform): string {
  return env.HOME || (platform === 'win32' ? env.USERPROFILE || '' : '');
}

/** The raw chain value. Pure: never prints, never touches the filesystem. */
export function resolveStateRoot(env: StateRootEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  for (const name of STATE_ROOT_VARS) {
    if (env[name]) return env[name] as string;
  }
  if (env.CLAUDE_PLUGIN_DATA && (env.CLAUDE_PLUGIN_ROOT || '').toLowerCase().includes('gstack')) return env.CLAUDE_PLUGIN_DATA;
  const home = userHome(env, platform);
  return home ? `${home}/.gstack` : '.gstack';
}

/**
 * The default root a merged privacy key is also read from. Tests point
 * GSTACK_TEST_LEGACY_ROOT at an empty dir (test-setup.ts) so a developer's
 * real ~/.gstack never leaks into a run.
 */
function legacyStateRoot(env: StateRootEnv, platform: NodeJS.Platform): string | null {
  if (env.GSTACK_TEST_LEGACY_ROOT) return env.GSTACK_TEST_LEGACY_ROOT;
  const home = userHome(env, platform);
  return home ? `${home}/.gstack` : null;
}

/** Roots merged privacy settings are read from: the resolved root, then $HOME/.gstack when different. */
export function mergedStateRoots(env: StateRootEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const resolved = resolveStateRoot(env, platform);
  const legacy = legacyStateRoot(env, platform);
  return legacy && legacy !== resolved ? [resolved, legacy] : [resolved];
}

/** Privacy and egress opt-outs: most restrictive first. Read from every candidate root. */
export const MERGED_CONFIG_KEYS: Record<string, readonly string[]> = {
  telemetry: ['off', 'anonymous', 'community'],
  memorable_recall: ['off', 'on'],
  codex_reviews: ['disabled', 'enabled'],
  update_check: ['false', 'true'],
};

/** Same parse as `gstack-config get`: last `^key:` line wins, value trimmed, empty = unset. */
export function readKeyFromRoot(root: string, key: string): string | null {
  let yaml: string;
  try {
    yaml = fs.readFileSync(`${root}/config.yaml`, 'utf-8');
  } catch {
    return null;
  }
  let value: string | null = null;
  for (const line of yaml.split('\n')) {
    if (line.startsWith(`${key}:`)) value = line.slice(key.length + 1).trim();
  }
  return value ? value : null;
}

export interface ConfigKeyReading {
  value: string | null;
  /** Root whose config.yaml supplied the value (null when no root sets it). */
  root: string | null;
}

/**
 * Read one config key. Merged keys (MERGED_CONFIG_KEYS) take the most
 * restrictive value across the resolved root and $HOME/.gstack; an
 * unrecognized value ranks as most restrictive. Every other key reads the
 * resolved root only.
 */
export function readConfigKeyWithRoot(key: string, env: StateRootEnv = process.env, platform: NodeJS.Platform = process.platform): ConfigKeyReading {
  const order = MERGED_CONFIG_KEYS[key];
  const candidates = order ? mergedStateRoots(env, platform) : [resolveStateRoot(env, platform)];
  let best: ConfigKeyReading = { value: null, root: null };
  let bestRank = Infinity;
  for (const root of candidates) {
    const value = readKeyFromRoot(root, key);
    if (value === null) continue;
    const rank = order ? order.indexOf(value) : 0;
    if (rank < bestRank) {
      best = { value, root };
      bestRank = rank;
    }
  }
  return best;
}

export function readConfigKey(key: string, env: StateRootEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  return readConfigKeyWithRoot(key, env, platform).value;
}
