#!/usr/bin/env bun
/**
 * PostToolUse hook for AskUserQuestion (Claude Code, plan-tune cathedral T5).
 *
 * Reads hook stdin JSON, extracts every AUQ question + user choice from the
 * tool_input/tool_response, and writes them via gstack-question-log so the
 * substrate captures fires deterministically — no agent compliance required.
 *
 * Triggered by ~/.claude/settings.json:
 *   {
 *     "hooks": {
 *       "PostToolUse": [
 *         {
 *           "matcher": "(AskUserQuestion|mcp__.*__AskUserQuestion)",
 *           "hooks": [
 *             { "type": "command",
 *               "command": "$CLAUDE_PROJECT_DIR/.claude/skills/gstack/hosts/claude/hooks/question-log-hook",
 *               "timeout": 5 }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Invariants:
 *   - Always exits 0. A failing hook MUST NOT block the user's session.
 *     Errors land in ~/.gstack/hook-errors.log for postmortem.
 *   - Spawns gstack-question-log as a subprocess; that bin handles
 *     validation, dedup (source+tool_use_id), async derive.
 *   - Marker-first question_id (`<gstack-qid:foo-bar>`), hash fallback
 *     (D18 progressive markers).
 *
 * See docs/spikes/claude-code-hook-mutation.md for the protocol contract.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

interface HookStdin {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: {
    questions?: Array<{
      question?: string;
      options?: Array<string | { label?: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
  tool_response?: unknown;
  cwd?: string;
}

interface ExtractedQuestion {
  question_id: string;
  question_summary: string;
  options_count: number;
  user_choice: string;
  recommended?: string;
  free_text?: string;
  category?: string;
  door_type?: string;
}

const MARKER_RE = /<gstack-qid:([a-z0-9-]{1,64})>/i;
const RECOMMENDED_LABEL_RE = /\(recommended\)\s*$/i;

function logHookError(msg: string): void {
  try {
    const stateRoot =
      process.env.GSTACK_STATE_ROOT ||
      process.env.GSTACK_HOME ||
      path.join(os.homedir(), '.gstack');
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.appendFileSync(
      path.join(stateRoot, 'hook-errors.log'),
      `${new Date().toISOString()} question-log-hook: ${msg}\n`,
    );
  } catch {
    // Last-resort: swallow. Hook must not block.
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    // Hard cutoff so we don't hang the user's session waiting for stdin.
    setTimeout(() => resolve(buf), 2000);
  });
}

function hashQuestionId(skill: string, question: string, options: string[]): string {
  const sorted = [...options].sort().join('|');
  const h = crypto
    .createHash('sha1')
    .update(`${skill}::${question}::${sorted}`)
    .digest('hex');
  return `hook-${h.slice(0, 10)}`;
}

/**
 * Marker-first id extraction. Returns the marker id (stripped of the
 * <gstack-qid:...> wrapper) when present, else a hash-based hook- id.
 * Per D18 progressive markers — hash ids are observed-only, never used
 * as preference keys.
 */
function extractQuestionId(
  skill: string,
  questionText: string,
  options: string[],
): { id: string; marker_present: boolean; stripped_question: string } {
  const match = questionText.match(MARKER_RE);
  if (match) {
    return {
      id: match[1],
      marker_present: true,
      stripped_question: questionText.replace(MARKER_RE, '').trim(),
    };
  }
  return {
    id: hashQuestionId(skill, questionText, options),
    marker_present: false,
    stripped_question: questionText,
  };
}

function optionLabels(opts: Array<string | { label?: string; description?: string }>): string[] {
  return opts.map((o) => (typeof o === 'string' ? o : o.label || o.description || ''));
}

/**
 * Parse "(recommended)" label-first per D2; fall back to "Recommendation: X"
 * prose match; refuse (return undefined) if ambiguous.
 */
function extractRecommended(questionText: string, opts: string[]): string | undefined {
  const labelMatches = opts.filter((o) => RECOMMENDED_LABEL_RE.test(o));
  if (labelMatches.length === 1) return labelMatches[0].replace(RECOMMENDED_LABEL_RE, '').trim();
  if (labelMatches.length > 1) return undefined; // ambiguous

  const m = questionText.match(/Recommendation:\s*([^\n]+)/i);
  if (!m) return undefined;
  const recPhrase = m[1].trim();
  const matchByPrefix = opts.find((o) => o.toLowerCase().startsWith(recPhrase.toLowerCase().slice(0, 12)));
  return matchByPrefix;
}

/**
 * Best-effort extraction of which option the user picked per question.
 * AUQ tool_response shape varies by Claude Code variant (native vs MCP),
 * and the hook stdin docs don't pin a single canonical shape. We handle
 * the common cases gracefully.
 */
function extractUserChoices(
  response: unknown,
  questionCount: number,
): Array<{ choice: string; free_text?: string }> {
  const out: Array<{ choice: string; free_text?: string }> = [];
  if (!response) {
    for (let i = 0; i < questionCount; i++) out.push({ choice: '__unknown__' });
    return out;
  }
  // Shape A: { answers: [{option_label, free_text?}] }
  // Shape B: { questions: [{user_answer}] }
  // Shape C: { content: [...] } or array.
  // We probe lazily.
  const rec = response as Record<string, unknown>;
  if (Array.isArray(rec.answers)) {
    for (const a of rec.answers as Array<Record<string, unknown>>) {
      const choice = (a.option_label || a.label || a.choice || a.answer || '__unknown__') as string;
      const freeText = (a.free_text || a.other_text) as string | undefined;
      out.push(freeText ? { choice, free_text: freeText } : { choice });
    }
    while (out.length < questionCount) out.push({ choice: '__unknown__' });
    return out;
  }
  if (Array.isArray(rec.questions)) {
    for (const q of rec.questions as Array<Record<string, unknown>>) {
      const choice = (q.user_answer || q.answer || q.choice || '__unknown__') as string;
      out.push({ choice });
    }
    while (out.length < questionCount) out.push({ choice: '__unknown__' });
    return out;
  }
  // Fall back: stringify and log first 100 chars to help future debugging.
  for (let i = 0; i < questionCount; i++) {
    out.push({ choice: `__response-shape-unknown:${JSON.stringify(response).slice(0, 80)}__` });
  }
  return out;
}

function detectSkill(cwd: string | undefined): string {
  // Best-effort: cwd often contains the project slug but rarely the running
  // skill. Without a session-state mechanism, leave as 'unknown' — the
  // skill marker (<gstack-skill:NAME>) embedded in question text per
  // future plan-tune work is the durable path.
  void cwd;
  return 'unknown';
}

function spawnLog(payload: Record<string, unknown>, cwd?: string): void {
  // Locate the bin relative to this script's directory.
  const here = path.dirname(new URL(import.meta.url).pathname);
  // hosts/claude/hooks/ -> ../../../bin/
  const repoRoot = path.resolve(here, '..', '..', '..');
  const bin = path.join(repoRoot, 'bin', 'gstack-question-log');
  const res = spawnSync(bin, [JSON.stringify(payload)], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
    // Run from the originating tool call's cwd so gstack-slug resolves to
    // the project the user is actually in, not the hook script's location.
    cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
  });
  if (res.status !== 0) {
    logHookError(`gstack-question-log exited ${res.status}: ${res.stderr || res.stdout}`);
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.exit(0);
  }
  let stdin: HookStdin;
  try {
    stdin = JSON.parse(raw);
  } catch (e) {
    logHookError(`stdin parse failed: ${(e as Error).message}`);
    process.exit(0);
  }

  const toolName = stdin.tool_name || '';
  if (
    toolName !== 'AskUserQuestion' &&
    !toolName.match(/^mcp__.+__AskUserQuestion$/)
  ) {
    // Matcher should have filtered this out; defensive no-op.
    process.exit(0);
  }

  const questions = stdin.tool_input?.questions || [];
  if (questions.length === 0) {
    process.exit(0);
  }

  const skill = detectSkill(stdin.cwd);
  const choices = extractUserChoices(stdin.tool_response, questions.length);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qText = q.question || '';
    if (!qText) continue;

    const opts = optionLabels(q.options || []);
    const { id, stripped_question } = extractQuestionId(skill, qText, opts);
    const recommended = extractRecommended(stripped_question, opts);
    const summary = stripped_question.slice(0, 200);
    const choice = choices[i] || { choice: '__unknown__' };

    const payload: Record<string, unknown> = {
      skill,
      question_id: id,
      question_summary: summary,
      options_count: opts.length,
      user_choice: String(choice.choice).slice(0, 64),
      source: choice.free_text ? 'auq-other' : 'hook',
      session_id: stdin.session_id?.slice(0, 64),
      tool_use_id: stdin.tool_use_id?.slice(0, 128),
    };
    if (recommended) payload.recommended = recommended.slice(0, 64);
    if (choice.free_text) payload.free_text = String(choice.free_text);

    spawnLog(payload, stdin.cwd);
  }

  process.exit(0);
}

main().catch((e) => {
  logHookError(`main crash: ${(e as Error).message}`);
  process.exit(0);
});
