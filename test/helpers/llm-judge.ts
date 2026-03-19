/**
 * Shared LLM-as-judge helpers for eval and E2E tests.
 *
 * Provides callJudge (generic JSON-from-Codex), judge (doc quality scorer),
 * and outcomeJudge (planted-bug detection scorer).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const LOCAL_CODEX = path.join(ROOT, 'node_modules', '.bin', 'codex');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCodexBinary(): string {
  return fs.existsSync(LOCAL_CODEX) ? LOCAL_CODEX : 'codex';
}

export function extractAssistantText(stdout: string): string {
  const messages: string[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (event.type === 'item.completed'
        && item?.type === 'agent_message'
        && typeof item.text === 'string') {
        messages.push(item.text);
      }
    } catch {
      // Ignore malformed JSONL lines; callers will fall back to raw output if needed.
    }
  }

  return messages.join('\n').trim();
}

async function runCodexPrompt(prompt: string): Promise<string> {
  const promptFile = path.join(
    os.tmpdir(),
    `gstack-codex-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(promptFile, prompt);

  const modelName = process.env.CODEX_JUDGE_MODEL || 'gpt-5.4-mini';
  const codexBinary = resolveCodexBinary();

  const proc = Bun.spawn([
    'sh',
    '-lc',
    `cat ${shellQuote(promptFile)} | ${shellQuote(codexBinary)} exec --json --sandbox read-only --skip-git-repo-check -C ${shellQuote(ROOT)} -m ${shellQuote(modelName)} -`,
  ], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  try { fs.unlinkSync(promptFile); } catch { /* non-fatal */ }

  const assistantText = extractAssistantText(stdout);
  if (exitCode !== 0) {
    throw new Error(`Codex judge failed with exit code ${exitCode}: ${(stderr || assistantText || stdout).slice(0, 500)}`);
  }

  return assistantText || stdout;
}

export interface JudgeScore {
  clarity: number;       // 1-5
  completeness: number;  // 1-5
  actionability: number; // 1-5
  reasoning: string;
}

export interface OutcomeJudgeResult {
  detected: string[];
  missed: string[];
  false_positives: number;
  detection_rate: number;
  evidence_quality: number;
  reasoning: string;
}

/**
 * Call Codex with a prompt, extract the JSON object from the final response.
 * Retries once on transient failures.
 */
export async function callJudge<T>(prompt: string): Promise<T> {
  let text = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      text = await runCodexPrompt(prompt);
      break;
    } catch (error) {
      if (attempt === 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge returned non-JSON: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]) as T;
}

/**
 * Score documentation quality on clarity/completeness/actionability (1-5).
 */
export async function judge(section: string, content: string): Promise<JudgeScore> {
  return callJudge<JudgeScore>(`You are evaluating documentation quality for an AI coding agent's CLI tool reference.

The agent reads this documentation to learn how to use a headless browser CLI. It needs to:
1. Understand what each command does
2. Know what arguments to pass
3. Know valid values for enum-like parameters
4. Construct correct command invocations without guessing

Rate the following ${section} on three dimensions (1-5 scale):

- **clarity** (1-5): Can an agent understand what each command/flag does from the description alone?
- **completeness** (1-5): Are arguments, valid values, and important behaviors documented? Would an agent need to guess anything?
- **actionability** (1-5): Can an agent construct correct command invocations from this reference alone?

Scoring guide:
- 5: Excellent - no ambiguity, all info present
- 4: Good - minor gaps an experienced agent could infer
- 3: Adequate - some guessing required
- 2: Poor - significant info missing
- 1: Unusable - agent would fail without external help

Respond with ONLY valid JSON in this exact format:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the ${section} to evaluate:

${content}`);
}

/**
 * Evaluate a QA report against planted-bug ground truth.
 * Returns detection metrics for the planted bugs.
 */
export async function outcomeJudge(
  groundTruth: any,
  report: string,
): Promise<OutcomeJudgeResult> {
  return callJudge<OutcomeJudgeResult>(`You are evaluating a QA testing report against known ground truth bugs.

GROUND TRUTH (${groundTruth.total_bugs} planted bugs):
${JSON.stringify(groundTruth.bugs, null, 2)}

QA REPORT (generated by an AI agent):
${report}

For each planted bug, determine if the report identified it. A bug counts as
"detected" if the report describes the same defect, even if the wording differs.
Use the detection_hint keywords as guidance.

Also count false positives: issues in the report that don't correspond to any
planted bug AND aren't legitimate issues with the page.

Respond with ONLY valid JSON:
{
  "detected": ["bug-id-1", "bug-id-2"],
  "missed": ["bug-id-3"],
  "false_positives": 0,
  "detection_rate": 2,
  "evidence_quality": 4,
  "reasoning": "brief explanation"
}

Rules:
- "detected" and "missed" arrays must only contain IDs from the ground truth: ${groundTruth.bugs.map((b: any) => b.id).join(', ')}
- detection_rate = length of detected array
- evidence_quality (1-5): Do detected bugs have screenshots, repro steps, or specific element references?
  5 = excellent evidence for every bug, 1 = no evidence at all`);
}
