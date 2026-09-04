/**
 * Runtime probe for the Aside AI browser — the browser every gstack browsing
 * skill drives. E2E tests that need a live browser call `asideAvailable()`
 * and self-skip when it is false (CI runners have no Aside; the probe is the
 * same one the skills run in their BROWSER SETUP step).
 */
import { spawnSync } from 'child_process';

let cached: boolean | null = null;

export function asideAvailable(): boolean {
  if (cached !== null) return cached;
  if (process.env.GSTACK_SKIP_ASIDE === '1') return (cached = false);
  const which = spawnSync('sh', ['-c', 'command -v aside'], { encoding: 'utf-8' });
  if (which.status !== 0) return (cached = false);
  const probe = spawnSync('aside', ['repl', 'console.log("ASIDE_READY " + pwd)'], { encoding: 'utf-8', timeout: 30_000 });
  cached = /^ASIDE_READY/m.test(probe.stdout || '');
  return cached;
}
