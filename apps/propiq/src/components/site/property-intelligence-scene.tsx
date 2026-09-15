'use client';

/**
 * The hero's city scene.
 *
 * Three.js directly rather than React Three Fiber: R3F 9.7 pins
 * `react <19.3` and this app runs 19.3, so pulling it in would mean either a
 * forced peer resolution or downgrading React for the whole product. For one
 * bespoke scene the reconciler earns nothing — this is a few hundred
 * instanced boxes, a grid and a camera drift, and owning the loop directly is
 * what lets it throttle DPR, pause off-screen and dispose cleanly.
 *
 * It is a stylised district, not a map of anywhere. Blocks sit on a grid with
 * corridors cut through them; a handful are lifted and lit in brand colour to
 * read as the properties under analysis. Nothing here claims to be Bengaluru.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * Can this browser give us a context at all?
 *
 * Checked once during render rather than inside the effect, so the fallback
 * is chosen before the first paint instead of swapped in afterwards. A
 * throwaway canvas is the only reliable probe — feature-detecting `WebGLRenderingContext`
 * says nothing about whether a context will actually be granted.
 */
const webglAvailable = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
};

/** Deterministic PRNG so the skyline is identical on every render and machine. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const BRAND = {
  blue: 0x2f6bdd,
  cyan: 0x14a5c9,
  violet: 0x6d55d9,
  base: 0x1b2540,
  ground: 0x070b16,
};

const GRID = 13;
const SPACING = 2.05;
/** Rows and columns left empty, so the district reads as having roads. */
const CORRIDORS = new Set([3, 9]);

export const PropertyIntelligenceScene = ({ className }: { className?: string }) => {
  const host = useRef<HTMLDivElement>(null);
  // Lazy initialiser: evaluated once on mount, never inside an effect.
  const [supported] = useState(webglAvailable);

  useEffect(() => {
    const mount = host.current;
    if (!mount || !supported) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A coarse pointer means a phone or tablet: fewer towers, no parallax.
    const light = !window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !light,
        alpha: true,
        powerPreference: 'low-power',
      });
    } catch {
      // Context creation can still fail after the probe succeeded — a lost
      // context, a driver blocklist. The flat skyline is already on screen
      // underneath, so there is nothing to swap in.
      return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(BRAND.ground, 20, 54);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
    const basePos = new THREE.Vector3(15.5, 12.5, 17.5);
    camera.position.copy(basePos);
    camera.lookAt(0, 1.4, 0);

    scene.add(new THREE.AmbientLight(0x8ea6d8, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(9, 16, 7);
    scene.add(key);
    const rim = new THREE.PointLight(BRAND.violet, 90, 46);
    rim.position.set(-11, 7, -9);
    scene.add(rim);
    const fill = new THREE.PointLight(BRAND.cyan, 70, 42);
    fill.position.set(12, 5, 11);
    scene.add(fill);

    // --- Ground plane and spatial grid -------------------------------------
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 70),
      new THREE.MeshStandardMaterial({ color: BRAND.ground, roughness: 0.95, metalness: 0.1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);

    const grid = new THREE.GridHelper(64, 32, BRAND.blue, 0x16203a);
    (grid.material as THREE.Material).opacity = 0.26;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // --- The district ------------------------------------------------------
    const random = seeded(20260915);
    const plots: Array<{ x: number; z: number; h: number; highlight: boolean }> = [];
    const step = light ? 2 : 1;
    for (let r = 0; r < GRID; r += step) {
      for (let c = 0; c < GRID; c += step) {
        if (CORRIDORS.has(r) || CORRIDORS.has(c)) continue;
        const dx = r - (GRID - 1) / 2;
        const dz = c - (GRID - 1) / 2;
        const fromCentre = Math.hypot(dx, dz);
        // Taller toward the middle, which is what makes it read as a city
        // rather than a field of equal blocks.
        const h = Math.max(0.5, (4.6 - fromCentre * 0.42) * (0.45 + random() * 0.95));
        plots.push({ x: dx * SPACING, z: dz * SPACING, h, highlight: random() > 0.9 });
      }
    }

    const box = new THREE.BoxGeometry(1.24, 1, 1.24);
    const shell = new THREE.MeshStandardMaterial({
      color: BRAND.base,
      roughness: 0.62,
      metalness: 0.38,
    });
    const blocks = new THREE.InstancedMesh(box, shell, plots.length);
    const matrix = new THREE.Matrix4();
    plots.forEach((p, i) => {
      matrix.makeScale(1, p.h, 1).setPosition(p.x, p.h / 2, p.z);
      blocks.setMatrixAt(i, matrix);
    });
    blocks.instanceMatrix.needsUpdate = true;
    scene.add(blocks);

    // The lit towers: the properties under analysis.
    const marked = plots.filter((p) => p.highlight);
    const hues = [BRAND.cyan, BRAND.blue, BRAND.violet];
    const markers: THREE.Mesh[] = [];
    marked.forEach((p, i) => {
      const colour = hues[i % hues.length] ?? BRAND.cyan;
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, p.h * 1.5, 1.3),
        new THREE.MeshStandardMaterial({
          color: colour,
          emissive: colour,
          emissiveIntensity: 0.45,
          roughness: 0.3,
          metalness: 0.55,
        }),
      );
      tower.position.set(p.x, (p.h * 1.5) / 2, p.z);
      scene.add(tower);

      // A node floating above it, the way a pin sits over a map.
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 18, 18),
        new THREE.MeshBasicMaterial({ color: colour }),
      );
      node.position.set(p.x, p.h * 1.5 + 1.15, p.z);
      scene.add(node);
      markers.push(node);

      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 1.1, 6),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.55 }),
      );
      stem.position.set(p.x, p.h * 1.5 + 0.55, p.z);
      scene.add(stem);
    });

    // --- Loop --------------------------------------------------------------
    const pointer = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      const box2 = mount.getBoundingClientRect();
      pointer.x = (e.clientX - box2.left) / box2.width - 0.5;
      pointer.y = (e.clientY - box2.top) / box2.height - 0.5;
    };
    if (!light && !reduced) window.addEventListener('pointermove', onPointer);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      // Cap DPR: the scene is soft-edged and a retina buffer buys nothing
      // visible while costing four times the fill rate.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, light ? 1.25 : 1.75));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    renderer.domElement.setAttribute('aria-hidden', 'true');
    mount.append(renderer.domElement);

    // Pause entirely when scrolled away. A hero animating behind three
    // screens of content is pure battery.
    let visible = true;
    const visibility = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? true;
      },
      { threshold: 0.01 },
    );
    visibility.observe(mount);

    let frame = 0;
    const started = performance.now();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!visible) return;
      const t = (performance.now() - started) / 1000;

      if (!reduced) {
        const drift = Math.sin(t * 0.085) * 1.5;
        camera.position.x = basePos.x + drift + pointer.x * 2.1;
        camera.position.z = basePos.z - drift * 0.55;
        camera.position.y = basePos.y + Math.sin(t * 0.13) * 0.55 - pointer.y * 1.3;
        markers.forEach((m, i) => {
          m.position.y += Math.sin(t * 1.5 + i) * 0.0016;
        });
      }
      camera.lookAt(0, 1.4, 0);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
      window.removeEventListener('pointermove', onPointer);
      // Three does not free GPU memory on garbage collection; every geometry
      // and material has to be released explicitly or a route change leaks.
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
          obj.geometry.dispose();
          const material = obj.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [supported]);

  if (!supported) return <SceneFallback className={className} />;
  return <div ref={host} className={className} aria-hidden />;
};

/**
 * What renders when WebGL is unavailable or refuses a context, and what the
 * server always renders before the client decides. Not a blank box: the same
 * district, drawn flat, at a contrast that is actually visible against the
 * hero's own background rather than a rumour of one.
 */
export const SceneFallback = ({ className }: { className?: string }) => (
  <div className={className} aria-hidden>
    <svg viewBox="0 0 400 300" className="size-full" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="propiq-fallback-sky" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0d1424" />
          <stop offset="100%" stopColor="#070b16" />
        </linearGradient>
        <linearGradient id="propiq-fallback-tower" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#42c9e8" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#2f6bdd" stopOpacity="0.45" />
        </linearGradient>
      </defs>
      <rect width="400" height="300" fill="url(#propiq-fallback-sky)" />
      {Array.from({ length: 26 }, (_, i) => {
        const x = 8 + i * 15;
        const h = 40 + ((i * 37) % 110);
        const lit = i % 7 === 3;
        return (
          <rect
            key={i}
            x={x}
            y={300 - h}
            width={11}
            height={h}
            rx={1.5}
            fill={lit ? 'url(#propiq-fallback-tower)' : '#2a3754'}
          />
        );
      })}
      {Array.from({ length: 7 }, (_, i) => (
        <line
          key={i}
          x1="0"
          x2="400"
          y1={182 + i * 17}
          y2={182 + i * 17}
          stroke="#2f6bdd"
          strokeOpacity="0.3"
        />
      ))}
    </svg>
  </div>
);
