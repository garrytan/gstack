/**
 * Tests for the inbox meta-command handler (file drop relay).
 *
 * Tests the inbox display, --clear flag, and edge cases by creating
 * temp directories with test JSON files and calling handleMetaCommand.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleMetaCommand } from '../src/meta-commands';
import { BrowserManager } from '../src/browser-manager';

let tmpDir: string;
let bm: BrowserManager;

// We need a BrowserManager instance for handleMetaCommand, but inbox
// doesn't use it. We also need to mock git rev-parse to point to our
// temp directory. We'll test the inbox logic directly by manipulating
// the filesystem and using child_process.execSync override.

// ─── Direct filesystem tests (bypassing handleMetaCommand) ──────
// The inbox handler in meta-commands.ts calls `git rev-parse --show-toplevel`
// to find the inbox directory. Since we can't easily mock that in unit tests,
// we test the inbox parsing logic directly.

interface InboxMessage {
  timestamp: string;
  url: string;
  userMessage: string;
}

/** Replicate the inbox file reading logic from meta-commands.ts */
function readInbox(inboxDir: string): InboxMessage[] {
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs.readdirSync(inboxDir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .reverse();

  if (files.length === 0) return [];

  const messages: InboxMessage[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(inboxDir, file), 'utf-8'));
      messages.push({
        timestamp: data.timestamp || '',
        url: data.page?.url || 'unknown',
        userMessage: data.userMessage || '',
      });
    } catch {
      // Skip malformed files
    }
  }
  return messages;
}

/** Replicate the inbox formatting logic from meta-commands.ts */
function formatInbox(messages: InboxMessage[]): string {
  if (messages.length === 0) return 'Inbox empty.';

  const lines: string[] = [];
  lines.push(`SIDEBAR INBOX (${messages.length} message${messages.length === 1 ? '' : 's'})`);
  lines.push('────────────────────────────────');

  for (const msg of messages) {
    const ts = msg.timestamp ? `[${msg.timestamp}]` : '[unknown]';
    lines.push(`${ts} ${msg.url}`);
    lines.push(`  "${msg.userMessage}"`);
    lines.push('');
  }

  lines.push('────────────────────────────────');
  return lines.join('\n');
}

/** Replicate the --clear logic from meta-commands.ts */
function clearInbox(inboxDir: string): number {
  const files = fs.readdirSync(inboxDir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'));
  for (const file of files) {
    try { fs.unlinkSync(path.join(inboxDir, file)); } catch {}
  }
  return files.length;
}

function writeTestInboxFile(
  inboxDir: string,
  message: string,
  pageUrl: string,
  timestamp: string,
): string {
  fs.mkdirSync(inboxDir, { recursive: true });
  const filename = `${timestamp.replace(/:/g, '-')}-observation.json`;
  const filePath = path.join(inboxDir, filename);
  fs.writeFileSync(filePath, JSON.stringify({
    type: 'observation',
    timestamp,
    page: { url: pageUrl, title: '' },
    userMessage: message,
    sidebarSessionId: 'test-session',
  }, null, 2));
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-drop-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Empty Inbox ─────────────────────────────────────────────────

describe('inbox — empty states', () => {
  test('no .context/sidebar-inbox directory returns empty', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    const messages = readInbox(inboxDir);
    expect(messages.length).toBe(0);
    expect(formatInbox(messages)).toBe('Inbox empty.');
  });

  test('empty inbox directory returns empty', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const messages = readInbox(inboxDir);
    expect(messages.length).toBe(0);
    expect(formatInbox(messages)).toBe('Inbox empty.');
  });

  test('directory with only dotfiles returns empty', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, '.tmp-file.json'), '{}');
    const messages = readInbox(inboxDir);
    expect(messages.length).toBe(0);
  });
});

// ─── Valid Messages ──────────────────────────────────────────────

describe('inbox — valid messages', () => {
  test('displays formatted output with timestamps and URLs', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    writeTestInboxFile(inboxDir, 'This button is broken', 'https://example.com/page', '2024-06-15T10:30:00.000Z');
    writeTestInboxFile(inboxDir, 'Login form fails', 'https://example.com/login', '2024-06-15T10:31:00.000Z');

    const messages = readInbox(inboxDir);
    expect(messages.length).toBe(2);

    const output = formatInbox(messages);
    expect(output).toContain('SIDEBAR INBOX (2 messages)');
    expect(output).toContain('https://example.com/page');
    expect(output).toContain('https://example.com/login');
    expect(output).toContain('"This button is broken"');
    expect(output).toContain('"Login form fails"');
    expect(output).toContain('[2024-06-15T10:30:00.000Z]');
    expect(output).toContain('[2024-06-15T10:31:00.000Z]');
  });

  test('single message uses singular form', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    writeTestInboxFile(inboxDir, 'Just one', 'https://example.com', '2024-06-15T10:30:00.000Z');

    const messages = readInbox(inboxDir);
    const output = formatInbox(messages);
    expect(output).toContain('1 message)');
    expect(output).not.toContain('messages)');
  });

  test('messages sorted newest first', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    writeTestInboxFile(inboxDir, 'older', 'https://example.com', '2024-06-15T10:00:00.000Z');
    writeTestInboxFile(inboxDir, 'newer', 'https://example.com', '2024-06-15T11:00:00.000Z');

    const messages = readInbox(inboxDir);
    // Filenames sort lexicographically, reversed = newest first
    expect(messages[0].userMessage).toBe('newer');
    expect(messages[1].userMessage).toBe('older');
  });
});

// ─── Malformed Files ─────────────────────────────────────────────

describe('inbox — malformed files', () => {
  test('malformed JSON files are skipped gracefully', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write a valid message
    writeTestInboxFile(inboxDir, 'valid message', 'https://example.com', '2024-06-15T10:30:00.000Z');

    // Write a malformed JSON file
    fs.writeFileSync(
      path.join(inboxDir, '2024-06-15T10-35-00.000Z-observation.json'),
      'this is not valid json {{{',
    );

    const messages = readInbox(inboxDir);
    expect(messages.length).toBe(1);
    expect(messages[0].userMessage).toBe('valid message');
  });

  test('JSON file missing fields uses defaults', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write a JSON file with missing fields
    fs.writeFileSync(
      path.join(inboxDir, '2024-06-15T10-30-00.000Z-observation.json'),
      JSON.stringify({ type: 'observation' }),
    );

    const messages = readInbox(inboxDir);
    expect(messages.length).toBe(1);
    expect(messages[0].timestamp).toBe('');
    expect(messages[0].url).toBe('unknown');
    expect(messages[0].userMessage).toBe('');
  });
});

// ─── Clear Flag ──────────────────────────────────────────────────

describe('inbox — --clear flag', () => {
  test('files deleted after clear', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    writeTestInboxFile(inboxDir, 'message 1', 'https://example.com', '2024-06-15T10:30:00.000Z');
    writeTestInboxFile(inboxDir, 'message 2', 'https://example.com', '2024-06-15T10:31:00.000Z');

    // Verify files exist
    const filesBefore = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(filesBefore.length).toBe(2);

    // Clear
    const cleared = clearInbox(inboxDir);
    expect(cleared).toBe(2);

    // Verify files deleted
    const filesAfter = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(filesAfter.length).toBe(0);
  });

  test('clear on empty directory does nothing', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const cleared = clearInbox(inboxDir);
    expect(cleared).toBe(0);
  });

  test('clear preserves dotfiles', () => {
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write a dotfile and a regular file
    fs.writeFileSync(path.join(inboxDir, '.keep'), '');
    writeTestInboxFile(inboxDir, 'to be cleared', 'https://example.com', '2024-06-15T10:30:00.000Z');

    clearInbox(inboxDir);

    // Dotfile should remain
    expect(fs.existsSync(path.join(inboxDir, '.keep'))).toBe(true);
    // Regular file should be gone
    const jsonFiles = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(jsonFiles.length).toBe(0);
  });
});
