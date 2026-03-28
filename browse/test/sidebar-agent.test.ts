/**
 * Tests for sidebar agent queue parsing and inbox writing.
 *
 * sidebar-agent.ts functions are not exported (it's an entry-point script),
 * so we test the same logic inline: JSONL parsing, writeToInbox filesystem
 * behavior, and edge cases.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Helpers: replicate sidebar-agent logic for unit testing ──────

/** Parse a single JSONL line — same logic as sidebar-agent poll() */
function parseQueueLine(line: string): any | null {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line);
    if (!entry.message && !entry.prompt) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Read all valid entries from a JSONL string — same as countLines + readLine loop */
function parseQueueFile(content: string): any[] {
  const entries: any[] = [];
  const lines = content.split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = parseQueueLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Write to inbox — extracted logic from sidebar-agent.ts writeToInbox() */
function writeToInbox(
  gitRoot: string,
  message: string,
  pageUrl?: string,
  sessionId?: string,
): string | null {
  if (!gitRoot) return null;

  const inboxDir = path.join(gitRoot, '.context', 'sidebar-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-');
  const filename = `${timestamp}-observation.json`;
  const tmpFile = path.join(inboxDir, `.${filename}.tmp`);
  const finalFile = path.join(inboxDir, filename);

  const inboxMessage = {
    type: 'observation',
    timestamp: now.toISOString(),
    page: { url: pageUrl || 'unknown', title: '' },
    userMessage: message,
    sidebarSessionId: sessionId || 'unknown',
  };

  fs.writeFileSync(tmpFile, JSON.stringify(inboxMessage, null, 2));
  fs.renameSync(tmpFile, finalFile);
  return finalFile;
}

// ─── Test setup ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-agent-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Queue File Parsing ─────────────────────────────────────────

describe('queue file parsing', () => {
  test('valid JSONL line parsed correctly', () => {
    const line = JSON.stringify({ message: 'hello', prompt: 'check this', pageUrl: 'https://example.com' });
    const entry = parseQueueLine(line);
    expect(entry).not.toBeNull();
    expect(entry.message).toBe('hello');
    expect(entry.prompt).toBe('check this');
    expect(entry.pageUrl).toBe('https://example.com');
  });

  test('malformed JSON line skipped without crash', () => {
    const entry = parseQueueLine('this is not json {{{');
    expect(entry).toBeNull();
  });

  test('valid JSON without message or prompt is skipped', () => {
    const line = JSON.stringify({ foo: 'bar' });
    const entry = parseQueueLine(line);
    expect(entry).toBeNull();
  });

  test('empty file returns no entries', () => {
    const entries = parseQueueFile('');
    expect(entries).toEqual([]);
  });

  test('file with blank lines returns no entries', () => {
    const entries = parseQueueFile('\n\n\n');
    expect(entries).toEqual([]);
  });

  test('mixed valid and invalid lines', () => {
    const content = [
      JSON.stringify({ message: 'first' }),
      'not json',
      JSON.stringify({ unrelated: true }),
      JSON.stringify({ message: 'second', prompt: 'do stuff' }),
    ].join('\n');

    const entries = parseQueueFile(content);
    expect(entries.length).toBe(2);
    expect(entries[0].message).toBe('first');
    expect(entries[1].message).toBe('second');
  });
});

// ─── writeToInbox ────────────────────────────────────────────────

describe('writeToInbox', () => {
  test('creates .context/sidebar-inbox/ directory', () => {
    writeToInbox(tmpDir, 'test message');
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    expect(fs.existsSync(inboxDir)).toBe(true);
    expect(fs.statSync(inboxDir).isDirectory()).toBe(true);
  });

  test('writes valid JSON file', () => {
    const filePath = writeToInbox(tmpDir, 'test message', 'https://example.com', 'session-123');
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath!)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(data.type).toBe('observation');
    expect(data.userMessage).toBe('test message');
    expect(data.page.url).toBe('https://example.com');
    expect(data.sidebarSessionId).toBe('session-123');
    expect(data.timestamp).toBeTruthy();
  });

  test('atomic write — final file exists, no .tmp left', () => {
    const filePath = writeToInbox(tmpDir, 'atomic test');
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath!)).toBe(true);

    // Check no .tmp files remain in the inbox directory
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    const files = fs.readdirSync(inboxDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);

    // Final file should end with -observation.json
    const jsonFiles = files.filter(f => f.endsWith('-observation.json') && !f.startsWith('.'));
    expect(jsonFiles.length).toBe(1);
  });

  test('handles missing git root gracefully', () => {
    const result = writeToInbox('', 'test');
    expect(result).toBeNull();
  });

  test('defaults pageUrl to unknown when not provided', () => {
    const filePath = writeToInbox(tmpDir, 'no url provided');
    expect(filePath).not.toBeNull();
    const data = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(data.page.url).toBe('unknown');
  });

  test('defaults sessionId to unknown when not provided', () => {
    const filePath = writeToInbox(tmpDir, 'no session');
    expect(filePath).not.toBeNull();
    const data = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(data.sidebarSessionId).toBe('unknown');
  });

  test('multiple writes create separate files', () => {
    writeToInbox(tmpDir, 'message 1');
    // Tiny delay to ensure different timestamps
    const t = Date.now();
    while (Date.now() === t) {} // spin until next ms
    writeToInbox(tmpDir, 'message 2');

    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(files.length).toBe(2);
  });
});
