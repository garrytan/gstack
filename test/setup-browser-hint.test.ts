/**
 * setup: the browser lines of the final summary. Aside (aside.com, macOS 15+)
 * is the primary driver; the compiled browse binary is the fallback.
 *
 * Since the Chromium bootstrap became best-effort (#2802, _PW_FAIL_REASON),
 * two places must consult that reason so they never promise a bundled browser
 * that cannot launch, and never tell an Aside user their browser skills are
 * gone when only the fallback is missing:
 *   - _browser_hint, the one-line "browser:" hint under every host's
 *     "gstack ready" block;
 *   - the Chromium bootstrap summary printed last.
 * Both sites also honor GSTACK_SKIP_ASIDE=1 (the library's and the skills'
 * opt-out): with it set, an installed Aside counts as absent, so the lines
 * describe the bundled browser, never Aside. And the Aside-absent skill list
 * is DERIVED from the Aside-first list plus /pair-agent (which always runs on
 * gstack's own browser), so the two can never drift.
 * Behavior fixture: extract the code from setup and run it with the Aside
 * probe stubbed, the reason set or empty, and the opt-out set or unset.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

// The reason branch of the final summary, up to (not including) the
// foreign-entries report that follows it.
function summaryReasonBlock(): string {
  const start = SETUP_SRC.indexOf('# ─── Chromium bootstrap summary');
  const end = SETUP_SRC.indexOf('if [ ${#_FOREIGN_SKIPPED_ENTRIES[@]}', start);
  if (start < 0 || end < 0) throw new Error('Could not locate the Chromium bootstrap summary block in setup');
  return SETUP_SRC.slice(start, end);
}

// `command -v aside` is the only probe either site makes; shadow the builtin
// so the test never depends on whether the machine running it has Aside.
const COMMAND_SHADOW = 'command() { if [ "$1" = "-v" ] && [ "$2" = "aside" ]; then [ "$ASIDE_PRESENT" = "1" ]; else builtin command "$@"; fi; }';

function runBash(lines: string[], env: Record<string, string> = {}): string {
  // GSTACK_SKIP_ASIDE is read from the environment. Strip any inherited value
  // so the outcome is decided by the test, never by the operator's shell.
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.GSTACK_SKIP_ASIDE;
  const r = spawnSync('bash', ['-c', lines.join('\n')], { encoding: 'utf-8', timeout: 30_000, env: { ...base, ...env } });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return r.stdout;
}

/** `skipAside` is the value GSTACK_SKIP_ASIDE carries in the environment;
 *  omitted means unset. Only the literal "1" is the opt-out. */
type SiteOpts = { aside: boolean; reason: string; skipAside?: string };

function siteEnv(opts: SiteOpts): Record<string, string> {
  return opts.skipAside === undefined ? {} : { GSTACK_SKIP_ASIDE: opts.skipAside };
}

function runHint(opts: SiteOpts): string {
  return runBash([
    'set -e',
    'log() { echo "$@"; }',
    `ASIDE_PRESENT=${opts.aside ? 1 : 0}`,
    COMMAND_SHADOW,
    `_PW_FAIL_REASON=${JSON.stringify(opts.reason)}`,
    extractFn('_browser_hint'),
    '_browser_hint',
  ], siteEnv(opts));
}

function runSummary(opts: SiteOpts): string {
  return runBash([
    'set -e',
    'log() { echo "$@"; }',
    `ASIDE_PRESENT=${opts.aside ? 1 : 0}`,
    COMMAND_SHADOW,
    'SOURCE_GSTACK_DIR=/nonexistent-gstack-dir', // no telemetry binary → the event is skipped
    `_PW_FAIL_REASON=${JSON.stringify(opts.reason)}`,
    summaryReasonBlock(),
    // The two skill lists the block defines, so a test can check the
    // derivation at runtime and not only in the source text.
    'echo "ASIDE_SKILLS=$_PW_ASIDE_SKILLS"',
    'echo "BROWSER_SKILLS=$_PW_BROWSER_SKILLS"',
    'echo REACHED_END=1',
  ], siteEnv(opts));
}

function summaryLists(out: string): { aside: string; browser: string } {
  const aside = out.match(/^ASIDE_SKILLS=(.*)$/m)?.[1];
  const browser = out.match(/^BROWSER_SKILLS=(.*)$/m)?.[1];
  if (aside === undefined || browser === undefined) throw new Error(`summary block did not define both skill lists:\n${out}`);
  return { aside, browser };
}

describe('setup: _browser_hint', () => {
  test('static pin: the hint reads _PW_FAIL_REASON', () => {
    expect(extractFn('_browser_hint')).toContain('_PW_FAIL_REASON');
  });

  test('Aside present, bootstrap fine → Aside primary with the bundled fallback', () => {
    const out = runHint({ aside: true, reason: '' });
    expect(out).toContain('browser: Aside (primary) — gstack browser is the fallback');
  });

  test('Aside present, bootstrap failed → Aside primary, fallback named unavailable with the reason', () => {
    const out = runHint({ aside: true, reason: 'chromium-install-timeout' });
    expect(out).toContain('Aside (primary)');
    expect(out).toContain('fallback unavailable');
    expect(out).toContain('chromium-install-timeout');
    expect(out).not.toContain('gstack browser is the fallback');
  });

  test('Aside absent, bootstrap fine → bundled browser is the fallback, Aside suggested', () => {
    const out = runHint({ aside: false, reason: '' });
    expect(out).toContain('browser: gstack browser (fallback). Install Aside for the primary path: aside.com (macOS 15+)');
  });

  test('Aside absent, bootstrap failed → no browser promised; reason and both remedies named', () => {
    const out = runHint({ aside: false, reason: 'chromium-install,post-install-launch' });
    expect(out).toContain('browser: none available');
    expect(out).toContain('chromium-install,post-install-launch');
    expect(out).toContain('install Aside');
    expect(out).toContain('re-run ./setup');
    expect(out).not.toContain('gstack browser (fallback)');
  });

  test('static pin: the hint honors the GSTACK_SKIP_ASIDE opt-out before probing for Aside', () => {
    expect(extractFn('_browser_hint')).toContain('[ "${GSTACK_SKIP_ASIDE:-}" != "1" ] && command -v aside');
  });

  test('GSTACK_SKIP_ASIDE=1 with Aside on PATH, bootstrap fine → treated as Aside absent: the fallback line, never Aside (primary)', () => {
    const out = runHint({ aside: true, reason: '', skipAside: '1' });
    expect(out).toContain('browser: gstack browser (fallback). Install Aside for the primary path: aside.com (macOS 15+)');
    expect(out).not.toContain('Aside (primary)');
  });

  test('GSTACK_SKIP_ASIDE=1 with Aside on PATH, bootstrap failed → none available; Aside is not promised', () => {
    const out = runHint({ aside: true, reason: 'chromium-install', skipAside: '1' });
    expect(out).toContain('browser: none available');
    expect(out).toContain('chromium-install');
    expect(out).not.toContain('Aside (primary)');
  });

  test('only the literal 1 opts out: GSTACK_SKIP_ASIDE=0 or empty keeps Aside primary', () => {
    for (const v of ['0', '']) {
      const out = runHint({ aside: true, reason: '', skipAside: v });
      expect(out).toContain('browser: Aside (primary) — gstack browser is the fallback');
    }
  });
});

describe('setup: _browser_hint treats GSTACK_SKIP_PLAYWRIGHT as a request, not a failure', () => {
  test('Aside absent, bootstrap skipped by request → names the flag, does not say fix the bootstrap', () => {
    const out = runHint({ aside: false, reason: 'skipped' });
    expect(out).toContain('browser: none available');
    expect(out).toContain('skipped by request (GSTACK_SKIP_PLAYWRIGHT=1)');
    expect(out).toContain('re-run ./setup without the flag');
    expect(out).not.toContain('fix the bootstrap');
  });
});

describe('setup: Chromium bootstrap summary is Aside-aware', () => {
  test('Aside present → skills keep running in Aside, only the fallback is missing, /pair-agent excepted', () => {
    const out = runSummary({ aside: true, reason: 'chromium-install' });
    expect(out).toContain('Browser unavailable: Chromium bootstrap did not complete (chromium-install)');
    expect(out).toContain('Aside is installed');
    expect(out).toContain('only their bundled fallback is missing');
    expect(out).toContain('/pair-agent needs the bundled browser itself');
    expect(out).not.toContain('Skills that need it:');
    expect(out).toContain('REACHED_END=1');
  });

  test('Aside absent → the pre-Aside wording: the skills need the bundled browser', () => {
    const out = runSummary({ aside: false, reason: 'chromium-install' });
    expect(out).toContain('Browser unavailable: Chromium bootstrap did not complete (chromium-install)');
    expect(out).toContain('Skills that need it:');
    for (const skill of ['/qa', '/qa-only', '/design-review', '/browse', 'make-pdf', '/pair-agent']) {
      expect(out).toContain(skill);
    }
    expect(out).not.toContain('Aside is installed');
    expect(out).toContain('REACHED_END=1');
  });

  test('no failure → the reason branch prints nothing', () => {
    const out = runSummary({ aside: true, reason: '' });
    expect(out).not.toContain('Browser unavailable');
    expect(out).toContain('REACHED_END=1');
  });

  test('GSTACK_SKIP_ASIDE=1 with Aside on PATH → the Aside-absent wording: the skills need the bundled browser', () => {
    const out = runSummary({ aside: true, reason: 'chromium-install', skipAside: '1' });
    expect(out).toContain('Browser unavailable: Chromium bootstrap did not complete (chromium-install)');
    expect(out).toContain('Skills that need it:');
    expect(out).toContain('/pair-agent');
    expect(out).not.toContain('Aside is installed');
    expect(out).not.toContain('only their bundled fallback is missing');
    expect(out).toContain('REACHED_END=1');
  });

  test('static pin: _PW_BROWSER_SKILLS is derived from _PW_ASIDE_SKILLS (plus /pair-agent) so the two lists cannot drift', () => {
    const block = summaryReasonBlock();
    expect(block).toContain('_PW_BROWSER_SKILLS="$_PW_ASIDE_SKILLS,');
    const asideLine = block.match(/^_PW_ASIDE_SKILLS="(.*)"$/m)?.[1];
    const browserLine = block.match(/^_PW_BROWSER_SKILLS="(.*)"$/m)?.[1];
    expect(asideLine).toBeDefined();
    expect(browserLine).toBeDefined();
    // /pair-agent always runs on gstack's own browser, so it belongs only to
    // the derived list, never to the Aside-first list.
    expect(asideLine).not.toContain('/pair-agent');
    expect(browserLine).toContain('/pair-agent');
    expect(block).toContain('[ "${GSTACK_SKIP_ASIDE:-}" != "1" ] && command -v aside');
  });

  test('runtime: the Aside-absent list is the Aside list plus /pair-agent, and each arm prints its own list verbatim', () => {
    const present = runSummary({ aside: true, reason: 'chromium-install' });
    const { aside, browser } = summaryLists(present);
    expect(aside.length).toBeGreaterThan(0);
    expect(aside).not.toContain('/pair-agent');
    expect(browser.startsWith(`${aside}, /pair-agent`)).toBe(true);
    // Aside present: the Aside-first skills keep running there, and /pair-agent
    // is called out as needing the bundled browser itself.
    expect(present).toContain(`Aside is installed, so ${aside} keep running there; only their bundled fallback is missing.`);
    expect(present).toContain('/pair-agent needs the bundled browser itself');
    // Aside absent: the derived list, /pair-agent included, is what needs it.
    const absent = runSummary({ aside: false, reason: 'chromium-install' });
    expect(absent).toContain(`Skills that need it: ${browser}.`);
    expect(summaryLists(absent)).toEqual({ aside, browser });
  });
});
