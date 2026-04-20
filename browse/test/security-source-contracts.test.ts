/**
 * Source-level contract tests for security code paths that are not exported
 * and therefore not reachable from unit tests. Follows the same convention
 * as sidebar-security.test.ts — asserts specific invariants by grep'ing the
 * source tree.
 *
 * These tests fail fast if a future refactor silently drops:
 *   * A canary-leak check on one of the known outbound channels
 *   * The SCANNED_TOOLS set for post-tool-result ML scans
 *   * The security_event relay in server.ts processAgentEvent
 *   * The canary field on the queue entry (server → sidebar-agent)
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const AGENT_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/sidebar-agent.ts'),
  'utf-8',
);
const SERVER_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/server.ts'),
  'utf-8',
);

describe('detectCanaryLeak — channel coverage (source)', () => {
  test('covers assistant_text channel', () => {
    expect(AGENT_SRC).toContain("'assistant_text'");
  });

  test('covers tool_use arguments via checkCanaryInStructure', () => {
    expect(AGENT_SRC).toMatch(/checkCanaryInStructure\(block\.input, canary\)/);
    expect(AGENT_SRC).toMatch(/checkCanaryInStructure\(event\.content_block\.input, canary\)/);
  });

  test('covers text_delta streaming channel', () => {
    expect(AGENT_SRC).toContain("'text_delta'");
    expect(AGENT_SRC).toContain("event.delta?.type === 'text_delta'");
  });

  test('covers input_json_delta (streaming tool args)', () => {
    expect(AGENT_SRC).toContain("'tool_input_delta'");
    expect(AGENT_SRC).toContain("event.delta?.type === 'input_json_delta'");
  });

  test('covers result channel (final claude event)', () => {
    expect(AGENT_SRC).toContain("event.type === 'result'");
    expect(AGENT_SRC).toContain('event.result.includes(canary)');
  });
});

describe('SCANNED_TOOLS — ML scan coverage for tool outputs', () => {
  test('Read, Grep, Glob, Bash, WebFetch all included', () => {
    const match = AGENT_SRC.match(/const SCANNED_TOOLS = new Set\(\[([^\]]+)\]\);/);
    expect(match).toBeTruthy();
    const list = match![1];
    expect(list).toContain("'Read'");
    expect(list).toContain("'Grep'");
    expect(list).toContain("'Glob'");
    expect(list).toContain("'Bash'");
    expect(list).toContain("'WebFetch'");
  });

  test('tool-result scanner only fires when text.length >= 32', () => {
    // Tiny tool outputs (e.g. empty directory listings) should not trigger
    // the expensive ML path.
    expect(AGENT_SRC).toMatch(/text\.length >= 32/);
  });
});

describe('processAgentEvent — security_event relay (server.ts)', () => {
  test('relays verdict, reason, layer, confidence, domain, channel, tool, signals', () => {
    // Block: addChatEntry call inside the security_event branch
    const branch = SERVER_SRC.split("event.type === 'security_event'")[1] ?? '';
    expect(branch).toContain('addChatEntry');
    expect(branch).toContain('verdict: event.verdict');
    expect(branch).toContain('reason: event.reason');
    expect(branch).toContain('layer: event.layer');
    expect(branch).toContain('confidence: event.confidence');
    expect(branch).toContain('domain: event.domain');
    expect(branch).toContain('channel: event.channel');
    expect(branch).toContain('signals: event.signals');
  });
});

describe('spawnClaude — canary lifecycle (server.ts)', () => {
  test('generates a fresh canary per message', () => {
    expect(SERVER_SRC).toMatch(/const canary = generateCanary\(\);/);
  });

  test('injects canary into the system prompt before embedding user message', () => {
    expect(SERVER_SRC).toMatch(/injectCanary\(systemPrompt, canary\)/);
    // Order matters: canary-augmented system prompt comes before <user-message>
    expect(SERVER_SRC).toMatch(/systemPromptWithCanary.*<user-message>/s);
  });

  test('canary is written into the queue entry for sidebar-agent pickup', () => {
    // Queue entry JSON includes `canary` field so sidebar-agent can scan
    // outbound channels for it.
    expect(SERVER_SRC).toMatch(/canary,.*sidebar-agent/s);
  });
});

describe('askClaude — pre-spawn + tool-result defense wiring', () => {
  test('preSpawnSecurityCheck runs BEFORE claude subprocess spawn', () => {
    // The pre-spawn check must be `await`ed and short-circuit spawning when
    // it returns true.
    expect(AGENT_SRC).toMatch(/await preSpawnSecurityCheck\(queueEntry\)/);
  });

  test('canaryCtx onLeak kills proc with SIGTERM then SIGKILL after 2s', () => {
    expect(AGENT_SRC).toContain("proc.kill('SIGTERM')");
    expect(AGENT_SRC).toContain("proc.kill('SIGKILL')");
    // 2000ms fallback appears near both onLeak and tool-result-block handlers
    expect(AGENT_SRC).toContain('}, 2000);');
  });

  test('tool-result scan runs all three classifiers in parallel (no L4 gate)', () => {
    // Regression guard for the Haiku-always change. Previously the scan
    // short-circuited when L4/L4c both returned below WARN, which meant
    // Haiku (our best signal per BrowseSafe-Bench) rarely ran. Now we run
    // all three in parallel and let combineVerdict decide.
    expect(AGENT_SRC).toMatch(/scanPageContent\(text\),[\s\S]*scanPageContentDeberta\(text\),[\s\S]*checkTranscript\(/);
    // The old short-circuit must be gone.
    expect(AGENT_SRC).not.toMatch(/if \(maxContent < THRESHOLDS\.WARN\) return;/);
  });

  test('onCanaryLeaked fires both security_event and agent_error for legacy clients', () => {
    const fn = AGENT_SRC.split('async function onCanaryLeaked')[1]?.split('async function ')[0] ?? '';
    expect(fn).toContain("type: 'security_event'");
    expect(fn).toContain("type: 'agent_error'");
    expect(fn).toContain('Session terminated');
  });
});
