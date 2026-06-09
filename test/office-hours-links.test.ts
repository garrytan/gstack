/**
 * office-hours founder-resource link-check (OPT-IN, network).
 *
 * The closing hands users 34 hand-picked YouTube videos / PG essays. Dead
 * YouTube IDs still render a valid-looking "Video unavailable" page, so link rot
 * is silent. This test catches it — but only when LINKCHECK=1, so the normal
 * `bun run test` suite stays deterministic and offline. Wire it to a weekly CI
 * cron rather than the per-commit suite.
 *
 *   LINKCHECK=1 bun test test/office-hours-links.test.ts
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = path.join(ROOT, 'office-hours', 'SKILL.md');
const ENABLED = process.env.LINKCHECK === '1';

function poolUrls(): string[] {
  const content = fs.readFileSync(SKILL, 'utf-8');
  const start = content.indexOf('**Resource Pool**');
  const end = content.indexOf('**After presenting resources', start);
  const slice = content.slice(start, end);
  return Array.from(new Set(content.length && start > -1 ? (slice.match(/https?:\/\/[^\s)]+/g) || []) : []));
}

async function isLive(url: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    // YouTube: a removed/private video returns 404 from oembed (watch pages 200 even when dead).
    if (/youtube\.com\/watch|youtu\.be\//.test(url)) {
      const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const r = await fetch(oembed, { signal: ac.signal, headers: { 'user-agent': 'gstack-linkcheck' } });
      return r.status === 200;
    }
    let r = await fetch(url, { method: 'HEAD', signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'gstack-linkcheck' } });
    if (r.status === 405 || r.status === 403) {
      r = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'gstack-linkcheck' } });
    }
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

(ENABLED ? describe : describe.skip)('office-hours resource links (LINKCHECK=1)', () => {
  test('every founder-resource URL is reachable', async () => {
    const urls = poolUrls();
    expect(urls.length).toBeGreaterThan(0);
    const results = await Promise.all(urls.map(async (u) => ({ u, live: await isLive(u) })));
    const dead = results.filter((r) => !r.live).map((r) => r.u);
    if (dead.length) console.error('DEAD LINKS:\n' + dead.join('\n'));
    expect(dead).toEqual([]);
  }, 120_000);
});
