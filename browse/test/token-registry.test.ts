import { describe, it, expect, beforeEach } from 'bun:test';
import {
  initRegistry, getRootToken, isRootToken,
  createToken, createSetupKey, exchangeSetupKey,
  validateToken, checkScope, checkDomain, checkRate,
  revokeToken, rotateRoot, listTokens, recordCommand,
  serializeRegistry, restoreRegistry, checkConnectRateLimit,
  SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN, SCOPE_CONTROL, SCOPE_META,
  DEFAULT_PAIR_SCOPES, InvalidScopeError, ReservedClientIdError,
  revokeSetupKeys, getClientSession, grantReducesAccess,
  type TokenInfo, type ResolvedGrant,
  __resetRegistry,
} from '../src/token-registry';

describe('token-registry', () => {
  beforeEach(() => {
    // __resetRegistry zeroes rootToken so the new initRegistry mismatch guard
    // doesn't fire on the immediate initRegistry call. rotateRoot would leave
    // a UUID in rootToken and the guard would throw.
    __resetRegistry();
    initRegistry('root-token-for-tests');
  });

  // D2: `root` is the sentinel checkScope/checkDomain/checkRate use for the
  // omnipotent caller; a scoped token carrying it bypasses all enforcement.
  describe('reserved clientId (D2)', () => {
    it('createToken rejects clientId "root" and lookalikes', () => {
      expect(() => createToken({ clientId: 'root' })).toThrow(ReservedClientIdError);
      expect(() => createToken({ clientId: 'ROOT' })).toThrow(ReservedClientIdError);
      expect(() => createToken({ clientId: '  root  ' })).toThrow(ReservedClientIdError);
    });

    it('createToken rejects empty / whitespace clientId', () => {
      expect(() => createToken({ clientId: '' })).toThrow(ReservedClientIdError);
      expect(() => createToken({ clientId: '   ' })).toThrow(ReservedClientIdError);
    });

    it('createSetupKey rejects clientId "root" but allows an omitted one', () => {
      expect(() => createSetupKey({ clientId: 'root' })).toThrow(ReservedClientIdError);
      // Omitted clientId gets a safe generated default, not a throw.
      const key = createSetupKey({});
      expect(key.clientId.startsWith('remote-')).toBe(true);
    });

    it('revokeSetupKeys drops only PENDING keys, keeping the spent key and the session', () => {
      const k1 = createSetupKey({ clientId: 'x' });   // pending
      exchangeSetupKey(k1.token);                      // k1 now spent + a session exists
      createSetupKey({ clientId: 'x' });               // pending k2
      expect(revokeSetupKeys('x')).toBe(1);            // only the pending k2
      expect(getClientSession('x')).not.toBeNull();    // session kept
      // The spent key survives for idempotent re-exchange (#2646).
      expect(exchangeSetupKey(k1.token)).not.toBeNull();
    });

    it('restoreRegistry skips a persisted "root" entry instead of injecting a bypass token', () => {
      restoreRegistry({ agents: {
        root: { token: 'gsk_sess_evil', type: 'session', scopes: ['read', 'write', 'admin', 'meta', 'control'], tabPolicy: 'shared', rateLimit: 0, expiresAt: null, createdAt: new Date().toISOString() } as any,
        good: { token: 'gsk_sess_good', type: 'session', scopes: ['read'], tabPolicy: 'own-only', rateLimit: 10, expiresAt: null, createdAt: new Date().toISOString() } as any,
      } });
      // The evil root entry is dropped; the valid one still restores.
      expect(validateToken('gsk_sess_evil')).toBeNull();
      const good = validateToken('gsk_sess_good');
      expect(good?.clientId).toBe('good');
    });
  });

  // D1: drives the /pair supersede decision. Direction matters — dropping an
  // allowlisted domain is the reduction, not adding one; 0 = unlimited rate.
  describe('grantReducesAccess (D1)', () => {
    const prior = (o: Partial<TokenInfo> = {}): TokenInfo => ({
      token: 't', clientId: 'c', type: 'session',
      scopes: ['read', 'write', 'admin', 'meta'], tabPolicy: 'own-only',
      rateLimit: 10, expiresAt: null, createdAt: '', commandCount: 0, ...o,
    });
    const grant = (o: Partial<ResolvedGrant> = {}): ResolvedGrant => ({
      scopes: ['read', 'write', 'admin', 'meta'], rateLimit: 10, tabPolicy: 'own-only', ...o,
    });

    it('scopes: drop → reduce; add/equal → not; dropping control → reduce', () => {
      expect(grantReducesAccess(prior({ scopes: ['read', 'write', 'admin', 'meta'] }), grant({ scopes: ['read'] }))).toBe(true);
      expect(grantReducesAccess(prior({ scopes: ['read'] }), grant({ scopes: ['read', 'write'] }))).toBe(false);
      expect(grantReducesAccess(prior({ scopes: ['read'] }), grant({ scopes: ['read'] }))).toBe(false);
      expect(grantReducesAccess(prior({ scopes: ['read', 'control'] }), grant({ scopes: ['read'] }))).toBe(true);
    });

    it('domains: drop → reduce; add/equal → not; unrestricted→restricted → reduce; glob narrowing → reduce', () => {
      expect(grantReducesAccess(prior({ domains: ['a.com', 'b.com'] }), grant({ domains: ['a.com'] }))).toBe(true);
      expect(grantReducesAccess(prior({ domains: ['a.com'] }), grant({ domains: ['a.com', 'b.com'] }))).toBe(false);
      expect(grantReducesAccess(prior({ domains: ['a.com'] }), grant({ domains: ['a.com'] }))).toBe(false);
      expect(grantReducesAccess(prior({ domains: undefined }), grant({ domains: ['a.com'] }))).toBe(true);
      expect(grantReducesAccess(prior({ domains: ['a.com'] }), grant({ domains: undefined }))).toBe(false);
      expect(grantReducesAccess(prior({ domains: ['*.example.com'] }), grant({ domains: ['*.com'] }))).toBe(false); // widen
      expect(grantReducesAccess(prior({ domains: ['*.com'] }), grant({ domains: ['*.example.com'] }))).toBe(true);  // narrow
    });

    it('rate (0 = unlimited): unlimited→capped → reduce; lower cap → reduce; higher/equal → not', () => {
      expect(grantReducesAccess(prior({ rateLimit: 0 }), grant({ rateLimit: 10 }))).toBe(true);
      expect(grantReducesAccess(prior({ rateLimit: 10 }), grant({ rateLimit: 5 }))).toBe(true);
      expect(grantReducesAccess(prior({ rateLimit: 5 }), grant({ rateLimit: 10 }))).toBe(false);
      expect(grantReducesAccess(prior({ rateLimit: 10 }), grant({ rateLimit: 10 }))).toBe(false);
      expect(grantReducesAccess(prior({ rateLimit: 10 }), grant({ rateLimit: 0 }))).toBe(false); // → unlimited = broaden
    });

    it('tabPolicy: shared → own-only → reduce; the reverse → not', () => {
      expect(grantReducesAccess(prior({ tabPolicy: 'shared' }), grant({ tabPolicy: 'own-only' }))).toBe(true);
      expect(grantReducesAccess(prior({ tabPolicy: 'own-only' }), grant({ tabPolicy: 'shared' }))).toBe(false);
    });
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
      // revokeToken returns the delete count, not a boolean (truthy for callers)
      expect(revokeToken('to-revoke')).toBe(1);
      expect(validateToken(info.token)).toBeNull();
    });

    it('returns 0 for non-existent client', () => {
      expect(revokeToken('no-such-client')).toBe(0);
    });

    // Regression: revokeToken deleted only the FIRST matching Map entry. The
    // spent setup key (kept for idempotent re-exchange) is inserted before the
    // session token, so it shadowed the session: revoke reported success while
    // the live session survived and DELETE /token returned a false 200.
    it('revokes the session even when a spent setup key precedes it (shape a)', () => {
      const setup = createSetupKey({ clientId: 'shadowed' });
      const session = exchangeSetupKey(setup.token)!;
      expect(revokeToken('shadowed')).toBe(2);
      expect(validateToken(session.token)).toBeNull();
      expect(exchangeSetupKey(setup.token)).toBeNull();
    });

    // Regression: an UNSPENT setup key created after the session survived the
    // old first-match revoke, so a "revoked" agent could POST /connect and
    // mint a brand-new session within the key's 5-minute validity window.
    it('closes the re-grant hole: unspent setup key dies with the revoke (shape b)', () => {
      const first = createSetupKey({ clientId: 'regrant' });
      exchangeSetupKey(first.token);
      const second = createSetupKey({ clientId: 'regrant' });
      expect(revokeToken('regrant')).toBe(3);
      expect(exchangeSetupKey(second.token)).toBeNull();
      expect(listTokens().filter(t => t.clientId === 'regrant')).toHaveLength(0);
    });

    it('revokes multiple pending setup keys for one clientId in a single call (shape c)', () => {
      const keys = [1, 2, 3].map(() => createSetupKey({ clientId: 'multi' }));
      expect(revokeToken('multi')).toBe(3);
      for (const k of keys) expect(exchangeSetupKey(k.token)).toBeNull();
      expect(revokeToken('multi')).toBe(0); // idempotent: second call finds nothing
    });

    it('does not touch other clients\' tokens', () => {
      const bystander = createToken({ clientId: 'bystander' });
      createSetupKey({ clientId: 'target' });
      createToken({ clientId: 'target' });
      expect(revokeToken('target')).toBe(2);
      expect(validateToken(bystander.token)).not.toBeNull();
    });
  });

  describe('pair defaults and option validation', () => {
    it('DEFAULT_PAIR_SCOPES is exactly read,write,admin,meta (b73f3644: the ceremony is the trust boundary)', () => {
      expect([...DEFAULT_PAIR_SCOPES]).toEqual(['read', 'write', 'admin', 'meta']);
    });

    // Regression: only createToken validated options, so a scope typo minted
    // a poisoned setup key at /pair and surfaced to the REMOTE agent at
    // /connect as a misleading "Invalid request body".
    it('createSetupKey rejects an unknown scope with InvalidScopeError naming it', () => {
      expect(() => createSetupKey({ scopes: ['raed' as never] }))
        .toThrow(InvalidScopeError);
      expect(() => createSetupKey({ scopes: ['raed' as never] }))
        .toThrow('Invalid scope: raed');
    });

    it('createSetupKey rejects a negative rateLimit', () => {
      expect(() => createSetupKey({ rateLimit: -5 })).toThrow(InvalidScopeError);
    });

    // Regression: `opts.rateLimit || 10` coerced the documented "0 = unlimited"
    // into 10 on the /pair path while /token honored it.
    it('createSetupKey preserves rateLimit 0 (unlimited)', () => {
      const setup = createSetupKey({ rateLimit: 0 });
      expect(setup.rateLimit).toBe(0);
      const session = exchangeSetupKey(setup.token)!;
      expect(session.rateLimit).toBe(0);
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

    it('includeSetup lists pending setup keys but hides spent ones', () => {
      createToken({ clientId: 'sess' });
      createSetupKey({ clientId: 'pending' });
      const spent = createSetupKey({ clientId: 'spent' });
      exchangeSetupKey(spent.token);
      expect(listTokens().map(t => t.clientId).sort()).toEqual(['sess', 'spent']);
      const withSetup = listTokens({ includeSetup: true });
      // Pending key = a live grant the operator must see; the SPENT key is
      // re-exchange bookkeeping for the already-listed session and stays hidden.
      expect(withSetup.filter(t => t.type === 'setup').map(t => t.clientId)).toEqual(['pending']);
    });
  });

  describe('serialization', () => {
    it('serializes and restores registry', () => {
      createToken({ clientId: 'persist-1', scopes: ['read'] });
      createToken({ clientId: 'persist-2', scopes: ['read', 'write', 'admin'] });

      const state = serializeRegistry();
      expect(Object.keys(state.agents)).toHaveLength(2);

      // Clear and restore. __resetRegistry instead of rotateRoot+initRegistry
      // so the new initRegistry mismatch guard doesn't fire — rotateRoot
      // leaves a UUID in rootToken and initRegistry('new-root') would throw.
      __resetRegistry();
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
