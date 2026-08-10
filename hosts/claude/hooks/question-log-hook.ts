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
import {
  MARKER_RE,
  extractRecommended,
  isAskUserQuestionTool,
  makeHookErrorLogger,
  optionLabels,
  readHookStdin,
  spawnQuestionLog,
} from './hook-common';

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

const logHookError = makeHookErrorLogger('question-log-hook');

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

async function main(): Promise<void> {
  const stdin = await readHookStdin(logHookError);
  if (!stdin) {
    process.exit(0);
  }

  if (!isAskUserQuestionTool(stdin.tool_name)) {
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
    const { recommended } = extractRecommended(stripped_question, opts);
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

    spawnQuestionLog(payload, stdin.cwd, logHookError);
  }

  process.exit(0);
}

main().catch((e) => {
  logHookError(`main crash: ${(e as Error).message}`);
  process.exit(0);
});
