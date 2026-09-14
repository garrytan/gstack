import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Regression test for the runSkillTest timeout path (free tier — no API call,
// the spawned "claude" is a local fake).
//
// proc.kill() only signals the `sh -c` wrapper; the claude child it spawned
// survives as an orphan that inherited our stdout/stderr pipes. Before the
// fix, the runner then blocked on the pipe drain until the orphan exited —
// observed as a 600s spawn timeout stretching past 1400s and tripping bun's
// per-test timeout in skill-e2e-autoplan-dual-voice.test.ts. The fix cancels
// the stdout reader on timeout and races the stderr drain against child exit
// plus a short grace window.

const ORPHAN_LINGER_SECS = 45; // without the fix the runner blocks this long

describe.skipIf(process.platform === 'win32')('session-runner timeout path', () => {
  let fixtureBin: string;
  let workDir: string;

  beforeAll(() => {
    fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-bin-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-runner-timeout-'));

    // Fake claude: emits minimal stream-json, spawns a pipe-holding orphan,
    // then lingers in the foreground. Killing the sh wrapper leaves both this
    // process and its background child alive, holding the pipes open.
    const fakeClaude = path.join(fixtureBin, 'claude');
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
cat > /dev/null &
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo hi"}}]}}'
sleep ${ORPHAN_LINGER_SECS} &
exec sleep ${ORPHAN_LINGER_SECS}
`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    for (const dir of [fixtureBin, workDir]) {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    'returns promptly when a killed child leaves a pipe-holding orphan',
    async () => {
      const started = Date.now();
      const result = await runSkillTest({
        testName: 'session-runner-timeout-orphan',
        workingDirectory: workDir,
        prompt: 'irrelevant — the fake claude ignores stdin',
        timeout: 3_000,
        env: { PATH: `${fixtureBin}:${process.env.PATH ?? ''}` },
      });
      const wall = Date.now() - started;

      expect(result.exitReason).toBe('timeout');
      // Streamed lines collected before the kill must survive the cancel.
      expect(result.transcript.some((e: any) => e?.type === 'assistant')).toBe(true);
      // Without the fix the runner blocks until the orphan exits (~${ORPHAN_LINGER_SECS}s).
      // Timeout (3s) + stderr grace (5s) + slack must stay well under that.
      expect(wall).toBeLessThan(20_000);
    },
    30_000,
  );
});
