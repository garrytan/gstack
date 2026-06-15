/**
 * Transcript section logger (v2 plan T10).
 *
 * Two jobs, both pure analysis over a SkillTestResult / NDJSON transcript:
 *
 *  1. extractSectionReads()  — which `sections/*.md` files a run actually Read.
 *     Used by the sectioned world (post-carve) to verify the agent opened the
 *     chapters its situation required.
 *
 *  2. extractShipActions()   — an observable ACTION fingerprint of a /ship run
 *     (ran tests, bumped VERSION, wrote CHANGELOG, created PR, ...). This works
 *     on BOTH the monolith and the sectioned skill, which is the whole point:
 *     capture a baseline on the current monolith ship FIRST, then assert the
 *     sectioned ship still performs the same actions. A section-read check alone
 *     can't catch "agent read the chapter but skipped the step"; the action
 *     fingerprint can.
 *
 * Why baseline-first (Codex outside-voice critique on the T9 plan): a logger
 * shipped in the same PR as the carve is post-failure telemetry unless it has a
 * pre-carve reference. captureShipBaseline() records the monolith's action
 * fingerprint so compareShipActions() can flag a regression introduced by the
 * carve.
 *
 * Pure functions, no I/O except the explicit read/write baseline helpers. The
 * unit tests drive these with synthetic transcripts — no paid run needed to
 * validate the logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Minimal shape we need from SkillTestResult — kept structural so callers can
 *  pass a full SkillTestResult or a hand-built fixture in unit tests. */
export interface ToolCallLike {
  tool: string;
  input: unknown;
  output?: string;
}
export interface TranscriptResultLike {
  toolCalls: ToolCallLike[];
  output?: string;
}

/** Pull the file_path off a tool-call input, tolerating unknown shapes. */
function readFilePath(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const fp = (input as Record<string, unknown>).file_path;
    if (typeof fp === 'string') return fp;
  }
  return null;
}

/** Pull the command string off a Bash tool-call input. */
function bashCommand(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const cmd = (input as Record<string, unknown>).command;
    if (typeof cmd === 'string') return cmd;
  }
  return null;
}

/**
 * Every `sections/<name>.md` file the run Read, normalized to the section
 * basename (e.g. "version-bump.md"). Deduped, in first-Read order. Matching is
 * on the path segment `/sections/<file>.md` so it works regardless of whether
 * the host resolved a relative, absolute, or prefixed install path.
 */
export function extractSectionReads(result: TranscriptResultLike): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const call of result.toolCalls) {
    if (call.tool !== 'Read') continue;
    const fp = readFilePath(call.input);
    if (!fp) continue;
    const m = fp.match(/(?:^|\/)sections\/([A-Za-z0-9._-]+\.md)$/);
    if (!m) continue;
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

/**
 * The canonical /ship action vocabulary. Each action is detected from the Bash
 * commands the agent ran (plus a couple of Write/Edit signals). Order is the
 * rough ship sequence; detection is order-independent.
 *
 * Keep this list aligned with the ship skeleton's numbered steps. The
 * section-loading eval asserts the sectioned ship still triggers the same
 * actions a monolith run did for the same fixture situation.
 */
export const SHIP_ACTIONS = [
  'merged_base',       // git merge <base>
  'ran_tests',         // bun test / npm test / the project test cmd
  'bumped_version',    // wrote VERSION / package.json version / ran gstack-version-bump
  'wrote_changelog',   // edited CHANGELOG.md
  'committed',         // git commit
  'pushed',            // git push
  'opened_pr',         // gh pr create / glab mr create
] as const;
export type ShipAction = (typeof SHIP_ACTIONS)[number];

const BASH_ACTION_PATTERNS: Array<{ action: ShipAction; re: RegExp }> = [
  { action: 'merged_base', re: /\bgit\s+merge\b/ },
  { action: 'ran_tests', re: /\b(bun\s+test|npm\s+(run\s+)?test|yarn\s+test|pytest|go\s+test|cargo\s+test|rspec)\b/ },
  { action: 'bumped_version', re: /gstack-version-bump\b|gstack-next-version\b|>\s*VERSION\b|npm\s+version\b/ },
  { action: 'wrote_changelog', re: /CHANGELOG\.md/ },
  { action: 'committed', re: /\bgit\s+commit\b/ },
  { action: 'pushed', re: /\bgit\s+push\b/ },
  { action: 'opened_pr', re: /\bgh\s+pr\s+create\b|\bglab\s+mr\s+create\b/ },
];

/**
 * The observable action fingerprint of a ship run. Works on monolith AND
 * sectioned skills because it reads what the agent DID (Bash + file writes),
 * not which prose it loaded.
 */
export function extractShipActions(result: TranscriptResultLike): ShipAction[] {
  const found = new Set<ShipAction>();
  for (const call of result.toolCalls) {
    if (call.tool === 'Bash') {
      const cmd = bashCommand(call.input);
      if (!cmd) continue;
      for (const { action, re } of BASH_ACTION_PATTERNS) {
        if (re.test(cmd)) found.add(action);
      }
    } else if (call.tool === 'Write' || call.tool === 'Edit') {
      const fp = readFilePath(call.input);
      if (fp && /CHANGELOG\.md$/.test(fp)) found.add('wrote_changelog');
      if (fp && /(?:^|\/)VERSION$/.test(fp)) found.add('bumped_version');
    }
  }
  // Preserve canonical order.
  return SHIP_ACTIONS.filter(a => found.has(a));
}

export interface ShipBaseline {
  tag: string;
  /** Fixture/situation id this baseline was captured for. */
  situation: string;
  /** Action fingerprint observed on the monolith ship. */
  actions: ShipAction[];
  /** Section reads observed (empty on the monolith — present after carve). */
  sectionReads: string[];
  capturedAt: string;
}

const DEFAULT_BASELINE_DIR = path.join(os.homedir(), '.gstack-dev', 'ship-baselines');

/** Where a baseline for a given situation lives. */
export function baselinePath(situation: string, dir = DEFAULT_BASELINE_DIR): string {
  return path.join(dir, `${situation}.json`);
}

/** Persist a ship baseline (used once on the monolith, before the carve). */
export function writeShipBaseline(baseline: ShipBaseline, dir = DEFAULT_BASELINE_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = baselinePath(baseline.situation, dir);
  fs.writeFileSync(p, JSON.stringify(baseline, null, 2) + '\n');
  return p;
}

/** Read a previously-captured baseline, or null if none exists yet. */
export function readShipBaseline(situation: string, dir = DEFAULT_BASELINE_DIR): ShipBaseline | null {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(situation, dir), 'utf-8')) as ShipBaseline;
  } catch {
    return null;
  }
}

export interface ShipActionDiff {
  /** Actions the baseline performed that the current run did NOT (the regression set). */
  missing: ShipAction[];
  /** Actions the current run performed that the baseline did not (usually fine). */
  added: ShipAction[];
  /** True when no baseline action was dropped. */
  ok: boolean;
}

/**
 * Compare a current sectioned-ship run against the monolith baseline. A dropped
 * action (in baseline, not in current) is the carve regression we care about:
 * the sectioned ship stopped doing something the monolith did.
 */
export function compareShipActions(baseline: ShipBaseline, current: ShipAction[]): ShipActionDiff {
  const cur = new Set(current);
  const base = new Set(baseline.actions);
  const missing = baseline.actions.filter(a => !cur.has(a));
  const added = current.filter(a => !base.has(a));
  return { missing, added, ok: missing.length === 0 };
}
