/**
 * claude-bin.ts — Cross-platform `claude` binary resolution.
 *
 * Uses Bun.which() for the platform handling (PATH parsing, Windows PATHEXT,
 * X_OK, case-insensitive Path/PATH on Windows). Adds the gstack-specific
 * override + arg-prefix logic on top.
 *
 * Override precedence:
 *   1. GSTACK_CLAUDE_BIN (or CLAUDE_BIN as fallback) — absolute path or
 *      PATH-resolvable command. `wsl` resolves through Bun.which('wsl') just
 *      like a bare `claude` lookup would.
 *   2. Plain `Bun.which('claude')` if no override is set.
 *
 * Arg prefix:
 *   GSTACK_CLAUDE_BIN_ARGS (or CLAUDE_BIN_ARGS) prepends arguments to every
 *   spawn. Accepts a JSON array (e.g. '["claude", "--no-cache"]') or a single
 *   scalar string treated as one argument. Only applied when an override is
 *   active — bare `claude` resolution doesn't pick up an arg prefix.
 *
 * Returns null when nothing resolves; callers should degrade (e.g. transcript
 * classifier returns degraded:true) rather than throw.
 */

import * as path from 'path';

export interface ClaudeCommand {
  command: string;
  argsPrefix: string[];
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

function parseOverrideArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.GSTACK_CLAUDE_BIN_ARGS ?? env.CLAUDE_BIN_ARGS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    // Not JSON — treat as a single scalar argument.
  }
  return [stripWrappingQuotes(raw.trim())];
}

export function resolveClaudeCommand(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCommand | null {
  const argsPrefix = parseOverrideArgs(env);
  const override = (env.GSTACK_CLAUDE_BIN ?? env.CLAUDE_BIN)?.trim();
  // Honor case-insensitive Path/PATH on Windows. Bun.which itself reads
  // process.env so we forward whichever the caller passed.
  const PATH = env.PATH ?? env.Path ?? '';

  if (override) {
    const trimmed = stripWrappingQuotes(override);
    // Absolute path: use as-is. Otherwise PATH-resolve through Bun.which so
    // overrides like GSTACK_CLAUDE_BIN=wsl find the actual binary.
    const resolved = path.isAbsolute(trimmed) ? trimmed : Bun.which(trimmed, { PATH });
    return resolved ? { command: resolved, argsPrefix } : null;
  }

  const command = Bun.which('claude', { PATH });
  return command ? { command, argsPrefix: [] } : null;
}

/** Convenience wrapper for callers that only need the command path. */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveClaudeCommand(env)?.command ?? null;
}
