/** INV-1: every gate reason code users can see has a section in docs/troubleshooting.md. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GATE_OUTCOMES, gateOutcomeLine, type GateReason } from '../lib/gate-outcomes';

const ROOT = path.resolve(import.meta.dir, '..');
const doc = fs.readFileSync(path.join(ROOT, 'docs/troubleshooting.md'), 'utf8');
const anchors = new Set([...doc.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map(m => m[1]));

describe('docs/troubleshooting.md anchors', () => {
  for (const [code, outcome] of Object.entries(GATE_OUTCOMES)) {
    test(`${code} → #${outcome.anchor}`, () => {
      expect(anchors.has(outcome.anchor)).toBe(true);
      // The anchor introduces a section: the next line is its heading.
      const after = doc.slice(doc.indexOf(`<a id="${outcome.anchor}"></a>`)).split('\n')[1] ?? '';
      expect(after).toMatch(/^#{2,4} /);
    });
  }

  test('anchors are unique and every outcome has a fix action', () => {
    const all = [...doc.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map(m => m[1]);
    expect(new Set(all).size).toBe(all.length);
    const codes = Object.values(GATE_OUTCOMES).map(o => o.anchor);
    expect(new Set(codes).size).toBe(codes.length);
    for (const outcome of Object.values(GATE_OUTCOMES)) expect(outcome.fix.trim().length).toBeGreaterThan(0);
  });

  test('outcome lines follow the not run / unavailable / unverified shapes', () => {
    const line = (code: GateReason, detail?: string) => gateOutcomeLine('Codex outside review', code, detail);
    expect(line('disabled')).toBe('Codex outside review: not run (outside reviews are turned off (codex_reviews=disabled)). Fix: gstack-config set codex_reviews enabled.');
    expect(line('sandbox_unavailable', 'bwrap: No permissions to create new namespace'))
      .toBe("Codex outside review unavailable: Codex's sandbox could not start here (bwrap: No permissions to create new namespace). No review ran; this is missing coverage, not a pass. Fix: enable unprivileged user namespaces for this container, or set GSTACK_CODEX_NO_SANDBOX=1.");
    expect(line('untagged_review')).toMatch(/^Codex outside review: ran, verdict unverified \(.+\)\. Fix: read the output above/);
  });
});
