// tailscaled LocalAPI client tests. Codex-flagged: identity canonicalization
// for user / tag / node-key forms, fail-closed semantics on missing socket
// or unparseable response.

import { describe, test, expect } from 'bun:test';
import { canonicalize, probeTailscale } from '../src/tailscale-localapi';

describe('canonicalize', () => {
  test('returns lowercased user email when UserProfile.LoginName present', () => {
    const out = canonicalize({
      Node: { Tags: undefined },
      UserProfile: { LoginName: 'Alice@Example.COM' },
    });
    expect(out).toBe('alice@example.com');
  });

  test('returns tagged node identity when tags present (prefers tag over user)', () => {
    const out = canonicalize({
      Node: { Tags: ['tag:CI'] },
      UserProfile: { LoginName: 'admin@example.com' },
    });
    expect(out).toBe('tag:ci');
  });

  test('handles tag without prefix', () => {
    const out = canonicalize({
      Node: { Tags: ['ci'] },
    });
    expect(out).toBe('tag:ci');
  });

  test('returns node:<key> when no user and no tags', () => {
    const out = canonicalize({
      Node: { Key: 'nodekey:abcdef0123' },
    });
    expect(out).toBe('node:abcdef0123');
  });

  test('returns null for unparseable response', () => {
    expect(canonicalize({})).toBeNull();
    expect(canonicalize({ Node: {} })).toBeNull();
    expect(canonicalize({ UserProfile: { LoginName: 'no-at-sign' } })).toBeNull();
  });
});

describe('probeTailscale', () => {
  test('fails closed when socket does not exist', async () => {
    const r = await probeTailscale('/tmp/does-not-exist-' + Math.random());
    expect(r.ok).toBe(false);
    // Reason may be 'socket_missing' or 'unreachable' depending on how the
    // OS/runtime surfaces a missing unix socket. Either is a fail-closed
    // outcome that prevents the daemon from opening the tailnet listener.
    expect(['socket_missing', 'unreachable']).toContain(r.reason);
  });
});
