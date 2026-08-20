/**
 * Running-under-Codex detection (#2519, maintainer decision 7).
 *
 * /review executed inside a Codex host used to spawn nested codex
 * specialists — the same model reviewing itself at multiplied token cost
 * (observed: 15M tokens for one /review). A live Codex session exports
 * CODEX_THREAD_ID / CODEX_SANDBOX into every shell it spawns (verified
 * against a live `codex exec 'env | grep -i codex'` capture on codex
 * 0.147.0: CODEX_THREAD_ID, CODEX_SANDBOX=seatbelt,
 * CODEX_SANDBOX_NETWORK_DISABLED=1, CODEX_CI=1). The shared codexPreflight
 * presence-probes those vars and yields CODEX_MODE=under_codex, skipping
 * nested spawns with a one-line notice; GSTACK_FORCE_CODEX_REVIEW=1
 * overrides.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { codexPreflight } from '../scripts/resolvers/constants';

const ROOT = path.resolve(import.meta.dir, '..');

/** Extract the runnable bash from the rendered preflight (strip fences/prose). */
function preflightBash(): string {
  const rendered = codexPreflight({ disabledBehavior: 'codex-only' });
  const start = rendered.indexOf('```bash') + '```bash'.length;
  const end = rendered.indexOf('```', start);
  return rendered.slice(start, end);
}

function runPreflight(env: Record<string, string>): string {
  const result = spawnSync('bash', ['-c', `set +e\n${preflightBash()}`], {
    env: {
      // Minimal PATH without codex so the not_installed branch is reachable
      // and no real gstack-config/codex runs. The block's fallbacks
      // (`|| echo enabled`) keep it self-contained.
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent-home',
      ...env,
    },
    timeout: 10000,
  });
  return (result.stdout ?? '').toString();
}

describe('under-codex detection bash (#2519)', () => {
  test('CODEX_THREAD_ID present -> under_codex', () => {
    const out = runPreflight({ CODEX_THREAD_ID: '01a00ba9-ff91-7143-b424-c2d9b0cc89ff' });
    expect(out).toContain('CODEX_MODE: under_codex');
  });

  test('CODEX_SANDBOX present (no thread id) -> under_codex', () => {
    const out = runPreflight({ CODEX_SANDBOX: 'seatbelt' });
    expect(out).toContain('CODEX_MODE: under_codex');
  });

  test('GSTACK_FORCE_CODEX_REVIEW=1 overrides the presence probe', () => {
    const out = runPreflight({
      CODEX_THREAD_ID: '01a00ba9-ff91-7143-b424-c2d9b0cc89ff',
      CODEX_SANDBOX: 'seatbelt',
      GSTACK_FORCE_CODEX_REVIEW: '1',
    });
    expect(out).not.toContain('CODEX_MODE: under_codex');
    // With codex absent from the restricted PATH, the forced probe falls
    // through to the ordinary availability chain.
    expect(out).toContain('CODEX_MODE: not_installed');
  });

  test('no CODEX_* env -> ordinary availability chain', () => {
    const out = runPreflight({});
    expect(out).not.toContain('CODEX_MODE: under_codex');
    expect(out).toContain('CODEX_MODE: not_installed');
  });
});

describe('under-codex wiring renders (#2519)', () => {
  test('rendered adversarial section carries the probe + override + notice', () => {
    const rendered = fs.readFileSync(
      path.join(ROOT, 'ship', 'sections', 'adversarial.md'),
      'utf-8',
    );
    expect(rendered).toContain('CODEX_THREAD_ID');
    expect(rendered).toContain('GSTACK_FORCE_CODEX_REVIEW');
    expect(rendered).toContain('under_codex');
    expect(rendered).toContain('nested codex passes skipped');
  });

  test('rendered codex skill stops with the one-line notice when under codex', () => {
    const rendered = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(rendered).toContain('UNDER_CODEX');
    expect(rendered).toContain('GSTACK_FORCE_CODEX_REVIEW=1');
  });

  test('all three codexPreflight consumers render the probe', () => {
    for (const file of [
      path.join(ROOT, 'ship', 'sections', 'adversarial.md'),
      path.join(ROOT, 'plan-ceo-review', 'sections', 'review-sections.md'),
      path.join(ROOT, 'document-release', 'sections', 'release-body.md'),
    ]) {
      const rendered = fs.readFileSync(file, 'utf-8');
      expect(rendered).toContain('under_codex');
    }
  });
});
