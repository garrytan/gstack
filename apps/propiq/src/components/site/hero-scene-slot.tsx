'use client';

/**
 * The client boundary around the hero scene.
 *
 * The scene decides whether to draw at all by probing for a WebGL context, and
 * a probe is a client-only fact — on the server it has to guess. When it
 * guessed "available" and the browser disagreed, the two trees differed and
 * React threw a hydration mismatch and rebuilt the subtree. Rendering the
 * scene client-side only removes the guess: the server always emits the flat
 * skyline, and the browser either upgrades it or keeps it.
 *
 * It has to live in its own file because `ssr: false` is not allowed from a
 * Server Component, and the hero itself is one.
 */

import dynamic from 'next/dynamic';
import { SceneFallback } from '@/components/site/property-intelligence-scene';

const PropertyIntelligenceScene = dynamic(
  () =>
    import('@/components/site/property-intelligence-scene').then(
      (m) => m.PropertyIntelligenceScene,
    ),
  { ssr: false, loading: () => <SceneFallback className="size-full" /> },
);

export const HeroSceneSlot = ({ className }: { className?: string }) => (
  <PropertyIntelligenceScene className={className} />
);
