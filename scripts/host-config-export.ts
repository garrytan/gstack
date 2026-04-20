#!/usr/bin/env bun
/**
 * Export host configs as shell-safe values for consumption by the bash setup script.
 *
 * Usage: bun run scripts/host-config-export.ts <command> [args]
 *
 * Commands:
 *   list                    Print all host names, one per line
 *   get <host> <field>      Print a single config field value
 *   detect                  Print names of hosts whose CLI binary is on PATH
 *   validate                Validate all configs, exit 1 on error
 *
 * All output is shell-safe (single-quoted values, no eval needed).
 */

import { ALL_HOST_CONFIGS, getHostConfig, ALL_HOST_NAMES } from '../hosts/index';
import { validateAllConfigs } from './host-config';
import { execSync } from 'child_process';

const CLI_REGEX = /^[a-z][a-z0-9_-]*$/;
const PATH_REGEX = /^[a-zA-Z0-9_.\/${}~-]+$/;

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function validateValue(val: string, context: string): void {
  if (!PATH_REGEX.test(val) && !CLI_REGEX.test(val)) {
    throw new Error(`Unsafe value for ${context}: ${val}`);
  }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'list':
    for (const name of ALL_HOST_NAMES) {
      console.log(name);
    }
    break;

  case 'get': {
    const [hostName, field] = args;
    if (!hostName || !field) {
      console.error('Usage: host-config-export.ts get <host> <field>');
      process.exit(1);
    }
    const config = getHostConfig(hostName);
    const value = (config as any)[field];
    if (value === undefined) {
      console.error(`Unknown field: ${field}`);
      process.exit(1);
    }
    if (typeof value === 'string') {
      console.log(value);
    } else if (typeof value === 'boolean') {
      console.log(value ? '1' : '0');
    } else if (Array.isArray(value)) {
      for (const item of value) {
        console.log(typeof item === 'string' ? item : JSON.stringify(item));
      }
    } else {
      console.log(JSON.stringify(value));
    }
    break;
  }

  case 'detect': {
    for (const config of ALL_HOST_CONFIGS) {
      const commands = [config.cliCommand, ...(config.cliAliases || [])];
      for (const cmd of commands) {
        try {
          execSync(`command -v ${shellEscape(cmd)}`, { stdio: 'pipe' });
          console.log(config.name);
          break;  // Found this host, move to next
        } catch {
          // Binary not found, try next alias
        }
      }
    }
    break;
  }

  case 'validate': {
    const errors = validateAllConfigs(ALL_HOST_CONFIGS);
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`ERROR: ${error}`);
      }
      process.exit(1);
    }
    console.log(`All ${ALL_HOST_CONFIGS.length} configs valid`);
    break;
  }

  case 'symlinks': {
    const [hostName] = args;
    if (!hostName) {
      console.error('Usage: host-config-export.ts symlinks <host>');
      process.exit(1);
    }
    const config = getHostConfig(hostName);
    for (const link of config.runtimeRoot.globalSymlinks) {
      console.log(link);
    }
    if (config.runtimeRoot.globalFiles) {
      for (const [dir, files] of Object.entries(config.runtimeRoot.globalFiles)) {
        for (const file of files) {
          console.log(`${dir}/${file}`);
        }
      }
    }
    break;
  }

  default:
    console.error('Usage: host-config-export.ts <list|get|detect|validate|symlinks> [args]');
    process.exit(1);
}
