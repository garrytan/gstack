import { describe, test, expect } from 'bun:test';
import { handleWriteCommand } from '../browse/src/write-commands';

describe('browse viewport auto/reset (#1059)', () => {
  test('viewport auto/reset/unpin resets viewport to default 1280x720', async () => {
    let capturedW = 0;
    let capturedH = 0;
    const fakeBm = {
      getCurrentViewport: () => ({ width: 375, height: 812 }),
      setViewport: async (w: number, h: number) => {
        capturedW = w;
        capturedH = h;
      },
    };
    const fakeSession = {
      getPage: () => ({
        url: () => 'http://localhost:3000',
      }),
      getActiveFrameOrPage: () => ({}),
      getFrame: () => null,
    };

    const resAuto = await handleWriteCommand('viewport', ['auto'], fakeSession as any, fakeBm as any);
    expect(resAuto).toBe('Viewport reset to default 1280x720');
    expect(capturedW).toBe(1280);
    expect(capturedH).toBe(720);

    const resReset = await handleWriteCommand('viewport', ['reset'], fakeSession as any, fakeBm as any);
    expect(resReset).toBe('Viewport reset to default 1280x720');
    expect(capturedW).toBe(1280);
    expect(capturedH).toBe(720);

    const resUnpin = await handleWriteCommand('viewport', ['unpin'], fakeSession as any, fakeBm as any);
    expect(resUnpin).toBe('Viewport reset to default 1280x720');
    expect(capturedW).toBe(1280);
    expect(capturedH).toBe(720);
  });
});
