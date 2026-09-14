/**
 * Tests for the browser data platform: media extraction, network capture,
 * path security, and structured data extraction.
 */

import { describe, it, expect } from 'bun:test';
import { SizeCappedBuffer, type CapturedResponse } from '../src/network-capture';
import { validateTempPath, validateOutputPath, validateReadPath } from '../src/path-security';
import { TEMP_DIR } from '../src/platform';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── SizeCappedBuffer ─────────────────────────────────────────

describe('SizeCappedBuffer', () => {
  function makeEntry(size: number, url = 'https://example.com'): CapturedResponse {
    return {
      url,
      status: 200,
      headers: {},
      body: 'x'.repeat(size),
      contentType: 'text/plain',
      timestamp: Date.now(),
      size,
      bodyTruncated: false,
    };
  }

  it('stores entries within capacity', () => {
    const buf = new SizeCappedBuffer(1000);
    buf.push(makeEntry(100));
    buf.push(makeEntry(200));
    expect(buf.length).toBe(2);
    expect(buf.byteSize).toBe(300);
  });

  it('evicts oldest entries when over capacity', () => {
    const buf = new SizeCappedBuffer(500);
    buf.push(makeEntry(200, 'https://a.com'));
    buf.push(makeEntry(200, 'https://b.com'));
    buf.push(makeEntry(200, 'https://c.com')); // should evict first entry
    expect(buf.length).toBe(2);
    const urls = buf.toArray().map(e => e.url);
    expect(urls).toContain('https://b.com');
    expect(urls).toContain('https://c.com');
    expect(urls).not.toContain('https://a.com');
  });

  it('evicts multiple entries for one large push', () => {
    const buf = new SizeCappedBuffer(500);
    buf.push(makeEntry(100));
    buf.push(makeEntry(100));
    buf.push(makeEntry(100));
    buf.push(makeEntry(400)); // evicts first two (need totalSize + 400 <= 500, so totalSize <= 100)
    expect(buf.length).toBe(2); // one 100-byte entry + one 400-byte entry
    expect(buf.byteSize).toBe(500);
  });

  it('clear resets buffer', () => {
    const buf = new SizeCappedBuffer(1000);
    buf.push(makeEntry(100));
    buf.push(makeEntry(200));
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.byteSize).toBe(0);
  });

  it('exports to JSONL file', () => {
    const buf = new SizeCappedBuffer(1000);
    buf.push(makeEntry(10, 'https://a.com'));
    buf.push(makeEntry(20, 'https://b.com'));

    const tmpFile = path.join(os.tmpdir(), `test-export-${Date.now()}.jsonl`);
    try {
      const count = buf.exportToFile(tmpFile);
      expect(count).toBe(2);
      const lines = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.url).toBe('https://a.com');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('summary shows entries', () => {
    const buf = new SizeCappedBuffer(1000);
    buf.push(makeEntry(1024, 'https://api.example.com/graphql'));
    const summary = buf.summary();
    expect(summary).toContain('1 responses');
    expect(summary).toContain('graphql');
    expect(summary).toContain('1KB');
  });

  it('summary shows empty message when no entries', () => {
    const buf = new SizeCappedBuffer(1000);
    expect(buf.summary()).toBe('No captured responses.');
  });
});

// ─── validateTempPath ─────────────────────────────────────────

describe('validateTempPath', () => {
  let tmpFile: string;

  it('allows paths within /tmp that exist', () => {
    tmpFile = path.join(TEMP_DIR, `test-temp-path-${Date.now()}.jpg`);
    fs.writeFileSync(tmpFile, 'test');
    try {
      expect(() => validateTempPath(tmpFile)).not.toThrow();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('rejects non-existent files', () => {
    expect(() => validateTempPath('/tmp/nonexistent-file-12345.jpg')).toThrow(/not found/i);
  });

  it('rejects paths in cwd', () => {
    // Create a real file in cwd to test the path check (not the existence check)
    const cwdFile = path.join(process.cwd(), 'package.json');
    expect(() => validateTempPath(cwdFile)).toThrow(/temp directory/i);
  });

  it('rejects absolute paths outside safe dirs', () => {
    expect(() => validateTempPath('/etc/passwd')).toThrow();
  });
});

// ─── Command registration ─────────────────────────────────────

describe('command registration', () => {
  it('all new commands have descriptions', () => {
    // The load-time validation in commands.ts throws if any command
    // is missing from COMMAND_DESCRIPTIONS. If this import succeeds,
    // all commands are properly registered.
    const { COMMAND_DESCRIPTIONS, ALL_COMMANDS } = require('../src/commands');
    const newCommands = ['media', 'data', 'download', 'scrape', 'archive'];
    for (const cmd of newCommands) {
      expect(ALL_COMMANDS.has(cmd)).toBe(true);
      expect(COMMAND_DESCRIPTIONS[cmd]).toBeTruthy();
    }
  });

  it('new commands are in correct scope sets', () => {
    const { SCOPE_READ, SCOPE_WRITE } = require('../src/token-registry');
    expect(SCOPE_READ.has('media')).toBe(true);
    expect(SCOPE_READ.has('data')).toBe(true);
    expect(SCOPE_WRITE.has('download')).toBe(true);
    expect(SCOPE_WRITE.has('scrape')).toBe(true);
    expect(SCOPE_WRITE.has('archive')).toBe(true);
  });

  it('media and data are in PAGE_CONTENT_COMMANDS', () => {
    const { PAGE_CONTENT_COMMANDS } = require('../src/commands');
    expect(PAGE_CONTENT_COMMANDS.has('media')).toBe(true);
    expect(PAGE_CONTENT_COMMANDS.has('data')).toBe(true);
  });
});

// ─── MIME type mapping ─────────────────────────────────────────

describe('mimeToExt', () => {
  // mimeToExt is a private function in write-commands.ts,
  // so we test it indirectly through command behavior.
  // This test verifies the source contains the expected mappings.
  it('write-commands.ts contains MIME mappings', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../src/write-commands.ts'), 'utf-8');
    expect(src).toContain("'image/png': '.png'");
    expect(src).toContain("'image/jpeg': '.jpg'");
    expect(src).toContain("'video/mp4': '.mp4'");
    expect(src).toContain("'audio/mpeg': '.mp3'");
  });
});
