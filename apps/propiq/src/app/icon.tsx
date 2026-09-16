/**
 * The browser tab icon.
 *
 * The same typographic treatment as the wordmark, cropped to the half that
 * survives at 32px. The supplied logo is deliberately NOT used here: its glyph
 * is a three-dimensional ribbon threading a skyline, and at 32px that resolves
 * to a coloured smudge with no recognisable shape. A favicon has to survive one
 * square centimetre; two letters do, that drawing does not.
 */

import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#06201f',
        color: '#6fdcd2',
        fontSize: 19,
        fontWeight: 700,
        letterSpacing: -1,
        fontFamily: 'sans-serif',
      }}
    >
      IQ
    </div>,
    size,
  );
}
