/**
 * LLM judge for PTY state and snapshot logging. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as fs from 'node:fs';
import { resolveEvalModel } from '../../../lib/eval-model';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveClaudeBinary } from './binary';

// ────────────────────────────────────────────────────────────────────────────
// LLM judge — "is the model waiting for user input, working, or hung?"
//
// Regex detectors (isNumberedOptionListVisible, isProseAUQVisible) are fast
// and deterministic but brittle to PTY rendering quirks (cursor-positioning
// escapes that collapse multi-line option lists onto a single logical line).
// When they miss, the polling loop times out at the full budget — even
// though the model is correctly surfacing a question via a format the regex
// can't reassemble.
//
// This LLM judge takes a TTY snapshot and answers a trichotomy:
//   - 'waiting'  — agent surfaced a question/options, sitting at input prompt
//   - 'working'  — agent is still generating (spinner, tool calls, "Musing")
//   - 'hung'     — agent stopped without surfacing anything (rare)
//
// Used by polling loops as a fallback after N seconds with no terminal
// classification. On 'waiting' verdict, return outcome='asked' early.
//
// Cost: ~$0.0005 per call using claude haiku 5.5 (the warmup default). Cached by snapshot hash so
// identical TTY frames don't re-charge. All verdicts logged to
// ~/.gstack/analytics/pty-judge.jsonl for offline analysis.
// ────────────────────────────────────────────────────────────────────────────


export interface PtyStateVerdict {
  state: 'waiting' | 'working' | 'hung' | 'unknown';
  reasoning: string;
  /** SHA-1 of the normalized snapshot input (for caching/dedup). */
  hash: string;
  /** Wall time (ms) the judge call took. */
  elapsedMs: number;
}

const PTY_VERDICT_CACHE = new Map<string, PtyStateVerdict>();

/**
 * Persist a verdict (or snapshot dump) to the analytics JSONL log.
 * Best-effort — failures (disk full, permission denied, etc.) are swallowed
 * so the harness never fails on logging.
 */
function logPtyJudge(record: Record<string, unknown>): void {
  try {
    const dir = `${process.env.HOME}/.gstack/analytics`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(`${dir}/pty-judge.jsonl`, JSON.stringify(record) + '\n');
  } catch {
    /* best-effort */
  }
}

/**
 * Snapshot dump for postmortem debugging when GSTACK_PTY_LOG=1.
 * Writes the last 4KB of visible TTY plus context to
 * ~/.gstack/analytics/pty-snapshots/<testName>-<elapsed>ms.txt.
 */
export function logPtySnapshot(visible: string, ctx: { testName: string; elapsedMs: number; tag?: string }): void {
  if (process.env.GSTACK_PTY_LOG !== '1') return;
  try {
    const dir = `${process.env.HOME}/.gstack/analytics/pty-snapshots`;
    fs.mkdirSync(dir, { recursive: true });
    const tag = ctx.tag ? `-${ctx.tag}` : '';
    const file = `${dir}/${ctx.testName}-${ctx.elapsedMs}ms${tag}.txt`;
    fs.writeFileSync(
      file,
      `# testName: ${ctx.testName}\n# elapsedMs: ${ctx.elapsedMs}\n# tag: ${ctx.tag ?? ''}\n# visible.length: ${visible.length}\n\n${visible.slice(-4096)}`,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Ask Claude Haiku 4.5 to classify a TTY snapshot as waiting/working/hung.
 *
 * Implementation: spawns `claude -p --model <resolveEvalModel("warmup"), claude-haiku-5-5 by default>` synchronously
 * with the prompt piped via stdin. Uses subscription auth (no API key env
 * required). 30-second timeout; returns 'unknown' on any failure mode
 * (timeout, malformed JSON, missing claude binary). Asynchronous: a PTY
 * session sharing this process (bun --concurrent) keeps reading its terminal
 * and running its close deadlines while the judge waits.
 *
 * Cache: identical snapshot hashes return the cached verdict without
 * re-calling. Cache lives in-process; resets between test runs.
 */
export async function judgePtyState(
  visible: string,
  ctx?: { testName?: string },
): Promise<PtyStateVerdict> {
  // Normalize: strip trailing whitespace lines + take last 4KB. Hash the
  // normalized form so spinner-frame-only diffs (which all look "working")
  // don't bust the cache and rack up cost.
  const tail = visible.slice(-4096).replace(/[ \t]+$/gm, '');
  const hash = createHash('sha1').update(tail).digest('hex').slice(0, 16);

  const cached = PTY_VERDICT_CACHE.get(hash);
  if (cached) return cached;

  const judgeStart = Date.now();
  const prompt = `You are reading a snapshot of a terminal where Claude Code is running in plan mode for an automated test. Your job: classify the agent's current state.

Pick exactly ONE:
- WAITING — agent surfaced a question or option list and is sitting at the input prompt waiting for user reply. Signs: numbered/lettered options visible (1./2./3. or A)/B)/C)), "Recommendation:" line, cursor at empty input prompt with no recent generation activity, OR a fully-rendered question + reply-instruction (e.g. "Reply with A, B, or C" / "Recommendation:") is visible.
- WORKING — agent is actively generating or running tools. Signs: spinner glyphs (✻ ✶ ✳ ✢ ✽), "Musing..." or "Churned for ..." text, recent tool-call blocks (Read/Edit/Bash/Grep), in-flight token output.

PRECEDENCE OVERRIDE: if a lettered/numbered option list (A)/B)/1./2.) AND a "Recommendation:" or "Reply with"/"Reply A" instruction are BOTH visible in this snapshot, classify WAITING even when spinner glyphs (✻ ✶ ✳ ✢ ✽) are still animating — Claude Code keeps the spinner up at an idle prose decision, so a spinner alongside a fully-rendered question + reply-instruction is a residual render artifact, not active generation.
- HUNG — agent has stopped without surfacing a question and without any spinner/work activity. Rare; usually means a crash.

Respond with strict JSON ONLY (no markdown fences, no prose):
{"state":"waiting","reasoning":"one short sentence"}

Terminal snapshot (last 4KB):
\`\`\`
${tail}
\`\`\``;

  let verdict: PtyStateVerdict = {
    state: 'unknown',
    reasoning: 'judge call did not complete',
    hash,
    elapsedMs: 0,
  };

  try {
    // Use the same binary resolution as every PTY launch in this file —
    // judgePtyState previously hardcoded bare 'claude' three definitions
    // below resolveClaudeBinary(), breaking under hermetic PATHs.
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        resolveClaudeBinary() ?? 'claude',
        ['-p', '--model', resolveEvalModel('warmup'), '--max-turns', '1'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
      child.stdout.setEncoding('utf-8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf-8').on('data', chunk => { stderr += chunk; });
      child.stdin.on('error', () => {});
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      child.stdin.end(prompt);
    });
    const elapsedMs = Date.now() - judgeStart;
    if (result.status === 0 && result.stdout) {
      // Pull the first {...} JSON object out of stdout. Haiku occasionally
      // wraps in ```json ...``` despite the prompt; tolerate that.
      const match = result.stdout.match(/\{[\s\S]*?"state"[\s\S]*?\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          const state = ['waiting', 'working', 'hung'].includes(parsed.state)
            ? (parsed.state as 'waiting' | 'working' | 'hung')
            : 'unknown';
          verdict = {
            state,
            reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
            hash,
            elapsedMs,
          };
        } catch {
          verdict = { state: 'unknown', reasoning: 'malformed JSON', hash, elapsedMs };
        }
      } else {
        verdict = { state: 'unknown', reasoning: 'no JSON in response', hash, elapsedMs };
      }
    } else {
      verdict = {
        state: 'unknown',
        reasoning: `claude exited ${result.status} (${(result.stderr ?? '').slice(0, 80)})`,
        hash,
        elapsedMs,
      };
    }
  } catch (err) {
    verdict = {
      state: 'unknown',
      reasoning: `judge spawn failed: ${(err as Error).message}`.slice(0, 200),
      hash,
      elapsedMs: Date.now() - judgeStart,
    };
  }

  PTY_VERDICT_CACHE.set(hash, verdict);
  logPtyJudge({
    ts: new Date().toISOString(),
    testName: ctx?.testName ?? 'unknown',
    state: verdict.state,
    reasoning: verdict.reasoning,
    hash: verdict.hash,
    judgeMs: verdict.elapsedMs,
  });
  return verdict;
}
