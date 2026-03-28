/**
 * Eval result persistence and comparison.
 *
 * EvalCollector accumulates test results, writes them to
 * ~/.gstack/projects/$SLUG/evals/{version}-{branch}-{tier}-{timestamp}.json,
 * prints a summary table, and auto-compares with the previous run.
 *
 * Comparison functions are exported for reuse by the eval:compare CLI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const SCHEMA_VERSION = 1;
const LEGACY_EVAL_DIR = path.join(os.homedir(), '.gstack-dev', 'evals');

/**
 * Detect project-scoped eval dir via gstack-slug.
 * Falls back to legacy ~/.gstack-dev/evals/ if slug detection fails.
 */
export function getProjectEvalDir(): string {
  try {
    // Try repo-local gstack-slug first, then global install
    const localSlug = spawnSync('bash', ['-c', '.claude/skills/gstack/bin/gstack-slug 2>/dev/null || ~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null'], {
      stdio: 'pipe', timeout: 3000,
    });
    const output = localSlug.stdout?.toString().trim();
    if (output) {
      const slugMatch = output.match(/^SLUG=(.+)$/m);
      if (slugMatch && slugMatch[1]) {
        const dir = path.join(os.homedir(), '.gstack', 'projects', slugMatch[1], 'evals');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    }
  } catch { /* fall through */ }
  return LEGACY_EVAL_DIR;
}

const DEFAULT_EVAL_DIR = getProjectEvalDir();

// --- Interfaces ---

export interface EvalTestEntry {
  name: string;
  suite: string;
  tier: 'e2e' | 'llm-judge';
  passed: boolean;
  duration_ms: number;
  cost_usd: number;

  // E2E
  transcript?: any[];
  prompt?: string;
  output?: string;
  turns_used?: number;
  browse_errors?: string[];

  // LLM judge
  judge_scores?: Record<string, number>;
  judge_reasoning?: string;

  // Machine-readable diagnostics
  exit_reason?: string;       // 'success' | 'timeout' | 'error_max_turns' | 'exit_code_N'
  timeout_at_turn?: number;   // which turn was active when timeout hit
  last_tool_call?: string;    // e.g. "Write(review-output.md)"

  // Model + timing diagnostics (added for Sonnet/Opus split)
  model?: string;                // e.g. 'claude-sonnet-4-6' or 'claude-opus-4-6'
  first_response_ms?: number;    // time from spawn to first NDJSON line
  max_inter_turn_ms?: number;    // peak latency between consecutive tool calls

  // Outcome eval
  detection_rate?: number;
  false_positives?: number;
  evidence_quality?: number;
  detected_bugs?: string[];
  missed_bugs?: string[];

  error?: string;

  // Worktree harvest data
  harvest?: {
    filesChanged: number;
    patchPath: string;
    isDuplicate: boolean;
  };
}

export interface EvalResult {
  schema_version: number;
  version: string;
  branch: string;
  git_sha: string;
  timestamp: string;
  hostname: string;
  tier: 'e2e' | 'llm-judge';
  total_tests: number;
  passed: number;
  failed: number;
  total_cost_usd: number;
  total_duration_ms: number;
  wall_clock_ms?: number;     // wall-clock from collector creation to finalization (shows parallelism)
  tests: EvalTestEntry[];
  _partial?: boolean;  // true for incremental saves, absent in final
}

export interface TestDelta {
  name: string;
  before: { passed: boolean; cost_usd: number; turns_used?: number; duration_ms?: number;
            detection_rate?: number; tool_summary?: Record<string, number> };
  after:  { passed: boolean; cost_usd: number; turns_used?: number; duration_ms?: number;
            detection_rate?: number; tool_summary?: Record<string, number> };
  status_change: 'improved' | 'regressed' | 'unchanged';
}

export interface ComparisonResult {
  before_file: string;
  after_file: string;
  before_branch: string;
  after_branch: string;
  before_timestamp: string;
  after_timestamp: string;
  deltas: TestDelta[];
  total_cost_delta: number;
  total_duration_delta: number;
  improved: number;
  regressed: number;
  unchanged: number;
  tool_count_before: number;
  tool_count_after: number;
}

// --- Shared helpers ---

/**
 * Determine if a planted-bug eval passed based on judge results vs ground truth thresholds.
 * Centralizes the pass/fail logic so all planted-bug tests use the same criteria.
 */
export function judgePassed(
  judgeResult: { detection_rate: number; false_positives: number; evidence_quality: number },
  groundTruth: { minimum_detection: number; max_false_positives: number },
): boolean {
  return judgeResult.detection_rate >= groundTruth.minimum_detection
    && judgeResult.false_positives <= groundTruth.max_false_positives
    && judgeResult.evidence_quality >= 2;
}

// --- Comparison functions (exported for eval:compare CLI) ---

/**
 * Extract tool call counts from a transcript.
 * Returns e.g. { Bash: 8, Read: 3, Write: 1 }.
 */
export function extractToolSummary(transcript: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of transcript) {
    if (event.type === 'assistant') {
      const content = event.message?.content || [];
      for (const item of content) {
        if (item.type === 'tool_use') {
          const name = item.name || 'unknown';
          counts[name] = (counts[name] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

/**
 * Find the most recent prior eval file for comparison.
 * Prefers same branch, falls back to any branch.
 */
export function findPreviousRun(
  evalDir: string,
  tier: string,
  branch: string,
  excludeFile: string,
): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(evalDir).filter(f => f.endsWith('.json'));
  } catch {
    return null; // dir doesn't exist
  }

  // Parse top-level fields from each file (cheap — no full tests array needed)
  const entries: Array<{ file: string; branch: string; timestamp: string }> = [];
  for (const file of files) {
    if (file === path.basename(excludeFile)) continue;
    const fullPath = path.join(evalDir, file);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      // Quick parse — only grab the fields we need
      const data = JSON.parse(raw);
      if (data.tier !== tier) continue;
      entries.push({ file: fullPath, branch: data.branch || '', timestamp: data.timestamp || '' });
    } catch { continue; }
  }

  if (entries.length === 0) return null;

  // Sort by timestamp descending
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Prefer same branch
  const sameBranch = entries.find(e => e.branch === branch);
  if (sameBranch) return sameBranch.file;

  // Fallback: any branch
  return entries[0].file;
}

/**
 * Compare two eval results. Matches tests by name.
 */
export function compareEvalResults(
  before: EvalResult,
  after: EvalResult,
  beforeFile: string,
  afterFile: string,
): ComparisonResult {
  const deltas: TestDelta[] = [];
  let improved = 0, regressed = 0, unchanged = 0;
  let toolCountBefore = 0, toolCountAfter = 0;

  // Index before tests by name
  const beforeMap = new Map<string, EvalTestEntry>();
  for (const t of before.tests) {
    beforeMap.set(t.name, t);
  }

  // Walk after tests, match by name
  for (const afterTest of after.tests) {
    const beforeTest = beforeMap.get(afterTest.name);
    const beforeToolSummary = beforeTest?.transcript ? extractToolSummary(beforeTest.transcript) : {};
    const afterToolSummary = afterTest.transcript ? extractToolSummary(afterTest.transcript) : {};

    const beforeToolCount = Object.values(beforeToolSummary).reduce((a, b) => a + b, 0);
    const afterToolCount = Object.values(afterToolSummary).reduce((a, b) => a + b, 0);
    toolCountBefore += beforeToolCount;
    toolCountAfter += afterToolCount;

    let statusChange: TestDelta['status_change'] = 'unchanged';
    if (beforeTest) {
      if (!beforeTest.passed && afterTest.passed) { statusChange = 'improved'; improved++; }
      else if (beforeTest.passed && !afterTest.passed) { statusChange = 'regressed'; regressed++; }
      else { unchanged++; }
    } else {
      // New test — treat as unchanged (no prior data)
      unchanged++;
    }

    deltas.push({
      name: afterTest.name,
      before: {
        passed: beforeTest?.passed ?? false,
        cost_usd: beforeTest?.cost_usd ?? 0,
        turns_used: beforeTest?.turns_used,
        duration_ms: beforeTest?.duration_ms,
        detection_rate: beforeTest?.detection_rate,
        tool_summary: beforeToolSummary,
      },
      after: {
        passed: afterTest.passed,
        cost_usd: afterTest.cost_usd,
        turns_used: afterTest.turns_used,
        duration_ms: afterTest.duration_ms,
        detection_rate: afterTest.detection_rate,
        tool_summary: afterToolSummary,
      },
      status_change: statusChange,
    });

    beforeMap.delete(afterTest.name);
  }

  // Tests that were in before but not in after (removed tests)
  for (const [name, beforeTest] of beforeMap) {
    const beforeToolSummary = beforeTest.transcript ? extractToolSummary(beforeTest.transcript) : {};
    const beforeToolCount = Object.values(beforeToolSummary).reduce((a, b) => a + b, 0);
    toolCountBefore += beforeToolCount;
    unchanged++;
    deltas.push({
      name: `${name} (removed)`,
      before: {
        passed: beforeTest.passed,
        cost_usd: beforeTest.cost_usd,
        turns_used: beforeTest.turns_used,
        duration_ms: beforeTest.duration_ms,
        detection_rate: beforeTest.detection_rate,
        tool_summary: beforeToolSummary,
      },
      after: { passed: false, cost_usd: 0, tool_summary: {} },
      status_change: 'unchanged',
    });
  }

  return {
    before_file: beforeFile,
    after_file: afterFile,
    before_branch: before.branch,
    after_branch: after.branch,
    before_timestamp: before.timestamp,
    after_timestamp: after.timestamp,
    deltas,
    total_cost_delta: after.total_cost_usd - before.total_cost_usd,
    total_duration_delta: after.total_duration_ms - before.total_duration_ms,
    improved,
    regressed,
    unchanged,
    tool_count_before: toolCountBefore,
    tool_count_after: toolCountAfter,
  };
}

/**
 * Format a ComparisonResult as a readable string.
 */
export function formatComparison(c: ComparisonResult): string {
  const lines: string[] = [];
  const ts = c.before_timestamp ? c.before_timestamp.replace('T', ' ').slice(0, 16) : 'unknown';
  lines.push(`\nvs previous: ${c.before_branch}/${c.deltas.length ? 'eval' : ''} (${ts})`);
  lines.push('─'.repeat(70));

  // Per-test deltas
  for (const d of c.deltas) {
    const arrow = d.status_change === 'improved' ? '↑' : d.status_change === 'regressed' ? '↓' : '=';
    const beforeStatus = d.before.passed ? 'PASS' : 'FAIL';
    const afterStatus = d.after.passed ? 'PASS' : 'FAIL';

    // Turns delta
    let turnsDelta = '';
    if (d.before.turns_used !== undefined && d.after.turns_used !== undefined) {
      const td = d.after.turns_used - d.before.turns_used;
      turnsDelta = ` ${d.before.turns_used}→${d.after.turns_used}t`;
      if (td !== 0) turnsDelta += `(${td > 0 ? '+' : ''}${td})`;
    } else if (d.after.turns_used !== undefined) {
      turnsDelta = ` ${d.after.turns_used}t`;
    }

    // Duration delta
    let durDelta = '';
    if (d.before.duration_ms !== undefined && d.after.duration_ms !== undefined) {
      const bs = Math.round(d.before.duration_ms / 1000);
      const as = Math.round(d.after.duration_ms / 1000);
      const dd = as - bs;
      durDelta = ` ${bs}→${as}s`;
      if (dd !== 0) durDelta += `(${dd > 0 ? '+' : ''}${dd})`;
    } else if (d.after.duration_ms !== undefined) {
      durDelta = ` ${Math.round(d.after.duration_ms / 1000)}s`;
    }

    let detail = '';
    if (d.before.detection_rate !== undefined || d.after.detection_rate !== undefined) {
      detail = ` ${d.before.detection_rate ?? '?'}→${d.after.detection_rate ?? '?'} det`;
    } else {
      const costBefore = d.before.cost_usd.toFixed(2);
      const costAfter = d.after.cost_usd.toFixed(2);
      detail = ` $${costBefore}→$${costAfter}`;
    }

    const name = d.name.length > 30 ? d.name.slice(0, 27) + '...' : d.name.padEnd(30);
    lines.push(`  ${name}  ${beforeStatus.padEnd(5)} → ${afterStatus.padEnd(5)}  ${arrow}${detail}${turnsDelta}${durDelta}`);
  }

  lines.push('─'.repeat(70));

  // Totals
  const parts: string[] = [];
  if (c.improved > 0) parts.push(`${c.improved} improved`);
  if (c.regressed > 0) parts.push(`${c.regressed} regressed`);
  if (c.unchanged > 0) parts.push(`${c.unchanged} unchanged`);
  lines.push(`  Status: ${parts.join(', ')}`);

  const costSign = c.total_cost_delta >= 0 ? '+' : '';
  lines.push(`  Cost:   ${costSign}$${c.total_cost_delta.toFixed(2)}`);

  const durDelta = Math.round(c.total_duration_delta / 1000);
  const durSign = durDelta >= 0 ? '+' : '';
  lines.push(`  Duration: ${durSign}${durDelta}s`);

  const toolDelta = c.tool_count_after - c.tool_count_before;
  const toolSign = toolDelta >= 0 ? '+' : '';
  lines.push(`  Tool calls: ${c.tool_count_before} → ${c.tool_count_after} (${toolSign}${toolDelta})`);

  // Tool breakdown (show tools that changed)
  const allTools = new Set<string>();
  for (const d of c.deltas) {
    for (const t of Object.keys(d.before.tool_summary || {})) allTools.add(t);
    for (const t of Object.keys(d.after.tool_summary || {})) allTools.add(t);
  }

  if (allTools.size > 0) {
    // Aggregate tool counts across all tests
    const totalBefore: Record<string, number> = {};
    const totalAfter: Record<string, number> = {};
    for (const d of c.deltas) {
      for (const [t, n] of Object.entries(d.before.tool_summary || {})) {
        totalBefore[t] = (totalBefore[t] || 0) + n;
      }
      for (const [t, n] of Object.entries(d.after.tool_summary || {})) {
        totalAfter[t] = (totalAfter[t] || 0) + n;
      }
    }

    for (const tool of [...allTools].sort()) {
      const b = totalBefore[tool] || 0;
      const a = totalAfter[tool] || 0;
      if (b !== a) {
        const d = a - b;
        lines.push(`    ${tool}: ${b} → ${a} (${d >= 0 ? '+' : ''}${d})`);
      }
    }
  }

  // Commentary — interpret what the deltas mean
  const commentary = generateCommentary(c);
  if (commentary.length > 0) {
    lines.push('');
    lines.push('  Takeaway:');
    for (const line of commentary) {
      lines.push(`    ${line}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate human-readable commentary interpreting comparison deltas.
 * Pure function — analyzes the numbers and explains what they mean.
 */
export function generateCommentary(c: ComparisonResult): string[] {
  const notes: string[] = [];

  // 1. Regressions are the most important signal — call them out first
  const regressions = c.deltas.filter(d => d.status_change === 'regressed');
  if (regressions.length > 0) {
    for (const d of regressions) {
      notes.push(`REGRESSION: "${d.name}" was passing, now fails. Investigate immediately.`);
    }
  }

  // 2. Improvements
  const improvements = c.deltas.filter(d => d.status_change === 'improved');
  for (const d of improvements) {
    notes.push(`Fixed: "${d.name}" now passes.`);
  }

  // 3. Per-test efficiency changes (only for unchanged-status tests — regressions/improvements are already noted)
  const stable = c.deltas.filter(d => d.status_change === 'unchanged' && d.after.passed);
  for (const d of stable) {
    const insights: string[] = [];

    // Turns
    if (d.before.turns_used !== undefined && d.after.turns_used !== undefined && d.before.turns_used > 0) {
      const turnsDelta = d.after.turns_used - d.before.turns_used;
      const turnsPct = Math.round((turnsDelta / d.before.turns_used) * 100);
      if (Math.abs(turnsPct) >= 20 && Math.abs(turnsDelta) >= 2) {
        if (turnsDelta < 0) {
          insights.push(`${Math.abs(turnsDelta)} fewer turns (${Math.abs(turnsPct)}% more efficient)`);
        } else {
          insights.push(`${turnsDelta} more turns (${turnsPct}% less efficient)`);
        }
      }
    }

    // Duration
    if (d.before.duration_ms !== undefined && d.after.duration_ms !== undefined && d.before.duration_ms > 0) {
      const durDelta = d.after.duration_ms - d.before.duration_ms;
      const durPct = Math.round((durDelta / d.before.duration_ms) * 100);
      if (Math.abs(durPct) >= 20 && Math.abs(durDelta) >= 5000) {
        if (durDelta < 0) {
          insights.push(`${Math.round(Math.abs(durDelta) / 1000)}s faster`);
        } else {
          insights.push(`${Math.round(durDelta / 1000)}s slower`);
        }
      }
    }

    // Detection rate
    if (d.before.detection_rate !== undefined && d.after.detection_rate !== undefined) {
      const detDelta = d.after.detection_rate - d.before.detection_rate;
      if (detDelta !== 0) {
        if (detDelta > 0) {
          insights.push(`detecting ${detDelta} more bug${detDelta > 1 ? 's' : ''}`);
        } else {
          insights.push(`detecting ${Math.abs(detDelta)} fewer bug${Math.abs(detDelta) > 1 ? 's' : ''} — check prompt quality`);
        }
      }
    }

    // Cost
    if (d.before.cost_usd > 0) {
      const costDelta = d.after.cost_usd - d.before.cost_usd;
      const costPct = Math.round((costDelta / d.before.cost_usd) * 100);
      if (Math.abs(costPct) >= 30 && Math.abs(costDelta) >= 0.05) {
        if (costDelta < 0) {
          insights.push(`${Math.abs(costPct)}% cheaper`);
        } else {
          insights.push(`${costPct}% more expensive`);
        }
      }
    }

    if (insights.length > 0) {
      notes.push(`"${d.name}": ${insights.join(', ')}.`);
    }
  }

  // 4. Overall summary
  if (c.deltas.length >= 3 && regressions.length === 0) {
    const overallParts: string[] = [];

    // Total cost
    const totalBefore = c.deltas.reduce((s, d) => s + d.before.cost_usd, 0);
    if (totalBefore > 0) {
      const costPct = Math.round((c.total_cost_delta / totalBefore) * 100);
      if (Math.abs(costPct) >= 10) {
        overallParts.push(`${Math.abs(costPct)}% ${costPct < 0 ? 'cheaper' : 'more expensive'} overall`);
      }
    }

    // Total duration
    const totalDurBefore = c.deltas.reduce((s, d) => s + (d.before.duration_ms || 0), 0);
    if (totalDurBefore > 0) {
      const durPct = Math.round((c.total_duration_delta / totalDurBefore) * 100);
      if (Math.abs(durPct) >= 10) {
        overallParts.push(`${Math.abs(durPct)}% ${durPct < 0 ? 'faster' : 'slower'}`);
      }
    }

    // Total turns
    const turnsBefore = c.deltas.reduce((s, d) => s + (d.before.turns_used || 0), 0);
    const turnsAfter = c.deltas.reduce((s, d) => s + (d.after.turns_used || 0), 0);
    if (turnsBefore > 0) {
      const turnsPct = Math.round(((turnsAfter - turnsBefore) / turnsBefore) * 100);
      if (Math.abs(turnsPct) >= 10) {
        overallParts.push(`${Math.abs(turnsPct)}% ${turnsPct < 0 ? 'fewer' : 'more'} turns`);
      }
    }

    if (overallParts.length > 0) {
      notes.push(`Overall: ${overallParts.join(', ')}. ${regressions.length === 0 ? 'No regressions.' : ''}`);
    } else if (regressions.length === 0) {
      notes.push('Stable run — no significant efficiency changes, no regressions.');
    }
  }

  return notes;
}

// --- EvalCollector ---

function getGitInfo(): { branch: string; sha: string } {
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', timeout: 5000 });
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: 'pipe', timeout: 5000 });
    return {
      branch: branch.stdout?.toString().trim() || 'unknown',
      sha: sha.stdout?.toString().trim() || 'unknown',
    };
  } catch {
    return { branch: 'unknown', sha: 'unknown' };
  }
}

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export class EvalCollector {
  private tier: 'e2e' | 'llm-judge';
  private tests: EvalTestEntry[] = [];
  private finalized = false;
  private evalDir: string;
  private createdAt = Date.now();

  constructor(tier: 'e2e' | 'llm-judge', evalDir?: string) {
    this.tier = tier;
    this.evalDir = evalDir || DEFAULT_EVAL_DIR;
  }

  addTest(entry: EvalTestEntry): void {
    this.tests.push(entry);
    this.savePartial();
  }

  /** Write incremental results after each test. Atomic write, non-fatal. */
  savePartial(): void {
    try {
      const git = getGitInfo();
      const version = getVersion();
      const totalCost = this.tests.reduce((s, t) => s + t.cost_usd, 0);
      const totalDuration = this.tests.reduce((s, t) => s + t.duration_ms, 0);
      const passed = this.tests.filter(t => t.passed).length;

      const partial: EvalResult = {
        schema_version: SCHEMA_VERSION,
        version,
        branch: git.branch,
        git_sha: git.sha,
        timestamp: new Date().toISOString(),
        hostname: os.hostname(),
        tier: this.tier,
        total_tests: this.tests.length,
        passed,
        failed: this.tests.length - passed,
        total_cost_usd: Math.round(totalCost * 100) / 100,
        total_duration_ms: totalDuration,
        tests: this.tests,
        _partial: true,
      };

      fs.mkdirSync(this.evalDir, { recursive: true });
      const partialPath = path.join(this.evalDir, '_partial-e2e.json');
      const tmp = partialPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(partial, null, 2) + '\n');
      fs.renameSync(tmp, partialPath);
    } catch { /* non-fatal — partial saves are best-effort */ }
  }

  async finalize(): Promise<string> {
    if (this.finalized) return '';
    this.finalized = true;

    const git = getGitInfo();
    const version = getVersion();
    const timestamp = new Date().toISOString();
    const totalCost = this.tests.reduce((s, t) => s + t.cost_usd, 0);
    const totalDuration = this.tests.reduce((s, t) => s + t.duration_ms, 0);
    const passed = this.tests.filter(t => t.passed).length;

    const result: EvalResult = {
      schema_version: SCHEMA_VERSION,
      version,
      branch: git.branch,
      git_sha: git.sha,
      timestamp,
      hostname: os.hostname(),
      tier: this.tier,
      total_tests: this.tests.length,
      passed,
      failed: this.tests.length - passed,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      total_duration_ms: totalDuration,
      wall_clock_ms: Date.now() - this.createdAt,
      tests: this.tests,
    };

    // Write eval file
    fs.mkdirSync(this.evalDir, { recursive: true });
    const dateStr = timestamp.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    const safeBranch = git.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
    const filename = `${version}-${safeBranch}-${this.tier}-${dateStr}.json`;
    const filepath = path.join(this.evalDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2) + '\n');

    // Print summary table
    this.printSummary(result, filepath, git);

    // Auto-compare with previous run
    try {
      const prevFile = findPreviousRun(this.evalDir, this.tier, git.branch, filepath);
      if (prevFile) {
        const prevResult: EvalResult = JSON.parse(fs.readFileSync(prevFile, 'utf-8'));
        const comparison = compareEvalResults(prevResult, result, prevFile, filepath);
        process.stderr.write(formatComparison(comparison) + '\n');
      } else {
        process.stderr.write('\nFirst run — no comparison available.\n');
      }
    } catch (err: any) {
      process.stderr.write(`\nCompare error: ${err.message}\n`);
    }

    return filepath;
  }

  private printSummary(result: EvalResult, filepath: string, git: { branch: string; sha: string }): void {
    const lines: string[] = [];
    lines.push('');
    lines.push(`Eval Results — v${result.version} @ ${git.branch} (${git.sha}) — ${this.tier}`);
    lines.push('═'.repeat(70));

    for (const t of this.tests) {
      const status = t.passed ? ' PASS ' : ' FAIL ';
      const cost = `$${t.cost_usd.toFixed(2)}`;
      const dur = t.duration_ms ? `${Math.round(t.duration_ms / 1000)}s` : '';
      const turns = t.turns_used !== undefined ? `${t.turns_used}t` : '';

      let detail = '';
      if (t.detection_rate !== undefined) {
        detail = `${t.detection_rate}/${(t.detected_bugs?.length || 0) + (t.missed_bugs?.length || 0)} det`;
      } else if (t.judge_scores) {
        const scores = Object.entries(t.judge_scores).map(([k, v]) => `${k[0]}:${v}`).join(' ');
        detail = scores;
      }

      const name = t.name.length > 35 ? t.name.slice(0, 32) + '...' : t.name.padEnd(35);
      lines.push(`  ${name}  ${status}  ${cost.padStart(6)}  ${turns.padStart(4)}  ${dur.padStart(5)}  ${detail}`);
    }

    lines.push('─'.repeat(70));
    const totalCost = `$${result.total_cost_usd.toFixed(2)}`;
    const totalDur = `${Math.round(result.total_duration_ms / 1000)}s`;
    lines.push(`  Total: ${result.passed}/${result.total_tests} passed${' '.repeat(20)}${totalCost.padStart(6)}  ${totalDur}`);
    lines.push(`Saved: ${filepath}`);

    process.stderr.write(lines.join('\n') + '\n');
  }
}
