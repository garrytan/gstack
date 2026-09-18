/**
 * Live E2E for the Aside-driven browsing skills — periodic tier.
 *
 * Aside is the primary browser (the user's real sessions); gstack's own
 * headless browser is the fallback. These cases only run with a live Aside.
 * These tests hand a real `claude -p` session the regenerated skill docs and a
 * localhost fixture page, and check that the agent actually drove Aside the way
 * the {{ASIDE_SETUP}} contract (scripts/resolvers/aside.ts) says to: `aside repl`
 * scripts that print labelled evidence and the GSTACK_STEP_OK sentinel, and
 * artifacts copied out of the printed ASIDE_DIR. "Actually drove" means the
 * sentinel appeared on its own line in a BASH tool_result — the skill doc the
 * agent Reads also contains the token, so Read results are excluded and the
 * tokens are line-anchored (Read output is line-numbered; the cookbook wraps
 * them in console.log("…")).
 *
 * The skill docs come from the tree unless GSTACK_E2E_DOCS_ROOT points at a
 * `bun run gen:skill-docs --out-dir <dir>` render (mid-refactor the tree's
 * generated SKILL.md may be stale); either way a copied doc that is not
 * Aside-native fails fast with a "regenerate" message instead of a confusing
 * "agent did not drive Aside".
 *
 * External service (CLAUDE.md tiering rule 3) → periodic. The whole file
 * self-skips — never fails — when EVALS_TIER is not 'periodic' or when
 * `asideAvailable()` is false (no `aside` on PATH, app not running, or
 * GSTACK_SKIP_ASIDE=1). CI runners have no Aside, so this only runs on a dev
 * Mac with the app open:
 *
 *   EVALS=1 EVALS_TIER=periodic EVALS_ALL=1 bun test test/skill-e2e-aside.test.ts
 *
 * Cost: ~$1-3 per run (five sessions, 30-40 turns each). Each session gets
 * its own tmp workdir with only the skill's runtime files copied in and
 * cleans it up in a finally.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest, type SkillTestResult } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { e2eTierEnabled } from './helpers/e2e-gate';
import { asideAvailable } from './helpers/aside-available';
import { startTestServer } from '../browse/test/test-server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Whole-file gate: periodic tier AND a live Aside. Skip, never fail. ---

const tierOk = e2eTierEnabled('periodic');
const shouldRun = tierOk && asideAvailable();
if (process.env.EVALS && !shouldRun) {
  process.stderr.write(`\nskill-e2e-aside: SKIPPED — ${tierOk
    ? 'Aside is not installed or not running (or GSTACK_SKIP_ASIDE=1)'
    : 'external-service test, periodic tier only'}\n`);
}

const SUITE = 'Aside-driven skills E2E';
const evalCollector = shouldRun ? createEvalCollector('e2e-aside') : null;

/** describeIfSelected, forced to describe.skip when the whole-file gate is closed. */
const describeAside = (name: string, keys: string[], fn: () => void) =>
  describeIfSelected(name, keys, fn, shouldRun ? undefined : []);

// --- Helpers ---

/** Build output and sources never reach the agent — only SKILL.md + runtime assets. */
const SKIP_DIRS = new Set(['dist', 'src', 'test', 'bin', 'scripts', 'node_modules']);
/** Template sources and design notes are not runtime assets either. */
const skipFile = (name: string) => name.endsWith('.tmpl') || /^PLAN-.*\.md$/.test(name);
/** Generated docs: the tree, or a `gen:skill-docs --out-dir` render (mirrors the skill tree, outputs only). */
const DOCS_ROOT = process.env.GSTACK_E2E_DOCS_ROOT || ROOT;

function copySkill(name: string, dir: string): void {
  const src = path.join(ROOT, name);
  const dest = path.join(dir, name);
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || skipFile(e.name)) continue;
    if (e.isDirectory()) copyDirSync(path.join(src, e.name), path.join(dest, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dest, e.name));
  }
  if (DOCS_ROOT !== ROOT && fs.existsSync(path.join(DOCS_ROOT, name))) copyDirSync(path.join(DOCS_ROOT, name), dest);
  const doc = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8');
  // A doc with the Aside contract AND the `$B` fallback is the shipped shape.
  const stale = !doc.includes('BROWSER SETUP (Aside');
  if (stale) throw new Error(`${name}/SKILL.md is not Aside-native (stale generated doc) — run \`bun run gen:skill-docs\` (or point GSTACK_E2E_DOCS_ROOT at an --out-dir render) before this E2E`);
}

/**
 * Concatenated text of every BASH tool_result in the stream-json transcript.
 * runSkillTest leaves toolCalls[].output empty; the agent's Bash INPUT and the
 * skill doc it Reads both contain the sentinel string — only a Bash RESULT
 * proves an `aside repl` script printed it.
 */
function bashOutput(result: SkillTestResult): string {
  const bashIds = new Set<string>();
  const parts: string[] = [];
  for (const e of result.transcript) {
    for (const item of e?.message?.content ?? []) {
      if (e.type === 'assistant' && item?.type === 'tool_use' && item.name === 'Bash') bashIds.add(item.id);
      if (e.type === 'user' && item?.type === 'tool_result' && bashIds.has(item.tool_use_id)) {
        const c = item.content;
        parts.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('\n') : ''));
      }
    }
  }
  return parts.join('\n');
}

// Line-anchored: a `cat SKILL.md` in Bash prints `console.log("GSTACK_STEP_OK");`, never a bare token line.
const STEP_OK = /^GSTACK_STEP_OK\s*$/m;
const DIFF_START = /^DIFF_START\s*$/m;
const CONSOLE_ERRORS = /^CONSOLE_ERRORS=\[/m;

/** Every case: at least one `aside repl` script ran to completion. */
function expectDroveAside(result: SkillTestResult): string {
  const out = bashOutput(result);
  expect(out).toMatch(STEP_OK);
  return out;
}

/** First parseable JSON document in the final message: whole text, a fenced block, or the outermost [...] / {...}. */
function extractJson(text: string): unknown {
  const t = text.trim();
  const candidates = [t, ...[...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim())];
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a !== -1 && b > a) candidates.push(t.slice(a, b + 1));
  }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try the next shape */ }
  }
  return null;
}

function firstArray(doc: unknown): unknown[] | null {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object') {
    for (const v of Object.values(doc as Record<string, unknown>)) if (Array.isArray(v)) return v;
  }
  return null;
}

const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

/** Common preface: the fixture server is up, Aside is up, drive it through the skill's own cookbook. */
const preface = (skillMd: string) => `Aside is installed and running on this machine; its BROWSER SETUP probe will print READY.
Read ${skillMd} and follow its BROWSER SETUP and cookbook exactly. Skip the preamble bash block, lake intro, telemetry, and contributor-mode sections — go straight to the workflow.
Drive the browser ONLY with 'aside repl' scripts, each ending with console.log("GSTACK_STEP_OK"); copy any screenshot out of the printed ASIDE_DIR in bash.
Do not use AskUserQuestion. The target is a local test server that is already running — do not start servers or discover ports.
`;

// --- Cases ---

interface AsideCase {
  key: string;
  skills: string[];
  maxTurns: number;
  timeout: number;
  prompt: (dir: string, url: string) => string;
  check: (dir: string, result: SkillTestResult) => void;
}

const CASES: AsideCase[] = [
  {
    key: 'aside-browse-basic',
    skills: ['browse'],
    maxTurns: 30,
    timeout: CAPTURE_MS,
    prompt: (_dir, url) => `${preface('browse/SKILL.md')}
Open ${url}/basic.html, report the page title, the interactive elements from the snapshot tree, and the console error count, then close the tab.
Your final message must quote the page title verbatim.`,
    check: (_dir, result) => {
      expect(result.exitReason).toBe('success');
      expect(result.output.toLowerCase()).toContain('test page - basic');
      expect(expectDroveAside(result)).toMatch(CONSOLE_ERRORS);
    },
  },
  {
    key: 'aside-browse-flow',
    skills: ['browse'],
    maxTurns: 30,
    timeout: CAPTURE_MS,
    prompt: (dir, url) => `${preface('browse/SKILL.md')}
Drive this flow in ONE script, shaped like the cookbook's "Drive a flow" recipe:
open ${url}/forms.html, take a baseline interactive snapshot, fill #name with "Aside QA", select "user" in #role, click #profile-btn, wait for #result to be visible, then print the DIFF_START/DIFF_END block, the URL= line and the CONSOLE_ERRORS= line, save a screenshot named "flow-result.jpg", print ASIDE_DIR=, close the tab, print the sentinel.
Then, in bash, mkdir -p ${dir}/screenshots and copy flow-result.jpg from the printed ASIDE_DIR into ${dir}/screenshots/.
Your final message must include the DIFF and CONSOLE_ERRORS lines verbatim.`,
    check: (dir, result) => {
      expect(result.exitReason).toBe('success');
      const out = expectDroveAside(result);
      expect(out).toMatch(DIFF_START);
      expect(out).toMatch(CONSOLE_ERRORS);
      const shots = filesIn(path.join(dir, 'screenshots')).filter((f) => /\.(jpe?g|png)$/i.test(f));
      expect(shots.length).toBeGreaterThan(0);
      expect(fs.statSync(path.join(dir, 'screenshots', shots[0])).size).toBeGreaterThan(0);
    },
  },
  {
    key: 'aside-qa-quick',
    skills: ['qa'],
    maxTurns: 40,
    timeout: CAPTURE_LONG_MS,
    prompt: (dir, url) => `${preface('qa/SKILL.md')}
qa is a carved skill: when SKILL.md tells you to Read ~/.claude/skills/gstack/qa/sections/<file>, read qa/sections/<file> in this working directory instead (same content, local copy).
Also skip the clean-working-tree check and the test-framework bootstrap — this directory has no source code and nothing to fix, so run a report-only pass.
Run a Quick-tier QA test on ${url}/basic.html.
Output dir: ${dir}/qa-reports — write the report to ${dir}/qa-reports/qa-report.md (it must include the Health Score line) and copy every screenshot into ${dir}/qa-reports/screenshots/.`,
    check: (dir, result) => {
      // Thorough QA may run out of turns; the artifacts are the contract.
      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      expectDroveAside(result);
      const report = path.join(dir, 'qa-reports', 'qa-report.md');
      expect(fs.existsSync(report)).toBe(true);
      expect(fs.readFileSync(report, 'utf-8')).toMatch(/health score/i);
      expect(filesIn(path.join(dir, 'qa-reports', 'screenshots')).length).toBeGreaterThan(0);
    },
  },
  {
    key: 'aside-scrape-json',
    skills: ['scrape'],
    maxTurns: 30,
    timeout: CAPTURE_MS,
    prompt: (_dir, url) => `${preface('scrape/SKILL.md')}
Scrape the list of links (text and href) on ${url}/basic.html.
Follow the skill's output discipline: your final message is exactly one JSON document — an object with an "items" array (or a bare array) — with no prose around it.`,
    check: (_dir, result) => {
      expect(result.exitReason).toBe('success');
      expectDroveAside(result);
      const doc = extractJson(result.output);
      expect(doc).not.toBeNull();
      const items = firstArray(doc);
      expect(items).not.toBeNull();
      expect(items!.length).toBeGreaterThan(0);
      expect(JSON.stringify(doc)).toContain('page1');
    },
  },
  {
    key: 'aside-canary-quick',
    skills: ['canary'],
    maxTurns: 40,
    timeout: CAPTURE_LONG_MS,
    prompt: (dir, url) => `${preface('canary/SKILL.md')}
Run: /canary ${url}/basic.html --quick — a single-pass health check on that one page, no continuous monitoring, no baseline capture.
The working directory is ${dir}; write the report to ${dir}/.gstack/canary-reports/<date>-canary.md (and the .json) exactly as the skill describes. If a gstack helper binary is missing, skip that logging line and continue.`,
    check: (dir, result) => {
      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      expectDroveAside(result);
      const reportDir = path.join(dir, '.gstack', 'canary-reports');
      const reports = filesIn(reportDir).filter((f) => /-canary\.md$/.test(f));
      expect(reports.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(reportDir, reports[0]), 'utf-8')).toMatch(/CANARY REPORT|Status:/);
    },
  },
];

// --- Suite: one describe so the sessions run concurrently (one shard wall for five captures) ---

let server: ReturnType<typeof startTestServer>;

describeAside(SUITE, CASES.map((c) => c.key), () => {
  beforeAll(() => { server = startTestServer(); });
  afterAll(() => { server?.server?.stop(); });

  for (const c of CASES) {
    testConcurrentIfSelected(c.key, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${c.key}-`));
      try {
        for (const s of c.skills) copySkill(s, dir);
        if (c.skills.includes('qa')) fs.mkdirSync(path.join(dir, 'qa-reports', 'screenshots'), { recursive: true });
        const result = await runSkillTest({
          prompt: c.prompt(dir, server.url),
          workingDirectory: dir,
          maxTurns: c.maxTurns,
          timeout: c.timeout,
          testName: c.key,
          runId,
        });
        logCost(`/${c.key}`, result);
        let passed = false;
        try {
          c.check(dir, result);
          passed = true;
        } finally {
          recordE2E(evalCollector, c.key, SUITE, result, { passed });
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, c.timeout);
  }
});

// Explicit 60s timeout: finalize does a JSON save + cross-run comparison,
// observed past bun's 5s default hook timeout in sibling files.
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
}, 60_000);
