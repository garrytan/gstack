import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// v1.44 Commit 3 — client-side re-attach loop.
//
// On unexpected WS close (anything other than clean 1000 / 4001 / 4404),
// the sidebar now silently posts /pty-session/reattach with backoff,
// opens a new WS with the fresh attachToken, writes RIS to xterm when
// the agent sends {type:"reattach-begin"}, then treats the next binary
// frame as the scrollback replay payload. Static-grep tripwires defend
// the load-bearing protocol invariants; live re-attach exercises belong
// in the e2e tier.

const TERMINAL_JS = path.resolve(
  new URL(import.meta.url).pathname, '..', '..', '..', 'extension', 'sidepanel-terminal.js',
);

describe('sidepanel re-attach loop (v1.44+ Commit 3)', () => {
  test('1. STATE.RECONNECTING exists for the in-flight re-attach window', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    expect(src).toContain("RECONNECTING: 'reconnecting'");
  });

  test('2. backoff schedule matches the eng-review plan (1s/2s/4s/8s, 60s window)', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    expect(src).toContain('REATTACH_BACKOFF_MS = [1000, 2000, 4000, 8000]');
    expect(src).toContain('REATTACH_WINDOW_MS = 60_000');
  });

  test('3. startReattachLoop posts /pty-session/reattach with sessionId', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    expect(src).toMatch(/function startReattachLoop\(prevSessionId\)/);
    const block = sliceBetween(src, 'function startReattachLoop', 'function openReattachWebSocket');
    expect(block).toContain('/pty-session/reattach');
    expect(block).toContain('sessionId: prevSessionId');
  });

  test('4. 410 Gone from re-attach short-circuits to ENDED (no retry loop)', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    const block = sliceBetween(src, 'function startReattachLoop', 'function openReattachWebSocket');
    // 410 = lease window expired. Retrying wouldn't help; fall through
    // so the user clicks Restart for a fresh session.
    expect(block).toContain('resp.status === 410');
    expect(block).toContain('setState(STATE.ENDED)');
  });

  test('5. 401 from re-attach sticky-aborts auto-connect', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    const block = sliceBetween(src, 'function startReattachLoop', 'function openReattachWebSocket');
    expect(block).toContain('resp.status === 401');
    expect(block).toContain('autoConnectAborted = true');
  });

  test('6. openReattachWebSocket handles {type:"reattach-begin"} → RIS to xterm', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    const block = sliceBetween(src, 'function openReattachWebSocket', 'async function checkClaudeAvailable');
    expect(block).toContain("msg.type === 'reattach-begin'");
    // RIS (\x1bc) is the full-reset escape that clears xterm cleanly
    // before the replay binary arrives.
    expect(block).toContain("term.write('\\x1bc')");
    expect(block).toContain('nextBinaryIsReplay = true');
  });

  test('7. live connect()/forceRestart() close handlers trigger re-attach on transient close', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    // Both the connect() and forceRestart() close handlers must route
    // through startReattachLoop for non-clean codes. Count = 3
    // (open-reattach close handler + connect close + forceRestart close).
    const occurrences = (src.match(/startReattachLoop\(currentSessionId\)/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  test('8. clean codes (1000 / 4001 / 4404) bypass the re-attach loop', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    // The branch guard MUST exclude these codes from re-attach. 1000 =
    // PTY exited (claude quit), 4001 = intentional restart, 4404 = no
    // claude on PATH. Re-attaching in those cases would be wasted work
    // (or actively wrong — a force-restart that re-attaches to its own
    // pre-restart session is the bug we're avoiding).
    expect(src).toContain('code === 1000');
    expect(src).toContain('code === 4001');
    expect(src).toContain('code === 4404');
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
