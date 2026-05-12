import { describe, it, expect } from 'bun:test';
import { validateNavigationUrl, normalizeFileUrl } from '../src/url-validation';
import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR } from '../src/platform';

describe('validateNavigationUrl', () => {
  it('allows http URLs', async () => {
    await expect(validateNavigationUrl('http://example.com')).resolves.toBe('http://example.com');
  });

  it('allows https URLs', async () => {
    await expect(validateNavigationUrl('https://example.com/path?q=1')).resolves.toBe('https://example.com/path?q=1');
  });

  it('allows localhost', async () => {
    await expect(validateNavigationUrl('http://localhost:3000')).resolves.toBe('http://localhost:3000');
  });

  it('allows 127.0.0.1', async () => {
    await expect(validateNavigationUrl('http://127.0.0.1:8080')).resolves.toBe('http://127.0.0.1:8080');
  });

  it('allows private IPs', async () => {
    await expect(validateNavigationUrl('http://192.168.1.1')).resolves.toBe('http://192.168.1.1');
  });

  it('rejects file:// paths outside safe dirs (cwd + TEMP_DIR)', async () => {
    // file:// is accepted as a scheme now, but safe-dirs policy blocks /etc/passwd.
    await expect(validateNavigationUrl('file:///etc/passwd')).rejects.toThrow(/Path must be within/i);
  });

  it('accepts file:// for files under TEMP_DIR', async () => {
    const tmpHtml = path.join(TEMP_DIR, `browse-test-${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, '<html><body>ok</body></html>');
    try {
      const result = await validateNavigationUrl(`file://${tmpHtml}`);
      // Result should be a canonical file:// URL (pathToFileURL form)
      expect(result.startsWith('file://')).toBe(true);
      expect(result.toLowerCase()).toContain('browse-test-');
    } finally {
      fs.unlinkSync(tmpHtml);
    }
  });

  it('rejects unsupported file URL host (UNC/network paths)', async () => {
    await expect(validateNavigationUrl('file://host.example.com/foo.html')).rejects.toThrow(/Unsupported file URL host/i);
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

  it('blocks direct IPv6 link-local addresses', async () => {
    await expect(validateNavigationUrl('http://[fe80::2]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('does not block hostnames starting with fd (e.g. fd.example.com)', async () => {
    await expect(validateNavigationUrl('https://fd.example.com/')).resolves.toBe('https://fd.example.com/');
  });

  it('does not block hostnames starting with fc (e.g. fcustomer.com)', async () => {
    await expect(validateNavigationUrl('https://fcustomer.com/')).resolves.toBe('https://fcustomer.com/');
  });

  it('throws on malformed URLs', async () => {
    await expect(validateNavigationUrl('not-a-url')).rejects.toThrow(/Invalid URL/i);
  });
});

describe('validateNavigationUrl — restoreState coverage', () => {
  it('blocks file:// URLs outside safe dirs that could appear in saved state', async () => {
    await expect(validateNavigationUrl('file:///etc/passwd')).rejects.toThrow(/Path must be within/i);
  });

  it('blocks chrome:// URLs that could appear in saved state', async () => {
    await expect(validateNavigationUrl('chrome://settings')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks metadata IPs that could be injected into state files', async () => {
    await expect(validateNavigationUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/cloud metadata/i);
  });

  it('allows normal https URLs from saved state', async () => {
    await expect(validateNavigationUrl('https://example.com/page')).resolves.toBe('https://example.com/page');
  });

  it('allows localhost URLs from saved state', async () => {
    await expect(validateNavigationUrl('http://localhost:3000/app')).resolves.toBe('http://localhost:3000/app');
  });
});

describe('normalizeFileUrl', () => {
  const cwd = process.cwd();

  it('passes through absolute file:/// URLs unchanged', () => {
    expect(normalizeFileUrl('file:///tmp/page.html')).toBe('file:///tmp/page.html');
  });

  it('expands file://./<rel> to absolute file://<cwd>/<rel>', () => {
    const result = normalizeFileUrl('file://./docs/page.html');
    expect(result.startsWith('file://')).toBe(true);
    expect(result).toContain(cwd.replace(/\\/g, '/'));
    expect(result.endsWith('/docs/page.html')).toBe(true);
  });

  it('expands file://~/<rel> to absolute file://<homedir>/<rel>', () => {
    const result = normalizeFileUrl('file://~/Documents/page.html');
    expect(result.startsWith('file://')).toBe(true);
    expect(result.endsWith('/Documents/page.html')).toBe(true);
  });

  it('expands file://<simple-segment>/<rest> to cwd-relative', () => {
    const result = normalizeFileUrl('file://docs/page.html');
    expect(result.startsWith('file://')).toBe(true);
    expect(result).toContain(cwd.replace(/\\/g, '/'));
    expect(result.endsWith('/docs/page.html')).toBe(true);
  });

  it('passes through file://localhost/<abs> unchanged', () => {
    expect(normalizeFileUrl('file://localhost/tmp/page.html')).toBe('file://localhost/tmp/page.html');
  });

  it('rejects empty file:// URL', () => {
    expect(() => normalizeFileUrl('file://')).toThrow(/is empty/i);
  });

  it('rejects file:/// with no path', () => {
    expect(() => normalizeFileUrl('file:///')).toThrow(/no path/i);
  });

  it('rejects file://./ (directory listing)', () => {
    expect(() => normalizeFileUrl('file://./')).toThrow(/current directory/i);
  });

  it('rejects dotted host-like segment file://docs.v1/page.html', () => {
    expect(() => normalizeFileUrl('file://docs.v1/page.html')).toThrow(/Unsupported file URL host/i);
  });

  it('rejects IP-like host file://127.0.0.1/foo', () => {
    expect(() => normalizeFileUrl('file://127.0.0.1/tmp/x')).toThrow(/Unsupported file URL host/i);
  });

  it('rejects IPv6 host file://[::1]/foo', () => {
    expect(() => normalizeFileUrl('file://[::1]/tmp/x')).toThrow(/Unsupported file URL host/i);
  });

  it('rejects Windows drive letter file://C:/Users/x', () => {
    expect(() => normalizeFileUrl('file://C:/Users/x')).toThrow(/Unsupported file URL host/i);
  });

  it('passes through non-file URLs', () => {
    expect(normalizeFileUrl('https://example.com')).toBe('https://example.com');
  });
});

describe('validateNavigationUrl — file:// URL-encoding', () => {
  it('decodes %20 via fileURLToPath (space in filename)', async () => {
    const tmpHtml = path.join(TEMP_DIR, `hello world ${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, '<html>ok</html>');
    try {
      // Build an escaped file:// URL and verify it validates against the actual path
      const encodedPath = tmpHtml.split('/').map(encodeURIComponent).join('/');
      const url = `file://${encodedPath}`;
      const result = await validateNavigationUrl(url);
      expect(result.startsWith('file://')).toBe(true);
    } finally {
      fs.unlinkSync(tmpHtml);
    }
  });

  it('rejects path traversal via encoded slash (file:///tmp/safe%2F..%2Fetc/passwd)', async () => {
    // Node's fileURLToPath rejects encoded slashes outright with a clear error.
    // Either "encoded /" rejection OR "Path must be within" safe-dirs rejection is acceptable.
    await expect(
      validateNavigationUrl('file:///tmp/safe%2F..%2Fetc/passwd')
    ).rejects.toThrow(/encoded \/|Path must be within/i);
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
