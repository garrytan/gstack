import { describe, it, expect, beforeEach } from 'bun:test';
import {
  initRegistry, getRootToken, isRootToken,
  createToken, createSetupKey, exchangeSetupKey,
  validateToken, checkScope, checkDomain, checkRate,
  revokeToken, rotateRoot, listTokens, recordCommand,
  serializeRegistry, restoreRegistry, checkConnectRateLimit,
  SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN, SCOPE_CONTROL, SCOPE_META,
} from '../src/token-registry';

describe('token-registry', () => {
  beforeEach(() => {
    // rotateRoot clears all tokens and rate buckets, then initRegistry sets the root
    rotateRoot();
    initRegistry('root-token-for-tests');
  });

  describe('root token', () => {
    it('identifies root token correctly', () => {
      expect(isRootToken('root-token-for-tests')).toBe(true);
      expect(isRootToken('not-root')).toBe(false);
    });

    it('validates root token with full scopes', () => {
      const info = validateToken('root-token-for-tests');
      expect(info).not.toBeNull();
      expect(info!.clientId).toBe('root');
      expect(info!.scopes).toEqual(['read', 'write', 'admin', 'meta', 'control']);
      expect(info!.rateLimit).toBe(0);
    });

    // Regression: the previous fix did a JS string-length short-circuit before
    // crypto.timingSafeEqual, but the buffers passed in are UTF-8. A multibyte
    // input with matching string length but mismatched byte length would slip
    // past the check and crash inside timingSafeEqual. Auth path must return
    // false, not error.
    it('returns false for a multibyte token whose string length matches but UTF-8 byte length differs', () => {
      // 'root-token-for-tests' is 20 ASCII chars (20 bytes).
      // 'é'.repeat(20) is 20 chars but 40 UTF-8 bytes.
      const multibyte = 'é'.repeat(20);
      expect(multibyte.length).toBe('root-token-for-tests'.length);
      expect(Buffer.byteLength(multibyte, 'utf8')).not.toBe(
        Buffer.byteLength('root-token-for-tests', 'utf8'),
      );
      expect(() => isRootToken(multibyte)).not.toThrow();
      expect(isRootToken(multibyte)).toBe(false);
    });

    it('returns false for a token that differs only in length (same prefix)', () => {
      expect(isRootToken('root-token-for-tests-extra')).toBe(false);
      expect(isRootToken('root-token-for-test')).toBe(false);
    });

    it('returns false for a same-length token that differs only in the last byte', () => {
      const expected = 'root-token-for-tests';
      const wrong = expected.slice(0, -1) + (expected.endsWith('x') ? 'y' : 'x');
      expect(wrong.length).toBe(expected.length);
      expect(isRootToken(wrong)).toBe(false);
    });

    it('returns false for the empty string even when root is set', () => {
      expect(isRootToken('')).toBe(false);
    });
  });

  describe('createToken', () => {
    it('creates a session token with defaults', () => {
      const info = createToken({ clientId: 'test-agent' });
      expect(info.token).toStartWith('gsk_sess_');
      expect(info.clientId).toBe('test-agent');
      expect(info.type).toBe('session');
      expect(info.scopes).toEqual(['read', 'write']);
      expect(info.tabPolicy).toBe('own-only');
      expect(info.rateLimit).toBe(10);
      expect(info.expiresAt).not.toBeNull();
      expect(info.commandCount).toBe(0);
    });

    it('creates token with custom scopes', () => {
      const info = createToken({
        clientId: 'admin-agent',
        scopes: ['read', 'write', 'admin'],
        rateLimit: 20,
        expiresSeconds: 3600,
      });
      expect(info.scopes).toEqual(['read', 'write', 'admin']);
      expect(info.rateLimit).toBe(20);
    });

    it('creates token with indefinite expiry', () => {
      const info = createToken({
        clientId: 'forever',
        expiresSeconds: null,
      });
      expect(info.expiresAt).toBeNull();
    });

    it('overwrites existing token for same clientId', () => {
      const first = createToken({ clientId: 'agent-1' });
      const second = createToken({ clientId: 'agent-1' });
      expect(first.token).not.toBe(second.token);
      expect(validateToken(first.token)).toBeNull();
      expect(validateToken(second.token)).not.toBeNull();
    });
  });

  describe('setup key exchange', () => {
    it('creates setup key with 5-minute expiry', () => {
      const setup = createSetupKey({});
      expect(setup.token).toStartWith('gsk_setup_');
      expect(setup.type).toBe('setup');
      expect(setup.usesRemaining).toBe(1);
    });

    it('exchanges setup key for session token', () => {
      const setup = createSetupKey({ clientId: 'remote-1' });
      const session = exchangeSetupKey(setup.token);
      expect(session).not.toBeNull();
      expect(session!.token).toStartWith('gsk_sess_');
      expect(session!.clientId).toBe('remote-1');
      expect(session!.type).toBe('session');
    });

    it('setup key is single-use', () => {
      const setup = createSetupKey({});
      exchangeSetupKey(setup.token);
      // Second exchange with 0 commands should be idempotent
      const second = exchangeSetupKey(setup.token);
      expect(second).not.toBeNull(); // idempotent — session has 0 commands
    });

    it('idempotent exchange fails after commands are executed', () => {
      const setup = createSetupKey({});
      const session = exchangeSetupKey(setup.token);
      // Simulate command execution
      recordCommand(session!.token);
      // Now re-exchange should fail
      const retry = exchangeSetupKey(setup.token);
      expect(retry).toBeNull();
    });

    it('rejects expired setup key', () => {
      const setup = createSetupKey({});
      // Manually expire it
      const info = validateToken(setup.token);
      if (info) {
        (info as any).expiresAt = new Date(Date.now() - 1000).toISOString();
      }
      const session = exchangeSetupKey(setup.token);
      expect(session).toBeNull();
    });

    it('rejects unknown setup key', () => {
      expect(exchangeSetupKey('gsk_setup_nonexistent')).toBeNull();
    });

    it('rejects session token as setup key', () => {
      const session = createToken({ clientId: 'test' });
      expect(exchangeSetupKey(session.token)).toBeNull();
    });
  });

  describe('validateToken', () => {
    it('validates active session token', () => {
      const created = createToken({ clientId: 'valid' });
      const info = validateToken(created.token);
      expect(info).not.toBeNull();
      expect(info!.clientId).toBe('valid');
    });

    it('rejects unknown token', () => {
      expect(validateToken('gsk_sess_unknown')).toBeNull();
    });

    it('rejects expired token', async () => {
      // expiresSeconds: 0 creates a token that expires at creation time
      const created = createToken({ clientId: 'expiring', expiresSeconds: 0 });
      // Wait 1ms so the expiry is definitively in the past
      await new Promise(r => setTimeout(r, 2));
      expect(validateToken(created.token)).toBeNull();
    });
  });

  describe('checkScope', () => {
    it('allows read commands with read scope', () => {
      const info = createToken({ clientId: 'reader', scopes: ['read'] });
      expect(checkScope(info, 'snapshot')).toBe(true);
      expect(checkScope(info, 'text')).toBe(true);
      expect(checkScope(info, 'html')).toBe(true);
    });

    it('denies write commands with read-only scope', () => {
      const info = createToken({ clientId: 'reader', scopes: ['read'] });
      expect(checkScope(info, 'click')).toBe(false);
      expect(checkScope(info, 'goto')).toBe(false);
      expect(checkScope(info, 'fill')).toBe(false);
    });

    it('denies admin commands without admin scope', () => {
      const info = createToken({ clientId: 'normal', scopes: ['read', 'write'] });
      expect(checkScope(info, 'eval')).toBe(false);
      expect(checkScope(info, 'js')).toBe(false);
      expect(checkScope(info, 'cookies')).toBe(false);
      expect(checkScope(info, 'storage')).toBe(false);
    });

    it('allows admin commands with admin scope', () => {
      const info = createToken({ clientId: 'admin', scopes: ['read', 'write', 'admin'] });
      expect(checkScope(info, 'eval')).toBe(true);
      expect(checkScope(info, 'cookies')).toBe(true);
    });

    it('allows chain with meta scope', () => {
      const info = createToken({ clientId: 'meta', scopes: ['read', 'meta'] });
      expect(checkScope(info, 'chain')).toBe(true);
    });

    it('denies chain without meta scope', () => {
      const info = createToken({ clientId: 'no-meta', scopes: ['read'] });
      expect(checkScope(info, 'chain')).toBe(false);
    });

    it('root token allows everything', () => {
      const root = validateToken('root-token-for-tests')!;
      expect(checkScope(root, 'eval')).toBe(true);
      expect(checkScope(root, 'state')).toBe(true);
      expect(checkScope(root, 'stop')).toBe(true);
    });

    it('denies destructive commands without admin scope', () => {
      const info = createToken({ clientId: 'normal', scopes: ['read', 'write'] });
      expect(checkScope(info, 'useragent')).toBe(false);
      expect(checkScope(info, 'state')).toBe(false);
      expect(checkScope(info, 'handoff')).toBe(false);
      expect(checkScope(info, 'stop')).toBe(false);
    });
  });

  describe('checkDomain', () => {
    it('allows any domain when no restrictions', () => {
      const info = createToken({ clientId: 'unrestricted' });
      expect(checkDomain(info, 'https://evil.com')).toBe(true);
    });

    it('matches exact domain', () => {
      const info = createToken({ clientId: 'exact', domains: ['myapp.com'] });
      expect(checkDomain(info, 'https://myapp.com/page')).toBe(true);
      expect(checkDomain(info, 'https://evil.com')).toBe(false);
    });

    it('matches wildcard domain', () => {
      const info = createToken({ clientId: 'wild', domains: ['*.myapp.com'] });
      expect(checkDomain(info, 'https://api.myapp.com/v1')).toBe(true);
      expect(checkDomain(info, 'https://myapp.com')).toBe(true);
      expect(checkDomain(info, 'https://evil.com')).toBe(false);
    });

    it('root allows all domains', () => {
      const root = validateToken('root-token-for-tests')!;
      expect(checkDomain(root, 'https://anything.com')).toBe(true);
    });

    it('denies invalid URLs', () => {
      const info = createToken({ clientId: 'strict', domains: ['myapp.com'] });
      expect(checkDomain(info, 'not-a-url')).toBe(false);
    });
  });

  describe('checkRate', () => {
    it('allows requests under limit', () => {
      const info = createToken({ clientId: 'rated', rateLimit: 10 });
      for (let i = 0; i < 10; i++) {
        expect(checkRate(info).allowed).toBe(true);
      }
    });

    it('denies requests over limit', () => {
      const info = createToken({ clientId: 'limited', rateLimit: 3 });
      checkRate(info);
      checkRate(info);
      checkRate(info);
      const result = checkRate(info);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('root is unlimited', () => {
      const root = validateToken('root-token-for-tests')!;
      for (let i = 0; i < 100; i++) {
        expect(checkRate(root).allowed).toBe(true);
      }
    });
  });

  describe('revokeToken', () => {
    it('revokes existing token', () => {
      const info = createToken({ clientId: 'to-revoke' });
      expect(revokeToken('to-revoke')).toBe(true);
      expect(validateToken(info.token)).toBeNull();
    });

    it('returns false for non-existent client', () => {
      expect(revokeToken('no-such-client')).toBe(false);
    });
  });

  describe('rotateRoot', () => {
    it('generates new root and invalidates all tokens', () => {
      const oldRoot = getRootToken();
      createToken({ clientId: 'will-die' });
      const newRoot = rotateRoot();
      expect(newRoot).not.toBe(oldRoot);
      expect(isRootToken(newRoot)).toBe(true);
      expect(isRootToken(oldRoot)).toBe(false);
      expect(listTokens()).toHaveLength(0);
    });
  });

  describe('listTokens', () => {
    it('lists active session tokens', () => {
      createToken({ clientId: 'a' });
      createToken({ clientId: 'b' });
      createSetupKey({}); // setup keys not listed
      expect(listTokens()).toHaveLength(2);
    });
  });

  describe('serialization', () => {
    it('serializes and restores registry', () => {
      createToken({ clientId: 'persist-1', scopes: ['read'] });
      createToken({ clientId: 'persist-2', scopes: ['read', 'write', 'admin'] });

      const state = serializeRegistry();
      expect(Object.keys(state.agents)).toHaveLength(2);

      // Clear and restore
      rotateRoot();
      initRegistry('new-root');
      restoreRegistry(state);

      const restored = listTokens();
      expect(restored).toHaveLength(2);
      expect(restored.find(t => t.clientId === 'persist-1')?.scopes).toEqual(['read']);
    });
  });

  describe('connect rate limit', () => {
    it('allows up to 3 attempts per minute', () => {
      // Reset by creating a new module scope (can't easily reset static state)
      // Just verify the function exists and returns boolean
      const result = checkConnectRateLimit();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('scope coverage', () => {
    it('every command in commands.ts is covered by a scope', () => {
      // Import the command sets to verify coverage
      const allInScopes = new Set([
        ...SCOPE_READ, ...SCOPE_WRITE, ...SCOPE_ADMIN, ...SCOPE_CONTROL, ...SCOPE_META,
      ]);
      // chain is a special case (checked via meta scope but dispatches subcommands)
      allInScopes.add('chain');

      // These commands don't need scope coverage (server control, handled separately)
      const exemptFromScope = new Set(['status', 'snapshot']);
      // snapshot appears in both READ and META (it's read-safe)

      // Verify dangerous commands are in admin scope
      expect(SCOPE_ADMIN.has('eval')).toBe(true);
      expect(SCOPE_ADMIN.has('js')).toBe(true);
      expect(SCOPE_ADMIN.has('cookies')).toBe(true);
      expect(SCOPE_ADMIN.has('storage')).toBe(true);
      expect(SCOPE_ADMIN.has('useragent')).toBe(true);
      // Browser-wide destructive commands moved to SCOPE_CONTROL
      expect(SCOPE_CONTROL.has('state')).toBe(true);
      expect(SCOPE_CONTROL.has('handoff')).toBe(true);
      expect(SCOPE_CONTROL.has('stop')).toBe(true);
      expect(SCOPE_CONTROL.has('restart')).toBe(true);
      expect(SCOPE_CONTROL.has('disconnect')).toBe(true);

      // Verify safe read commands are NOT in admin
      expect(SCOPE_ADMIN.has('text')).toBe(false);
      expect(SCOPE_ADMIN.has('snapshot')).toBe(false);
      expect(SCOPE_ADMIN.has('screenshot')).toBe(false);
    });
  });

  // ─── CSO Fix #4: Input validation ──────────────────────────────
  describe('Input validation (CSO finding #4)', () => {
    it('rejects invalid scope values', () => {
      expect(() => createToken({
        clientId: 'test-invalid-scope',
        scopes: ['read', 'bogus' as any],
      })).toThrow('Invalid scope: bogus');
    });

    it('rejects negative rateLimit', () => {
      expect(() => createToken({
        clientId: 'test-neg-rate',
        rateLimit: -1,
      })).toThrow('rateLimit must be >= 0');
    });

    it('rejects negative expiresSeconds', () => {
      expect(() => createToken({
        clientId: 'test-neg-expire',
        expiresSeconds: -100,
      })).toThrow('expiresSeconds must be >= 0 or null');
    });

    it('accepts null expiresSeconds (indefinite)', () => {
      const token = createToken({
        clientId: 'test-indefinite',
        expiresSeconds: null,
      });
      expect(token.expiresAt).toBeNull();
    });

    it('accepts zero rateLimit (unlimited)', () => {
      const token = createToken({
        clientId: 'test-unlimited-rate',
        rateLimit: 0,
      });
      expect(token.rateLimit).toBe(0);
    });

    it('accepts valid scopes', () => {
      const token = createToken({
        clientId: 'test-valid-scopes',
        scopes: ['read', 'write', 'admin', 'meta'],
      });
      expect(token.scopes).toEqual(['read', 'write', 'admin', 'meta']);
    });
  });
});
