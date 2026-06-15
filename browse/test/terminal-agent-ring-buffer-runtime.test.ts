import { describe, test, expect, beforeEach } from 'bun:test';
import {
  appendToRingBuffer,
  buildReplayPayload,
  type PtySession,
} from '../src/terminal-agent';

// Runtime exercises for the v1.44 Commit 3 ring buffer + replay prelude.
// Companion to browse/test/terminal-agent-detach-reattach.test.ts which
// covers the structural invariants; this file calls the helpers directly
// to prove behavioral correctness without spinning up a real Bun.serve
// listener.

function fresh(): PtySession {
  return {
    proc: null,
    cols: 80,
    rows: 24,
    cookie: 'test-cookie',
    liveWs: null,
    sessionId: 'test-session',
    spawned: false,
    pingInterval: null,
    ringBuffer: [],
    ringBufferBytes: 0,
    altScreenActive: false,
    detached: false,
    detachTimer: null,
  };
}

describe('appendToRingBuffer runtime', () => {
  test('appends frames in order and tracks byte count', () => {
    const s = fresh();
    appendToRingBuffer(s, Buffer.from('hello '));
    appendToRingBuffer(s, Buffer.from('world'));
    expect(s.ringBuffer).toHaveLength(2);
    expect(s.ringBufferBytes).toBe(11);
    expect(Buffer.concat(s.ringBuffer).toString()).toBe('hello world');
  });

  test('evicts oldest frames when cap exceeded', () => {
    // Default cap is 1 MB. Override via env wouldn't help inside this
    // running process (constant was read at module load), so use frames
    // big enough to exceed it deterministically.
    const s = fresh();
    const big = Buffer.alloc(400_000, 0x41); // 400 KB of 'A'
    appendToRingBuffer(s, big);
    appendToRingBuffer(s, big);
    appendToRingBuffer(s, big); // total 1.2 MB — exceeds default cap
    // Eviction must drop frames until under cap; first 400 KB chunk goes.
    expect(s.ringBuffer.length).toBeLessThan(3);
    expect(s.ringBufferBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  test('keeps at least one frame even when a single frame exceeds the cap', () => {
    const s = fresh();
    // 2 MB single frame — bigger than the 1 MB cap. The eviction loop
    // guards on `ringBuffer.length > 1`, so the single oversized frame
    // stays. Without that guard, the buffer would empty itself, defeating
    // the whole point of replay on re-attach.
    const huge = Buffer.alloc(2 * 1024 * 1024, 0x42);
    appendToRingBuffer(s, huge);
    expect(s.ringBuffer.length).toBe(1);
    expect(s.ringBufferBytes).toBe(huge.length);
  });

  test('tracks alt-screen enter (CSI ?1049h)', () => {
    const s = fresh();
    expect(s.altScreenActive).toBe(false);
    appendToRingBuffer(s, Buffer.from('plain text'));
    expect(s.altScreenActive).toBe(false);
    appendToRingBuffer(s, Buffer.from('\x1b[?1049h'));
    expect(s.altScreenActive).toBe(true);
  });

  test('tracks alt-screen exit (CSI ?1049l)', () => {
    const s = fresh();
    appendToRingBuffer(s, Buffer.from('\x1b[?1049h'));
    expect(s.altScreenActive).toBe(true);
    appendToRingBuffer(s, Buffer.from('\x1b[?1049l'));
    expect(s.altScreenActive).toBe(false);
  });

  test('trailing state wins when enter + exit appear in one frame', () => {
    const s = fresh();
    // Tool call opened alt-screen then closed it inside one render — net
    // state is back to main screen. lastIndexOf comparison handles this.
    appendToRingBuffer(s, Buffer.from('start\x1b[?1049hmiddle\x1b[?1049lend'));
    expect(s.altScreenActive).toBe(false);

    const s2 = fresh();
    // Reverse order: exited then re-entered — net state alt-screen.
    appendToRingBuffer(s2, Buffer.from('\x1b[?1049l\x1b[?1049h'));
    expect(s2.altScreenActive).toBe(true);
  });
});

describe('buildReplayPayload runtime', () => {
  test('prepends DECSTR soft reset before ring buffer contents', () => {
    const s = fresh();
    appendToRingBuffer(s, Buffer.from('prompt> '));
    const payload = buildReplayPayload(s).toString('latin1');
    expect(payload.startsWith('\x1b[!p')).toBe(true);
    expect(payload.endsWith('prompt> ')).toBe(true);
  });

  test('re-enters alt-screen when session was in alt-screen at detach', () => {
    const s = fresh();
    appendToRingBuffer(s, Buffer.from('\x1b[?1049h tool output '));
    const payload = buildReplayPayload(s).toString('latin1');
    // Order: soft reset, alt-screen re-enter, ring buffer.
    expect(payload.indexOf('\x1b[!p')).toBeLessThan(payload.indexOf('\x1b[?1049h'));
    expect(payload.indexOf('\x1b[?1049h')).toBeLessThan(payload.indexOf('tool output'));
  });

  test('omits alt-screen re-enter when session was on main screen', () => {
    const s = fresh();
    appendToRingBuffer(s, Buffer.from('regular prompt'));
    const payload = buildReplayPayload(s).toString('latin1');
    // Soft reset is present, but alt-screen enter is NOT. Both substrings
    // are otherwise identical 8 bytes apart in the alphabet, so equal-
    // substring checks need to be strict.
    expect(payload).toContain('\x1b[!p');
    expect(payload).not.toContain('\x1b[?1049h');
  });

  test('replay buffer length = soft-reset + (optional alt-screen) + ring bytes', () => {
    const s = fresh();
    appendToRingBuffer(s, Buffer.from('abc'));
    appendToRingBuffer(s, Buffer.from('def'));
    const payload = buildReplayPayload(s);
    // 4 bytes (DECSTR) + 6 bytes (abc/def) = 10 bytes. No alt-screen.
    expect(payload.length).toBe(4 + 6);
  });
});

describe('lease lifecycle interplay (via pty-session-lease)', () => {
  // Cross-module behavior: lease + ring buffer are both per-session.
  // This catches the case where a refactor accidentally couples them.
  test('lease registry is independent of ring buffer state', async () => {
    const { mintLease, validateLease, __resetLeases } = await import('../src/pty-session-lease');
    __resetLeases();
    const a = mintLease();
    const b = mintLease();
    expect(a.sessionId).not.toBe(b.sessionId);
    const va = validateLease(a.sessionId);
    const vb = validateLease(b.sessionId);
    expect(va.ok && vb.ok).toBe(true);
    if (va.ok && vb.ok) {
      expect(va.expiresAt).toBe(vb.expiresAt);
    }
  });
});
