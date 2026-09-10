/**
 * Runtime probe for the Aside AI browser — the primary browser; gstack's own
 * headless browser is the fallback. E2E tests that need a live Aside call
 * `asideAvailable()` and self-skip when it is false (CI runners have no
 * Aside; the fallback path is exercised there instead). The probe mirrors the
 * bash one the skills run in BROWSER SETUP (scripts/resolvers/aside.ts) via
 * lib/aside-render.ts probeAside(); the two classify the same way.
 */
import { probeAside } from '../../lib/aside-render';

let cached: boolean | null = null;

export function asideAvailable(): boolean {
  if (cached !== null) return cached;
  if (process.env.GSTACK_SKIP_ASIDE === '1') return (cached = false);
  cached = probeAside().ok;
  return cached;
}
