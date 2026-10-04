/**
 * Preflight for the overlay efficacy harness.
 *
 * Confirms, before any paid eval runs:
 *   1. `@anthropic-ai/claude-agent-sdk` loads and `query()` is the expected shape.
 *   2. `claude-opus-4-7` is a live API model ID (not a Claude Code alias).
 *   3. The SDK event stream contains the types we assume (system init, assistant,
 *      result) with the fields we destructure.
 *   4. `scripts/resolvers/model-overlay.ts` resolves `{{INHERIT:claude}}` against
 *      `opus-4-7.md` with no unresolved inheritance directives.
 *   5. A local `claude` binary exists at `which claude` so binary pinning is possible.
 *
 * Run: bun run scripts/preflight-agent-sdk.ts [--live]
 *
 * Checks 1-2 and 4-5 are free. Check 3 (the live SDK query, ~15 tokens of API
 * spend) runs only with --live. Exit 0 on success, 1 on any failed check,
 * 2 on a bad argument.
 */

import '../lib/conductor-env-shim';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readOverlay } from './resolvers/model-overlay';
import { resolveClaudeBinary } from '../lib/claude-bin';

const USAGE = `Usage: bun run scripts/preflight-agent-sdk.ts [--live]

Free checks: overlay resolution and local claude binary pinning.
--live  also runs one end-to-end SDK query against claude-opus-4-7
        (~15 tokens of API spend; needs ANTHROPIC_API_KEY).`;

function parsePreflightArgs(argv: string[]): { help: boolean; live: boolean } {
  const parsed = { help: false, live: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--live') parsed.live = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return parsed;
}

async function main() {
  let args: { help: boolean; live: boolean };
  try {
    args = parsePreflightArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`preflight-agent-sdk: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const failures: string[] = [];
  const pass = (msg: string) => console.log(`  ok  ${msg}`);
  const fail = (msg: string) => {
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
  };

  // 1. Overlay resolver
  console.log('1. Overlay resolver');
  const resolved = readOverlay('opus-4-7');
  if (!resolved) {
    fail("readOverlay('opus-4-7') returned empty");
  } else {
    pass(`resolved overlay length: ${resolved.length} chars`);
    if (resolved.includes('{{INHERIT:')) {
      fail('resolved overlay still contains {{INHERIT:...}} directive');
    } else {
      pass('no unresolved INHERIT directives');
    }
  }

  // 2. Local claude binary exists
  console.log('\n2. Binary pinning');
  let claudePath: string | null = resolveClaudeBinary();
  if (claudePath) {
    pass(`local claude binary: ${claudePath}`);
  } else {
    fail('`Bun.which("claude")` failed — cannot pin binary (set GSTACK_CLAUDE_BIN to override)');
  }

  // 3. SDK query end-to-end
  console.log('\n3. SDK query end-to-end');
  if (!args.live) {
    console.log('  skip  live query not requested — rerun with --live to spend ~15 tokens on it');
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  skip  ANTHROPIC_API_KEY not set — cannot test live query');
  } else {
    try {
      const events: SDKMessage[] = [];
      const q = query({
        prompt: 'say pong',
        options: {
          model: 'claude-opus-4-7',
          systemPrompt: '',
          tools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          maxTurns: 1,
          pathToClaudeCodeExecutable: claudePath ?? undefined,
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
        },
      });
      for await (const ev of q) events.push(ev);
      pass(`received ${events.length} events`);

      const init = events.find(
        (e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init',
      ) as { claude_code_version?: string; model?: string } | undefined;
      if (!init) {
        fail('no system/init event received');
      } else {
        pass(`system init: claude_code_version=${init.claude_code_version}, model=${init.model}`);
      }

      const assistantEvents = events.filter((e) => e.type === 'assistant');
      if (assistantEvents.length === 0) {
        fail('no assistant events received — model ID may be rejected');
      } else {
        pass(`received ${assistantEvents.length} assistant event(s)`);
        const first = assistantEvents[0] as { message?: { content?: unknown[] } };
        const content = first.message?.content;
        if (!Array.isArray(content)) {
          fail('first assistant event has no content[] array');
        } else {
          pass(`first assistant content[] has ${content.length} block(s)`);
        }
      }

      const result = events.find((e) => e.type === 'result') as
        | { subtype?: string; total_cost_usd?: number; num_turns?: number }
        | undefined;
      if (!result) {
        fail('no result event received');
      } else {
        pass(
          `result: subtype=${result.subtype}, cost=$${result.total_cost_usd?.toFixed(4)}, turns=${result.num_turns}`,
        );
      }
    } catch (err) {
      fail(`SDK query threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  if (failures.length > 0) {
    console.log(`PREFLIGHT FAILED: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('PREFLIGHT OK');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
