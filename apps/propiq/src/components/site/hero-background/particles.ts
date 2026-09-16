/**
 * The atmospheric particle field.
 *
 * Positions are a baked constant rather than `Math.random()` at render time:
 * a randomised field would differ between the server pass and the client pass
 * and throw a hydration mismatch, which is the exact bug this hero shipped
 * once already. Generated once from a seeded PRNG and frozen here.
 *
 * `tier` splits the field so a phone can drop roughly half of it without the
 * distribution collapsing to one corner.
 */

export interface Particle {
  /** Percentage across the hero. */
  readonly x: number;
  /** Percentage down the hero. */
  readonly y: number;
  readonly size: number;
  readonly opacity: number;
  readonly hue: 'cyan' | 'white' | 'aqua';
  /** `core` renders everywhere; `extra` is dropped below `md`. */
  readonly tier: 'core' | 'extra';
}

export const PARTICLES: readonly Particle[] = [
  { x: 14.2, y: 22.8, size: 2, opacity: 0.42, hue: 'cyan', tier: 'core' },
  { x: 23.6, y: 63.4, size: 1, opacity: 0.3, hue: 'white', tier: 'extra' },
  { x: 31.1, y: 14.5, size: 1, opacity: 0.38, hue: 'aqua', tier: 'core' },
  { x: 37.8, y: 41.2, size: 3, opacity: 0.49, hue: 'cyan', tier: 'core' },
  { x: 41.3, y: 78.6, size: 1, opacity: 0.27, hue: 'white', tier: 'extra' },
  { x: 46.9, y: 29.7, size: 2, opacity: 0.36, hue: 'aqua', tier: 'core' },
  { x: 52.4, y: 55.1, size: 1, opacity: 0.28, hue: 'cyan', tier: 'extra' },
  { x: 57.2, y: 19.3, size: 2, opacity: 0.46, hue: 'white', tier: 'core' },
  { x: 61.8, y: 71.4, size: 1, opacity: 0.25, hue: 'cyan', tier: 'extra' },
  { x: 65.3, y: 37.9, size: 3, opacity: 0.53, hue: 'aqua', tier: 'core' },
  { x: 69.7, y: 84.2, size: 1, opacity: 0.23, hue: 'white', tier: 'extra' },
  { x: 73.1, y: 26.6, size: 2, opacity: 0.4, hue: 'cyan', tier: 'core' },
  { x: 77.6, y: 58.8, size: 1, opacity: 0.32, hue: 'aqua', tier: 'extra' },
  { x: 81.4, y: 12.1, size: 2, opacity: 0.34, hue: 'white', tier: 'core' },
  { x: 85.9, y: 45.3, size: 1, opacity: 0.28, hue: 'cyan', tier: 'extra' },
  { x: 89.2, y: 68.7, size: 2, opacity: 0.38, hue: 'aqua', tier: 'core' },
  { x: 92.7, y: 31.5, size: 1, opacity: 0.25, hue: 'white', tier: 'extra' },
  { x: 8.6, y: 48.9, size: 1, opacity: 0.3, hue: 'cyan', tier: 'extra' },
  { x: 18.9, y: 87.3, size: 2, opacity: 0.36, hue: 'aqua', tier: 'core' },
  { x: 27.4, y: 35.6, size: 1, opacity: 0.27, hue: 'white', tier: 'extra' },
  { x: 34.7, y: 92.1, size: 1, opacity: 0.21, hue: 'cyan', tier: 'extra' },
  { x: 44.1, y: 8.4, size: 2, opacity: 0.44, hue: 'aqua', tier: 'core' },
  { x: 55.8, y: 95.2, size: 1, opacity: 0.19, hue: 'white', tier: 'extra' },
  { x: 63.5, y: 51.7, size: 2, opacity: 0.42, hue: 'cyan', tier: 'core' },
  { x: 71.2, y: 6.9, size: 1, opacity: 0.28, hue: 'aqua', tier: 'extra' },
  { x: 79.8, y: 89.6, size: 2, opacity: 0.32, hue: 'white', tier: 'core' },
  { x: 87.3, y: 21.4, size: 1, opacity: 0.27, hue: 'cyan', tier: 'extra' },
  { x: 95.1, y: 54.8, size: 1, opacity: 0.23, hue: 'aqua', tier: 'extra' },
  { x: 5.3, y: 73.2, size: 2, opacity: 0.34, hue: 'cyan', tier: 'core' },
  { x: 49.6, y: 66.5, size: 1, opacity: 0.25, hue: 'white', tier: 'extra' },
];

export const PARTICLE_COLOR: Readonly<Record<Particle['hue'], string>> = {
  cyan: 'rgba(79, 209, 197, 1)',
  white: 'rgba(238, 245, 240, 1)',
  aqua: 'rgba(122, 231, 221, 1)',
};
