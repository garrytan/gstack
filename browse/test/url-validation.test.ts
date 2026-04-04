import { describe, it, expect } from 'bun:test';
import { validateNavigationUrl } from '../src/url-validation';

describe('validateNavigationUrl', () => {
  it('allows http URLs', async () => {
    await expect(validateNavigationUrl('http://example.com')).resolves.toBeUndefined();
  });

  it('allows https URLs', async () => {
    await expect(validateNavigationUrl('https://example.com/path?q=1')).resolves.toBeUndefined();
  });

  it('allows localhost', async () => {
    await expect(validateNavigationUrl('http://localhost:3000')).resolves.toBeUndefined();
  });

  it('allows 127.0.0.1', async () => {
    await expect(validateNavigationUrl('http://127.0.0.1:8080')).resolves.toBeUndefined();
  });

  it('allows private IPs', async () => {
    await expect(validateNavigationUrl('http://192.168.1.1')).resolves.toBeUndefined();
  });

  it('blocks file:// scheme', async () => {
    await expect(validateNavigationUrl('file:///etc/passwd')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks javascript: scheme', async () => {
    await expect(validateNavigationUrl('javascript:alert(1)')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks data: scheme', async () => {
    await expect(validateNavigationUrl('data:text/html,<h1>hi</h1>')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks AWS/GCP metadata endpoint', async () => {
    await expect(validateNavigationUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks GCP metadata hostname', async () => {
    await expect(validateNavigationUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks Azure metadata hostname', async () => {
    await expect(validateNavigationUrl('http://metadata.azure.internal/metadata/instance')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata hostname with trailing dot', async () => {
    await expect(validateNavigationUrl('http://metadata.google.internal./computeMetadata/v1/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in hex form', async () => {
    await expect(validateNavigationUrl('http://0xA9FEA9FE/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in decimal form', async () => {
    await expect(validateNavigationUrl('http://2852039166/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in octal form', async () => {
    await expect(validateNavigationUrl('http://0251.0376.0251.0376/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 metadata with brackets', async () => {
    await expect(validateNavigationUrl('http://[fd00::]/')).rejects.toThrow(/cloud metadata/i);
  });

  // SECURITY FIX: IPv4-mapped IPv6 bypass protection
  // These test cases verify that IPv4-mapped IPv6 addresses cannot bypass metadata IP blocking
  // See: https://en.wikipedia.org/wiki/IPv6_address#IPv4-mapped_IPv6_addresses
  
  it('blocks metadata IP in IPv4-mapped IPv6 form (::ffff:169.254.169.254)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:169.254.169.254]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in IPv4-mapped IPv6 hex form (::ffff:a9fe:a9fe)', async () => {
    await expect(validateNavigationUrl('http://[::ffff:a9fe:a9fe]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in deprecated IPv4-compatible form (::169.254.169.254)', async () => {
    await expect(validateNavigationUrl('http://[::169.254.169.254]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in full IPv4-mapped IPv6 form (0:0:0:0:0:ffff:169.254.169.254)', async () => {
    await expect(validateNavigationUrl('http://[0:0:0:0:0:ffff:169.254.169.254]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in full deprecated IPv4-compatible form (0:0:0:0:0:0:169.254.169.254)', async () => {
    await expect(validateNavigationUrl('http://[0:0:0:0:0:0:169.254.169.254]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in full IPv4-mapped hex form (0:0:0:0:0:ffff:a9fe:a9fe)', async () => {
    await expect(validateNavigationUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in full deprecated IPv4-compatible hex form (0:0:0:0:0:0:a9fe:a9fe)', async () => {
    await expect(validateNavigationUrl('http://[0:0:0:0:0:0:a9fe:a9fe]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('throws on malformed URLs', async () => {
    await expect(validateNavigationUrl('not-a-url')).rejects.toThrow(/Invalid URL/i);
  });
});


