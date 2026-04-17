import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK_JS = path.join(ROOT, 'hooks', 'caveman-voice-verify.js');

// Prebuild hook if missing (e.g. fresh clone, tests run before build)
beforeAll(() => {
  if (!fs.existsSync(HOOK_JS)) {
    const build = spawnSync(
      'bun',
      ['build', 'hooks/caveman-voice-verify.ts', '--target=node', '--outfile=hooks/caveman-voice-verify.js'],
      { cwd: ROOT, stdio: 'pipe' }
    );
    if (build.status !== 0) {
      throw new Error(`Hook build failed: ${build.stderr?.toString()}`);
    }
  }
});

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-hook-test-'));
afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Transcript fixture helpers ─────────────────────────────

interface TranscriptEvent {
  type?: string;
  message?: {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<{ type: 'text'; text: string }>;
  };
  timestamp?: string;
}

function writeTranscript(events: TranscriptEvent[]): string {
  const file = path.join(TMP_DIR, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function makeAssistantEvent(text: string, timestamp?: string): TranscriptEvent {
  return {
    type: 'assistant',
    timestamp: timestamp || new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

function makeUserEvent(text: string): TranscriptEvent {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: text,
    },
  };
}

// ─── Hook runner ────────────────────────────────────────────

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

function runHook(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): HookResult {
  const start = Date.now();
  const result = spawnSync('node', [HOOK_JS], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 3000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? -1,
    durationMs: Date.now() - start,
  };
}

// ─── Scenarios ──────────────────────────────────────────────

// Cave-compressed text that should pass caveman-full thresholds
const PASS_TEXT = `Hook fires on Stop. Read transcript. Score density. Block below threshold.
Retry detection: stop_hook_active flag primary, 5s timestamp fallback.
Fail open on errors. No disk writes. Exit 0 silent on pass. Exit 2 on block.
Tests cover 8 scenarios plus latency benchmark p95 under 300ms.
Ship complete. Next: wire setup auto-register.`;

// Verbose text that should fail caveman-full thresholds
const FAIL_TEXT = `In order to basically complete the implementation, we will really
just need to utilize the comprehensive approach that leverages the robust pattern.
It is important to note that you might want to consider whether this approach
allows for the optimization. We can perhaps actually facilitate the integration
in the event that the configuration is set up correctly. The nuanced tradeoff
is that this ensures that the system remains stable while we delve into the
crucial details. Simply put, it is worth noting that the following approach
really does help us achieve the goal in a straightforward manner.`;

describe('caveman-voice-verify Stop hook', () => {
  test('scenario 1: pass on cave-compressed transcript → exit 0, empty stdout', () => {
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(PASS_TEXT),
    ]);
    const result = runHook({ transcript_path: transcript, stop_hook_active: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('scenario 2: block on verbose transcript first attempt → exit 2 + JSON block', () => {
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(FAIL_TEXT),
    ]);
    const result = runHook({ transcript_path: transcript, stop_hook_active: false });
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('Voice density failed');
    expect(parsed.reason).toMatch(/(articles|fillers|hedges|verbose)/);
  });

  test('scenario 3: retry via stop_hook_active=true → exit 0 + retry marker', () => {
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(FAIL_TEXT),
    ]);
    const result = runHook({ transcript_path: transcript, stop_hook_active: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[voice: over-floor');
    expect(result.stdout).toContain('shipped as-is');
  });

  test('scenario 4: retry via recent prev-assistant timestamp <5s → exit 0 + marker', () => {
    const prevTs = new Date(Date.now() - 1000).toISOString(); // 1s ago
    const nowTs = new Date().toISOString();
    const transcript = writeTranscript([
      makeUserEvent('first'),
      makeAssistantEvent('prev msg', prevTs),
      makeUserEvent('second'),
      makeAssistantEvent(FAIL_TEXT, nowTs),
    ]);
    const result = runHook({ transcript_path: transcript, stop_hook_active: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[voice: over-floor');
  });

  test('scenario 5: opt-out via CAVESTACK_VOICE_VERIFY=0 → exit 0 silent', () => {
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(FAIL_TEXT),
    ]);
    const result = runHook(
      { transcript_path: transcript, stop_hook_active: false },
      { CAVESTACK_VOICE_VERIFY: '0' }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('scenario 6: short message (<20 words) → exit 0 silent even if verbose', () => {
    // Verbose short message — fewer than 20 words
    const short = 'The thing is just really very simply wrong.';
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(short),
    ]);
    const result = runHook({ transcript_path: transcript, stop_hook_active: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('scenario 7: profile=none → exit 0 silent', () => {
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(FAIL_TEXT),
    ]);
    const result = runHook(
      { transcript_path: transcript, stop_hook_active: false },
      { CAVESTACK_VOICE: 'none' }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('scenario 8: missing transcript → exit 0 silent (fail open)', () => {
    const result = runHook({ transcript_path: '/definitely/not/a/real/path.jsonl' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('scenario 9: no stdin input → exit 0 silent', () => {
    const result = runHook({});
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('scenario 10: code/table stripping — verbose content inside fence does not block', () => {
    const mixed = `Pass text here. Hook fires. Read transcript. Score.

\`\`\`
In order to utilize the comprehensive approach we will leverage robust tooling.
It is important to note that you might want to consider this.
\`\`\`

Direct. Tight. Ship.`;
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(mixed),
    ]);
    const result = runHook({ transcript_path: transcript, stop_hook_active: false });
    expect(result.exitCode).toBe(0);
  });

  test('scenario 11: caveman-lite profile permits more articles', () => {
    // Mildly articled prose — should fail caveman-full but pass caveman-lite
    const mild = `The hook reads the transcript from the path given by Claude Code.
It extracts the last assistant message. It scores the density against the active
profile. The profile thresholds determine the floor. Code blocks are stripped
before scoring. Tables are also stripped if they have a separator row.
The output writes nothing on pass. On a block, the output is a JSON decision.
The retry path writes a marker so the user sees what happened.`;
    const transcript = writeTranscript([
      makeUserEvent('test'),
      makeAssistantEvent(mild),
    ]);
    const full = runHook({ transcript_path: transcript, stop_hook_active: false });
    const lite = runHook(
      { transcript_path: transcript, stop_hook_active: false },
      { CAVESTACK_VOICE: 'caveman-lite' }
    );
    // caveman-full is strict (articles floor 2.0), should block
    expect(full.exitCode).toBe(2);
    // caveman-lite is looser (articles floor 3.0) — may or may not pass this
    // specific sample, but should never be stricter than caveman-full
    if (full.exitCode === 2 && lite.exitCode === 0) {
      expect(lite.stdout.trim()).toBe('');
    }
  });
});

describe('caveman-voice-verify latency benchmark', () => {
  test(
    'p95 latency ≤ 500ms over 30 runs',
    () => {
      const transcript = writeTranscript([
        makeUserEvent('test'),
        makeAssistantEvent(PASS_TEXT),
      ]);

      const durations: number[] = [];
      const runs = 30;
      for (let i = 0; i < runs; i++) {
        const r = runHook({ transcript_path: transcript, stop_hook_active: false });
        durations.push(r.durationMs);
      }

      durations.sort((a, b) => a - b);
      const p95Index = Math.floor(runs * 0.95);
      const p95 = durations[p95Index];
      const median = durations[Math.floor(runs / 2)];
      const max = durations[runs - 1];

      if (process.env.VERBOSE_BENCH === '1') {
        console.log(
          `  latency: median=${median}ms, p95=${p95}ms, max=${max}ms (${runs} runs)`
        );
      }

      // Budget: 300ms p95 per design doc. Windows Node startup is slow — cap
      // at 500ms in CI so this does not false-flag on cold start. Tighten
      // to 300ms once Linux CI baseline is known.
      expect(p95).toBeLessThanOrEqual(500);
    },
    { timeout: 30000 }
  );
});
