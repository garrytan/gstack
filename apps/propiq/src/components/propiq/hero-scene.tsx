'use client';

/**
 * The hero's 3D stage.
 *
 * A perspective container whose contents tilt toward the pointer. The depth
 * is doing a job rather than decorating: the cards receding behind the front
 * one are the rest of the scored market, so the stack's thickness is a real
 * quantity, and the front card reads as the one pulled out of it.
 *
 * Three constraints shaped the implementation:
 *
 *  - `prefers-reduced-motion` gets a fixed resting tilt and no listener at
 *    all. The scene is still three-dimensional; it simply does not move.
 *  - Pointer updates are written to CSS custom properties inside a single
 *    rAF, so a fast mouse cannot queue more work than a frame can absorb.
 *  - Below the `lg` breakpoint the tilt is disabled in CSS. A tilted card on
 *    a 390px screen costs legibility and buys nothing.
 */

import { useEffect, useRef } from 'react';

/** Degrees of travel at the edge of the stage. Past this it reads as a gimmick. */
const MAX_TILT_Y = 13;
const MAX_TILT_X = 9;

export const HeroScene = ({
  children,
  depth,
}: {
  children: React.ReactNode;
  /** How many cards sit behind the front one. Clamped to what reads as a stack. */
  depth: number;
}) => {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A pointer that cannot hover is a touchscreen; there is nothing to track.
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let frame = 0;
    let pending: { x: number; y: number } | undefined;

    const apply = () => {
      frame = 0;
      if (!pending) return;
      node.style.setProperty('--tilt-y', `${pending.x * MAX_TILT_Y}deg`);
      node.style.setProperty('--tilt-x', `${-pending.y * MAX_TILT_X}deg`);
      pending = undefined;
    };

    const onMove = (event: PointerEvent) => {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      pending = {
        x: (event.clientX - box.left) / box.width - 0.5,
        y: (event.clientY - box.top) / box.height - 0.5,
      };
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const onLeave = () => {
      pending = undefined;
      node.style.removeProperty('--tilt-y');
      node.style.removeProperty('--tilt-x');
    };

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  const ghosts = Math.min(Math.max(depth, 0), 3);

  return (
    <div ref={stage} className="propiq-stage">
      <div className="propiq-tilt">
        {Array.from({ length: ghosts }, (_, i) => (
          <div
            key={i}
            aria-hidden
            className="propiq-ghost"
            style={{ '--ghost': String(ghosts - i) } as React.CSSProperties}
          />
        ))}
        <div className="propiq-face">{children}</div>
      </div>
    </div>
  );
};
