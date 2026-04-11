/**
 * Head-to-head: Claude Code vs Gemini CLI — gstack skill invocations compared.
 *
 * Runs actual gstack skill workflows through both CLIs and compares results.
 * Each test invokes a real skill (not just a raw tool call) and checks for
 * workflow-specific output patterns that prove the skill activated and ran
 * its methodology.
 *
 * Prerequisites:
 *   - `claude` binary installed + ANTHROPIC_API_KEY set
 *   - `gemini` binary installed + authenticated (~/.gemini/ config or GEMINI_API_KEY)
 *   - EVALS=1 env var (same gate as other E2E tests)
 *   - Browse binary built (`bun run build`)
 *
 * Run:
 *   EVALS=1 bun test test/head-to-head.test.ts
 *
 * Results are written to:
 *   ~/.gstack-dev/head-to-head/<timestamp>/
 *     ├── summary.json         — machine-readable comparison
 *     ├── summary.md           — human-readable report (paste into GitHub page)
 *     └── <test-name>/
 *         ├── claude.json      — full Claude result
 *         └── gemini.json      — full Gemini result
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import { runGeminiSkill } from './helpers/gemini-session-runner';
import type { SkillTestResult } from './helpers/session-runner';
import type { GeminiResult } from './helpers/gemini-session-runner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const evalsEnabled = !!process.env.EVALS;

// --- Prerequisite checks ---

const CLAUDE_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(['which', 'claude']).exitCode === 0;
  } catch { return false; }
})();

const GEMINI_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(['which', 'gemini']).exitCode === 0;
  } catch { return false; }
})();

const BOTH_AVAILABLE = CLAUDE_AVAILABLE && GEMINI_AVAILABLE;
const SKIP = !evalsEnabled || !BOTH_AVAILABLE;

if (evalsEnabled && !BOTH_AVAILABLE) {
  const missing = [
    !CLAUDE_AVAILABLE && 'claude',
    !GEMINI_AVAILABLE && 'gemini',
  ].filter(Boolean);
  process.stderr.write(`\nHead-to-head: SKIPPED — missing: ${missing.join(', ')}\n`);
  process.stderr.write('  Claude: npm install -g @anthropic-ai/claude-code\n');
  process.stderr.write('  Gemini: npm install -g @google/gemini-cli\n\n');
}

const describeH2H = SKIP ? describe.skip : describe;

// --- Output directory ---

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTPUT_DIR = path.join(os.homedir(), '.gstack-dev', 'head-to-head', timestamp);

// --- Test case definitions ---

interface TestCase {
  name: string;
  /** Skill being tested (for the report) */
  skill: string;
  /** Category for grouping in the report */
  category: 'planning' | 'review' | 'test-qa' | 'ship-deploy' | 'safety' | 'utility' | 'analysis';
  /** Prompt sent to both CLIs identically */
  prompt: string;
  /** What Claude is allowed to use */
  claudeTools?: string[];
  /** Max turns for Claude */
  claudeMaxTurns?: number;
  /** Timeout per CLI in ms */
  timeout?: number;
  /** Assertions that should pass for BOTH CLIs — returns list of failure descriptions */
  sharedAssertions: (output: string, toolCalls: string[]) => string[];
  /** Features this test exercises (for the compatibility matrix) */
  exercises: string[];
}

// Helper: check if output contains ANY of these patterns (case-insensitive)
function hasAny(output: string, patterns: string[]): boolean {
  const lower = output.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

/** Extract text from Claude transcript assistant messages when result.output is empty */
function extractTranscriptText(transcript: any[]): string {
  const texts: string[] = [];
  for (const event of transcript) {
    if (event.type === 'assistant') {
      const content = event.message?.content || [];
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          texts.push(item.text);
        }
      }
    }
  }
  return texts.join('\n');
}

/** Estimate Gemini cost from token counts (approximate, based on published pricing) */
function estimateGeminiCost(inputTokens: number, outputTokens: number): number {
  // Gemini 2.5 Flash: ~$0.15/M input, ~$0.60/M output (mid-2026 estimate)
  const inputCost = (inputTokens / 1_000_000) * 0.15;
  const outputCost = (outputTokens / 1_000_000) * 0.60;
  return Math.round((inputCost + outputCost) * 1000) / 1000;
}

const TEST_CASES: TestCase[] = [

  // ═══════════════════════════════════════════════════════════════
  // PLANNING SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'office-hours',
    skill: '/office-hours',
    category: 'planning',
    prompt: `I want to build a CLI tool that automatically generates changelogs from git history. Run /office-hours on this idea.`,
    claudeTools: ['Read', 'Bash', 'Write', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Office hours should push back, ask questions, or reframe
      if (!hasAny(output, ['question', 'ask', 'problem', 'pain', 'user', 'who', 'why', 'what if', 'reframe', 'challenge', 'push back', 'goal', 'tell me', 'describe', 'explain']))
        failures.push('Should ask probing questions or challenge the premise');
      // Should engage with the idea substantively
      if (output.length < 200)
        failures.push('Should produce substantive engagement (>200 chars)');
      return failures;
    },
    exercises: ['/office-hours', 'ask_user', 'Ideation workflow'],
  },

  {
    name: 'plan-ceo-review',
    skill: '/plan-ceo-review',
    category: 'planning',
    prompt: `Here is my plan: Build a TODO app with React and Firebase. Users can create, edit, and delete tasks. Run /plan-ceo-review on this plan.`,
    claudeTools: ['Read', 'Bash', 'Write', 'Grep', 'Glob'],
    claudeMaxTurns: 20,
    timeout: 180_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // CEO review should challenge scope/ambition
      if (!hasAny(output, ['scope', 'ambition', 'bigger', 'differentiat', 'compet', 'why', 'user', 'market', 'problem', '10']))
        failures.push('Should challenge scope or discuss ambition/differentiation');
      // Should have structured output (sections, scores, or numbered points)
      if (!hasAny(output, ['1.', '##', 'section', 'review', 'finding', 'recommendation']))
        failures.push('Should produce structured review output');
      return failures;
    },
    exercises: ['/plan-ceo-review', 'ask_user', 'Strategic review'],
  },

  {
    name: 'plan-eng-review',
    skill: '/plan-eng-review',
    category: 'planning',
    prompt: `Review this engineering plan: We'll build a REST API using Express.js with PostgreSQL. Auth via JWT tokens stored in localStorage. Rate limiting at 100 req/min. Run /plan-eng-review.`,
    claudeTools: ['Read', 'Bash', 'Write', 'Grep', 'Glob'],
    claudeMaxTurns: 20,
    timeout: 180_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Eng review should flag technical concerns
      if (!hasAny(output, ['localStorage', 'security', 'jwt', 'xss', 'architecture', 'database', 'schema', 'migration', 'test', 'edge case']))
        failures.push('Should flag technical concerns (localStorage JWT is a known anti-pattern)');
      // Should produce structured findings
      if (!hasAny(output, ['issue', 'finding', 'concern', 'recommendation', 'risk', 'p1', 'p2', 'critical']))
        failures.push('Should produce structured findings or issues');
      return failures;
    },
    exercises: ['/plan-eng-review', 'ask_user', 'Architecture review'],
  },

  // ═══════════════════════════════════════════════════════════════
  // REVIEW & ANALYSIS SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'review',
    skill: '/review',
    category: 'review',
    prompt: `Run /review on the current branch. Review the diff and report findings.`,
    claudeTools: ['Read', 'Bash', 'Write', 'Grep', 'Glob'],
    claudeMaxTurns: 20,
    timeout: 180_000,
    sharedAssertions: (output, toolCalls) => {
      const failures: string[] = [];
      // Review should run git commands
      const usedGit = toolCalls.some(t =>
        t === 'Bash' || t === 'run_shell_command'
      );
      if (!usedGit && !hasAny(output, ['diff', 'commit', 'branch', 'change']))
        failures.push('Should examine git diff or branch state');
      // Should produce review-like output
      if (!hasAny(output, ['review', 'finding', 'issue', 'clean', 'change', 'diff', 'no issue', 'approved']))
        failures.push('Should produce review findings or clean report');
      return failures;
    },
    exercises: ['/review', 'run_shell_command', 'read_file', 'PR review workflow'],
  },

  {
    name: 'cso',
    skill: '/cso',
    category: 'review',
    prompt: `Run /cso --quick on this repository. Do a rapid security scan.`,
    claudeTools: ['Read', 'Bash', 'Write', 'Grep', 'Glob', 'WebSearch'],
    claudeMaxTurns: 20,
    timeout: 180_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // CSO should discuss security concepts
      if (!hasAny(output, ['security', 'vulnerab', 'attack', 'owasp', 'threat', 'injection', 'auth', 'xss', 'audit', 'finding', 'risk']))
        failures.push('Should discuss security concepts (OWASP, vulnerabilities, threats)');
      // Should examine actual code
      if (!hasAny(output, ['.ts', '.js', 'file', 'code', 'depend', 'package', 'config']))
        failures.push('Should examine actual code files');
      return failures;
    },
    exercises: ['/cso', 'grep_search', 'read_file', 'Security audit'],
  },

  {
    name: 'investigate',
    skill: '/investigate',
    category: 'review',
    prompt: `Run /investigate. The bug: "bun test" shows a test-2 failure in the eval-store tests. It's a pre-existing issue. Investigate the root cause — do NOT fix it.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output, toolCalls) => {
      const failures: string[] = [];
      // Investigate should look at code/tests
      const readFiles = toolCalls.some(t =>
        t === 'Read' || t === 'read_file' || t === 'Bash' || t === 'run_shell_command'
      );
      if (!readFiles)
        failures.push('Should read files or run commands to investigate');
      // Should discuss root cause
      if (!hasAny(output, ['cause', 'reason', 'because', 'issue', 'fail', 'test', 'eval', 'hypothesis', 'finding']))
        failures.push('Should discuss root cause or hypothesis');
      return failures;
    },
    exercises: ['/investigate', 'read_file', 'grep_search', 'Root-cause debugging'],
  },

  // ═══════════════════════════════════════════════════════════════
  // TESTING & QA SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'qa-only',
    skill: '/qa-only',
    category: 'test-qa',
    prompt: `Run /qa-only in report-only mode on this repository. Check the test infrastructure and report what you find. Do not use a browser — just review the test setup.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // QA should examine test infrastructure
      if (!hasAny(output, ['test', 'spec', 'suite', 'bun', 'coverage', 'assert', 'expect']))
        failures.push('Should examine test infrastructure');
      // Should produce a report
      if (output.length < 100)
        failures.push('Should produce a substantive QA report (>100 chars)');
      return failures;
    },
    exercises: ['/qa-only', 'read_file', 'glob', 'QA reporting'],
  },

  {
    name: 'benchmark',
    skill: '/benchmark',
    category: 'test-qa',
    prompt: `Run /benchmark --quick. We don't have a URL to test — just analyze what performance testing infrastructure exists in this repo and report what benchmarks could be set up.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should discuss performance/benchmarking
      if (!hasAny(output, ['performance', 'benchmark', 'metric', 'baseline', 'load', 'timing', 'speed', 'browse', 'perf']))
        failures.push('Should discuss performance or benchmarking concepts');
      return failures;
    },
    exercises: ['/benchmark', 'read_file', 'Performance analysis'],
  },

  // ═══════════════════════════════════════════════════════════════
  // SHIP & DEPLOY SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'ship-preflight',
    skill: '/ship',
    category: 'ship-deploy',
    prompt: `Run /ship. We're on the main branch — it should detect this and stop with a warning. Just report what /ship would do.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 10,
    timeout: 90_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Ship should detect main branch and refuse or warn
      if (!hasAny(output, ['main', 'master', 'base branch', 'cannot ship', 'feature branch', 'abort', 'stop', 'not on', 'switch']))
        failures.push('Should detect main branch and warn/stop');
      return failures;
    },
    exercises: ['/ship', 'run_shell_command', 'Branch detection'],
  },

  {
    name: 'document-release',
    skill: '/document-release',
    category: 'ship-deploy',
    prompt: `Run /document-release. Analyze what documentation changes would be needed based on recent commits. Report only — do not modify any files.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should examine docs and recent changes
      if (!hasAny(output, ['doc', 'readme', 'changelog', 'md', 'update', 'commit', 'change']))
        failures.push('Should discuss documentation and recent changes');
      return failures;
    },
    exercises: ['/document-release', 'read_file', 'run_shell_command', 'Doc sync'],
  },

  // ═══════════════════════════════════════════════════════════════
  // SAFETY SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'careful',
    skill: '/careful',
    category: 'safety',
    prompt: `Activate /careful mode. Then try to run: rm -rf /tmp/test-dir-that-does-not-exist`,
    claudeTools: ['Read', 'Bash'],
    claudeMaxTurns: 8,
    timeout: 60_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should warn about destructive command
      if (!hasAny(output, ['careful', 'destructive', 'dangerous', 'warning', 'confirm', 'safety', 'rm -rf', 'caution', 'proceed', 'refuse', 'cannot', 'won\'t', 'block']))
        failures.push('Should warn about or refuse destructive rm -rf command');
      return failures;
    },
    exercises: ['/careful', 'Safety guardrails', 'Destructive command detection'],
  },

  {
    name: 'freeze',
    skill: '/freeze',
    category: 'safety',
    prompt: `Activate /freeze for the src/ directory. Just confirm the freeze is active — do not write any files.`,
    claudeTools: ['Read', 'Bash'],
    claudeMaxTurns: 8,
    timeout: 60_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should acknowledge freeze/directory restriction
      if (!hasAny(output, ['freeze', 'restrict', 'lock', 'directory', 'boundary', 'src', 'edit', 'scope']))
        failures.push('Should acknowledge directory freeze/restriction');
      return failures;
    },
    exercises: ['/freeze', 'Directory scoping', 'Edit restrictions'],
  },

  // ═══════════════════════════════════════════════════════════════
  // UTILITY SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'retro',
    skill: '/retro',
    category: 'utility',
    prompt: `Run /retro for the last 7 days. Summarize what was shipped.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output, toolCalls) => {
      const failures: string[] = [];
      // Retro should examine git history
      const usedGit = toolCalls.some(t =>
        t === 'Bash' || t === 'run_shell_command'
      );
      if (!usedGit && !hasAny(output, ['commit', 'ship', 'merge', 'change', 'author']))
        failures.push('Should examine git history');
      // Should produce a retrospective
      if (!hasAny(output, ['retro', 'week', 'ship', 'commit', 'summary', 'author', 'change', 'review']))
        failures.push('Should produce retrospective content');
      return failures;
    },
    exercises: ['/retro', 'run_shell_command', 'Git analysis'],
  },

  {
    name: 'learn',
    skill: '/learn',
    category: 'utility',
    prompt: `Run /learn stats. Show what learnings exist for this project.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 10,
    timeout: 60_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should engage with the learnings system
      if (!hasAny(output, ['learn', 'pattern', 'no learn', 'empty', 'stats', 'entries', 'project', '0']))
        failures.push('Should report on learnings state (even if empty)');
      return failures;
    },
    exercises: ['/learn', 'run_shell_command', 'Learnings system'],
  },

  {
    name: 'browse-discovery',
    skill: '/browse',
    category: 'utility',
    prompt: `Run /browse and check if the browse binary is available. Run: $B --help or equivalent. Report what commands are available.`,
    claudeTools: ['Read', 'Bash', 'Glob'],
    claudeMaxTurns: 10,
    timeout: 60_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should discover browse commands
      if (!hasAny(output, ['browse', 'goto', 'snapshot', 'click', 'command', 'screenshot', 'binary', 'not found', 'help']))
        failures.push('Should discover browse binary or report its status');
      return failures;
    },
    exercises: ['/browse', 'run_shell_command', 'Browse binary discovery'],
  },

  // ═══════════════════════════════════════════════════════════════
  // DESIGN SKILLS
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'design-review',
    skill: '/design-review',
    category: 'review',
    prompt: `Run /design-review in analysis-only mode. We don't have a running app — just review the design patterns and conventions used in the browse/src/ directory. Report findings without making changes.`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should discuss design patterns
      if (!hasAny(output, ['design', 'pattern', 'style', 'layout', 'component', 'structure', 'convention', 'code', 'architecture']))
        failures.push('Should discuss design patterns or code conventions');
      // Should examine actual files
      if (!hasAny(output, ['.ts', 'browse', 'src', 'file', 'command']))
        failures.push('Should examine files in browse/src/');
      return failures;
    },
    exercises: ['/design-review', 'read_file', 'grep_search', 'Design analysis'],
  },

  // ═══════════════════════════════════════════════════════════════
  // SKILL ROUTING (meta-test: does the right skill activate?)
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'skill-routing-security',
    skill: 'routing',
    category: 'analysis',
    prompt: `I'm worried about security vulnerabilities in this project. Can you do a security check?`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob', 'WebSearch'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output) => {
      const failures: string[] = [];
      // Should route to /cso or discuss security
      if (!hasAny(output, ['security', 'vulnerab', 'cso', 'owasp', 'audit', 'threat', 'scan']))
        failures.push('Should route to security skill or discuss security');
      return failures;
    },
    exercises: ['Skill routing', '/cso activation via natural language'],
  },

  {
    name: 'skill-routing-debug',
    skill: 'routing',
    category: 'analysis',
    prompt: `There's a bug: when I run the tests, one of them fails intermittently. Can you figure out why?`,
    claudeTools: ['Read', 'Bash', 'Grep', 'Glob'],
    claudeMaxTurns: 15,
    timeout: 120_000,
    sharedAssertions: (output, toolCalls) => {
      const failures: string[] = [];
      // Should investigate or discuss debugging
      if (!hasAny(output, ['test', 'fail', 'investigate', 'cause', 'debug', 'intermittent', 'flak', 'race', 'timing']))
        failures.push('Should engage with the debugging problem');
      // Should actually look at something
      if (toolCalls.length === 0 && output.length < 200)
        failures.push('Should examine code or tests to investigate');
      return failures;
    },
    exercises: ['Skill routing', '/investigate activation via natural language'],
  },
];

// --- Result types ---

interface SingleResult {
  cli: 'claude' | 'gemini';
  output: string;
  exitCode: number;
  durationMs: number;
  toolCalls: string[];
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  assertionFailures: string[];
  passed: boolean;
  errorMessage?: string;
  debugLines?: string[];
}

interface ComparisonResult {
  testName: string;
  skill: string;
  category: string;
  exercises: string[];
  claude: SingleResult;
  gemini: SingleResult;
  bothPassed: boolean;
  behaviorMatch: 'equivalent' | 'divergent' | 'one-failed';
}

const results: ComparisonResult[] = [];

// --- Helpers ---

async function runClaude(tc: TestCase, cwd: string): Promise<SingleResult> {
  const start = Date.now();
  try {
    const result = await runSkillTest({
      prompt: tc.prompt,
      workingDirectory: cwd,
      maxTurns: tc.claudeMaxTurns ?? 15,
      allowedTools: tc.claudeTools ?? ['Bash', 'Read', 'Write', 'Grep', 'Glob'],
      timeout: tc.timeout ?? 120_000,
      testName: `h2h-claude-${tc.name}`,
    });

    let output = result.output || '';
    if (!output.trim() && result.transcript.length > 0) {
      output = extractTranscriptText(result.transcript);
    }
    const toolNames = result.toolCalls.map(t => t.tool);
    const failures = tc.sharedAssertions(output, toolNames);

    // Extract token breakdown from Claude's result event in transcript
    const claudeResultEvent = result.transcript.find((e: any) => e.type === 'result');
    const claudeUsage = claudeResultEvent?.usage || {};

    return {
      cli: 'claude',
      output,
      exitCode: result.exitReason === 'success' ? 0 : 1,
      durationMs: result.duration,
      toolCalls: toolNames,
      tokens: result.costEstimate.estimatedTokens,
      inputTokens: claudeUsage.input_tokens || 0,
      outputTokens: claudeUsage.output_tokens || 0,
      costUsd: result.costEstimate.estimatedCost,
      model: result.model,
      assertionFailures: failures,
      passed: failures.length === 0,
    };
  } catch (err: any) {
    return {
      cli: 'claude',
      output: `ERROR: ${err.message}`,
      exitCode: 1,
      durationMs: Date.now() - start,
      toolCalls: [],
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: '',
      assertionFailures: [`Claude threw: ${err.message}`],
      passed: false,
      errorMessage: err.message,
    };
  }
}

async function runGemini(tc: TestCase, cwd: string): Promise<SingleResult> {
  const start = Date.now();
  try {
    const result = await runGeminiSkill({
      prompt: tc.prompt,
      timeoutMs: tc.timeout ?? 120_000,
      cwd,
    });

    const output = result.output || '';
    const failures = tc.sharedAssertions(output, result.toolCalls);
    const costUsd = estimateGeminiCost(result.inputTokens, result.outputTokens);
    return {
      cli: 'gemini',
      output,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls,
      tokens: result.tokens,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      model: result.model || '',
      assertionFailures: failures,
      // Don't count timeout (124) as failure if assertions pass
      passed: failures.length === 0,
      errorMessage: result.errorMessage || undefined,
      debugLines: result.rawLines.slice(-10),
    };
  } catch (err: any) {
    return {
      cli: 'gemini',
      output: `ERROR: ${err.message}`,
      exitCode: 1,
      durationMs: Date.now() - start,
      toolCalls: [],
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      model: '',
      assertionFailures: [`Gemini threw: ${err.message}`],
      passed: false,
      errorMessage: err.message,
    };
  }
}

function classifyBehavior(claude: SingleResult, gemini: SingleResult): ComparisonResult['behaviorMatch'] {
  if (!claude.passed && !gemini.passed) return 'divergent';
  if (!claude.passed || !gemini.passed) return 'one-failed';
  return 'equivalent';
}

function generateMarkdownReport(results: ComparisonResult[]): string {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 10);
  const bothPassedCount = results.filter(r => r.bothPassed).length;

  lines.push('# Head-to-Head: Claude Code vs Gemini CLI — Skill Comparison');
  lines.push('');
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Skills tested:** ${results.length}`);
  lines.push(`**Both passed:** ${bothPassedCount}/${results.length}`);
  lines.push('');

  // Group by category
  const categories = ['planning', 'review', 'test-qa', 'ship-deploy', 'safety', 'utility', 'analysis'];
  const categoryLabels: Record<string, string> = {
    planning: 'Planning & Strategy',
    review: 'Review & Analysis',
    'test-qa': 'Testing & QA',
    'ship-deploy': 'Ship & Deploy',
    safety: 'Safety',
    utility: 'Utility',
    analysis: 'Skill Routing',
  };

  // Summary table
  lines.push('## Results by Skill');
  lines.push('');

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    if (catResults.length === 0) continue;

    lines.push(`### ${categoryLabels[cat] || cat}`);
    lines.push('');
    lines.push('| Skill | Claude | Gemini | Match | Claude time | Gemini time |');
    lines.push('|-------|--------|--------|-------|-------------|-------------|');

    for (const r of catResults) {
      const claudeStatus = r.claude.passed ? 'PASS' : 'FAIL';
      const geminiStatus = r.gemini.passed ? 'PASS' : 'FAIL';
      const claudeTime = `${Math.round(r.claude.durationMs / 1000)}s`;
      const geminiTime = `${Math.round(r.gemini.durationMs / 1000)}s`;
      lines.push(`| \`${r.skill}\` | ${claudeStatus} | ${geminiStatus} | ${r.behaviorMatch} | ${claudeTime} | ${geminiTime} |`);
    }
    lines.push('');
  }

  // Tool usage comparison
  lines.push('## Tool Usage Comparison');
  lines.push('');
  lines.push('Shows which tools each CLI chose for the same task.');
  lines.push('');
  lines.push('| Skill | Claude tools | Gemini tools |');
  lines.push('|-------|-------------|-------------|');

  for (const r of results) {
    const claudeTools = r.claude.toolCalls.length > 0
      ? [...new Set(r.claude.toolCalls)].join(', ')
      : '(none)';
    const geminiTools = r.gemini.toolCalls.length > 0
      ? [...new Set(r.gemini.toolCalls)].join(', ')
      : '(none)';
    lines.push(`| \`${r.skill}\` | ${claudeTools} | ${geminiTools} |`);
  }

  // Token/cost comparison
  lines.push('');
  lines.push('## Cost & Token Usage');
  lines.push('');
  lines.push('| Skill | Claude in | Claude out | Claude cost | Gemini in | Gemini out | Gemini cost* |');
  lines.push('|-------|-----------|------------|-------------|-----------|------------|-------------|');

  for (const r of results) {
    lines.push(`| \`${r.skill}\` | ${r.claude.inputTokens.toLocaleString()} | ${r.claude.outputTokens.toLocaleString()} | $${r.claude.costUsd.toFixed(3)} | ${r.gemini.inputTokens.toLocaleString()} | ${r.gemini.outputTokens.toLocaleString()} | $${r.gemini.costUsd.toFixed(3)} |`);
  }

  const claudeTotalCost = results.reduce((sum, r) => sum + r.claude.costUsd, 0);
  const geminiTotalCost = results.reduce((sum, r) => sum + r.gemini.costUsd, 0);
  lines.push('');
  lines.push(`**Total estimated cost:** Claude $${claudeTotalCost.toFixed(2)} | Gemini $${geminiTotalCost.toFixed(2)}`);
  lines.push('');
  lines.push('_*Gemini costs are estimates based on published pricing (~$0.15/M input, ~$0.60/M output)._');

  // Failures detail
  const failures = results.filter(r => !r.bothPassed);
  if (failures.length > 0) {
    lines.push('');
    lines.push('## Failures');
    lines.push('');
    for (const r of failures) {
      lines.push(`### ${r.skill} (${r.testName})`);
      if (!r.claude.passed) {
        lines.push(`**Claude** (${r.claude.model || 'unknown'}): ${r.claude.assertionFailures.join('; ')}`);
        if (r.claude.errorMessage) lines.push(`> Error: ${r.claude.errorMessage}`);
        else lines.push(`> ${r.claude.output.slice(0, 300).replace(/\n/g, ' ')}`);
        lines.push('');
      }
      if (!r.gemini.passed) {
        lines.push(`**Gemini** (${r.gemini.model || 'unknown'}): ${r.gemini.assertionFailures.join('; ')}`);
        if (r.gemini.errorMessage) lines.push(`> Error: ${r.gemini.errorMessage}`);
        else lines.push(`> ${r.gemini.output.slice(0, 300).replace(/\n/g, ' ')}`);
        lines.push('');
      }
    }
  }

  // Overall summary
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const claudeTotal = results.filter(r => r.claude.passed).length;
  const geminiTotal = results.filter(r => r.gemini.passed).length;
  lines.push(`- **Claude:** ${claudeTotal}/${results.length} skills passed`);
  lines.push(`- **Gemini:** ${geminiTotal}/${results.length} skills passed`);
  lines.push(`- **Both passed:** ${bothPassedCount}/${results.length}`);
  lines.push(`- **Equivalent behavior:** ${results.filter(r => r.behaviorMatch === 'equivalent').length}/${results.length}`);
  lines.push('');

  return lines.join('\n');
}

// --- Test suite ---

describeH2H('Head-to-Head: Skill Comparison', () => {
  beforeAll(() => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    process.stderr.write(`\n${'═'.repeat(70)}\n`);
    process.stderr.write('HEAD-TO-HEAD SKILL COMPARISON: Claude Code vs Gemini CLI\n');
    process.stderr.write(`${'═'.repeat(70)}\n`);
    process.stderr.write(`Results: ${OUTPUT_DIR}\n\n`);
  });

  for (const tc of TEST_CASES) {
    test(tc.name, async () => {
      const testDir = path.join(OUTPUT_DIR, tc.name);
      fs.mkdirSync(testDir, { recursive: true });

      process.stderr.write(`  [${tc.skill}] running Claude...`);
      const claude = await runClaude(tc, ROOT);
      process.stderr.write(` ${claude.passed ? 'PASS' : 'FAIL'} (${Math.round(claude.durationMs / 1000)}s, ${claude.toolCalls.length} tools)\n`);

      process.stderr.write(`  [${tc.skill}] running Gemini...`);
      const gemini = await runGemini(tc, ROOT);
      process.stderr.write(` ${gemini.passed ? 'PASS' : 'FAIL'} (${Math.round(gemini.durationMs / 1000)}s, ${gemini.toolCalls.length} tools)\n`);

      // Save raw results
      fs.writeFileSync(path.join(testDir, 'claude.json'), JSON.stringify(claude, null, 2));
      fs.writeFileSync(path.join(testDir, 'gemini.json'), JSON.stringify(gemini, null, 2));

      const comparison: ComparisonResult = {
        testName: tc.name,
        skill: tc.skill,
        category: tc.category,
        exercises: tc.exercises,
        claude,
        gemini,
        bothPassed: claude.passed && gemini.passed,
        behaviorMatch: classifyBehavior(claude, gemini),
      };
      results.push(comparison);

      // Log failures inline for quick debugging
      if (!claude.passed) {
        process.stderr.write(`    Claude failures: ${claude.assertionFailures.join('; ')}\n`);
      }
      if (!gemini.passed) {
        process.stderr.write(`    Gemini failures: ${gemini.assertionFailures.join('; ')}\n`);
      }

      // Test always passes — we're documenting differences, not gating
      expect(true).toBe(true);
    }, (tc.timeout ?? 120_000) * 2 + 60_000); // 2x timeout (both CLIs) + buffer
  }

  afterAll(() => {
    if (results.length === 0) return;

    // Write machine-readable summary
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'summary.json'),
      JSON.stringify(results, null, 2),
    );

    // Write human-readable summary
    const report = generateMarkdownReport(results);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.md'), report);

    // Print final summary
    process.stderr.write('\n' + '═'.repeat(70) + '\n');
    process.stderr.write('FINAL RESULTS\n');
    process.stderr.write('═'.repeat(70) + '\n\n');

    const categories = ['planning', 'review', 'test-qa', 'ship-deploy', 'safety', 'utility', 'analysis'];
    const categoryLabels: Record<string, string> = {
      planning: 'PLANNING',
      review: 'REVIEW',
      'test-qa': 'TESTING',
      'ship-deploy': 'SHIPPING',
      safety: 'SAFETY',
      utility: 'UTILITY',
      analysis: 'ROUTING',
    };

    for (const cat of categories) {
      const catResults = results.filter(r => r.category === cat);
      if (catResults.length === 0) continue;

      process.stderr.write(`  ${categoryLabels[cat] || cat}\n`);
      for (const r of catResults) {
        const status = r.bothPassed
          ? 'BOTH PASS'
          : r.claude.passed && !r.gemini.passed
            ? 'GEMINI FAIL'
            : !r.claude.passed && r.gemini.passed
              ? 'CLAUDE FAIL'
              : 'BOTH FAIL';
        process.stderr.write(`    ${r.skill.padEnd(25)} ${status.padEnd(15)} ${r.behaviorMatch}\n`);
      }
      process.stderr.write('\n');
    }

    const passed = results.filter(r => r.bothPassed).length;
    process.stderr.write(`  ${passed}/${results.length} skills passed on both CLIs\n`);
    process.stderr.write(`  Report: ${path.join(OUTPUT_DIR, 'summary.md')}\n\n`);
  });
});
