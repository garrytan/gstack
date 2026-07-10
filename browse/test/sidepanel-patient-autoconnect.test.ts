import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// v1.44 patient autoConnect — static-grep invariants for the polling loop.
//
// Pre-v1.44 the sidebar gave up at 15s with "Browse server not ready.
// Reload sidebar to retry." Cold-start the browse server takes ~3-8s on a
// healthy laptop, longer on Conductor workspaces / slow CI, so the user
// frequently saw the failure message even when nothing was wrong. The
// fix: poll forever with ascending status messages and only abort on
// explicit unrecoverable signals (401 auth invalid).

const CLIENT_JS = path.resolve(
  new URL(import.meta.url).pathname,
  '..',
  '..',
  '..',
  'extension',
  'sidepanel-terminal.js',
);

describe('sidepanel tryAutoConnect patience (v1.44+)', () => {
  test('1. no 15s give-up message', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    // The v0.x give-up string must NOT reappear — it's the message users
    // saw on every cold start and the whole point of v1.44 was to delete it.
    expect(src).not.toContain('Browse server not ready. Reload sidebar to retry.');
  });

  test('2. ascending status messages at 15s / 60s / 5min', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    expect(src).toContain('Waiting for browse server...');
    expect(src).toContain('Still waiting');
    expect(src).toContain('still not responding after 5 min');
  });

  test('3. sticky abort flag prevents loop spam on 401', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    expect(src).toContain('autoConnectAborted');
    // The mint failure branch must short-circuit on 401 specifically.
    expect(src).toMatch(/minted\.error.*startsWith\('401'\)/);
    // tryAutoConnect tick must respect the flag.
    expect(src).toMatch(/if \(autoConnectAborted\) return/);
  });

  test('4. forceRestart re-arms the loop by clearing the abort flag', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    // forceRestart is the user's "try again" escape hatch — must reset
    // the sticky flag or 401-once means stuck-forever.
    const block = sliceBetween(src, 'function forceRestart', 'function repaintIfLive');
    expect(block).toContain('autoConnectAborted = false');
  });

  test('5. poll interval is 2s, not the legacy 200ms tight loop', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    // 200ms ticks burned CPU and made the give-up window land too fast.
    // 2s is the v1.44 cadence — verify the tight-loop literal is gone.
    expect(src).toContain('setTimeout(tick, 2000)');
    expect(src).not.toContain('setTimeout(tick, 200)');
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
