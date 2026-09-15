/**
 * The Open Graph card.
 *
 * Generated rather than hand-drawn so it cannot drift from the brand, and
 * deliberately free of figures: a share card is the one surface where a number
 * travels with no banner, no data-status chip and no methodology link beside
 * it. Brand, promise and tagline only.
 *
 * This is the same typographic treatment the site falls back to while no logo
 * asset is supplied. When one is dropped into `public/brand/`, replace this
 * card too — see `public/brand/README.md`.
 */

import { ImageResponse } from 'next/og';

export const alt = 'PropIQ by CiteRank AI — Find the right property. Understand the opportunity.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#070b16',
        padding: 72,
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div style={{ display: 'flex', fontSize: 46, fontWeight: 700, letterSpacing: -1 }}>
          <span style={{ color: '#f3f6fb' }}>Prop</span>
          <span style={{ color: '#42c9e8' }}>IQ</span>
        </div>
        <div
          style={{
            color: '#8e9ab2',
            fontSize: 19,
            letterSpacing: 4,
            textTransform: 'uppercase',
          }}
        >
          by CiteRank AI
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            color: '#f3f6fb',
            fontSize: 68,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -2,
          }}
        >
          Find the Right Property.
        </div>
        <div
          style={{
            color: '#5b8def',
            fontSize: 68,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -2,
          }}
        >
          Understand the Opportunity.
        </div>
        <div style={{ color: '#a8b4cb', fontSize: 26, marginTop: 26 }}>
          Cities. Insights. Growth.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div
          style={{
            height: 5,
            width: '100%',
            background: 'linear-gradient(100deg, #2f6bdd 0%, #14a5c9 48%, #6d55d9 100%)',
          }}
        />
        <div style={{ color: '#8e9ab2', fontSize: 21 }}>
          Published scoring · 95% confidence bands · the evidence behind every number
        </div>
      </div>
    </div>,
    size,
  );
}
