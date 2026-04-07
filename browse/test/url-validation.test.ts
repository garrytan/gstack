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

  it('blocks IPv6 metadata with brackets (fd00::)', async () => {
    await expect(validateNavigationUrl('http://[fd00::]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 ULA fd00::1 (not just fd00::)', async () => {
    await expect(validateNavigationUrl('http://[fd00::1]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 ULA fd12:3456::1', async () => {
    await expect(validateNavigationUrl('http://[fd12:3456::1]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 ULA fc00:: (full fc00::/7 range)', async () => {
    await expect(validateNavigationUrl('http://[fc00::]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('does not block hostnames starting with fd (e.g. fd.example.com)', async () => {
    await expect(validateNavigationUrl('https://fd.example.com/')).resolves.toBeUndefined();
  });

  it('does not block hostnames starting with fc (e.g. fcustomer.com)', async () => {
    await expect(validateNavigationUrl('https://fcustomer.com/')).resolves.toBeUndefined();
  });

  it('throws on malformed URLs', async () => {
    await expect(validateNavigationUrl('not-a-url')).rejects.toThrow(/Invalid URL/i);
  });
});

describe('validateNavigationUrl — restoreState coverage', () => {
  it('blocks file:// URLs that could appear in saved state', async () => {
    await expect(validateNavigationUrl('file:///etc/passwd')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks chrome:// URLs that could appear in saved state', async () => {
    await expect(validateNavigationUrl('chrome://settings')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks metadata IPs that could be injected into state files', async () => {
    await expect(validateNavigationUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/cloud metadata/i);
  });

  it('allows normal https URLs from saved state', async () => {
    await expect(validateNavigationUrl('https://example.com/page')).resolves.toBeUndefined();
  });

  it('allows localhost URLs from saved state', async () => {
    await expect(validateNavigationUrl('http://localhost:3000/app')).resolves.toBeUndefined();
  });
});
