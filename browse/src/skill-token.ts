/**
 * Skill-token — scoped tokens minted per `$B skill run` invocation.
 *
 * Why this exists:
 *   When `$B skill run <name>` spawns a browser-skill script, the script needs
 *   to call back into the daemon over loopback HTTP. It MUST NOT receive the
 *   daemon root token — a script that gets the root token can call any endpoint
 *   with full authority, defeating the trusted/untrusted distinction.
 *
 *   This module wraps `token-registry.ts` to mint per-spawn session tokens
 *   bound to read+write scope (the 17-cmd browser-driving surface, minus the
 *   `eval`/`js`/admin commands that live in the admin scope). The token's
 *   clientId encodes the skill name and spawn id, so revocation is
 *   deterministic when the script exits or times out.
 *
 * Lifecycle:
 *   spawn start → mintSkillToken() → set GSTACK_SKILL_TOKEN in child env
 *                                  ↓
 *   script makes HTTP calls       /command with Bearer <skill-token>
 *                                  ↓
 *   spawn exit / timeout         → revokeSkillToken() → token invalidated
 *
 * Why scopes = ['read', 'write']:
 *   These map to SCOPE_READ + SCOPE_WRITE in token-registry.ts and cover
 *   navigation, reading, and interaction commands the bulk of skills need.
 *   Excludes admin (eval/js/cookies/storage) deliberately — agent-authored
 *   skills should not get arbitrary JS execution. Phase 2 may add an opt-in
 *   `admin: true` frontmatter flag for cases that genuinely need it, gated
 *   by stronger review at skillify time.
 *
 * Zero side effects on import. Safe to import from tests.
 */

import * as crypto from 'crypto';
import { createToken, revokeToken, type ScopeCategory, type TokenInfo } from './token-registry';

/** Length of TTL slack (in seconds) past the spawn timeout. */
const TOKEN_TTL_SLACK = 30;

/** Default scopes for skill tokens. Excludes `admin` (eval/js) and `control`. */
const DEFAULT_SKILL_SCOPES: ScopeCategory[] = ['read', 'write'];

/** Generate a fresh spawn id. Caller passes this to spawn AND revoke. */
export function generateSpawnId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** Build the canonical clientId for a skill spawn. */
export function skillClientId(skillName: string, spawnId: string): string {
  return `skill:${skillName}:${spawnId}`;
}

export interface MintSkillTokenOptions {
  skillName: string;
  spawnId: string;
  /** Spawn timeout in seconds. Token TTL = timeout + 30s slack. */
  spawnTimeoutSeconds: number;
  /**
   * Override the default scopes. Phase 1 callers should not pass this; reserved
   * for future opt-in flags (e.g. an `admin: true` frontmatter for trusted
   * human-authored skills that need eval/js).
   */
  scopes?: ScopeCategory[];
}

/**
 * Mint a fresh scoped token for a skill spawn.
 *
 * Returns the token info; the caller passes `info.token` to the child via the
 * GSTACK_SKILL_TOKEN env var. The clientId is deterministic from skillName +
 * spawnId so the corresponding `revokeSkillToken()` always finds the right
 * record.
 */
export function mintSkillToken(opts: MintSkillTokenOptions): TokenInfo {
  const clientId = skillClientId(opts.skillName, opts.spawnId);
  return createToken({
    clientId,
    scopes: opts.scopes ?? DEFAULT_SKILL_SCOPES,
    tabPolicy: 'shared',          // skill scripts may switch tabs as needed
    rateLimit: 0,                  // skill scripts can run as fast as the daemon allows
    expiresSeconds: opts.spawnTimeoutSeconds + TOKEN_TTL_SLACK,
  });
}

/**
 * Revoke the token for a finished spawn. Idempotent — revoking an already-revoked
 * token returns false but is not an error.
 */
export function revokeSkillToken(skillName: string, spawnId: string): boolean {
  return revokeToken(skillClientId(skillName, spawnId));
}
