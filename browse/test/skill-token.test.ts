/**
 * skill-token tests — verify scoped tokens minted per spawn behave correctly:
 *   - mint creates a session token bound to the right clientId
 *   - default scopes are read+write (no admin/control)
 *   - TTL = spawnTimeout + 30s slack
 *   - revoke kills the token
 *   - revoking an already-revoked token is idempotent (returns false)
 *   - the clientId encoding survives round-trip
 *   - generated spawn ids are unique
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  initRegistry, rotateRoot, validateToken, checkScope,
} from '../src/token-registry';
import {
  generateSpawnId,
  skillClientId,
  mintSkillToken,
  revokeSkillToken,
} from '../src/skill-token';

describe('skill-token', () => {
  beforeEach(() => {
    rotateRoot();
    initRegistry('root-token-for-tests');
  });

  describe('generateSpawnId', () => {
    it('returns a hex string', () => {
      const id = generateSpawnId();
      expect(id).toMatch(/^[0-9a-f]+$/);
      expect(id.length).toBe(16); // 8 bytes -> 16 hex chars
    });

    it('returns unique ids on each call', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) ids.add(generateSpawnId());
      expect(ids.size).toBe(50);
    });
  });

  describe('skillClientId', () => {
    it('encodes skillName + spawnId deterministically', () => {
      expect(skillClientId('hackernews-frontpage', 'abc123')).toBe('skill:hackernews-frontpage:abc123');
    });
  });

  describe('mintSkillToken', () => {
    it('mints a session token for the spawn', () => {
      const info = mintSkillToken({
        skillName: 'hn-frontpage',
        spawnId: 'spawn1',
        spawnTimeoutSeconds: 60,
      });
      expect(info.token).toStartWith('gsk_sess_');
      expect(info.clientId).toBe('skill:hn-frontpage:spawn1');
      expect(info.type).toBe('session');
    });

    it('defaults to read+write scopes (no admin)', () => {
      const info = mintSkillToken({
        skillName: 'hn-frontpage',
        spawnId: 'spawn1',
        spawnTimeoutSeconds: 60,
      });
      expect(info.scopes).toEqual(['read', 'write']);
      expect(info.scopes).not.toContain('admin');
      expect(info.scopes).not.toContain('control');
    });

    it('TTL is spawnTimeout + 30s slack', () => {
      const before = Date.now();
      const info = mintSkillToken({
        skillName: 'x', spawnId: 'y', spawnTimeoutSeconds: 60,
      });
      const after = Date.now();
      const expiresMs = new Date(info.expiresAt!).getTime();
      // Token expires ~90s after mint (60s + 30s slack), allow some test fuzz.
      expect(expiresMs).toBeGreaterThanOrEqual(before + 90_000 - 1_000);
      expect(expiresMs).toBeLessThanOrEqual(after + 90_000 + 1_000);
    });

    it('minted token validates and grants browser-driving scope', () => {
      const info = mintSkillToken({
        skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60,
      });
      const validated = validateToken(info.token);
      expect(validated).not.toBeNull();
      expect(checkScope(validated!, 'goto')).toBe(true);
      expect(checkScope(validated!, 'click')).toBe(true);
      expect(checkScope(validated!, 'snapshot')).toBe(true);
      expect(checkScope(validated!, 'text')).toBe(true);
    });

    it('minted token denies admin commands (eval, js, cookies, storage)', () => {
      const info = mintSkillToken({
        skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60,
      });
      const validated = validateToken(info.token);
      expect(validated).not.toBeNull();
      expect(checkScope(validated!, 'eval')).toBe(false);
      expect(checkScope(validated!, 'js')).toBe(false);
      expect(checkScope(validated!, 'cookies')).toBe(false);
      expect(checkScope(validated!, 'storage')).toBe(false);
    });

    it('minted token denies control commands (state, stop, restart)', () => {
      const info = mintSkillToken({
        skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60,
      });
      const validated = validateToken(info.token);
      expect(checkScope(validated!, 'stop')).toBe(false);
      expect(checkScope(validated!, 'restart')).toBe(false);
      expect(checkScope(validated!, 'state')).toBe(false);
    });

    it('rateLimit is unlimited (skill scripts run as fast as daemon allows)', () => {
      const info = mintSkillToken({
        skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60,
      });
      expect(info.rateLimit).toBe(0);
    });

    it('two spawns of the same skill mint distinct tokens', () => {
      const a = mintSkillToken({ skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60 });
      const b = mintSkillToken({ skillName: 'hn', spawnId: 's2', spawnTimeoutSeconds: 60 });
      expect(a.token).not.toBe(b.token);
      expect(a.clientId).not.toBe(b.clientId);
      // Both remain valid until revoked.
      expect(validateToken(a.token)).not.toBeNull();
      expect(validateToken(b.token)).not.toBeNull();
    });
  });

  describe('revokeSkillToken', () => {
    it('revokes the token for a given spawn', () => {
      const info = mintSkillToken({ skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60 });
      expect(validateToken(info.token)).not.toBeNull();

      const ok = revokeSkillToken('hn', 's1');
      expect(ok).toBe(true);
      expect(validateToken(info.token)).toBeNull();
    });

    it('idempotent — revoking again returns false (already gone)', () => {
      mintSkillToken({ skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60 });
      expect(revokeSkillToken('hn', 's1')).toBe(true);
      expect(revokeSkillToken('hn', 's1')).toBe(false);
    });

    it('revoking unknown spawn is a no-op (returns false)', () => {
      expect(revokeSkillToken('nonexistent', 'whatever')).toBe(false);
    });

    it('revoking one spawn does not affect a sibling spawn', () => {
      const a = mintSkillToken({ skillName: 'hn', spawnId: 's1', spawnTimeoutSeconds: 60 });
      const b = mintSkillToken({ skillName: 'hn', spawnId: 's2', spawnTimeoutSeconds: 60 });

      expect(revokeSkillToken('hn', 's1')).toBe(true);
      expect(validateToken(a.token)).toBeNull();
      expect(validateToken(b.token)).not.toBeNull();
    });
  });
});
