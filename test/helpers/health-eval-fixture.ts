/** Isolated fixtures and assertions for the single periodic /health capture. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSkillSections } from './skill-fixture';
import type { SkillTestResult } from './session-runner';
import type { EvalTestEntry } from './eval-store';

export const HEALTH_EVAL_ID = 'health-reporting';
export const HEALTH_EVAL_SECTIONS = [
  'Step 1: Detect Health Stack',
  'Step 2: Run Tools',
  'Step 3: Score Each Category',
  'Step 4: Present Dashboard',
  'Step 5: Persist to Health History',
  'Step 6: Trend Analysis + Recommendations',
  'Important Rules',
];

const PRIOR_HISTORY = JSON.stringify({
  ts: '2026-01-01T00:00:00Z', branch: 'unknown', score: 10,
  typecheck: null, lint: null, test: 10, deadcode: null, shell: null,
  gbrain: null, duration_s: 1,
}) + '\n';

export interface HealthEvalFixture {
  dir: string;
  gstackHome: string;
  receipts: string;
  prompt: string;
  projectFiles: Record<string, string>;
}

function projectSnapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) { files[name + '/'] = '<directory>'; walk(name); }
      else files[name] = entry.isSymbolicLink() ? `<symlink:${fs.readlinkSync(path.join(dir, name))}>` : fs.readFileSync(path.join(dir, name), 'utf-8');
    }
  };
  for (const project of ['partial', 'no-tools']) walk(project);
  return files;
}

export function createHealthEvalFixture(dir: string, repoRoot: string): HealthEvalFixture {
  const gstackHome = path.join(dir, 'gstack-state');
  const receipts = path.join(dir, 'checker-runs.txt');
  // Instrumentation belongs to the fixture, not to the model's shell setup.
  // Single-quote escaping also covers temporary paths containing apostrophes.
  const quotedReceipts = "'" + receipts.replaceAll("'", "'\"'\"'") + "'";
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'bin', 'gstack-slug'), path.join(dir, 'bin', 'gstack-slug'));
  fs.chmodSync(path.join(dir, 'bin', 'gstack-slug'), 0o755);

  // Only redirect installed paths. The workflow and score/history rules come
  // from the real generated skill, without its unrelated shared preamble.
  const skill = extractSkillSections(path.join(repoRoot, 'health'), HEALTH_EVAL_SECTIONS)
    .replaceAll('~/.claude/skills/gstack/bin/gstack-slug', path.join(dir, 'bin', 'gstack-slug'))
    .replaceAll('~/.gstack', gstackHome);
  fs.writeFileSync(path.join(dir, 'health-SKILL.md'), skill);

  for (const project of ['partial', 'no-tools']) {
    const projectDir = path.join(dir, project);
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, '.project.yaml'), `name: ${project}\n`);
    const historyDir = path.join(gstackHome, 'projects', project);
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'health-history.jsonl'), PRIOR_HISTORY);
  }
  fs.writeFileSync(path.join(dir, 'partial', 'CLAUDE.md'), `# Partial project

## Health Stack

- typecheck: bash ./check-typecheck.sh
- test: bash ./check-tests.sh

Only the listed tools are available. Lint, dead-code, shell-lint, and GBrain
tools are not installed. This configuration is final; do not install tools.
`);
  fs.writeFileSync(path.join(dir, 'no-tools', 'CLAUDE.md'), `# No-tools project

## Health Stack

No health tools are configured or installed for any category.
This configuration is final; do not install tools or substitute other checks.
`);
  fs.writeFileSync(path.join(dir, 'partial', 'check-typecheck.sh'), `#!/usr/bin/env bash
printf 'typecheck\\n' >> ${quotedReceipts}
for ((i = 1; i <= 60; i++)); do
  printf 'src/file%s.ts(1,1): error TS2322: Type mismatch.\\n' "$i" >&2
done
for ((i = 1; i <= 80; i++)); do
  printf 'Additional diagnostic context %s\\n' "$i"
done
exit 2
`);
  fs.writeFileSync(path.join(dir, 'partial', 'check-tests.sh'), `#!/usr/bin/env bash
printf 'test\\n' >> ${quotedReceipts}
printf '5 pass\\n0 fail\\n'
`);

  return {
    dir, gstackHome, receipts, projectFiles: projectSnapshot(dir),
    prompt: `Read health-SKILL.md and run its /health workflow, Steps 1–6, for
the partial project first and the no-tools project second. Each has its own
CLAUDE.md with the final Health Stack configuration. Run commands from the
corresponding project directory. These are local fixtures without Git remotes.

Save each complete dashboard, details, trends, and recommendations as
partial-report.md or no-tools-report.md in ${dir}. Keep the dashboard's
COMPOSITE SCORE label. Existing health histories are available under
${gstackHome}/projects/<project>/health-history.jsonl; apply the skill's normal
history rules. GSTACK_HOME already points at this isolated state directory.

Do not modify project files, install tools, or ask to change either Health Stack.
Only write the reports and any history updates required by the supplied skill.
Finish after producing both reports.`,
  };
}

/** Validate behavior, allowing ordinary Markdown/wording variation in reports. */
export function healthReportingFailures(fixture: HealthEvalFixture): string[] {
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const plain = (text: string) => text.replace(/[*_`]/g, '');
  const partial = plain(read(path.join(fixture.dir, 'partial-report.md')));
  const empty = plain(read(path.join(fixture.dir, 'no-tools-report.md')));
  const composite = (report: string) => report.match(/composite\s+score\s*[:|]?\s*(N\/A|\d+(?:\.\d+)?)/i)?.[1];
  check(composite(partial) === '5.6', 'partial coverage must score 5.6, preserving the failing typecheck');
  check(/partial\s+coverage/i.test(partial), 'numeric score must be labeled as partial coverage');
  const typecheckRows = partial.split('\n').filter(line => /\btype\s*check\b/i.test(line));
  check(typecheckRows.some(line => /(?:\b0\s*\/\s*10\b|\|\s*0\s*\|)/.test(line)
    && /\b(?:critical|fail(?:ed|ure)?|error)\b/i.test(line) && !/\bclean\b/i.test(line)),
  'dashboard must report the failing typecheck as 0/10, not clean');
  check(/\b60\s+(?:\w+\s+){0,2}(?:errors|diagnostics|findings)\b/i.test(partial)
    || /(?:errors|diagnostics|findings)[^\n]{0,20}\b60\b/i.test(partial),
  'report must count all 60 errors before the final 50 output lines');
  check(/(?:coverage|checked|executed)/i.test(partial), 'partial report must disclose checked coverage');
  check(/type\s*check/i.test(partial) && /tests?/i.test(partial), 'checked category names must be visible');
  for (const category of ['lint', 'dead[ -]?code', 'shell(?:[ -]?lint)?', 'gbrain']) {
    const unavailable = '(?:unavailable|skipped|not (?:installed|configured|available|found))';
    check(new RegExp(`${unavailable}[\\s\\S]{0,240}${category}|${category}[^\\n]{0,120}${unavailable}`, 'i').test(partial),
      `partial report must name unavailable ${category}`);
  }
  check(/(?:coverage|categor(?:y|ies)|checks)[\s\S]{0,160}(?:chang|differ|not compar)/i.test(partial)
    || /(?:chang|differ|not compar)[\s\S]{0,160}(?:coverage|categor(?:y|ies)|checks)/i.test(partial),
  'partial report must flag changed coverage instead of comparing unlike histories');
  check(!/[+-]\s*4\.4\b|trend\s*:\s*(?:improving|regressing|worsening)/i.test(partial),
    'partial report must not calculate a trend delta against different coverage');
  check(composite(empty)?.toUpperCase() === 'N/A', 'no-tools composite must be N/A');
  check(/(?:no|zero|0)\s+(?:health\s+)?checks?\s+(?:ran|run|executed|available)|no\s+tools/i.test(empty),
    'no-tools report must explain that no checks ran');

  const history = read(path.join(fixture.gstackHome, 'projects', 'partial', 'health-history.jsonl'));
  check(history.startsWith(PRIOR_HISTORY), 'partial run must preserve its prior history row');
  const rows = history.trim().split('\n').filter(Boolean);
  check(rows.length === 2, 'partial run must append exactly one history row');
  try {
    const row = JSON.parse(rows.at(-1) || '{}');
    check(row.score === 5.6 && row.typecheck === 0 && row.test === 10,
      'persisted partial scores must reflect all diagnostics and the actual exit status');
    check(['lint', 'deadcode', 'shell', 'gbrain'].every(category => row[category] === null),
      'unavailable categories must persist as null');
  } catch {
    failures.push('partial history must remain valid JSONL');
  }
  check(read(path.join(fixture.gstackHome, 'projects', 'no-tools', 'health-history.jsonl')) === PRIOR_HISTORY,
    'no-tools run must leave its history unchanged');
  const runs = read(fixture.receipts).trim().split('\n');
  check(runs.includes('typecheck') && runs.includes('test'), 'both configured checkers must actually run');
  check(JSON.stringify(projectSnapshot(fixture.dir)) === JSON.stringify(fixture.projectFiles),
    'health must leave project files unchanged');
  return failures;
}

/** One attempt records once, after all assertions; throws remain failures. */
export async function recordHealthAttempt(
  record: (entry: EvalTestEntry) => void,
  capture: () => Promise<SkillTestResult>,
  verify: (result: SkillTestResult) => void,
): Promise<void> {
  const started = Date.now();
  let result: SkillTestResult | undefined;
  let passed = false;
  let failure: unknown;
  try {
    result = await capture();
    if (result.exitReason !== 'success') throw new Error(`health capture ended: ${result.exitReason}`);
    verify(result);
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    record({
      name: HEALTH_EVAL_ID, suite: 'health', tier: 'e2e', passed,
      duration_ms: result?.duration ?? Date.now() - started,
      cost_usd: result?.costEstimate.estimatedCost ?? 0,
      turns_used: result?.costEstimate.turnsUsed,
      tokens_used: result?.costEstimate.estimatedTokens,
      transcript: result?.transcript,
      output: [result?.output, failure === undefined ? '' : String(failure)].filter(Boolean).join('\n').slice(-4000),
      exit_reason: result?.exitReason === 'success' && !passed ? 'assertion_failed' : result?.exitReason ?? 'runner_error',
      model: result?.model,
    });
  }
}
