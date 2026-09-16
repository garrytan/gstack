/**
 * The hero background.
 *
 * A layered atmospheric scene built from CSS gradients and SVG rather than
 * WebGL. It replaces a Three.js city that cost ~538KB of JavaScript on the
 * critical path to draw something the brief explicitly does not want (3D
 * buildings). Nothing here ships a runtime: gradients, two inline SVGs and
 * thirty absolutely-positioned dots.
 *
 * The composition follows the supplied reference — ambient glow top-right, a
 * large translucent organic form left-of-centre with an internal highlight, a
 * faceted polygon behind the headline, a crystal bottom-right, orbital vector
 * lines, a particle field, fine grain and an edge vignette. The reference is
 * teal with a chartreuse accent; this is PropIQ, so the same structure is
 * rendered in the brand's blue, cyan and violet on the product's own #070b16
 * ground. Structure copied, identity kept.
 *
 * Every layer is decorative: `aria-hidden`, `pointer-events-none`, and stacked
 * on negative z-indices inside an `isolate` container so nothing escapes into
 * the section below or sits over the content.
 */

import { PARTICLES, PARTICLE_COLOR } from './particles';

/* ------------------------------------------------------------ base + glow */

/**
 * The ground, plus the two large light sources.
 *
 * Three radial gradients over a shallow linear one. The point of the stack is
 * that no single edge is ever visible — a lone radial reads as a circle on a
 * flat field, which is the "generic SaaS gradient" failure mode.
 */
const AmbientGlow = () => (
  <>
    <div
      className="absolute inset-0 -z-10"
      style={{
        background:
          'radial-gradient(circle at 78% 18%, rgba(66, 201, 232, 0.30), transparent 34%),' +
          'radial-gradient(circle at 70% 72%, rgba(47, 107, 221, 0.24), transparent 36%),' +
          'radial-gradient(circle at 27% 50%, rgba(109, 85, 217, 0.18), transparent 48%),' +
          'linear-gradient(110deg, #070b16 0%, #070d1c 38%, #0b1730 70%, #070b16 100%)',
      }}
    />
    {/* Large atmospheric bloom behind the upper right, blurred past any edge. */}
    <div
      className="propiq-hero-breathe absolute -right-[5%] -top-[5%] -z-[9] size-[720px] max-w-[110vw] rounded-full blur-[70px] lg:size-[820px]"
      style={{
        background:
          'radial-gradient(circle, rgba(66,201,232,.30) 0%, rgba(47,107,221,.14) 30%, transparent 67%)',
      }}
    />
    {/* Low diffused light under the lower right. */}
    <div
      className="absolute -bottom-[8%] right-[2%] -z-[9] size-[520px] max-w-[110vw] rounded-full blur-[90px] lg:size-[660px]"
      style={{
        background:
          'radial-gradient(circle, rgba(47,107,221,.22) 0%, rgba(20,165,201,.10) 40%, transparent 70%)',
      }}
    />
    {/* Halo behind where the intelligence cards sit, so the panel reads as lit
        by the scene rather than pasted onto it. */}
    <div
      className="absolute right-[3%] top-[6%] -z-[9] hidden size-[480px] rounded-full blur-[60px] lg:block"
      style={{
        background: 'radial-gradient(circle, rgba(35,180,220,.18), transparent 68%)',
      }}
    />
  </>
);

/* ----------------------------------------------------------------- grain */

/**
 * Fine noise.
 *
 * Not a film-grain effect — at this opacity it is invisible as texture and only
 * does one job: break up the banding that large low-contrast gradients produce
 * on 8-bit displays.
 */
const NOISE_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E";

const NoiseOverlay = () => (
  <div
    className="absolute inset-0 -z-[8] opacity-[0.028] mix-blend-overlay"
    style={{ backgroundImage: `url("${NOISE_SVG}")`, backgroundSize: '160px 160px' }}
  />
);

/* ------------------------------------------------------------- particles */

const ParticleLayer = () => (
  <div className="absolute inset-0 -z-[7] overflow-hidden">
    {PARTICLES.map((p, i) => (
      <span
        key={`${p.x}-${p.y}`}
        className={`propiq-hero-drift absolute rounded-full ${
          p.tier === 'extra' ? 'hidden md:block' : ''
        }`}
        style={{
          left: `${p.x}%`,
          top: `${p.y}%`,
          width: p.size,
          height: p.size,
          background: PARTICLE_COLOR[p.hue],
          opacity: p.opacity,
          // Staggered so the field never pulses in unison.
          animationDelay: `${(i % 7) * 1.7}s`,
          animationDuration: `${18 + (i % 5) * 4}s`,
        }}
      />
    ))}
  </div>
);

/* --------------------------------------------------------- orbital lines */

/**
 * Two sweeping Bézier curves across the centre-left.
 *
 * Barely visible by design: they give the scene a scientific register without
 * drawing a bright arc across the headline.
 */
const OrbitalLines = () => (
  <svg
    className="absolute inset-0 -z-[6] size-full"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
    fill="none"
  >
    <path
      d="M 15 48 C 28 40, 42 52, 57 44"
      stroke="rgba(130,185,255,.42)"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
    />
    <path
      d="M 12 56 C 30 49, 46 60, 62 51"
      stroke="rgba(100,220,250,.26)"
      strokeWidth="0.8"
      vectorEffect="non-scaling-stroke"
    />
  </svg>
);

/* ------------------------------------------------------------- polygons */

/**
 * The faceted form behind the headline.
 *
 * Deliberately fragmented rather than a readable solid: a recognisable cube
 * would read as an illustration sitting behind the type. Muted violet and
 * slate-blue planes, mostly covered by the copy.
 */
const LeftPolygon = () => (
  <svg
    className="propiq-hero-float absolute left-[6%] top-[46%] -z-[5] w-[280px] opacity-95 lg:left-[9%] lg:w-[340px]"
    viewBox="0 0 200 200"
    fill="none"
  >
    <polygon points="100,18 168,62 132,104 76,84" fill="#4a3f7d" fillOpacity="0.62" />
    <polygon points="76,84 132,104 118,168 54,132" fill="#2a4676" fillOpacity="0.56" />
    <polygon points="168,62 186,128 118,168 132,104" fill="#2c4a5e" fillOpacity="0.5" />
    <polygon points="100,18 76,84 22,58 58,26" fill="#8a6a3c" fillOpacity="0.34" />
    <polygon points="22,58 76,84 54,132 14,104" fill="#1c3350" fillOpacity="0.62" />
  </svg>
);

/**
 * The crystal at the lower right, half-dissolved into the dark.
 */
const BottomCrystal = () => (
  <svg
    className="propiq-hero-float-slow absolute bottom-[5%] right-[8%] -z-[2] hidden w-[150px] opacity-80 blur-[0.4px] sm:block lg:w-[175px]"
    viewBox="0 0 160 160"
    fill="none"
  >
    <polygon points="80,10 146,54 112,92 44,68" fill="#2274b8" fillOpacity="0.42" />
    <polygon points="44,68 112,92 96,146 30,110" fill="#1f5f9d" fillOpacity="0.34" />
    <polygon points="146,54 154,112 96,146 112,92" fill="#236072" fillOpacity="0.26" />
    <polygon points="80,10 44,68 8,44 40,20" fill="#15455f" fillOpacity="0.3" />
  </svg>
);

/* ----------------------------------------------------------------- blob */

/**
 * The organic translucent form — the scene's primary object.
 *
 * An asymmetric `border-radius` morph rather than a circle or an SVG blob:
 * the eight-value syntax gives a genuinely organic silhouette that stays
 * resolution-independent and costs nothing to animate, since only `transform`
 * moves.
 *
 * Lighting runs left-dark to upper-right-bright, which is what makes it read
 * as inflated glass rather than a flat shape with a gradient on it.
 */
const OrganicBlob = () => (
  <div
    className="propiq-hero-blob absolute left-[35%] top-[18%] -z-[4] hidden size-[440px] lg:block lg:h-[450px] lg:w-[470px]"
    style={{
      borderRadius: '68% 32% 58% 42% / 38% 62% 38% 62%',
      background:
        'linear-gradient(135deg, rgba(47,107,221,.62) 0%, rgba(20,165,201,.56) 45%, rgba(109,85,217,.34) 100%)',
      filter: 'drop-shadow(0 0 90px rgba(66,201,232,.22))',
    }}
  >
    {/* Inner rim light: brighter along the upper-right surface. */}
    <div
      className="absolute inset-0"
      style={{
        borderRadius: 'inherit',
        background:
          'radial-gradient(ellipse 60% 55% at 72% 30%, rgba(140,230,250,.42), transparent 62%),' +
          'radial-gradient(ellipse 72% 66% at 16% 70%, rgba(5,8,18,.62), transparent 68%)',
      }}
    />
  </div>
);

/**
 * The highlight inside the blob.
 *
 * Blurred and off-centre so it reads as light caught inside a translucent
 * body, not a UI dot sitting on top of one.
 */
const BlobLight = () => (
  <div
    className="absolute left-[calc(35%+318px)] top-[calc(18%+150px)] -z-[3] hidden size-[30px] rounded-full blur-[7px] lg:block"
    style={{
      background: 'rgba(225,248,255,.78)',
      boxShadow:
        '0 0 10px rgba(225,248,255,.7), 0 0 28px rgba(66,201,232,.4), 0 0 65px rgba(47,107,221,.18)',
    }}
  />
);

/* ------------------------------------------------------------- vignette */

const Vignette = () => (
  <div
    className="absolute inset-0 -z-[1] opacity-75"
    style={{
      background:
        'radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,.15) 68%, rgba(0,0,0,.40) 100%)',
    }}
  />
);

/* ---------------------------------------------------------------- mobile */

/**
 * The phone recomposition.
 *
 * Not the desktop scene scaled down: the blob moves off the right edge so the
 * headline sits on clean ground, and the field thins out. Shrinking the
 * desktop coordinates would put the brightest object directly behind the copy.
 */
const MobileBlob = () => (
  <div
    className="propiq-hero-blob absolute -right-[150px] top-[120px] -z-[4] size-[340px] sm:size-[400px] lg:hidden"
    style={{
      borderRadius: '68% 32% 58% 42% / 38% 62% 38% 62%',
      background:
        'linear-gradient(135deg, rgba(47,107,221,.46) 0%, rgba(20,165,201,.38) 45%, rgba(109,85,217,.22) 100%)',
      filter: 'drop-shadow(0 0 50px rgba(66,201,232,.12))',
    }}
  />
);

/* ------------------------------------------------------------- composite */

export const HeroBackground = () => (
  <div
    aria-hidden
    // `-z-10` puts the whole scene behind the hero's own contrast wash, which
    // is the next sibling at the same depth and therefore paints over it.
    // `isolate` keeps the internal negative z-indices from escaping.
    className="pointer-events-none absolute inset-0 -z-10 select-none overflow-hidden"
    style={{ isolation: 'isolate' }}
  >
    <AmbientGlow />
    <NoiseOverlay />
    <ParticleLayer />
    <OrbitalLines />
    <LeftPolygon />
    <OrganicBlob />
    <MobileBlob />
    <BlobLight />
    <BottomCrystal />
    <Vignette />
  </div>
);
