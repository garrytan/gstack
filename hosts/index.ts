/**
 * Host config registry.
 *
 * Import all host configs and derive the Host union type.
 * Adding a new host: create hosts/myhost.ts, import here, add to ALL_HOST_CONFIGS.
 */

import type { HostConfig } from '../scripts/host-config';
import claude from './claude';
import codex from './codex';
import factory from './factory';
import kiro from './kiro';
import opencode from './opencode';
import slate from './slate';
import cursor from './cursor';
import openclaw from './openclaw';
import hermes from './hermes';
import gbrain from './gbrain';

/** All registered host configs. Add new hosts here. */
export const ALL_HOST_CONFIGS: HostConfig[] = [claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain];

/** Map from host name to config. */
export const HOST_CONFIG_MAP: Record<string, HostConfig> = Object.fromEntries(
  ALL_HOST_CONFIGS.map(c => [c.name, c])
);

/** Union type of all host names, derived from configs. */
export type Host = (typeof ALL_HOST_CONFIGS)[number]['name'];

/** All host names as a string array (for CLI arg validation, etc.). */
export const ALL_HOST_NAMES: string[] = ALL_HOST_CONFIGS.map(c => c.name);

/** Get a host config by name. Throws if not found. */
export function getHostConfig(name: string): HostConfig {
  const config = HOST_CONFIG_MAP[name];
  if (!config) {
    throw new Error(`Unknown host '${name}'. Valid hosts: ${ALL_HOST_NAMES.join(', ')}`);
  }
  return config;
}

/**
 * Resolve a host name from a CLI argument, handling aliases.
 * e.g., 'agents' → 'codex', 'droid' → 'factory'
 */
export function resolveHostArg(arg: string): string {
  // Direct name match
  if (HOST_CONFIG_MAP[arg]) return arg;

  // Alias match
  for (const config of ALL_HOST_CONFIGS) {
    if (config.cliAliases?.includes(arg)) return config.name;
  }

  throw new Error(`Unknown host '${arg}'. Valid hosts: ${ALL_HOST_NAMES.join(', ')}`);
}

/**
 * Get hosts that are NOT the primary host (Claude).
 * These are the hosts that need generated skill docs.
 */
export function getExternalHosts(): HostConfig[] {
  return ALL_HOST_CONFIGS.filter(c => c.name !== 'claude');
}

// Re-export individual configs for direct import
export { claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain };
