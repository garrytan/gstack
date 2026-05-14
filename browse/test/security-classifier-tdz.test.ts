import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Regression test for the TDZ (Temporal Dead Zone) bug at the claude-CLI-missing
 * early return inside checkTranscript's Promise executor.
 *
 * Original bug:
 *   const claude = resolveClaudeCommand();
 *   if (!claude) return finish({...});     // ← TDZ: finish not yet declared
 *   const p = spawn(...);
 *   let done = false;
 *   const finish = (...) => {...};          // ← declared HERE, too late
 *
 * Fix: hoist `let done` + `const finish` above the resolveClaudeCommand call.
 *
 * This test exercises the outer guard (checkHaikuAvailable returning false when
 * claude CLI is not on PATH), which is the realistic runtime path. The TDZ
 * itself was inside the spawn Promise — only reachable in a TOCTOU window if
 * claude went missing between checkHaikuAvailable and the spawn call. The fix
 * makes that window safe regardless. This test guards against regression by
 * proving the missing-CLI flow returns the expected degraded signal without
 * throwing.
 */
describe('security-classifier: missing claude CLI degraded path', () => {
  let origPath: string | undefined;
  let origGstackClaudeBin: string | undefined;
  let origClaudeBin: string | undefined;

  beforeEach(() => {
    origPath = process.env.PATH;
    origGstackClaudeBin = process.env.GSTACK_CLAUDE_BIN;
    origClaudeBin = process.env.CLAUDE_BIN;
    // Force resolveClaudeCommand() to fail: clear PATH AND override env vars
    // (resolveClaudeCommand in browse/src/claude-bin.ts honors GSTACK_CLAUDE_BIN
    // and CLAUDE_BIN before falling back to Bun.which(PATH)).
    process.env.PATH = '/nonexistent';
    delete process.env.GSTACK_CLAUDE_BIN;
    delete process.env.CLAUDE_BIN;
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    if (origGstackClaudeBin !== undefined) process.env.GSTACK_CLAUDE_BIN = origGstackClaudeBin;
    if (origClaudeBin !== undefined) process.env.CLAUDE_BIN = origClaudeBin;
  });

  test('checkTranscript returns degraded signal without throwing when claude CLI is unavailable', async () => {
    // Fresh import so haikuAvailableCache isn't already populated from a prior test.
    // Bun's module cache is per-test-file; this fresh import path stays clean.
    const { checkTranscript } = await import('../src/security-classifier');

    const result = await checkTranscript({
      user_message: 'hello',
      tool_calls: [],
    });

    // Assert via JSON serialization to bypass any TS narrowing quirks on
    // result.meta (Record<string, unknown>).
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('"layer":"transcript_classifier"');
    expect(serialized).toContain('"confidence":0');
    expect(serialized).toContain('"degraded":true');
    // Reason must indicate the CLI was missing or the spawn failed — proves the
    // early-return / spawn-path returned a structured signal without throwing.
    expect(serialized).toMatch(/"reason":"(claude_cli_not_found|spawn_error|exit_)/);
  });
});
