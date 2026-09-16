/**
 * The intelligence node — PropIQ's one visual motif.
 *
 * A node is a small luminous data point; a path is the inference between two
 * of them. That is the whole vocabulary, and it is the same vocabulary the
 * product uses in prose: evidence points, and a score that is the line drawn
 * between them. It appears in the hero scene, behind the score, at section
 * seams and in the footer, and nowhere else — a motif used everywhere stops
 * being a motif.
 *
 * Everything here is SVG plus CSS. No WebGL, no animation library, no canvas.
 * Three reasons, in order of how much they matter:
 *
 *  1. The text is real text. A hero whose headline lives inside a canvas is a
 *     hero with no headline as far as a crawler or a screen reader is
 *     concerned, and this product's whole argument is that it is legible.
 *  2. It costs no JavaScript, so there is no low-power fallback to maintain —
 *     the fallback is the thing itself.
 *  3. Only `transform` and `opacity` animate, so every frame is composited.
 */

import { cn } from '@/lib/utils';

export interface SceneNode {
  /** Percentage coordinates within the scene box. */
  readonly x: number;
  readonly y: number;
  /** Visual weight: a primary node is a subject, a trace is context. */
  readonly kind: 'primary' | 'trace';
  /** Seconds of delay, so the field never pulses in unison. */
  readonly delay: number;
}

export interface ScenePath {
  readonly from: number;
  readonly to: number;
  readonly delay: number;
}

/**
 * The node field.
 *
 * Deliberately a fixed, hand-placed constellation rather than a random one.
 * Randomised points cluster and leave holes, and re-randomising per render
 * would make the scene flicker between server and client.
 */
export const CITY_NODES: readonly SceneNode[] = [
  { x: 18, y: 62, kind: 'primary', delay: 0 },
  { x: 31, y: 44, kind: 'trace', delay: 1.4 },
  { x: 44, y: 70, kind: 'trace', delay: 2.1 },
  { x: 52, y: 33, kind: 'primary', delay: 0.7 },
  { x: 63, y: 58, kind: 'trace', delay: 3.2 },
  { x: 71, y: 28, kind: 'trace', delay: 1.9 },
  { x: 79, y: 51, kind: 'primary', delay: 2.6 },
  { x: 88, y: 37, kind: 'trace', delay: 0.4 },
  { x: 26, y: 24, kind: 'trace', delay: 3.8 },
  { x: 38, y: 86, kind: 'trace', delay: 1.1 },
  { x: 68, y: 79, kind: 'trace', delay: 2.9 },
  { x: 92, y: 68, kind: 'trace', delay: 0.9 },
];

export const CITY_PATHS: readonly ScenePath[] = [
  { from: 0, to: 1, delay: 0 },
  { from: 1, to: 3, delay: 0.6 },
  { from: 3, to: 5, delay: 1.2 },
  { from: 5, to: 7, delay: 1.8 },
  { from: 3, to: 4, delay: 2.4 },
  { from: 4, to: 6, delay: 3.0 },
  { from: 0, to: 2, delay: 3.6 },
  { from: 2, to: 4, delay: 4.2 },
  { from: 8, to: 1, delay: 4.8 },
  { from: 9, to: 2, delay: 5.4 },
  { from: 10, to: 6, delay: 6.0 },
  { from: 6, to: 11, delay: 6.6 },
];

/**
 * The motif, drawn.
 *
 * `aria-hidden`, with no role: it carries no information a reader needs. The
 * figures beside it do, and they are text.
 */
export const NodeField = ({
  nodes = CITY_NODES,
  paths = CITY_PATHS,
  className,
}: {
  nodes?: readonly SceneNode[];
  paths?: readonly ScenePath[];
  className?: string;
}) => (
  <svg
    aria-hidden
    focusable="false"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
    className={cn('propiq-nodefield', className)}
  >
    <defs>
      <linearGradient id="propiq-path" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="var(--color-iris-300)" stopOpacity="0" />
        <stop offset="50%" stopColor="var(--color-iris-cyan-300)" stopOpacity="0.55" />
        <stop offset="100%" stopColor="var(--color-iris-violet-300)" stopOpacity="0" />
      </linearGradient>
    </defs>

    {paths.map((p, i) => {
      const a = nodes[p.from];
      const b = nodes[p.to];
      if (!a || !b) return null;
      return (
        <line
          key={`p-${i}`}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="url(#propiq-path)"
          strokeWidth="0.35"
          vectorEffect="non-scaling-stroke"
          className="propiq-nodefield-path"
          style={{ animationDelay: `${p.delay}s` }}
        />
      );
    })}

    {nodes.map((n, i) => (
      <g key={`n-${i}`} className="propiq-nodefield-node" style={{ animationDelay: `${n.delay}s` }}>
        {n.kind === 'primary' && (
          <circle cx={n.x} cy={n.y} r="1.9" className="propiq-nodefield-halo" />
        )}
        <circle
          cx={n.x}
          cy={n.y}
          r={n.kind === 'primary' ? 0.75 : 0.45}
          fill={n.kind === 'primary' ? 'var(--color-iris-cyan-300)' : 'var(--color-iris-300)'}
          opacity={n.kind === 'primary' ? 0.95 : 0.55}
        />
      </g>
    ))}
  </svg>
);
