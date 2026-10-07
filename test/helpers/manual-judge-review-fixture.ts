import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvalTestEntry } from './eval-store';
import { buildCookieWorkflowJudgeInput } from './cookie-workflow-judge-input';
import { COOKIE_MANUAL_REVIEW_FILE } from './cookie-workflow-manual-review';

// Later documentation added to the judged BROWSER.md section after the approval
// was recorded (v1.91.4.0 Windows Opera wave). Reversing it reconstructs the
// exact historical prompt bytes, including the section's line range.
const LATER_BROWSER_BLOCK = /\*\*Windows: Opera and Opera GX\.\*\*[\s\S]*?appear in CLI output\.\n\n/;
const LATER_BROWSER_EDITS: Array<[string, string]> = [
  ['The picker recognizes Chrome, Chromium, Brave, Edge, Windows-only Opera and Opera GX, and macOS-only Comet, Arc, and Dia.', 'The picker recognizes Chrome, Chromium, Brave, Edge, and macOS-only Comet, Arc, and Dia.'],
  [' Opera and Opera GX are Windows-only and read from `%APPDATA%\\Opera Software\\Opera Stable` or `Opera GX Stable`, in `Default` or `Profile N` directories; legacy root-level layouts, Opera side profiles and portable or relocated installs are not detected. Opera has no native extraction, so its App-Bound cookies (if any) need manual sign-in.', ''],
];

// The judged SKILL.md excerpt follows the generated preamble, so later preamble
// edits move its line range without changing its bytes. The approved request
// named lines from 153; the parallel-waves one-line skill start (#2763) removed
// three preamble lines. A raw SKILL.md gets those lines back, and a built prompt,
// which has no preamble, gets the approved start line.
const APPROVED_ENTRYPOINT_START = 153;
const LATER_PREAMBLE_EDITS: Array<[string, string]> = [
  ['~/.claude/skills/gstack/bin/gstack-skill-start --skill "setup-browser-cookies" --model "claude"\n', '_SS="$HOME/.claude/skills/gstack/bin/gstack-skill-start"\n[ -x "$_SS" ] || _SS=".claude/skills/gstack/bin/gstack-skill-start"\n"$_SS" --skill "setup-browser-cookies" --model "claude" --parent-pid "$PPID" \\\n  || echo "SKILL_START: unavailable — stale install; run ./setup or /gstack-upgrade (preamble degraded, continue the user\'s task)"\n'],
];

// The v1.91.19.0 generated-bash lint (INV-3) gave the shared Bun-install block a
// ${TMPDIR:-/tmp} mktemp template; same line, different bytes.
// The v1.91.30.0 Bun floor (E1) pinned the install hint to the tested Bun.
const LATER_WAVE_EDITS: Array<[string, string]> = [
  ['tmpfile=$(mktemp "${TMPDIR:-/tmp}/bun-install.XXXXXX")', 'tmpfile=$(mktemp)'],
  ['BUN_VERSION="1.4.2"', 'BUN_VERSION="1.3.10"'],
  // Oct 7 wave: the artifacts-sync preamble block surfaces attention lines (one line longer).
  ["Skill-start already ran artifacts sync. GBrain hint text (if any) says\nwhen to prefer `gbrain` over Grep. `ARTIFACTS_SYNC:` reports sync health\n(`off`, `mode=... | queue=N`, `remote-mode`, or a `gstack-brain-restore`\nhint). On an `attention:` line, tell the user in one sentence what\nit says and the command it names, then continue.\n\nThe one-time privacy stop-gate arrives as a `GSTACK_INSTRUCTION` block\nfrom skill-start when consent is pending; fire it via AskUserQuestion\nexactly as instructed.",
    "The skill-start output above already ran artifacts sync. Act on its lines:\nGBrain hint text (if present) tells you when to prefer `gbrain` over Grep;\n`ARTIFACTS_SYNC:` reports sync health (`off`, `mode=... | queue=N`,\n`remote-mode`, or a restore hint naming `gstack-brain-restore`).\n\nThe one-time privacy stop-gate (artifacts-sync consent) arrives as a\n`GSTACK_INSTRUCTION` block from skill-start when consent is actually pending\n\u2014 fire it via AskUserQuestion exactly as the block instructs."],
];

export function approvedCookieWorkflowSource(source: string): string {
  let removedLines = 0;
  let historical = source
    .replace('sha256sum < "$tmpfile" | awk \'{print $(1)}\'', 'sha256sum "$tmpfile" | awk \'{print $1}\'')
    .replace('shasum -a 256 < "$tmpfile" | awk \'{print $(1)}\'', 'shasum -a 256 "$tmpfile" | awk \'{print $1}\'')
    .replace(LATER_BROWSER_BLOCK, block => { removedLines = block.split('\n').length - 1; return ''; });
  for (const [later, earlier] of [...LATER_BROWSER_EDITS, ...LATER_PREAMBLE_EDITS, ...LATER_WAVE_EDITS]) historical = historical.replace(later, earlier);
  return historical
    .replace(/(--- BEGIN FILE "BROWSER\.md" \(lines \d+-)(\d+)(; section\) ---)/, (_, head, end, tail) => `${head}${Number(end) - removedLines}${tail}`)
    .replace(/(--- BEGIN FILE "setup-browser-cookies\/SKILL\.md" \(lines )(\d+)-(\d+)(; entrypoint\) ---)/, (_, head, start, end, tail) => `${head}${APPROVED_ENTRYPOINT_START}-${APPROVED_ENTRYPOINT_START + Number(end) - Number(start)}${tail}`);
}

export function manualReviewFixture(root = resolve(import.meta.dir, '../..')): EvalTestEntry {
  const approval = JSON.parse(readFileSync(resolve(root, COOKIE_MANUAL_REVIEW_FILE), 'utf8'));
  const prompt = approvedCookieWorkflowSource(buildCookieWorkflowJudgeInput(root).prompt);
  if (createHash('sha256').update(prompt).digest('hex') !== approval.prompt_sha256
    || Buffer.byteLength(prompt) !== approval.prompt_bytes) {
    throw new Error('Historical cookie approval fixture no longer reconstructs the exact approved prompt');
  }
  return {
    name: 'setup-browser-cookies/SKILL.md workflow', suite: 'Cookie setup workflow quality', tier: 'llm-judge',
    passed: false, execution: 'executed', exit_reason: 'provider_refusal', attempt: 1, duration_ms: 1, cost_usd: 0,
    model: approval.model, prompt,
    error: 'Synthetic provider refusal fixture, not live model evidence',
    manual_review: { approval, refusal: { stop_reason: 'refusal', response_id: 'msg_synthetic_fixture',
      request_id: 'req_synthetic_fixture', model: approval.model, input_tokens: 1, output_tokens: 0, text_blocks: 0 } },
  };
}
