// /auth/mint endpoint handler. Two trust models, kept distinct:
//
// 1. Self-service mint: caller's tailnet identity (from WhoIs) must already
//    be in the allowlist. NEVER auto-allowlists.
// 2. Owner-granted mint: not on /auth/mint at all — that's the CLI
//    `gstack-ios-qa-mint --remote <identity>` writing to the allowlist file.

import { SessionTokenStore } from './session-tokens';
import { hasCapability, loadAllowlist } from './allowlist';
import { writeAttempt } from './audit';
import type { Capability } from './types';
import { capabilityCovers } from './types';

export interface MintRequest {
  capability?: Capability; // requested tier; default 'interact'
  device_udid?: string;
}

export interface MintResponse {
  session_token: string;
  expires_at: number;
  capability: Capability;
}

export interface MintError {
  error: 'identity_not_allowed' | 'capability_insufficient' | 'rate_limited';
}

export async function mintForCaller(opts: {
  callerIdentity: string;
  request: MintRequest;
  tokenStore: SessionTokenStore;
  allowlistPath?: string;
  attemptsPath?: string;
  endpoint?: string;
}): Promise<MintResponse | MintError> {
  const allowlist = await loadAllowlist(opts.allowlistPath);
  const wantedCap: Capability = opts.request.capability ?? 'interact';

  // Must be in the allowlist.
  if (!hasCapability(allowlist, opts.callerIdentity, 'observe')) {
    await writeAttempt({
      rawIdentity: opts.callerIdentity,
      endpoint: opts.endpoint ?? '/auth/mint',
      reason: 'identity_not_allowed',
      path: opts.attemptsPath,
    });
    return { error: 'identity_not_allowed' };
  }

  // Must have at least the requested capability.
  if (!hasCapability(allowlist, opts.callerIdentity, wantedCap)) {
    await writeAttempt({
      rawIdentity: opts.callerIdentity,
      endpoint: opts.endpoint ?? '/auth/mint',
      reason: 'capability_insufficient',
      path: opts.attemptsPath,
    });
    return { error: 'capability_insufficient' };
  }

  // Find the entry to determine the highest tier they can hold.
  const entry = allowlist.entries.find(e => e.identity === opts.callerIdentity);
  // Mint at the requested tier, capped at the highest granted tier.
  const grantedTier = entry?.capabilities.find(c => capabilityCovers(c, wantedCap)) ?? wantedCap;

  const result = opts.tokenStore.mint({
    identity: opts.callerIdentity,
    capability: grantedTier,
    deviceUdid: opts.request.device_udid ?? null,
    origin: 'self_service',
  });

  if ('error' in result) {
    await writeAttempt({
      rawIdentity: opts.callerIdentity,
      endpoint: opts.endpoint ?? '/auth/mint',
      reason: 'rate_limited',
      path: opts.attemptsPath,
    });
    return { error: 'rate_limited' };
  }

  return {
    session_token: result.token,
    expires_at: result.expires_at,
    capability: result.capability,
  };
}
