/**
 * #2975: GSTACK_CODEX_EFFORT sets the default reasoning effort for manual
 * /codex runs, mirroring GSTACK_CODEX_MODEL.
 *
 * Contract:
 *   - unset  -> the per-mode default the section passed to `check-effort`
 *   - set    -> validated against the documented Codex levels (the config
 *               reference lists low, medium, high, xhigh, max, ultra — and the
 *               API docs add minimal; levels are model-dependent, so the
 *               allowlist is the union), and used for every mode
 *   - `--xhigh` on a request still wins (prose precedence, kept in the
 *     section templates)
 *   - an invalid value stops before any Codex call, like an invalid model
 *   - only manual /codex sections route through it: outside-voice callers
 *     (autoplan, spec, plan-review) keep their fixed efforts so an operator's
 *     env default cannot blow up gstack's internal review budgets
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const MODES: Array<[string, string]> = [
  ['review-mode', 'high'],
  ['challenge-mode', 'high'],
  ['consult-mode', 'medium'],
];

describe('GSTACK_CODEX_EFFORT (#2975)', () => {
  test('every manual /codex mode captures the effort from check-effort and uses it in the dispatch', () => {
    for (const [mode, def] of MODES) {
      const tmpl = read(`codex/sections/${mode}.md.tmpl`);
      expect(tmpl, mode).toContain(`_CODEX_OUT=$("$_CODEX_PROBE" check-effort ${def}) || exit 1`);
      expect(tmpl, mode).toContain('_CODEX_EFFORT=$(echo "$_CODEX_OUT" | sed -n \'s/^CODEX_EFFORT: //p\')');
      const dispatches = tmpl.split('\n').filter(line => /run-with-timeout \d+ codex (exec|review)\b/.test(line));
      expect(dispatches.length, mode).toBeGreaterThan(0);
      for (const line of dispatches) {
        expect(line, mode).toContain(`-c "model_reasoning_effort=\\"`);
        expect(line, mode).toContain('${_CODEX_EFFORT:?}');
        expect(line, mode).not.toContain(`model_reasoning_effort="${def}"`);
      }
    }
  });

  test('the capture sits in the same bash block as CODEX_SELECT, after it', () => {
    for (const [mode] of MODES) {
      const tmpl = read(`codex/sections/${mode}.md.tmpl`);
      const select = tmpl.indexOf('{{CODEX_SELECT:');
      const capture = tmpl.indexOf('_CODEX_EFFORT=$(echo');
      expect(select, mode).toBeGreaterThan(-1);
      expect(capture, mode).toBeGreaterThan(select);
      // Same fenced block: no closing fence between the two.
      expect(tmpl.slice(select, capture).includes('```'), mode).toBe(false);
    }
  });

  test('the --xhigh prose states the request flag outranks the env default', () => {
    for (const [mode, def] of MODES) {
      const tmpl = read(`codex/sections/${mode}.md.tmpl`);
      const prose = tmpl.split('\n').find(line => line.includes('`--xhigh`'));
      expect(prose, mode).toBeTruthy();
      expect(prose!, mode).toContain('GSTACK_CODEX_EFFORT');
      expect(prose!, mode).toContain(def);
    }
  });

  test('outside-voice callers keep their fixed efforts (an operator env default must not reach them)', () => {
    const sources = ['autoplan/sections/ceo-phase.md', 'autoplan/sections/design-phase.md', 'autoplan/sections/dx-phase.md', 'autoplan/sections/eng-phase.md'];
    for (const rel of sources) {
      const text = read(rel);
      expect(text, rel).toContain(`-c 'model_reasoning_effort="high"'`);
      expect(text, rel).not.toContain('GSTACK_CODEX_EFFORT');
      expect(text, rel).not.toContain('_CODEX_EFFORT');
    }
    const resolver = read('scripts/resolvers/outside-voice.ts');
    expect(resolver).not.toContain('GSTACK_CODEX_EFFORT');
  });

  test('the skill body documents the env next to GSTACK_CODEX_MODEL', () => {
    const body = read('codex/SKILL.md.tmpl');
    expect(body).toContain('GSTACK_CODEX_EFFORT');
    const override = body.split('\n').findIndex(l => l.includes('**Reasoning effort override:**'));
    const defaults = body.split('\n').findIndex(l => l.includes('**Reasoning effort (per-mode defaults, overridable via `GSTACK_CODEX_EFFORT`):**'));
    expect(override).toBeGreaterThan(-1);
    expect(defaults).toBeGreaterThan(-1);
  });
});
