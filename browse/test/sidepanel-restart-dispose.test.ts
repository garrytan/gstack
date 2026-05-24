import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// v1.44 Commit 2C — client-side restart + dispose wiring.
//
// Pre-v1.44 forceRestart only closed the client WS and disposed xterm;
// the old PTY died asynchronously via the agent's WS close handler.
// Race window between kill and mint, two claude instances briefly,
// no prompt visible until the user typed.
//
// Now forceRestart POSTs /pty-restart (one transaction: dispose + mint),
// opens the new WS with the fresh attachToken from the response, and
// sends {type:"start"} for the eager spawn. pagehide handler in
// sidepanel.js sendBeacon /pty-dispose so browser quit / panel close
// doesn't leak a 60s-zombie claude.

const TERMINAL_JS = path.resolve(
  new URL(import.meta.url).pathname, '..', '..', '..', 'extension', 'sidepanel-terminal.js',
);
const SIDEPANEL_JS = path.resolve(
  new URL(import.meta.url).pathname, '..', '..', '..', 'extension', 'sidepanel.js',
);

describe('sidepanel-terminal: forceRestart via /pty-restart (v1.44+)', () => {
  test('1. mintSession callers read the 4-tuple (sessionId + attachToken)', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    // The new shape lands in `minted.sessionId` and `minted.attachToken`.
    expect(src).toContain('const { terminalPort, sessionId } = minted');
    expect(src).toContain('minted.attachToken || minted.ptySessionToken');
    // Backward-compat fallback to ptySessionToken kept so a partially-
    // updated extension still works against a fresh server.
  });

  test('2. eager spawn via {type:"start"} on ws.open', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    // Replaces the legacy `ws.send(TextEncoder().encode("\\n"))` newline
    // hack that nudged the lazy-binary-spawn.
    expect(src).toMatch(/ws\.send\(JSON\.stringify\(\{\s*type:\s*'start'\s*\}\)\)/);
    expect(src).not.toContain("TextEncoder().encode('\\n')");
  });

  test('3. forceRestart sends 4001 close code (intentional restart)', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    expect(src).toMatch(/ws\.close\(4001/);
  });

  test('4. forceRestart POSTs /pty-restart with current sessionId', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    expect(src).toContain('/pty-restart');
    expect(src).toContain('priorSessionId ? { sessionId: priorSessionId } : {}');
  });

  test('5. forceRestart 401 triggers sticky abort (no spam loop)', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    // Same defense pattern as connect() — 401 must flip the sticky flag
    // or every 2s the user sees a fresh "Auth invalid" message.
    const block = sliceBetween(src, 'async function forceRestart', 'function repaintIfLive');
    expect(block).toContain('resp.status === 401');
    expect(block).toContain('autoConnectAborted = true');
  });

  test('6. currentSessionId is exposed on window for sidepanel.js pagehide', () => {
    const src = fs.readFileSync(TERMINAL_JS, 'utf-8');
    expect(src).toContain('window.gstackPtySession = currentSessionId');
  });
});

describe('sidepanel: pagehide → sendBeacon /pty-dispose (v1.44+)', () => {
  test('7. pagehide handler fires sendBeacon to /pty-dispose', () => {
    const src = fs.readFileSync(SIDEPANEL_JS, 'utf-8');
    expect(src).toMatch(/window\.addEventListener\('pagehide'/);
    expect(src).toContain('navigator.sendBeacon');
    expect(src).toContain('/pty-dispose');
  });

  test('8. pagehide payload carries sessionId + authToken in body (sendBeacon-compat)', () => {
    const src = fs.readFileSync(SIDEPANEL_JS, 'utf-8');
    // sendBeacon can't set custom headers — server route accepts body-auth.
    // Both fields must be in the payload or the server rejects.
    expect(src).toMatch(/JSON\.stringify\(\{\s*sessionId,\s*authToken\s*\}\)/);
    expect(src).toContain('window.gstackPtySession');
    expect(src).toContain('window.gstackAuthToken');
  });

  test('9. pagehide handler is best-effort (try/catch swallows failures)', () => {
    const src = fs.readFileSync(SIDEPANEL_JS, 'utf-8');
    // The 60s detach window catches any sendBeacon that fails, so the
    // handler MUST not throw — uncaught throws can interfere with the
    // browser's unload sequence. Slice between pagehide and end-of-file
    // (it's the last addEventListener in sidepanel.js by design).
    const i = src.indexOf("addEventListener('pagehide'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i);
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/} catch /);
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
