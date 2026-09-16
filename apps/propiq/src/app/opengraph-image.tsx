/**
 * The Open Graph card.
 *
 * Generated rather than hand-drawn so it cannot drift from the brand, and
 * deliberately free of figures: a share card is the one surface where a number
 * travels with no banner, no data-status chip and no methodology link beside
 * it. Brand, promise and tagline only.
 *
 * The card's ground is dark, so it takes the glyph cut of the supplied logo
 * (alpha, reads on either ground) rather than the full lockup, whose near-black
 * wordmark is designed for a light ground. The glyph is read off disk at render
 * rather than inlined as a base64 literal, so the card tracks the asset.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'PropIQ by CiteRank AI — Find the right property. Understand the opportunity.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const markDataUri = (): string | undefined => {
  try {
    const bytes = readFileSync(join(process.cwd(), 'public', 'brand', 'propiq-mark.png'));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    // No asset supplied: the card falls back to the wordmark alone rather than
    // failing the whole route over a decoration.
    return undefined;
  }
};

export default function OpengraphImage() {
  const mark = markDataUri();

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#06201f',
        padding: 72,
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {mark !== undefined && (
          // A bare <img>, not next/image: Satori rasterises this tree itself,
          // so there is no browser to optimise for and no loader to run.
          <img src={mark} alt="" width={98} height={60} />
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <div style={{ display: 'flex', fontSize: 46, fontWeight: 700, letterSpacing: -1 }}>
            <span style={{ color: '#eef5f0' }}>Prop</span>
            <span style={{ color: '#6fdcd2' }}>IQ</span>
          </div>
          <div
            style={{
              color: '#9fb3ad',
              fontSize: 19,
              letterSpacing: 4,
              textTransform: 'uppercase',
            }}
          >
            by CiteRank AI
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            color: '#eef5f0',
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
            color: '#6fdcd2',
            fontSize: 68,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -2,
          }}
        >
          Understand the Opportunity.
        </div>
        <div style={{ color: '#a9bcb6', fontSize: 26, marginTop: 26 }}>
          Cities. Insights. Growth.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div
          style={{
            height: 5,
            width: '100%',
            background: 'linear-gradient(100deg, #2ba79b 0%, #4fd1c5 48%, #6d55d9 100%)',
          }}
        />
        <div style={{ color: '#9fb3ad', fontSize: 21 }}>
          Published scoring · 95% confidence bands · the evidence behind every number
        </div>
      </div>
    </div>,
    size,
  );
}
