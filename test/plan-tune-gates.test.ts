/**
 * Plan-tune v1.49 gate regression tests.
 *
 * v1.49 shipped two prose-driven implicit gates inside plan-tune/SKILL.md.tmpl
 * Step 0:
 *   - Consent gate:  question_tuning=false AND ~/.gstack/.question-tuning-prompted missing
 *                    → run "Consent + opt-in".
 *   - Setup gate:    question_tuning=true AND declared empty AND
 *                    ~/.gstack/.declared-setup-prompted missing → run "5-Q setup".
 *
 * The gates are evaluated by the agent reading the template's bash + prose.
 * The cathedral (T5/T6) replaces enforcement with hooks, but it must NOT break
 * these v1.49 gates — they're the only path from "feature off" to "feature on"
 * for first-time users.
 *
 * Three regression tests, all FREE tier, IRON RULE (no opt-out):
 *   1. consent-gate fires under the right conditions and stops re-firing after marker.
 *   2. setup-gate fires under the right conditions and stops re-firing after marker.
 *   3. marker idempotency: re-invoking after either decision produces zero re-prompts.
 *
 * Strategy: exercise the helpers the gates depend on (gstack-config get,
 * developer-profile.json schema, marker file paths). If those break, the
 * gates break. Plus a static-template assertion so the gate language can't
 * be silently deleted from the template.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_CONFIG = path.join(ROOT, 'bin', 'gstack-config');
const BIN_DEV = path.join(ROOT, 'bin', 'gstack-developer-profile');
const SKILL_TMPL = path.join(ROOT, 'plan-tune', 'SKILL.md.tmpl');

let stateRoot: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-'));
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function runBin(
  bin: string,
  args: string[],
): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  delete env.GSTACK_HOME;
  const res = spawnSync(bin, args, { env, encoding: 'utf-8', cwd: ROOT });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

/**
 * Simulate the consent-gate check as the agent would evaluate it from
 * the template's Step 0 prose. Mirrors exactly the conditions in
 * plan-tune/SKILL.md.tmpl §"Implicit gates run first" → "Consent gate."
 */
function evaluateConsentGate(): boolean {
  const qt = runBin(BIN_CONFIG, ['get', 'question_tuning']).stdout.trim() || 'false';
  const markerPath = path.join(stateRoot, '.question-tuning-prompted');
  return qt === 'false' && !fs.existsSync(markerPath);
}

/**
 * Simulate the setup-gate check. Mirrors plan-tune/SKILL.md.tmpl §"Setup gate."
 */
function evaluateSetupGate(): boolean {
  const qt = runBin(BIN_CONFIG, ['get', 'question_tuning']).stdout.trim() || 'false';
  const profilePath = path.join(stateRoot, 'developer-profile.json');
  let declaredEmpty = true;
  if (fs.existsSync(profilePath)) {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    declaredEmpty = !profile.declared || Object.keys(profile.declared).length === 0;
  }
  const markerPath = path.join(stateRoot, '.declared-setup-prompted');
  return qt === 'true' && declaredEmpty && !fs.existsSync(markerPath);
}

// ---------------------------------------------------------------
// Test 1: consent gate fires + idempotent on marker write
// ---------------------------------------------------------------

describe('v1.49 consent gate', () => {
  test('fires when question_tuning=false AND no marker', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'false']);
    expect(evaluateConsentGate()).toBe(true);
  });

  test('does NOT fire after marker is written (decline path)', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'false']);
    fs.writeFileSync(path.join(stateRoot, '.question-tuning-prompted'), '');
    expect(evaluateConsentGate()).toBe(false);
  });

  test('does NOT fire after question_tuning flipped to true (accept path)', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'true']);
    expect(evaluateConsentGate()).toBe(false);
  });
});

// ---------------------------------------------------------------
// Test 2: setup gate fires + idempotent on marker write
// ---------------------------------------------------------------

describe('v1.49 setup gate', () => {
  test('fires when question_tuning=true AND declared empty AND no marker', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'true']);
    // --read creates a stub profile with empty declared.
    runBin(BIN_DEV, ['--read']);
    expect(evaluateSetupGate()).toBe(true);
  });

  test('does NOT fire after declared populated (post-setup)', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'true']);
    runBin(BIN_DEV, ['--read']);
    // Simulate setup completion: populate declared.
    const profilePath = path.join(stateRoot, 'developer-profile.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    profile.declared = {
      scope_appetite: 0.85,
      risk_tolerance: 0.7,
      detail_preference: 0.5,
      autonomy: 0.5,
      architecture_care: 0.85,
    };
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    expect(evaluateSetupGate()).toBe(false);
  });

  test('does NOT fire after marker is written even if declared still empty (bail path)', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'true']);
    runBin(BIN_DEV, ['--read']);
    fs.writeFileSync(path.join(stateRoot, '.declared-setup-prompted'), '');
    expect(evaluateSetupGate()).toBe(false);
  });

  test('does NOT fire when question_tuning still false (consent comes first)', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'false']);
    runBin(BIN_DEV, ['--read']);
    expect(evaluateSetupGate()).toBe(false);
  });
});

// ---------------------------------------------------------------
// Test 3: marker idempotency across re-invocations
// ---------------------------------------------------------------

describe('v1.49 marker idempotency', () => {
  test('consent gate stays silent across 5 re-invocations after one decline', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'false']);
    fs.writeFileSync(path.join(stateRoot, '.question-tuning-prompted'), '');
    for (let i = 0; i < 5; i++) {
      expect(evaluateConsentGate()).toBe(false);
    }
  });

  test('setup gate stays silent across 5 re-invocations after one bail', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'true']);
    runBin(BIN_DEV, ['--read']);
    fs.writeFileSync(path.join(stateRoot, '.declared-setup-prompted'), '');
    for (let i = 0; i < 5; i++) {
      expect(evaluateSetupGate()).toBe(false);
    }
  });

  test('both markers honored independently', () => {
    runBin(BIN_CONFIG, ['set', 'question_tuning', 'true']);
    runBin(BIN_DEV, ['--read']);
    // Touch consent marker only; setup gate should still fire.
    fs.writeFileSync(path.join(stateRoot, '.question-tuning-prompted'), '');
    expect(evaluateConsentGate()).toBe(false);
    expect(evaluateSetupGate()).toBe(true);
  });
});

// ---------------------------------------------------------------
// Test 4: static-template assertion (catches accidental deletion of gate prose)
// ---------------------------------------------------------------

describe('v1.49 gate prose survives in skill template', () => {
  const tmpl = fs.readFileSync(SKILL_TMPL, 'utf-8');

  test('Consent gate condition is present', () => {
    expect(tmpl).toMatch(/Consent gate/i);
    expect(tmpl).toMatch(/question-tuning-prompted/);
    expect(tmpl).toMatch(/question_tuning.*false/);
  });

  test('Setup gate condition is present', () => {
    expect(tmpl).toMatch(/Setup gate/i);
    expect(tmpl).toMatch(/declared-setup-prompted/);
    expect(tmpl).toMatch(/declared.*empty/i);
  });

  test('marker writes documented for both gates', () => {
    expect(tmpl).toMatch(/touch.*question-tuning-prompted/);
    expect(tmpl).toMatch(/touch.*declared-setup-prompted/);
  });
});
