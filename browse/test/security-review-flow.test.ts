/**
 * Review-on-BLOCK regression tests.
 *
 * Covers the user-in-the-loop path added to resolve false positives on
 * benign developer content (e.g., HN comments discussing a prompt injection
 * incident getting flagged as prompt injection). Instead of hard-stopping
 * the session on a tool-output BLOCK, the agent emits a reviewable
 * security_event and polls for the user's decision via a per-tab file.
 *
 * These tests pin the file-based handshake and the excerpt sanitization.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeDecision,
  readDecision,
  clearDecision,
  decisionFileForTab,
  excerptForReview,
  type Verdict,
} from '../src/security';

const ORIG_HOME = process.env.HOME;
let tmpHome = '';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-review-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('security decision file handshake', () => {
  test('writeDecision + readDecision round-trips', () => {
    // SECURITY_DIR is computed at module load time from the original HOME.
    // The function writes relative to its own SECURITY_DIR constant, so we
    // verify the API shape rather than the exact path. The file lives where
    // decisionFileForTab says it does.
    const file = decisionFileForTab(42);
    expect(file.endsWith('/tab-42.json')).toBe(true);

    // Ensure the directory exists (writeDecision creates it).
    writeDecision({ tabId: 42, decision: 'allow', ts: new Date().toISOString(), reason: 'user' });
    const rec = readDecision(42);
    expect(rec).not.toBeNull();
    expect(rec?.tabId).toBe(42);
    expect(rec?.decision).toBe('allow');
    expect(rec?.reason).toBe('user');
  });

  test('clearDecision removes the file', () => {
    writeDecision({ tabId: 7, decision: 'block', ts: new Date().toISOString() });
    expect(readDecision(7)).not.toBeNull();
    clearDecision(7);
    expect(readDecision(7)).toBeNull();
  });

  test('readDecision returns null for a tab with no decision', () => {
    expect(readDecision(99999)).toBeNull();
  });

  test('writeDecision + readDecision handles both values', () => {
    writeDecision({ tabId: 1, decision: 'allow', ts: '2026-04-20T12:00:00Z' });
    writeDecision({ tabId: 2, decision: 'block', ts: '2026-04-20T12:00:01Z' });
    expect(readDecision(1)?.decision).toBe('allow');
    expect(readDecision(2)?.decision).toBe('block');
  });

  test('atomic write: temp file is cleaned up after rename', () => {
    writeDecision({ tabId: 10, decision: 'allow', ts: new Date().toISOString() });
    const file = decisionFileForTab(10);
    const dir = path.dirname(file);
    const leftover = fs.readdirSync(dir).filter((f) => f.startsWith('tab-10.json.tmp'));
    expect(leftover.length).toBe(0);
  });

  test('file perms are 0600 on the decision file', () => {
    writeDecision({ tabId: 3, decision: 'allow', ts: new Date().toISOString() });
    const stat = fs.statSync(decisionFileForTab(3));
    // mode & 0o777 = lower 9 bits of permission
    const perms = stat.mode & 0o777;
    // On some filesystems the sticky/group bits may vary; we assert the
    // owner-only pattern.
    expect(perms & 0o077).toBe(0); // no group/other read or write
  });
});

describe('excerptForReview sanitization', () => {
  test('passes short clean text through', () => {
    expect(excerptForReview('hello world')).toBe('hello world');
  });

  test('truncates at the default max with ellipsis', () => {
    const long = 'a'.repeat(800);
    const out = excerptForReview(long);
    expect(out.length).toBe(501); // 500 chars + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  test('strips control chars that would break the UI', () => {
    const input = 'before\x00\x01\x02\x1Fafter';
    expect(excerptForReview(input)).toBe('beforeafter');
  });

  test('collapses whitespace for compact display', () => {
    expect(excerptForReview('foo   \n\n\t  bar')).toBe('foo bar');
  });

  test('returns empty string for empty input', () => {
    expect(excerptForReview('')).toBe('');
    expect(excerptForReview(null as any)).toBe('');
  });

  test('custom max parameter', () => {
    expect(excerptForReview('abcdefghij', 5)).toBe('abcde…');
  });
});

describe('Verdict type includes user_overrode', () => {
  test('user_overrode is a valid Verdict value', () => {
    // TypeScript compile-time check that the type accepts the value.
    // If 'user_overrode' were removed from the Verdict union, this file
    // would fail to type-check.
    const v: Verdict = 'user_overrode';
    expect(v).toBe('user_overrode');
  });
});

describe('review-flow smoke — simulated sidebar-agent poll loop', () => {
  test('agent-side poll sees user allow decision', async () => {
    const tabId = 123;
    clearDecision(tabId);

    // Simulate the sidepanel POST happening after a short delay.
    setTimeout(() => {
      writeDecision({ tabId, decision: 'allow', ts: new Date().toISOString(), reason: 'user' });
    }, 50);

    // Simulate the sidebar-agent poll loop.
    const deadline = Date.now() + 2000;
    let decision: 'allow' | 'block' | null = null;
    while (Date.now() < deadline) {
      const rec = readDecision(tabId);
      if (rec?.decision) {
        decision = rec.decision;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(decision).toBe('allow');
  });

  test('agent-side poll sees user block decision', async () => {
    const tabId = 456;
    clearDecision(tabId);
    setTimeout(() => {
      writeDecision({ tabId, decision: 'block', ts: new Date().toISOString() });
    }, 50);

    const deadline = Date.now() + 2000;
    let decision: 'allow' | 'block' | null = null;
    while (Date.now() < deadline) {
      const rec = readDecision(tabId);
      if (rec?.decision) {
        decision = rec.decision;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(decision).toBe('block');
  });

  test('poll times out when no decision arrives', async () => {
    const tabId = 789;
    clearDecision(tabId);

    const deadline = Date.now() + 200;
    let decision: 'allow' | 'block' | null = null;
    while (Date.now() < deadline) {
      const rec = readDecision(tabId);
      if (rec?.decision) {
        decision = rec.decision;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(decision).toBeNull();
  });
});
