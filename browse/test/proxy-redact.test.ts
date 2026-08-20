import { describe, test, expect } from 'bun:test';
import { redactProxyUrl, redactUpstream } from '../src/proxy-redact';

describe('redactProxyUrl', () => {
  test('replaces user:pass with ***:*** in socks5 URL', () => {
    const out = redactProxyUrl('socks5://alice:secret@host.example.com:1080');
    expect(out).toContain('***:***');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('secret');
    expect(out).toContain('host.example.com:1080');
  });

  test('replaces creds in http URL', () => {
    const out = redactProxyUrl('http://bob:hunter2@proxy.corp:3128');
    expect(out).not.toContain('bob');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('proxy.corp:3128');
  });

  test('returns URL unchanged when no creds present', () => {
    const out = redactProxyUrl('http://proxy.corp:3128');
    expect(out).toContain('proxy.corp:3128');
    expect(out).not.toContain('***');
  });

  test('returns placeholder for malformed input', () => {
    expect(redactProxyUrl('not-a-url')).toBe('<malformed proxy url>');
    expect(redactProxyUrl('http://')).toBe('<malformed proxy url>');
  });

  test('returns placeholder for empty/null', () => {
    expect(redactProxyUrl(null)).toBe('<no proxy>');
    expect(redactProxyUrl(undefined)).toBe('<no proxy>');
    expect(redactProxyUrl('')).toBe('<no proxy>');
  });

  test('does not echo cred bytes when URL is malformed but contains creds', () => {
    // Defensive: if input has creds AND is malformed, we still don't echo.
    const out = redactProxyUrl('socks5://leaked:password-bad-host');
    expect(out).not.toContain('leaked');
    expect(out).not.toContain('password');
  });
});

describe('redactUpstream', () => {
  test('redacts userId and password', () => {
    const out = redactUpstream({
      host: 'proxy.example.com',
      port: 1080,
      userId: 'realuser',
      password: 'realpass',
    });
    expect(out.host).toBe('proxy.example.com');
    expect(out.port).toBe(1080);
    expect(out.userId).toBe('***');
    expect(out.password).toBe('***');
  });

  test('omits userId/password when not present', () => {
    const out = redactUpstream({ host: 'proxy.example.com', port: 1080 });
    expect(out.userId).toBeUndefined();
    expect(out.password).toBeUndefined();
  });
});
