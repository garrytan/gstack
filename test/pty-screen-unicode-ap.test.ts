import {expect, test} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createPtyScreen} from './helpers/pty-screen';

const frame = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/pty-screen/unicode-redraw-ap.json'), 'utf8'));

test('public emoji redraw overwrites the old option cell without changing question text', async () => {
  for (const chunkSize of [1, 7, 4096]) {
    const screen = await createPtyScreen(frame.cols, frame.rows);
    try {
      screen.write(frame.initial);
      for (let i = 0; i < frame.update.length; i += chunkSize) screen.write(frame.update.slice(i, i + chunkSize));
      expect(await screen.read()).toBe(frame.expected + '\n\n');
    } finally { await screen.dispose(); }
  }
});

test('ASCII, CJK and emoji occupy the columns used by absolute cursor redraws', async () => {
  for (const [text, width] of [['A', 1], ['界', 2], ['❌', 2], ['✅', 2], ['😀', 2]] as const) {
    const screen = await createPtyScreen(12, 2);
    try {
      // If the glyph is too narrow, a stale x survives before the marker.
      screen.write('xxxxxxxx\r' + text + `\x1b[${width + 1}G!\x1b[K`);
      expect(await screen.read()).toBe(text + '!\n');
    } finally { await screen.dispose(); }
  }
});

test('combining acute, variation selector and joiner do not consume a scalar column', async () => {
  for (const mark of ['\u0301', '\ufe0f', '\u200d']) {
    const screen = await createPtyScreen(12, 2);
    try {
      screen.write('xxxxxxxx\re' + mark + '\x1b[2G!\x1b[K');
      expect(await screen.read()).toBe('e' + mark + '!\n');
    } finally { await screen.dispose(); }
  }
});

test('control bytes retain carriage-return, line-feed and erase behavior around wide cells', async () => {
  const screen = await createPtyScreen(12, 3);
  try {
    screen.write('界X\0\x07\rA\x1b[K\r\n❌Z\x1b[3G!\x1b[K');
    expect(await screen.read()).toBe('A\n❌!\n');
    screen.write('\x1b[2J\x1b[Hdone');
    expect(await screen.read()).toBe('done\n\n');
  } finally { await screen.dispose(); }
});

test('split surrogate and ANSI sequences preserve the same wide-character viewport', async () => {
  const raw = 'xxxxxxxx\r😀\x1b[3G!\x1b[K';
  for (let boundary = 0; boundary <= raw.length; boundary++) {
    const screen = await createPtyScreen(12, 2);
    try {
      screen.write(raw.slice(0, boundary));
      screen.write(raw.slice(boundary));
      expect(await screen.read()).toBe('😀!\n');
    } finally { await screen.dispose(); }
  }
});

test('Unicode screen state remains local and final writes drain on disposal', async () => {
  const a = await createPtyScreen(12, 2);
  const b = await createPtyScreen(12, 2);
  try {
    a.write('xxxxxxxx\r❌\x1b[3G!\x1b[K');
    b.write('untouched');
    const closing = a.dispose();
    await closing;
    expect(await a.read()).toBe('❌!\n');
    expect(await b.read()).toBe('untouched\n');
    expect(a.dispose()).toBe(closing);
    expect(() => a.write('late')).toThrow('disposed');
  } finally { await a.dispose(); await b.dispose(); }
});
