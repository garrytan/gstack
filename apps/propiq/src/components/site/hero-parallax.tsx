'use client';

/**
 * Pointer parallax for the hero scene.
 *
 * Publishes the pointer's offset from the centre of the hero as two unitless
 * custom properties, `--px` and `--py`, each in roughly -1..1. The background
 * layers multiply them by their own depth, so the near crystal travels several
 * times further than the far bloom and the scene resolves as stacked planes
 * rather than a flat picture that slides.
 *
 * Custom properties rather than state: the layers are server-rendered markup,
 * and a value written to the host element reaches all of them through the
 * cascade without re-rendering a single component.
 *
 * The host is `display: contents`, so it has no box of its own and can neither
 * be measured nor receive a pointer event — and the scene it wraps is
 * `pointer-events: none` besides. The listener therefore binds to the hero
 * section, which is the element the pointer actually crosses, while the
 * variables are still written to the host so they inherit down to the layers.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export const HeroParallax = ({ children }: { children: ReactNode }) => {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const surface = el.closest('section');
    if (!surface) return;

    let frame = 0;
    const onMove = (e: PointerEvent) => {
      const r = surface.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty('--px', (x * 2).toFixed(3));
        el.style.setProperty('--py', (y * 2).toFixed(3));
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      el.style.setProperty('--px', '0');
      el.style.setProperty('--py', '0');
    };

    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={host} className="propiq-parallax contents">
      {children}
    </div>
  );
};
