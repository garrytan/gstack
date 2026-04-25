/**
 * SSRF guard for gstack-config / gstack-brain-init.
 *
 * gstack-brain-init POSTs the brain bearer token + the brain repo URL
 * to ${gbrain_url}/ingest-repo. Without an SSRF guard, anyone with the
 * power to set the config (or the GBRAIN_URL env var) can redirect
 * that POST at the operator's own private network — most pointedly
 * AWS IMDS at 169.254.169.254 — and walk away with both the bearer
 * token and the private brain-repo URL.
 *
 * These tests exercise the validator directly via the internal
 * `gstack-config __validate-url` subcommand. The matching defense-in-
 * depth check lives at the top of the consumer-registration block in
 * bin/gstack-brain-init; the integration test in
 * gstack-brain-init-gh-mock.test.ts already covers the env-supplied
 * URL path end to end (mocked gh + tmp home).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const CONFIG_BIN = path.join(ROOT, 'bin', 'gstack-config');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ssrf-'));
});

afterEach(() => {
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function validateUrl(url: string, env: Record<string, string> = {}): { code: number | null; stderr: string } {
  const r = spawnSync(CONFIG_BIN, ['__validate-url', url], {
    env: { PATH: process.env.PATH ?? '', GSTACK_HOME: tmpHome, ...env },
    encoding: 'utf-8',
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

function setUrl(value: string, env: Record<string, string> = {}): { code: number | null; stderr: string } {
  const r = spawnSync(CONFIG_BIN, ['set', 'gbrain_url', value], {
    env: { PATH: process.env.PATH ?? '', GSTACK_HOME: tmpHome, ...env },
    encoding: 'utf-8',
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

describe('gstack-config __validate-url — accepts public URLs', () => {
  test.each([
    'https://gbrain.example.com',
    'https://gbrain.example.com/',
    'https://gbrain.example.com/api/v1',
    'https://gbrain.example.com:8443/ingest-repo',
    'http://gbrain.example.com',
    'https://203.0.113.42',     // TEST-NET-3 (public-ish, not RFC1918)
    'https://1.1.1.1',          // public Cloudflare DNS (sanity)
    'https://[2001:db8::1]/x',  // public IPv6 documentation prefix
  ])('accepts %s', (url) => {
    const { code, stderr } = validateUrl(url);
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });
});

describe('gstack-config __validate-url — rejects local-only targets', () => {
  test.each([
    ['http://localhost', /local-only/],
    ['http://localhost:9999', /local-only/],
    ['http://localhost.localdomain', /local-only/],
    ['http://gbrain.local', /local-only/],
    ['http://gbrain.local:8080/ingest-repo', /local-only/],
  ])('rejects %s', (url, errPattern) => {
    const { code, stderr } = validateUrl(url);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(errPattern);
  });

  test.each([
    'http://127.0.0.1',
    'http://127.0.0.1:8080/ingest-repo',
    'http://10.0.0.5/x',
    'http://10.255.255.255',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://169.254.170.2/v2/credentials',
  ])('rejects IPv4 %s', (url) => {
    const { code, stderr } = validateUrl(url);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test('rejects IPv6 loopback [::1]', () => {
    const { code, stderr } = validateUrl('http://[::1]:8080');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/IPv6/);
  });

  test('rejects IPv6 link-local [fe80::1]', () => {
    const { code, stderr } = validateUrl('http://[fe80::1]/x');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/IPv6/);
  });

  test('accepts 172.32.x.x — not RFC1918 (only 172.16-31 are private)', () => {
    const { code } = validateUrl('http://172.32.0.1/x');
    expect(code).toBe(0);
  });
});

describe('gstack-config __validate-url — rejects bad shapes', () => {
  test('rejects empty string', () => {
    const { code, stderr } = validateUrl('');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/must not be empty/);
  });

  test('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'gopher://example.com', 'data:text/plain,x', 'javascript:alert(1)', 'ftp://example.com']) {
      const { code, stderr } = validateUrl(u);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/http:\/\/ or https:\/\//);
    }
  });
});

describe('gstack-config __validate-url — env override (dev only)', () => {
  test('GSTACK_ALLOW_INTERNAL_URL=1 lets a localhost target through', () => {
    const { code, stderr } = validateUrl('http://127.0.0.1:8080', { GSTACK_ALLOW_INTERNAL_URL: '1' });
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  test('GSTACK_ALLOW_INTERNAL_URL=1 still rejects empty / non-http schemes', () => {
    expect(validateUrl('', { GSTACK_ALLOW_INTERNAL_URL: '1' }).code).not.toBe(0);
    expect(validateUrl('file:///etc/passwd', { GSTACK_ALLOW_INTERNAL_URL: '1' }).code).not.toBe(0);
  });

  test('GSTACK_ALLOW_INTERNAL_URL=0 (default) rejects loopback', () => {
    const { code } = validateUrl('http://127.0.0.1', { GSTACK_ALLOW_INTERNAL_URL: '0' });
    expect(code).not.toBe(0);
  });
});

describe('gstack-config set gbrain_url — refuses to write a hostile URL', () => {
  test('IMDS URL is rejected by the set path, no config file written', () => {
    const { code, stderr } = setUrl('http://169.254.169.254/latest/meta-data/');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/link-local|169\.254/);
    // The set path must short-circuit before writing the value to disk.
    const cfgPath = path.join(tmpHome, 'config.yaml');
    if (fs.existsSync(cfgPath)) {
      const contents = fs.readFileSync(cfgPath, 'utf-8');
      expect(contents).not.toContain('169.254.169.254');
    }
  });

  test('valid public URL is written through to config.yaml', () => {
    const { code } = setUrl('https://gbrain.example.com');
    expect(code).toBe(0);
    const contents = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(contents).toContain('gbrain_url: https://gbrain.example.com');
  });

  test('GSTACK_ALLOW_INTERNAL_URL=1 lets a dev URL through the set path', () => {
    const { code } = setUrl('http://127.0.0.1:8080', { GSTACK_ALLOW_INTERNAL_URL: '1' });
    expect(code).toBe(0);
    const contents = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(contents).toContain('http://127.0.0.1:8080');
  });
});
