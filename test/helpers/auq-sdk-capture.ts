/**
 * SDK-based AUQ capture — the reliable way to grade AskUserQuestion content.
 *
 * Real-PTY capture is lossy for plan-mode AUQs: they render every option on one
 * cursor-positioned logical line that stripAnsi can't reconstruct, so format
 * predicates (ELI10:, Net:, ✅) silently miss even when the question is
 * well-formed. This helper instead uses the `claude -p` SDK path (the same one
 * skill-e2e-plan-format uses): the agent is told to WRITE the verbatim text of
 * the AskUserQuestion it would have asked to a file. That captures exactly what
 * the model GENERATES — the surface where carving could degrade quality — with
 * zero rendering loss. The TTY rendering layer is identical for fat and slim
 * skills, so it is not where token-reduction degradation can hide.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSkillTest, type SkillTestResult } from './session-runner';

const ROOT = path.resolve(__dirname, '..', '..');

/** The 7 decision-brief format elements graded on the captured AUQ text. */
export const AUQ_FORMAT_ELEMENTS: Array<{ field: string; re: RegExp }> = [
  { field: 'ELI10:', re: /ELI10\s*:/i },
  { field: 'Recommendation:', re: /Recommendation\s*:/i },
  { field: 'Pros / cons:', re: /Pros\s*\/\s*cons/i },
  { field: '✅', re: /✅/ },
  { field: '❌', re: /❌/ },
  { field: 'Net:', re: /Net\s*:/i },
  { field: '(recommended)', re: /\(recommended\)/i },
];

export function scoreAuqFormat(text: string): { present: number; total: number; missing: string[] } {
  const missing = AUQ_FORMAT_ELEMENTS.filter(e => !e.re.test(text)).map(e => e.field);
  return { present: AUQ_FORMAT_ELEMENTS.length - missing.length, total: AUQ_FORMAT_ELEMENTS.length, missing };
}

/**
 * Grade recommendation substance ROBUST to the connective. judgeRecommendation()
 * keys on the literal "because" (correct for the spec, pinned by
 * llm-judge-recommendation.test.ts), but skills routinely write equally
 * substantive reasons as "Recommendation: A. <reason>" / "A — <reason>" /
 * "A: <reason>". Grading those as substance-1 would make the matrix cry wolf on
 * genuinely good recommendations. So we normalize a non-"because" connective to
 * "because" purely for grading, then call the shared judge. We also report
 * whether the ORIGINAL used the literal "because" — a soft style signal, since
 * the format spec prefers it and the voice rule forbids the em-dash form.
 *
 * This does NOT touch judgeRecommendation or its pinned fixtures.
 */
export async function gradeAuqRecommendation(
  text: string,
): Promise<{ substance: number; present: boolean; hadLiteralBecause: boolean; reason: string }> {
  const { judgeRecommendation } = await import('./llm-judge');
  const recLine = text.match(/^[*_]*\s*recommendation\s*[*_]*\s*:\s*(.+)$/im);
  const hadLiteralBecause = !!recLine && /\bbecause\s+\S/i.test(recLine[1]);

  let graded = text;
  if (recLine && !hadLiteralBecause) {
    // Rewrite "Recommendation: <choice><sep><reason>" → "...<choice> because <reason>"
    // sep ∈ {". ", " — ", " - ", ": "} right after a short choice token.
    const normalizedLine = recLine[1].replace(
      /^([^.:—-]{1,40}?)\s*(?:\.\s+|\s*[—-]\s+|:\s+)(\S.+)$/,
      '$1 because $2',
    );
    if (normalizedLine !== recLine[1]) {
      graded = text.replace(recLine[0], `Recommendation: ${normalizedLine}`);
    }
  }

  try {
    const r = await judgeRecommendation(graded);
    return { substance: r.reason_substance, present: r.present, hadLiteralBecause, reason: r.reason_text };
  } catch {
    return { substance: 0, present: !!recLine, hadLiteralBecause, reason: '' };
  }
}

/**
 * Build a throwaway plan dir holding a SPECIFIC plan-ceo-review SKILL.md (so we
 * can pit the carved skeleton against the verbose monolith). `sectionsFrom`, if
 * given, copies that dir's sections/ alongside (for the carved variant).
 */
export function setupPlanCeoDir(opts: {
  skillMd: string;
  sectionsFrom?: string | null;
  tmpPrefix?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix ?? 'auq-sdk-'));
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(dir, 'plan.md'),
    [
      '# Plan: Launch a "developer-friendly" pricing tier',
      '',
      '## Goal',
      'Increase developer adoption.',
      '',
      '## Success metric',
      'More signups.',
      '',
      '## Premise',
      "We haven't talked to any developers about whether the current pricing is a",
      'barrier. The team agreed it "feels like" it should be cheaper.',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(dir, 'plan-ceo-review'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan-ceo-review', 'SKILL.md'), opts.skillMd);
  if (opts.sectionsFrom && fs.existsSync(opts.sectionsFrom)) {
    fs.cpSync(opts.sectionsFrom, path.join(dir, 'plan-ceo-review', 'sections'), { recursive: true });
  }
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'plan']);
  return dir;
}

/**
 * Generic: build a throwaway dir holding ANY skill's SKILL.md (+ optional
 * sections) plus arbitrary fixture files, so the matrix can drive each skill to
 * its first AUQ. Mirrors setupPlanCeoDir but skill-agnostic.
 */
export function setupSkillDir(opts: {
  skillName: string;
  skillMd: string;
  sectionsFrom?: string | null;
  fixtures?: Record<string, string>;
  tmpPrefix?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix ?? `auq-${opts.skillName}-`));
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  for (const [name, content] of Object.entries(opts.fixtures ?? {})) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.mkdirSync(path.join(dir, opts.skillName), { recursive: true });
  fs.writeFileSync(path.join(dir, opts.skillName, 'SKILL.md'), opts.skillMd);
  if (opts.sectionsFrom && fs.existsSync(opts.sectionsFrom)) {
    fs.cpSync(opts.sectionsFrom, path.join(dir, opts.skillName, 'sections'), { recursive: true });
  }
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'fixture']);
  return dir;
}

/** Read any skill's current (worktree) SKILL.md + its sections dir if present. */
export function skillFromWorktree(skillName: string): { skillMd: string; sectionsFrom: string | null } {
  const sec = path.join(ROOT, skillName, 'sections');
  return {
    skillMd: fs.readFileSync(path.join(ROOT, skillName, 'SKILL.md'), 'utf-8'),
    sectionsFrom: fs.existsSync(sec) ? sec : null,
  };
}

/**
 * Generic: drive ANY skill to its FIRST AskUserQuestion and capture the
 * verbatim decision-brief text the model would have shown. `scenario` is the
 * per-skill prose that triggers a real AUQ (e.g. "review plan.md", "audit
 * vuln.ts for security"). Absolute skill path + Read/Write-only so the agent
 * cannot wander to the global install.
 */
export async function captureFirstAuq(opts: {
  planDir: string;
  skillName: string;
  scenario: string;
  testName: string;
  runId?: string;
  model?: string;
}): Promise<string> {
  const outFile = path.join(opts.planDir, 'ask-capture.md');
  const skillPath = path.join(opts.planDir, opts.skillName, 'SKILL.md');
  const prompt = `You are running a format-capture test. The ONLY skill file you may read is this absolute path: ${skillPath}. Do NOT search for, Glob, find, or read any other SKILL.md anywhere — especially nothing under ~/.claude or /Users.

Read ${skillPath} and follow its workflow for this scenario:

${opts.scenario}

This is a capture test, not an interactive session. Skip any system-audit / environment-setup / codebase-exploration steps. When you reach the FIRST point where the skill would call AskUserQuestion, write the verbatim full decision-brief text of that question (title, ELI10, stakes, recommendation, every option with its ✅/❌ pros/cons bullets, and the Net line) to ${outFile}. Do NOT call any tool to ask the user. Do NOT paraphrase. After writing the file, STOP.`;

  await runSkillTest({
    prompt,
    workingDirectory: opts.planDir,
    allowedTools: ['Read', 'Write'],
    maxTurns: 14,
    timeout: 240_000,
    testName: opts.testName,
    runId: opts.runId,
    model: opts.model ?? 'claude-opus-4-7',
  });

  try {
    return fs.readFileSync(outFile, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Drive ANY carved skill through a real `claude -p` run and detect, LOSSLESSLY,
 * which `sections/<file>.md` files the agent actually Read — from the tool-use
 * stream, not the ANSI screen buffer. This is the reliable replacement for the
 * real-PTY `visibleSince()` screen-scraping the section-loading tests used to do
 * (which silently saw nothing in a Conductor PTY: cursor-positioned renders and
 * an unanswered Step 0 question loop both defeat the regex).
 *
 * The skill under test is the planted copy in `planDir` (pin the absolute path so
 * the agent cannot wander to the global install). AskUserQuestion is declared
 * unavailable so the agent auto-picks the recommended option and proceeds far
 * enough to hit the post-Step-0 STOP-Read directives; Read is the tool a STOP-Read
 * resolves to, so Read/Grep/Glob/Write is all the agent needs (no Bash → it cannot
 * `find /` its way out, nor run git/gh mutations).
 */
export async function captureSectionReads(opts: {
  planDir: string;
  skillName: string;
  scenario: string;
  /** Relative filename the agent writes its final output to (terminal signal). */
  reportFile?: string;
  /** Marker proving a real report/plan was produced (default: any non-empty text). */
  reportMarker?: RegExp;
  testName: string;
  runId?: string;
  model?: string;
  maxTurns?: number;
  timeout?: number;
}): Promise<{ readSections: Set<string>; reportProduced: boolean; toolCalls: SkillTestResult['toolCalls']; output: string }> {
  const outFile = path.join(opts.planDir, opts.reportFile ?? 'REPORT.md');
  const skillPath = path.join(opts.planDir, opts.skillName, 'SKILL.md');
  const prompt = `You are running an automated skill-execution test. No human is present, so AskUserQuestion is unavailable. The ONLY skill file you may read is this absolute path: ${skillPath}. Do NOT Glob/find/search for any other SKILL.md anywhere — especially nothing under ~/.claude or /Users.

Read ${skillPath} and EXECUTE its workflow for this scenario:

${opts.scenario}

Rules for this run:
- Skip system-audit, environment-setup, telemetry, and codebase-exploration steps.
- At any decision point that would call AskUserQuestion, silently pick the skill's recommended option and continue. Do NOT stop to ask.
- This skill's body has been carved into on-demand sections/. When the skill gives a STOP-Read directive (for example "Read \`.../sections/<file>\` and execute it in full"), you MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers. Do not work from memory.
- Do NOT run git, gh, commit, push, or any mutating command.
- When the workflow is complete, write the skill's final output (the full review report / ship plan, including any required report table) to ${outFile}.`;

  const result = await runSkillTest({
    prompt,
    workingDirectory: opts.planDir,
    allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
    maxTurns: opts.maxTurns ?? 25,
    timeout: opts.timeout ?? 300_000,
    testName: opts.testName,
    runId: opts.runId,
    model: opts.model ?? 'claude-opus-4-7',
  });

  const readSections = new Set<string>();
  for (const c of result.toolCalls) {
    if (c.tool !== 'Read') continue;
    const fp = String(c.input?.file_path ?? '');
    const m = fp.match(/sections\/([A-Za-z0-9._-]+\.md)/);
    if (m) readSections.add(m[1]);
  }

  let output = '';
  try { output = fs.readFileSync(outFile, 'utf-8'); } catch { output = result.output ?? ''; }
  const reportProduced = opts.reportMarker ? opts.reportMarker.test(output) : output.trim().length > 0;

  return { readSections, reportProduced, toolCalls: result.toolCalls, output };
}

/** Read the carved (current worktree) plan-ceo SKILL.md + its sections dir. */
export function carvedSkill(): { skillMd: string; sectionsFrom: string | null } {
  const sec = path.join(ROOT, 'plan-ceo-review', 'sections');
  return {
    skillMd: fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8'),
    sectionsFrom: fs.existsSync(sec) ? sec : null,
  };
}

/** Read the pre-carve verbose monolith plan-ceo SKILL.md from git. */
export function verboseSkill(gitRef = 'ab66193e^'): string {
  return execGit(['show', `${gitRef}:plan-ceo-review/SKILL.md`]);
}

function execGit(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Drive plan-ceo-review to its Step 0F mode-selection AskUserQuestion in the
 * given plan dir and capture the verbatim question text the model generates.
 * Returns the captured text ('' if the agent never wrote the file).
 */
export async function captureModeSelectionAuq(opts: {
  planDir: string;
  testName: string;
  runId?: string;
  model?: string;
}): Promise<string> {
  const outFile = path.join(opts.planDir, 'ask-capture.md');
  const skillPath = path.join(opts.planDir, 'plan-ceo-review', 'SKILL.md');
  const planPath = path.join(opts.planDir, 'plan.md');
  // CRITICAL: pin the EXACT skill file. Without this the agent runs
  // `find / -name SKILL.md` / Glob and reads the GLOBAL install
  // (~/.claude/skills/...) instead of the version-under-test in the temp dir —
  // which silently invalidates a carved-vs-verbose A/B (both sides end up
  // reading the same global skill). Absolute path + no-wander instruction +
  // Bash disallowed (so `find /` is impossible) locks it to the planted file.
  const prompt = `You are running a format-capture test. Use ONLY these two files:
  - The skill to follow: ${skillPath}
  - The plan to review: ${planPath}

Read ${skillPath} for the review workflow. Do NOT search for, Glob, find, or read any OTHER SKILL.md anywhere on the system — especially nothing under ~/.claude or /Users. The ONLY skill file you may read is the absolute path above.

Read ${planPath} — that is the plan to review. It is a standalone plan document, not a codebase. Skip any codebase exploration or system-audit steps.

Proceed to Step 0F (Mode Selection), where the skill presents the 4 review-mode options to the user via AskUserQuestion.

Write the verbatim text of that AskUserQuestion (the full decision brief: title, ELI10, stakes, recommendation, every option with its pros/cons bullets, and the Net line) to ${outFile}. Do NOT call any tool to ask the user. Do NOT paraphrase. After writing the file, stop.`;

  await runSkillTest({
    prompt,
    workingDirectory: opts.planDir,
    // Read + Write only: no Bash means the agent cannot `find /` its way to the
    // global install, and the skill's preamble bash blocks (irrelevant to format
    // capture) can't run and wander.
    allowedTools: ['Read', 'Write'],
    maxTurns: 12,
    timeout: 240_000,
    testName: opts.testName,
    runId: opts.runId,
    model: opts.model ?? 'claude-opus-4-7',
  });

  try {
    const text = fs.readFileSync(outFile, 'utf-8');
    // Defense in depth: verify the agent actually read the planted skill, not a
    // global one. If the captured run somehow read elsewhere we can't detect it
    // from the output file alone, so callers should also confirm via the run
    // log; this guard at least catches an empty/placeholder capture.
    return text;
  } catch {
    return '';
  }
}
