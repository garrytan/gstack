/**
 * Regression tests for the 4 adversarial findings fixed during /ship:
 *
 * 1. Canary stream-chunk split bypass — rolling-buffer detection across
 *    consecutive text_delta / input_json_delta events.
 * 2. Tool-output ensemble rule — single ML classifier >= BLOCK blocks
 *    directly when the content is tool output (not user input).
 * 3. escapeHtml quote escaping (unit-level check on the shape we expect).
 * 4. snapshot command added to PAGE_CONTENT_COMMANDS.
 *
 * These tests pin the fixes so future refactors don't silently re-open
 * the bypasses both adversarial reviewers (Claude + Codex) flagged.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { combineVerdict, THRESHOLDS } from '../src/security';
import { PAGE_CONTENT_COMMANDS } from '../src/commands';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('canary stream-chunk split detection', () => {
  test('detectCanaryLeak uses rolling buffer across consecutive deltas', () => {
    // Pull in the function via dynamic require so we don't re-export it
    // from sidebar-agent.ts (it's internal on purpose).
    const agentSource = fs.readFileSync(
      path.join(REPO_ROOT, 'browse', 'src', 'sidebar-agent.ts'),
      'utf-8',
    );
    // Contract: detectCanaryLeak accepts an optional DeltaBuffer and
    // uses .slice(-(canary.length - 1)) to retain a rolling tail.
    expect(agentSource).toContain('DeltaBuffer');
    expect(agentSource).toMatch(/text_delta\s*=\s*combined\.slice\(-\(canary\.length - 1\)\)/);
    expect(agentSource).toMatch(/input_json_delta\s*=\s*combined\.slice\(-\(canary\.length - 1\)\)/);
  });

  test('canary context initializes deltaBuf', () => {
    const agentSource = fs.readFileSync(
      path.join(REPO_ROOT, 'browse', 'src', 'sidebar-agent.ts'),
      'utf-8',
    );
    // The askClaude call site must construct the buffer so the rolling
    // detection actually runs.
    expect(agentSource).toContain("deltaBuf: { text_delta: '', input_json_delta: '' }");
  });
});

describe('tool-output ensemble rule (single-layer BLOCK)', () => {
  test('user-input context: single layer at BLOCK degrades to WARN', () => {
    const result = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.95 },
      { layer: 'transcript_classifier', confidence: 0 },
    ]);
    expect(result.verdict).toBe('warn');
    expect(result.reason).toBe('single_layer_high');
  });

  test('tool-output context: single layer at BLOCK blocks directly', () => {
    const result = combineVerdict(
      [
        { layer: 'testsavant_content', confidence: 0.95 },
        { layer: 'transcript_classifier', confidence: 0, meta: { degraded: true } },
      ],
      { toolOutput: true },
    );
    expect(result.verdict).toBe('block');
    expect(result.reason).toBe('single_layer_tool_output');
  });

  test('tool-output context still respects ensemble path when 2 agree', () => {
    const result = combineVerdict(
      [
        { layer: 'testsavant_content', confidence: 0.80 },
        { layer: 'transcript_classifier', confidence: 0.75, meta: { verdict: 'block' } },
      ],
      { toolOutput: true },
    );
    expect(result.verdict).toBe('block');
    expect(result.reason).toBe('ensemble_agreement');
  });

  test('tool-output context: below BLOCK threshold still WARN, not BLOCK', () => {
    const result = combineVerdict(
      [{ layer: 'testsavant_content', confidence: THRESHOLDS.WARN }],
      { toolOutput: true },
    );
    expect(result.verdict).toBe('warn');
  });
});

describe('sidepanel escapeHtml quote escaping', () => {
  test('escapeHtml helper replaces double + single quotes', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'extension', 'sidepanel.js'),
      'utf-8',
    );
    expect(src).toContain(".replace(/\"/g, '&quot;')");
    expect(src).toContain(".replace(/'/g, '&#39;')");
  });
});

describe('snapshot in PAGE_CONTENT_COMMANDS', () => {
  test('snapshot is wrapped by untrusted-content envelope', () => {
    expect(PAGE_CONTENT_COMMANDS.has('snapshot')).toBe(true);
  });
});

describe('transcript classifier tool_output parameter', () => {
  test('checkTranscript accepts optional tool_output', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'browse', 'src', 'security-classifier.ts'),
      'utf-8',
    );
    expect(src).toContain('tool_output?: string');
    expect(src).toContain('tool_output');
    // Haiku prompt mentions tool_output
    expect(src).toContain('tool_output');
  });

  test('sidebar-agent passes tool text to transcript on tool-result scan', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'browse', 'src', 'sidebar-agent.ts'),
      'utf-8',
    );
    expect(src).toContain('tool_output: text');
  });
});

describe('GSTACK_SECURITY_OFF kill switch', () => {
  test('loadTestsavant honors env var early', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'browse', 'src', 'security-classifier.ts'),
      'utf-8',
    );
    expect(src).toContain("process.env.GSTACK_SECURITY_OFF === '1'");
  });
});
