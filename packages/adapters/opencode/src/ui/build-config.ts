import type { CreateConfigValues } from '@paperclipai/adapter-utils';

export function buildOpenCodeConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.cwd) {
    ac.cwd = v.cwd;
  }
  if (v.model) {
    ac.model = v.model;
  }
  if (v.timeoutSec !== undefined) {
    ac.timeoutSec = v.timeoutSec;
  }
  if (v.graceSec !== undefined) {
    ac.graceSec = v.graceSec;
  }
  if (v.sessionHistoryLimit !== undefined) {
    ac.sessionHistoryLimit = v.sessionHistoryLimit;
  }

  // Set default values for any missing optional fields
  // (Though we are handling them above, we can also set defaults here if needed)
  // For example, if we want to ensure timeoutSec is always set:
  if (ac.timeoutSec === undefined) {
    ac.timeoutSec = 120;
  }
  if (ac.graceSec === undefined) {
    ac.graceSec = 15;
  }
  if (ac.sessionHistoryLimit === undefined) {
    ac.sessionHistoryLimit = 10;
  }

  return ac;
}