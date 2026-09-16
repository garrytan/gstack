'use client';

/**
 * Pointer-driven 3D tilt.
 *
 * Wraps a card in a perspective context and rotates it toward the pointer. The
 * rotation is small on purpose: past about 8 degrees a card stops reading as a
 * surface catching light and starts reading as a toy.
 *
 * Three things this has to get right, all of them learned the hard way in this
 * codebase:
 *
 * - `backdrop-filter` flattens a 3D context. Any child that blurs its backdrop
 *   will collapse the transform, so the frosted look on a tilted card has to
 *   come from a solid tint rather than a backdrop blur.
 * - A coarse pointer has no hover, so the listener never attaches on a phone
 *   and the card stays flat rather than jittering on touch.
 * - Reduced motion means no tilt at all, not a smaller tilt.
 *
 * It writes transforms directly rather than through state: a pointermove that
 * sets state re-renders the subtree on every frame, which is how a tilt effect
 * turns into a scroll stutter.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export const Tilt3D = ({
  children,
  className,
  max = 7,
  lift = 10,
}: {
  children: ReactNode;
  className?: string;
  /** Maximum rotation in degrees on each axis. */
  max?: number;
  /** How far the card rises toward the viewer, in pixels. */
  lift?: number;
}) => {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;

    let frame = 0;
    const apply = (rx: number, ry: number, z: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        inner.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) translate3d(0,0,${z}px)`;
      });
    };

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      // -0.5..0.5 from the card's own centre, so the tilt follows the pointer
      // rather than the viewport.
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      apply(-y * max * 2, x * max * 2, lift);
    };
    const onLeave = () => apply(0, 0, 0);

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [max, lift]);

  return (
    <div ref={host} className={`propiq-tilt-host ${className ?? ''}`}>
      <div className="propiq-tilt-inner">{children}</div>
    </div>
  );
};
