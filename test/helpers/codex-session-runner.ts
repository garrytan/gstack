/**
 * Codex CLI subprocess runner for skill E2E testing.
 *
 * Spawns `codex exec --json` as an independent process, parses JSONL events,
 * and extracts command executions plus final agent messages.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const GSTACK_DEV_DIR = path.join(os.homedir(), ".gstack-dev");
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, "codex-e2e-live.json");

export function sanitizeCodexTestName(name: string): string {
  return name.replace(/^\/+/, "").replace(/\//g, "-");
}

function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export interface CodexCostEstimate {
  estimatedTokens: number;
  estimatedCost: number;
  turnsUsed: number;
}

export interface CodexToolCall {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

export interface CodexSkillTestResult {
  toolCalls: CodexToolCall[];
  browseErrors: string[];
  exitReason: string;
  duration: number;
  output: string;
  costEstimate: CodexCostEstimate;
  transcript: any[];
  stderr: string;
}

export interface ParsedCodexJSONL {
  transcript: any[];
  toolCalls: CodexToolCall[];
  agentMessages: string[];
  turnCount: number;
  usageTokens: number;
}

const BROWSE_ERROR_PATTERNS = [
  /failed to load skill .*missing YAML frontmatter/i,
  /Unknown command: \w+/,
  /Unknown snapshot flag: .+/,
  /ERROR: browse binary not found/,
  /Server failed to start/,
  /no such file or directory.*browse/i,
];

export function parseCodexJSONL(lines: string[]): ParsedCodexJSONL {
  const transcript: any[] = [];
  const toolCalls: CodexToolCall[] = [];
  const agentMessages: string[] = [];
  let turnCount = 0;
  let usageTokens = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      transcript.push(event);

      if (event.type === "turn.completed") {
        turnCount += 1;
        usageTokens +=
          (event.usage?.input_tokens || 0) +
          (event.usage?.cached_input_tokens || 0) +
          (event.usage?.output_tokens || 0);
      }

      if (event.type === "item.completed") {
        const item = event.item || {};
        if (item.type === "agent_message" && typeof item.text === "string") {
          agentMessages.push(item.text);
        }
        if (item.type === "command_execution") {
          toolCalls.push({
            tool: "command_execution",
            input: { command: item.command || "" },
            output: item.aggregated_output || "",
          });
        }
      }
    } catch {
      // ignore malformed lines
    }
  }

  return { transcript, toolCalls, agentMessages, turnCount, usageTokens };
}

export async function runCodexSkillTest(options: {
  prompt: string;
  workingDirectory: string;
  timeout?: number;
  testName?: string;
  runId?: string;
}): Promise<CodexSkillTestResult> {
  const { prompt, workingDirectory, timeout = 120_000, testName, runId } = options;

  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  let runDir: string | null = null;
  const safeName = testName ? sanitizeCodexTestName(testName) : null;

  if (runId) {
    try {
      runDir = path.join(GSTACK_DEV_DIR, "codex-e2e-runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch {
      /* non-fatal */
    }
  }

  const proc = Bun.spawn(
    [
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      workingDirectory,
      "-",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  proc.stdin.write(prompt);
  proc.stdin.end();

  let stderr = "";
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  const stderrPromise = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const collectedLines: string[] = [];
  let buf = "";
  let liveTurnCount = 0;
  let liveToolCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        try {
          const event = JSON.parse(line);
          if (event.type === "turn.completed") {
            liveTurnCount += 1;
          }
          if (event.type === "item.completed" && event.item?.type === "command_execution") {
            liveToolCount += 1;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const progressLine = `  [${elapsed}s] codex turn ${liveTurnCount} command #${liveToolCount}: ${event.item.command}\n`;
            process.stderr.write(progressLine);

            if (runDir) {
              try {
                fs.appendFileSync(path.join(runDir, "progress.log"), progressLine);
              } catch {
                /* non-fatal */
              }
            }

            if (runId && testName) {
              try {
                atomicWriteSync(
                  HEARTBEAT_PATH,
                  JSON.stringify(
                    {
                      runId,
                      startedAt,
                      currentTest: testName,
                      status: "running",
                      turn: liveTurnCount,
                      toolCount: liveToolCount,
                      lastTool: event.item.command,
                      lastToolAt: new Date().toISOString(),
                      elapsedSec: elapsed,
                    },
                    null,
                    2,
                  ) + "\n",
                );
              } catch {
                /* non-fatal */
              }
            }
          }
        } catch {
          // ignore malformed lines here; parse step handles them later
        }

        if (runDir && safeName) {
          try {
            fs.appendFileSync(path.join(runDir, `${safeName}.jsonl`), line + "\n");
          } catch {
            /* non-fatal */
          }
        }
      }
    }
  } catch {
    // fall through to exit handling
  }

  if (buf.trim()) collectedLines.push(buf);

  stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  const duration = Date.now() - startTime;
  const parsed = parseCodexJSONL(collectedLines);
  const browseErrors: string[] = [];
  const allText = collectedLines.join("\n") + "\n" + stderr;

  for (const pattern of BROWSE_ERROR_PATTERNS) {
    const match = allText.match(pattern);
    if (match) browseErrors.push(match[0].slice(0, 200));
  }

  let exitReason = "success";
  if (timedOut) exitReason = "timeout";
  else if (exitCode !== 0) exitReason = `exit_code_${exitCode}`;

  if (browseErrors.length > 0 && exitReason === "success") {
    exitReason = "error_runtime";
  }

  const output = parsed.agentMessages.at(-1) || "";

  if (browseErrors.length > 0 || exitReason !== "success") {
    try {
      const failureDir = runDir || path.join(workingDirectory, ".gstack", "test-transcripts");
      fs.mkdirSync(failureDir, { recursive: true });
      const failureName = safeName
        ? `${safeName}-failure.json`
        : `codex-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      fs.writeFileSync(
        path.join(failureDir, failureName),
        JSON.stringify(
          {
            prompt: prompt.slice(0, 500),
            testName: testName || "unknown",
            exitReason,
            browseErrors,
            duration,
            stderr: stderr.slice(0, 4000),
            output: output.slice(0, 1000),
          },
          null,
          2,
        ),
      );
    } catch {
      /* non-fatal */
    }
  }

  return {
    toolCalls: parsed.toolCalls,
    browseErrors,
    exitReason,
    duration,
    output,
    stderr,
    costEstimate: {
      estimatedTokens: parsed.usageTokens,
      estimatedCost: 0,
      turnsUsed: parsed.turnCount,
    },
    transcript: parsed.transcript,
  };
}
