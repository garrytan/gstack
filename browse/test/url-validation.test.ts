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

// ---------------------------------------------------------------------------
// download + scrape must gate page.request.fetch through validateNavigationUrl
//
// Regression: the `goto` command was correctly wired through
// validateNavigationUrl, but the `download` and `scrape` commands
// called page.request.fetch(url, ...) directly. A caller with the
// default write scope could hit the /command endpoint and ask the
// daemon to fetch http://169.254.169.254/latest/meta-data/ (AWS
// IMDSv1) or the GCP/Azure/internal equivalents; the body comes back
// as base64 or lands on disk where GET /file serves it.
//
// Source-level check: both page.request.fetch call sites must have a
// validateNavigationUrl invocation immediately before them.
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
import { join } from 'path';

describe('download + scrape SSRF gate', () => {
  const WRITE_COMMANDS_SRC = readFileSync(
    join(import.meta.dir, '..', 'src', 'write-commands.ts'),
    'utf-8',
  );

  function callsitesOf(needle: string): number[] {
    const idxs: number[] = [];
    let at = 0;
    while ((at = WRITE_COMMANDS_SRC.indexOf(needle, at)) !== -1) {
      idxs.push(at);
      at += needle.length;
    }
    return idxs;
  }

  it('every page.request.fetch sits under a preceding validateNavigationUrl', () => {
    // Match the actual call site (`await page.request.fetch(`), not the
    // token when it appears inside a code comment.
    const fetches = callsitesOf('await page.request.fetch(');
    expect(fetches.length).toBeGreaterThan(0);
    for (const idx of fetches) {
      // Look at the 400 chars preceding the call — the gate must live
      // within the same branch / try block. 400 covers the comment +
      // await invocation without letting an unrelated upstream gate
      // pass as evidence.
      const lead = WRITE_COMMANDS_SRC.slice(Math.max(0, idx - 400), idx);
      expect(lead).toMatch(/validateNavigationUrl\s*\(/);
    }
  });

  it('download command validates the URL before fetch', () => {
    const block = WRITE_COMMANDS_SRC.slice(
      WRITE_COMMANDS_SRC.indexOf("case 'download'"),
      WRITE_COMMANDS_SRC.indexOf("case 'scrape'"),
    );
    const vIdx = block.indexOf('validateNavigationUrl');
    const fIdx = block.indexOf('await page.request.fetch(');
    expect(vIdx).toBeGreaterThan(-1);
    expect(fIdx).toBeGreaterThan(-1);
    expect(vIdx).toBeLessThan(fIdx);
  });

  it('scrape command validates each URL before fetch in the loop', () => {
    const block = WRITE_COMMANDS_SRC.slice(
      WRITE_COMMANDS_SRC.indexOf("case 'scrape'"),
    );
    // find the first actual `await page.request.fetch(` call site in scrape
    // and the nearest preceding validateNavigationUrl
    const fIdx = block.indexOf('await page.request.fetch(');
    expect(fIdx).toBeGreaterThan(-1);
    const preFetch = block.slice(0, fIdx);
    const vIdx = preFetch.lastIndexOf('validateNavigationUrl');
    expect(vIdx).toBeGreaterThan(-1);
  });
});
