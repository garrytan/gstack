/**
 * Hermetic-isolation canaries (gate tier, ~$0.02 each, deterministic).
 *
 * Two tests that make the hermeticity claim FALSIFIABLE instead of asserted:
 *
 * 1. `hermetic-canary` — env + auth isolation. Plants contamination vars in
 *    the TEST process env, spawns a child through the real runner, and
 *    asserts from the Bash tool_result in the stream-json transcript (never
 *    the model's prose — prose can hallucinate) that the child saw a temp
 *    `/.claude` config dir, a temp GSTACK_HOME, and none of the planted
 *    contamination. Auth hermeticity: hard-fails when ANTHROPIC_API_KEY is
 *    absent (a skip here would be a silent hole), and asserts
 *    total_cost_usd > 0 — subscription/keychain OAuth reports cost 0, so
 *    nonzero cost is the discriminator that the API key actually paid
 *    (verified empirically 2026-06-12; the result record exposes no
 *    auth-source field, so cost is the best available signal — residual
 *    gap documented in the plan).
 *
 * 2. `hermetic-sentinel` — config isolation, the poisoned-operator probe.
 *    Builds a FAKE operator config tree (user CLAUDE.md + an mcpServers
 *    entry) and points the test process's CLAUDE_CONFIG_DIR at it. If the
 *    hermetic redirect ever breaks, the child loads that poisoned tree and
 *    the probes fire: init.mcp_servers would list the planted server
 *    (semantic proof that --strict-mcp-config + the redirect yield ZERO MCP
 *    servers, not an assumption), and the child's config dir would contain
 *    the poisoned CLAUDE.md.
 *
 * Both canaries double as the seed-schema / CLI version-skew tripwire: a
 * claude release that changes first-run behavior or config discovery fails
 * here first, loudly, in the gate tier.
 */

import { expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runSkillTest } from './helpers/session-runner';
import {
  describeIfSelected, testIfSelected, createEvalCollector, finalizeEvalCollector,
  recordE2E, runId, logCost,
} from './helpers/e2e-helpers';

const evalCollector = createEvalCollector('e2e-hermetic');

// Cheap + deterministic: the canaries assert environment facts, not model
// quality, so the smallest model is the right tool.
const CANARY_MODEL = 'claude-haiku-4-5-20251001';

/** Extract concatenated tool_result text from the stream-json transcript. */
function toolResultText(transcript: any[]): string {
  const chunks: string[] = [];
  for (const event of transcript) {
    if (event.type !== 'user') continue;
    for (const item of event.message?.content ?? []) {
      if (item.type !== 'tool_result') continue;
      if (typeof item.content === 'string') chunks.push(item.content);
      else for (const c of item.content ?? []) if (c.type === 'text') chunks.push(c.text);
    }
  }
  return chunks.join('\n');
}

function initEvent(transcript: any[]): any {
  return transcript.find((e) => e.type === 'system' && e.subtype === 'init');
}

describeIfSelected('hermetic isolation canaries', ['hermetic-canary', 'hermetic-sentinel'], () => {
  testIfSelected('hermetic-canary', async () => {
    // Auth hermeticity is part of the contract: a missing key must FAIL the
    // gate, not skip it — a skipped canary is a silent hole.
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('hermetic-canary requires ANTHROPIC_API_KEY (source ~/.zshrc); refusing to skip');
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-canary-'));
    // Plant contamination deterministically — the operator env may or may not
    // carry these, so set them ourselves and restore after.
    const planted: Record<string, string> = {
      CONDUCTOR_WORKSPACE_PATH: '/tmp/poison-conductor-ws',
      GBRAIN_POISON_PROBE: 'leaked',
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(planted)) { prev[k] = process.env[k]; process.env[k] = v; }

    try {
      const result = await runSkillTest({
        prompt: 'Run exactly this bash command and then stop: ' +
          'echo "CFG=$CLAUDE_CONFIG_DIR"; echo "GH=$GSTACK_HOME"; ' +
          'echo "CW=$CONDUCTOR_WORKSPACE_PATH"; echo "GP=$GBRAIN_POISON_PROBE"',
        workingDirectory: workDir,
        maxTurns: 3,
        allowedTools: ['Bash'],
        timeout: 120_000,
        testName: 'hermetic-canary',
        runId,
        model: CANARY_MODEL,
      });
      logCost('hermetic-canary', result);
      recordE2E(evalCollector, 'hermetic-canary', 'e2e-hermetic', result);

      expect(result.exitReason).toBe('success');

      // Deterministic: assert the Bash tool OUTPUT, not the model's prose.
      const bashOut = toolResultText(result.transcript);
      const cfg = bashOut.match(/CFG=(\S*)/)?.[1] ?? '';
      expect(cfg).toMatch(/gstack-hermetic-.*\/\.claude$/);
      expect(bashOut).toMatch(/GH=\S*gstack-home/);
      // Planted contamination must not reach the child. CLAUDECODE is NOT
      // probed here: the child claude CLI sets CLAUDECODE=1 for its own tool
      // subprocesses (verified empirically — CI behaves identically), so the
      // Bash tool can't observe our scrub of it; the unit test pins that.
      expect(bashOut).toMatch(/(^|\n)CW=\s*($|\n)/); // planted Conductor var scrubbed
      expect(bashOut).toMatch(/(^|\n)GP=\s*($|\n)/); // GBRAIN_* scrubbed

      // Zero MCP servers — semantic, from the init event, not a flag grep.
      const init = initEvent(result.transcript);
      expect(init).toBeTruthy();
      expect(init.mcp_servers ?? []).toHaveLength(0);

      // Auth: nonzero cost = the API key paid (OAuth/keychain reports 0).
      expect(result.transcript.find((e) => e.type === 'result')?.total_cost_usd).toBeGreaterThan(0);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 180_000);

  testIfSelected('hermetic-sentinel', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('hermetic-sentinel requires ANTHROPIC_API_KEY (source ~/.zshrc); refusing to skip');
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-sentinel-'));
    // Poisoned operator config tree: if the hermetic redirect breaks, the
    // child discovers this dir and both probes below fire.
    const poisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-poison-'));
    const poisonCfg = path.join(poisonRoot, '.claude');
    fs.mkdirSync(poisonCfg, { recursive: true });
    fs.writeFileSync(path.join(poisonCfg, 'CLAUDE.md'), 'POISONED OPERATOR MEMORY — must never load\n');
    fs.writeFileSync(path.join(poisonCfg, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { 'sentinel-mcp': { command: '/usr/bin/true', args: [] } },
    }));
    const prevCfgDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = poisonCfg;

    try {
      const result = await runSkillTest({
        prompt: 'Run exactly this bash command and then stop: ' +
          'echo "CFG=$CLAUDE_CONFIG_DIR"; ' +
          'if [ -f "$CLAUDE_CONFIG_DIR/CLAUDE.md" ]; then echo "USER_MD=present"; else echo "USER_MD=absent"; fi',
        workingDirectory: workDir,
        maxTurns: 3,
        allowedTools: ['Bash'],
        timeout: 120_000,
        testName: 'hermetic-sentinel',
        runId,
        model: CANARY_MODEL,
      });
      logCost('hermetic-sentinel', result);
      recordE2E(evalCollector, 'hermetic-sentinel', 'e2e-hermetic', result);

      expect(result.exitReason).toBe('success');

      const bashOut = toolResultText(result.transcript);
      const cfg = bashOut.match(/CFG=(\S*)/)?.[1] ?? '';
      // The redirect must beat the poisoned operator value...
      expect(cfg).not.toBe(poisonCfg);
      expect(cfg).toMatch(/gstack-hermetic-.*\/\.claude$/);
      // ...and the active config dir must not carry the poisoned user memory.
      expect(bashOut).toContain('USER_MD=absent');

      // The planted MCP server must be invisible: zero servers in init.
      const init = initEvent(result.transcript);
      expect(init).toBeTruthy();
      const servers = (init.mcp_servers ?? []).map((s: any) => s?.name ?? s);
      expect(servers).toHaveLength(0);
      expect(JSON.stringify(servers)).not.toContain('sentinel-mcp');
    } finally {
      if (prevCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevCfgDir;
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(poisonRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

afterAll(() => finalizeEvalCollector(evalCollector));
