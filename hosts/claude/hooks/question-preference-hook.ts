#!/usr/bin/env bun
/**
 * PreToolUse hook for AskUserQuestion (Claude Code, plan-tune cathedral T6).
 *
 * Enforces never-ask / always-ask / ask-only-for-one-way preferences
 * deterministically — no agent compliance required.
 *
 * Decision tree (per question in tool_input.questions):
 *   1. Extract question_id via marker (<gstack-qid:foo-bar>). If no marker,
 *      enforcement is skipped for this question (D18 — hash IDs are
 *      observed-only, never used as preference keys).
 *   2. Look up door_type from scripts/question-registry.ts (default two-way).
 *   3. Read preferences with precedence: project-local > global (D8).
 *   4. Apply:
 *        never-ask + one-way → defer (safety override; one-way always asks).
 *        never-ask + two-way + marker → deny with auto-decided recommendation
 *          in reason. Mark tool_use_id so PostToolUse logs as 'auto-decided'.
 *        ask-only-for-one-way + two-way + marker → same as never-ask.
 *        always-ask, or no preference → defer.
 *
 * Why deny+reason instead of allow+updatedInput:
 *   AskUserQuestion's `updatedInput` shape for "pre-resolve this question"
 *   isn't structurally pinned in Claude Code docs (spike T4 left as open
 *   question). `deny` with a reason that names the auto-decided option is
 *   conservative + reliable: the model receives the rejection feedback,
 *   reads the recommended option from the reason, and proceeds without
 *   re-firing AUQ. When the spike around input mutation lands, we can
 *   swap to allow+updatedInput without changing the contract.
 *
 * Recommended-option extraction (per D2):
 *   - First: (recommended) label suffix on an option.
 *   - Fall back: "Recommendation: X" prose match against option labels.
 *   - Refuse to auto-decide if ambiguous (multiple labels OR no parseable
 *     recommendation): defer instead of silent-wrong.
 *
 * Always exits 0. Hook errors land in ~/.gstack/hook-errors.log.
 * See docs/spikes/claude-code-hook-mutation.md for the protocol contract.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { isConductor } from '../../../lib/is-conductor';

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
  cwd?: string;
}

const MARKER_RE = /<gstack-qid:([a-z0-9-]{1,64})>/i;
const RECOMMENDED_LABEL_RE = /\(recommended\)\s*$/i;

function stateRoot(): string {
  return (
    process.env.GSTACK_STATE_ROOT ||
    process.env.GSTACK_HOME ||
    path.join(os.homedir(), '.gstack')
  );
}

function logHookError(msg: string): void {
  try {
    const sr = stateRoot();
    fs.mkdirSync(sr, { recursive: true });
    fs.appendFileSync(
      path.join(sr, 'hook-errors.log'),
      `${new Date().toISOString()} question-preference-hook: ${msg}\n`,
    );
  } catch {
    // last-resort swallow
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 2000);
  });
}

function defer(additionalContext?: string): void {
  const out: Record<string, unknown> = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'defer',
  };
  if (additionalContext) out.additionalContext = additionalContext;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
  process.exit(0);
}

function deny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

interface PreferenceLookup {
  preference: string | undefined;
  source: 'project' | 'global' | 'none';
}

function lookupPreference(slug: string, questionId: string): PreferenceLookup {
  const sr = stateRoot();
  const projectFile = path.join(sr, 'projects', slug, 'question-preferences.json');
  const globalFile = path.join(sr, 'global-question-preferences.json');

  const project = readJsonSafe(projectFile);
  if (project && typeof project[questionId] === 'string') {
    return { preference: project[questionId] as string, source: 'project' };
  }
  const global = readJsonSafe(globalFile);
  if (global && typeof global[questionId] === 'string') {
    return { preference: global[questionId] as string, source: 'global' };
  }
  return { preference: undefined, source: 'none' };
}

interface RegistryEntry {
  id: string;
  door_type?: 'one-way' | 'two-way';
  signal_key?: string;
}

interface MemoryNugget {
  nugget: string;
  applies_to_signal_keys: string[];
  applied_at?: string;
}

/**
 * Read per-session cache first, fall back to canonical local file. Cache
 * invalidates by being missing — gstack-distill-apply doesn't touch the
 * cache because the canonical file is always the source-of-truth on read
 * miss. Sub-1ms cache reads (D13 perf).
 */
function loadMemoryNuggets(sessionId: string | undefined): MemoryNugget[] {
  const sr = stateRoot();
  const canonical = path.join(sr, 'free-text-memory.json');
  let nuggets: MemoryNugget[] | null = null;

  if (sessionId) {
    const cachePath = path.join(sr, 'sessions', sessionId, 'memory-cache.json');
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (Array.isArray(cached.nuggets)) {
        return cached.nuggets;
      }
    } catch {
      // miss → fall through
    }
  }

  try {
    const j = JSON.parse(fs.readFileSync(canonical, 'utf-8'));
    nuggets = Array.isArray(j.nuggets) ? j.nuggets : [];
  } catch {
    nuggets = [];
  }

  // Write through to the per-session cache so subsequent hooks on this
  // session take the fast path. Best-effort; never fails the hook.
  if (sessionId && nuggets) {
    try {
      const dir = path.join(sr, 'sessions', sessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'memory-cache.json'),
        JSON.stringify({ nuggets, cached_at: new Date().toISOString() }, null, 2),
      );
    } catch {
      // swallow
    }
  }

  return nuggets || [];
}

/**
 * For a given signal_key, return up to N nuggets whose applies_to_signal_keys
 * include it. Sorted by recency (most-recently-applied first), capped.
 */
function nuggetsForSignal(nuggets: MemoryNugget[], signalKey: string, max = 3): string[] {
  return nuggets
    .filter((n) => Array.isArray(n.applies_to_signal_keys) && n.applies_to_signal_keys.includes(signalKey))
    .sort((a, b) => (b.applied_at || '').localeCompare(a.applied_at || ''))
    .slice(0, max)
    .map((n) => n.nugget);
}

let registryCache: Record<string, RegistryEntry> | null = null;

function loadRegistry(): Record<string, RegistryEntry> {
  if (registryCache) return registryCache;
  registryCache = {};
  try {
    // Hook lives at hosts/claude/hooks/; registry at scripts/question-registry.ts
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(here, '..', '..', '..');
    const regPath = path.join(repoRoot, 'scripts', 'question-registry.ts');
    if (!fs.existsSync(regPath)) return registryCache;
    const src = fs.readFileSync(regPath, 'utf-8');
    // Cheap regex extraction so the hook doesn't need to import the TS file
    // (which would require bun resolving the module at hook-invocation time).
    // Matches entries like:
    //   'ship-test-failure-triage': {
    //     id: 'ship-test-failure-triage',
    //     ...
    //     door_type: 'one-way',
    //     signal_key: 'test-discipline',
    //     ...
    //   },
    const blockRe =
      /'([a-z0-9-]+)':\s*\{[^}]*?door_type:\s*'(one-way|two-way)'[^}]*?\}/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(src))) {
      const [block, id, door_type] = m;
      const sk = block.match(/signal_key:\s*'([a-z0-9-]+)'/);
      registryCache[id] = {
        id,
        door_type: door_type as 'one-way' | 'two-way',
        signal_key: sk ? sk[1] : undefined,
      };
    }
  } catch (e) {
    logHookError(`registry load failed: ${(e as Error).message}`);
  }
  return registryCache;
}

function optionLabels(opts: Array<string | { label?: string; description?: string }>): string[] {
  return opts.map((o) => (typeof o === 'string' ? o : o.label || o.description || ''));
}

function extractRecommended(
  questionText: string,
  opts: string[],
): { recommended: string | undefined; ambiguous: boolean } {
  const labelMatches = opts.filter((o) => RECOMMENDED_LABEL_RE.test(o));
  if (labelMatches.length === 1) {
    return { recommended: labelMatches[0].replace(RECOMMENDED_LABEL_RE, '').trim(), ambiguous: false };
  }
  if (labelMatches.length > 1) return { recommended: undefined, ambiguous: true };

  const m = questionText.match(/Recommendation:\s*([^\n]+)/i);
  if (!m) return { recommended: undefined, ambiguous: false };
  const recPhrase = m[1].trim();
  const prefixMatches = opts.filter((o) =>
    o.toLowerCase().startsWith(recPhrase.toLowerCase().slice(0, 12)),
  );
  if (prefixMatches.length === 1) return { recommended: prefixMatches[0], ambiguous: false };
  if (prefixMatches.length > 1) return { recommended: undefined, ambiguous: true };
  return { recommended: undefined, ambiguous: false };
}

function slugFromCwd(cwd: string | undefined): string {
  // Mirror gstack-slug's basename fallback. The full slug resolver shells out
  // to git, which is too expensive on a hot hook path; the basename is close
  // enough for preference lookup (preferences are keyed by question_id, slug
  // is just the directory bucket).
  if (!cwd) return 'unknown';
  return path.basename(cwd);
}

function markAutoDecided(sessionId: string | undefined, toolUseId: string | undefined): void {
  if (!sessionId || !toolUseId) return;
  try {
    const sr = stateRoot();
    const dir = path.join(sr, 'sessions', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `.auto-decided-${toolUseId}`), '');
  } catch (e) {
    logHookError(`markAutoDecided failed: ${(e as Error).message}`);
  }
}

/**
 * Log an auto-decided event directly from PreToolUse, since `deny` prevents
 * the tool from running and PostToolUse never fires. Without this, /plan-tune
 * Recent auto-decisions would be blind to enforcement hits.
 */
function logAutoDecided(
  questionId: string,
  questionSummary: string,
  recommended: string,
  optionsCount: number,
  sessionId: string | undefined,
  toolUseId: string | undefined,
  cwd: string | undefined,
): void {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(here, '..', '..', '..');
    const bin = path.join(repoRoot, 'bin', 'gstack-question-log');
    const payload: Record<string, unknown> = {
      skill: 'unknown',
      question_id: questionId,
      question_summary: questionSummary.slice(0, 200),
      options_count: optionsCount,
      user_choice: recommended.slice(0, 64),
      recommended: recommended.slice(0, 64),
      source: 'auto-decided',
      session_id: sessionId?.slice(0, 64),
      tool_use_id: toolUseId?.slice(0, 128),
    };
    spawnSync(bin, [JSON.stringify(payload)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      // cwd of the originating tool call so gstack-slug resolves to the
      // project the user is actually in, not the hook script's location.
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    });
  } catch (e) {
    logHookError(`logAutoDecided failed: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    defer();
    return;
  }
  let stdin: HookStdin;
  try {
    stdin = JSON.parse(raw);
  } catch (e) {
    logHookError(`stdin parse failed: ${(e as Error).message}`);
    defer();
    return;
  }

  const toolName = stdin.tool_name || '';
  if (
    toolName !== 'AskUserQuestion' &&
    !toolName.match(/^mcp__.+__AskUserQuestion$/)
  ) {
    defer();
    return;
  }

  const questions = stdin.tool_input?.questions || [];
  if (questions.length === 0) {
    defer();
    return;
  }

  // For multi-question AUQ, enforcement is all-or-nothing per call:
  // we deny only if ALL questions have marker + never-ask + safe door type.
  // Mixed cases pass through (defer) so the user still gets to answer.
  const registry = loadRegistry();
  const slug = slugFromCwd(stdin.cwd);
  const memoryNuggets = loadMemoryNuggets(stdin.session_id);

  // Compute Layer 8 memory context inline: any nuggets matching the
  // signal_keys of the questions in this AUQ get surfaced as additionalContext.
  // This applies whether we defer OR deny — gives the agent + user the
  // relevant prior context either way.
  const contextNuggets: string[] = [];
  for (const q of questions) {
    const qText = q.question || '';
    const marker = qText.match(MARKER_RE);
    if (!marker) continue;
    const entry = registry[marker[1]];
    if (!entry?.signal_key) continue;
    const hits = nuggetsForSignal(memoryNuggets, entry.signal_key);
    for (const h of hits) {
      if (!contextNuggets.includes(h)) contextNuggets.push(h);
    }
  }
  const memoryContext = contextNuggets.length
    ? '[plan-tune memory] Past answers suggest: ' + contextNuggets.join(' | ')
    : undefined;

  // Determine whether EVERY question is eligible for never-ask auto-decide.
  // We deliberately do NOT early-return defer on the first ineligible question:
  // a Conductor session still needs the [conductor] prose deny as a fallback,
  // so we compute eligibility, then branch. memoryContext is preserved on every
  // non-enforcing exit. (All-or-nothing per-call semantics are unchanged: any
  // ineligible question makes the whole call not auto-decidable.)
  const autoDecisions: Array<{ id: string; recommended: string }> = [];
  let fullyAutoDecidable = true;
  for (const q of questions) {
    const qText = q.question || '';
    const marker = qText.match(MARKER_RE);
    if (!marker) { fullyAutoDecidable = false; break; }
    const questionId = marker[1];
    const pref = lookupPreference(slug, questionId);
    if (!pref.preference || pref.preference === 'always-ask') { fullyAutoDecidable = false; break; }

    const entry = registry[questionId];
    const doorType = entry?.door_type || 'two-way';
    // Safety override — even never-ask doesn't bypass one-way doors.
    if (doorType === 'one-way') { fullyAutoDecidable = false; break; }

    const opts = optionLabels(q.options || []);
    const { recommended, ambiguous } = extractRecommended(qText, opts);
    // Refuse-on-ambiguous per D2 — fail safe.
    if (!recommended || ambiguous) { fullyAutoDecidable = false; break; }
    autoDecisions.push({ id: questionId, recommended });
  }

  if (fullyAutoDecidable && autoDecisions.length > 0) {
    // All questions were eligible for enforcement.
    markAutoDecided(stdin.session_id, stdin.tool_use_id);

    // Log each auto-decided question now, since deny prevents PostToolUse from
    // firing. /plan-tune Recent auto-decisions reads source=auto-decided events.
    for (let i = 0; i < autoDecisions.length; i++) {
      const d = autoDecisions[i];
      const q = questions[i];
      const qText = (q.question || '').replace(MARKER_RE, '').trim();
      const opts = optionLabels(q.options || []);
      logAutoDecided(d.id, qText, d.recommended, opts.length, stdin.session_id, stdin.tool_use_id, stdin.cwd);
    }

    const reasonLines = autoDecisions.map(
      (d) =>
        `[plan-tune auto-decide] ${d.id} → ${d.recommended} (your never-ask preference). Proceed with that option without re-prompting. Change with /plan-tune.`,
    );
    deny(reasonLines.join('\n'));
    return;
  }

  // Not fully auto-decidable. In Conductor, AskUserQuestion is unreliable
  // (native is disabled, the mcp__conductor__AskUserQuestion variant is flaky),
  // so deny the tool and redirect to a prose decision brief. This is TRANSPORT
  // AVOIDANCE, not preference enforcement: it fires regardless of marker,
  // preference, or door type — including one-way doors, which must reach the
  // human via prose rather than the unreliable tool.
  if (isConductor()) {
    const conductorReason =
      '[conductor] AskUserQuestion is unreliable in Conductor (native disabled, MCP variant flaky). ' +
      'Do NOT call AskUserQuestion (native or any mcp__*__AskUserQuestion). Render this decision as a ' +
      'PROSE decision brief now: a D<N> label, an ELI10 of the issue, a Recommendation line, then one ' +
      'paragraph per choice carrying its `(recommended)` marker and `Completeness: X/10`; tell the user ' +
      'to reply with a letter, then STOP. For a one-way/destructive confirmation, require an explicit ' +
      'typed confirmation and do NOT proceed on a vague reply. Capture the decision with gstack-question-log ' +
      '(PostToolUse will not fire on a prose path).' +
      (memoryContext ? `\n${memoryContext}` : '');
    deny(conductorReason);
    return;
  }

  defer(memoryContext);
}

main().catch((e) => {
  logHookError(`main crash: ${(e as Error).message}`);
  defer();
});
