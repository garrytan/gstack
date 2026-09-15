/**
 * The browser tab icon.
 *
 * The same typographic treatment as the wordmark, cropped to the half that
 * survives at 32px. This is not a logo: no logo asset has been supplied and
 * none is being approximated here. Replace it along with the wordmark when one
 * arrives — see `public/brand/README.md`.
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
        background: '#070b16',
        color: '#42c9e8',
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
