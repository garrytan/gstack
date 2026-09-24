/**
 * Shared AUQ grading and fixture helpers. First-question matrix captures use
 * exact public native tool fields bound to a displayed question. CEO mode
 * selection captures the native permission callback; section loading completes
 * its existing noninteractive workflow.
 */
import { resolveEvalModel } from '../../lib/eval-model';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSkillTest, type SkillTestResult } from './session-runner';
import { captureNativeFirstAuq, serializeNativeAuq } from './auq-native-capture';
import { runAgentSdkTest, resolveClaudeBinary } from './agent-sdk-runner';
import { buildSeedConfig, isHermeticEnabled } from './hermetic-env';
import { getProjectEvalDir } from './eval-store';
import type { NativePlanQuestion } from './plan-count-transcript';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Existing long section-loader work budget (v1.71): complete workflows can
 * load their sections quickly, then need 300–450s to generate the full report.
 * Keep 120s of the CAPTURE_LONG_MS outer budget for setup and reporting.
 * Ordinary captureSectionReads callers retain the 300s default below.
 */
export const LONG_SECTION_CAPTURE_MS = 480_000;

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
 * Drive any planted skill to its first displayed native AskUserQuestion.
 * Capture one question's exact public fields, without answering it or claiming
 * workflow completion. Missing format stays missing; refusals stay failures.
 */
export async function captureFirstAuq(opts: {
  planDir: string;
  skillName: string;
  scenario: string;
  testName: string;
  runId?: string;
  model?: string;
}): Promise<string> {
  return (await captureNativeFirstAuq(opts)).text;
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
 * resolves to, so Read/Grep/Glob/Write/Edit cover local artifacts (no Bash → it cannot
 * `find /` its way out, nor run git/gh mutations).
 */
export function hasDisabledOutsideReview(output: string): boolean {
  const headings = [...output.matchAll(/^## GSTACK REVIEW REPORT[ \t]*\r?$/gm)];
  const heading = headings.at(-1);
  if (!heading) return false;
  const section = output.slice(heading.index! + heading[0].length).split(/^##[ \t]+/m, 1)[0];
  const plain = (cell: string) => cell.replace(/[*_`]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map(plain);
    if (cells[1] === 'outside review') {
      return /^disabled(?:$|\s|[(:—–-])/.test(cells[5] ?? '');
    }
  }
  return false;
}

export async function captureSectionReads(opts: {
  planDir: string;
  skillName: string;
  /** Fixture-authorized local artifact commands. */
  artifactCommands?: string;
  scenario: string;
  /** The fixture actor's decision authority; defaults to recommended choices. */
  decisionPolicy?: string;
  /** Relative filename the agent writes its final output to (terminal signal). */
  reportFile?: string;
  /** Marker proving a real report/plan was produced (default: any non-empty text). */
  reportMarker?: RegExp;
  testName: string;
  runId?: string;
  model?: string;
  maxTurns?: number;
  timeout?: number;
  /** Measure native section loading with the documented extra-review opt-out. */
  nativeReviewOnly?: boolean;
}): Promise<{ readSections: Set<string>; reportProduced: boolean; reportWritten: boolean;
  exitReason: SkillTestResult['exitReason']; toolCalls: SkillTestResult['toolCalls'];
  transcript: SkillTestResult['transcript']; output: string }> {
  const outFile = path.join(opts.planDir, opts.reportFile ?? 'REPORT.md');
  const timeout = opts.timeout ?? 300_000;
  const fullPlanReview = opts.skillName === 'plan-ceo-review' || opts.skillName === 'plan-eng-review';
  // The Eng actor may run local review writers. Reject foreign destinations
  // before creating its state or starting a child, including symlink escapes.
  // Tool approval is not a filesystem sandbox; this checks fixture ownership.
  if (opts.skillName === 'plan-eng-review' && opts.nativeReviewOnly && opts.artifactCommands) {
    if (fs.lstatSync(opts.planDir).isSymbolicLink()) throw new Error('Eng section fixture root must not be a symlink');
    const owner = fs.realpathSync(opts.planDir);
    const isInside = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (path.resolve(outFile) === path.resolve(opts.planDir) || !isInside(path.resolve(opts.planDir), path.resolve(outFile))) {
      throw new Error('Eng section report must stay inside its fixture root');
    }
    let existing = path.resolve(outFile);
    for (;;) {
      try { fs.lstatSync(existing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existing = path.dirname(existing);
      }
    }
    if (!isInside(owner, fs.realpathSync(existing))) throw new Error('Eng section report must stay inside its fixture root');
  }
  const readReport = (): Buffer | undefined => {
    try { return fs.readFileSync(outFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  };
  const beforeReport = readReport();
  const skillPath = path.join(opts.planDir, opts.skillName, 'SKILL.md');
  // Outside-review dispatch has separate behavioral coverage. Native-only
  // captures use the real supported control in state owned by this call;
  // never mutate the operator's or another capture's gstack configuration.
  // Keep the model-facing config path relative to the fixture's working directory.
  const stateDir = opts.nativeReviewOnly
    ? fs.mkdtempSync(path.join(path.resolve(opts.planDir), '.gstack-section-state-')) : null;
  const nativeReviewRule = stateDir
    ? `\n- Read ${path.relative(path.resolve(opts.planDir), path.join(stateDir, 'config.yaml'))}, the isolated gstack configuration for this capture. It sets codex_reviews: disabled. Follow that documented control: skip the entire extra outside-review step, including its native fallback, and report outside coverage as disabled. Complete all native review sections and the full required report.`
    : '';
  // The actor needs the same execution window as the runner to allocate work.
  // Pacing does not change the review's required content or completion gates.
  const planReviewWritingRule = fullPlanReview
    ? `\n- Native execution window: ${timeout / 1000} seconds. Use the system notice's runner-bound deadline and the observed clock to reserve the final ${timeout / 4000} seconds for assembling and verifying completion outputs. Bash may additionally run exactly \`date -u +%Y-%m-%dT%H:%M:%SZ\` for a read-only clock check, including when other Bash commands are restricted. Every required section, finding, approval and output still has to be completed; this is pacing guidance, not permission to skip work.
1. Read the required skill and source material, then resolve Step 0 under the supplied author policy. ${opts.skillName === 'plan-eng-review' ? 'When Scope Challenge finishes, save its outcome. Check the Write/Edit result and Read the saved outcome before advancing.' : 'Follow each workflow save/readback checkpoint as it occurs; do not defer all persistence to one final Write.'} Preserve original requirements and accepted plan amendments throughout.
2. Whenever Step 0 or a section needs an independent choice, give it one ID and one authoritative decision record; findings may reference several choice IDs. Before auto-selecting, save its full currentDecision question/header, every labeled option and full description, commitment comparison and source citations. Read back and verify those fields against the drafted decision and cited source; fix mismatches first. Then record the authorized auto-decision and exact scope, apply answers and amendments with scoped Edit operations, and Read back before taking another row. Keep the complete question and every option before selecting, as the skill requires.
3. Work through ${opts.skillName === 'plan-ceo-review' ? 'all 11 sections, giving each an explicit outcome (including no issues or justified skips)' : 'all four review sections, including an explicit "No issues found" when applicable'}. ${opts.skillName === 'plan-eng-review' ? 'After each completed review section, save its complete findings and disposition with concrete evidence, the selected remedy, residual risks, and verification. Check the Write/Edit result and Read the saved outcome before advancing to the next section; these checkpoints also apply when no new choice needs approval.' : 'As sections finish, add each finding once with concrete evidence, the selected remedy, residual risks, and verification.'} Use compact outcomes, short option bullets and table cells. Execute checklists without copying their questions or narrating every check. Cross-reference saved IDs instead of repeating findings, option deliberations, diagrams or registries; do not regenerate unchanged records or repeat their briefs in the final report. Do not write full implementation or test code unless needed to specify an accepted change.
4. Use the completion reserve to assemble ${opts.skillName === 'plan-ceo-review' ? 'the complete required registries, applicable diagrams, tasks, completion summary, and exact GSTACK REVIEW REPORT table' : 'the required diagrams, test-plan artifact, tasks, TODOS dispositions, completion summary and GSTACK REVIEW REPORT'}. Preserve every finding and original requirement, required decision fields and comparisons, exact approvals and verification; every diagram must retain its specified format. Read back the assembled plan and verify the full required outputs. Finish missing required outputs with scoped Edits, without rewriting unchanged records, then perform the skill's full final Read-back gate. Complete every required artifact and verification before returning.`
    : '';
  const prompt = `You are running an automated skill-execution test. No human is present, so AskUserQuestion is unavailable. The ONLY skill file you may read is this absolute path: ${skillPath}. Do NOT Glob/find/search for any other SKILL.md anywhere — especially nothing under ~/.claude or /Users.

Read ${skillPath} and EXECUTE its workflow for this scenario:

${opts.scenario}

Rules for this run:
- Skip system-audit, environment-setup, telemetry, and unrelated codebase exploration. Read the supplied plan's referenced fixture files when its review requires them.
${opts.decisionPolicy ?? "- At any decision point that would call AskUserQuestion, silently pick the skill's recommended option and continue. Do NOT stop to ask."}
- This skill's body has been carved into on-demand sections/. When the skill gives a STOP-Read directive (for example "Read \`.../sections/<file>\` and execute it in full"), you MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers. Do not work from memory.
- Resolve installed-root paths for section and companion Markdown files under ${opts.planDir}, where this fixture's skill package is copied.
- Do NOT run git, gh, commit, push, or any mutating command${opts.artifactCommands ? ' except the local artifact commands explicitly authorized below' : ''}.${opts.artifactCommands ? `\n- ${opts.artifactCommands}` : ''}
${fullPlanReview ? `- Save the evolving plan and review outputs to ${outFile} with Write/Edit at the workflow checkpoints below.` : `- When the workflow is complete, write the skill's final output (the full review report / ship plan, including any required report table) to ${outFile}.`}${nativeReviewRule}${planReviewWritingRule}
- After all required writes are complete, return a brief completion message and STOP. Do not reproduce the full report in the final response.`;

  let result: SkillTestResult;
  try {
    if (stateDir) fs.writeFileSync(path.join(stateDir, 'config.yaml'), 'codex_reviews: disabled\n');
    result = await runSkillTest({
      prompt,
      workingDirectory: opts.planDir,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', ...(opts.nativeReviewOnly ? [] : ['Agent']), ...(opts.artifactCommands || fullPlanReview ? ['Bash'] : [])],
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', ...(opts.nativeReviewOnly ? [] : ['Agent']), ...(opts.artifactCommands || fullPlanReview ? ['Bash'] : [])],
      publicStreamDiagnostics: true,
      ...(fullPlanReview ? { completionReserveMs: timeout / 4 } : {}),
      maxTurns: opts.maxTurns ?? 25,
      timeout,
      testName: opts.testName,
      runId: opts.runId,
      model: resolveEvalModel('capture', opts.model),
      ...(stateDir ? { env: { GSTACK_HOME: stateDir, GSTACK_STATE_ROOT: stateDir } } : {}),
    });
  } finally {
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  }

  const readSections = new Set<string>();
  for (const c of result.toolCalls) {
    if (c.tool !== 'Read') continue;
    const fp = String(c.input?.file_path ?? '');
    const m = fp.match(/(?:^|[\\/])sections[\\/]([A-Za-z0-9._-]+\.md)(?=$|[?#])/);
    if (m) readSections.add(m[1]);
  }

  const afterReport = readReport();
  const reportWritten = afterReport !== undefined
    && (beforeReport === undefined || !afterReport.equals(beforeReport));
  // An unchanged seed (including a same-byte rewrite) is not this attempt's report.
  const output = reportWritten ? afterReport!.toString('utf-8') : result.output ?? '';
  const reportProduced = result.exitReason === 'success'
    && (opts.reportMarker ? opts.reportMarker.test(output) : output.trim().length > 0);

  // Keep successful terminal-output captures, but a draft left by a failed run
  // must never satisfy callers that use reportProduced as their completion gate.
  return { readSections, reportProduced, reportWritten, exitReason: result.exitReason, toolCalls: result.toolCalls, transcript: result.transcript, output };
}

/** A completed CEO review needs its artifact and every summary outcome. */
export function validateCeoReviewCompletion(capture: {
  exitReason: string;
  reportWritten: boolean;
  output: string;
}): void {
  if (capture.exitReason !== 'success') {
    throw new Error(`CEO review execution failed: ${capture.exitReason}`);
  }
  if (!capture.reportWritten) throw new Error('CEO review did not write REPORT.md');
  const lines = capture.output.split(/\r?\n/);
  const summaryStart = lines.findIndex(line =>
    /^(?:#{1,6}\s+(?:\d+[.)]\s+)?)?(?:\|\s*)?(?:MEGA PLAN REVIEW\s*[—–-]\s*)?COMPLETION SUMMARY(?:\s*\|)?$/i
      .test(line.trim().replace(/\*\*/g, '')),
  );
  if (summaryStart === -1) throw new Error('CEO report is missing its Completion Summary');
  const summaryLines = lines.slice(summaryStart + 1);
  const nextHeading = summaryLines.findIndex(line => /^#{1,6}\s+\S/.test(line));
  const summary = nextHeading === -1 ? summaryLines : summaryLines.slice(0, nextHeading);
  const outcomes = new Map<number, string>();
  for (const line of summary) {
    const row = line.replace(/\*\*/g, '').match(/^\s*\|\s*Section\s+(\d{1,2})\b[^|]*\|\s*(.*?)\s*\|\s*$/i);
    if (row) outcomes.set(Number(row[1]), row[2].replace(/\*\*/g, '').trim());
  }
  for (let section = 1; section <= 11; section++) {
    const outcome = outcomes.get(section) ?? '';
    const placeholder = !outcome || /___/.test(outcome)
      || /^(?:TBD|TODO|pending|not reviewed|done|complete(?:d)?|reviewed|[-—]+)[.!]?$/i.test(outcome);
    const skipped = /^(?:skip(?:ped)?|N\/A|not applicable)\b/i.test(outcome);
    const noUi = section === 11 && /\bno UI\b/i.test(outcome);
    if (placeholder || (skipped && !noUi)) {
      throw new Error(`CEO Completion Summary is missing a completed Section ${section} outcome`);
    }
  }
}

/** Read the carved (current worktree) plan-ceo SKILL.md + its sections dir. */
export function carvedSkill(): { skillMd: string; sectionsFrom: string | null } {
  const sec = path.join(ROOT, 'plan-ceo-review', 'sections');
  return {
    skillMd: fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8'),
    sectionsFrom: fs.existsSync(sec) ? sec : null,
  };
}

/** Read the pre-carve verbose monolith plan-ceo SKILL.md.
 *  VENDORED fixture (v1.75 precedent), not a git ref: the old default
 *  `git show ab66193e^:...` pinned a BRANCH-LOCAL commit — it dies the day
 *  that branch is pruned and already fails on shallow clones. The fixture
 *  is the frozen pre-cut render; test/git-ref-fixture-tripwire.test.ts
 *  keeps this class from coming back. */
export function verboseSkill(): string {
  return fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'auq-pre-cut-plan-ceo-review-SKILL.md'),
    'utf-8',
  );
}

function execGit(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Capture the real mode-selection tool input, without answering the question.
 * Print mode retains the existing 12-turn cap; interactive CLI max-turns is
 * print-only. Deliberate callback cancellation is not workflow completion.
 */
export async function captureModeSelectionAuq(opts: {
  planDir: string;
  testName: string;
  runId?: string;
  model?: string;
  caseDeadline?: number;
}): Promise<string> {
  const startedAt = Date.now();
  let deadline = opts.caseDeadline ?? startedAt + 240_000;
  const cwd = path.resolve(opts.planDir);
  const skillPath = path.join(cwd, 'plan-ceo-review', 'SKILL.md');
  const planPath = path.join(cwd, 'plan.md');
  // CRITICAL: pin the EXACT skill file. Without this the agent runs
  // `find / -name SKILL.md` / Glob and reads the GLOBAL install
  // (~/.claude/skills/...) instead of the version-under-test in the temp dir —
  // which silently invalidates a carved-vs-verbose A/B (both sides end up
  // reading the same global skill). Absolute path + no-wander instruction +
  // Bash disallowed (so `find /` is impossible) locks it to the planted file.
  const prompt = `Review the plan using ONLY these two files:
  - The skill to follow: ${skillPath}
  - The plan to review: ${planPath}

Read ${skillPath} for the review workflow. Do NOT search for, Glob, find, or read any OTHER SKILL.md anywhere on the system — especially nothing under ~/.claude or /Users. The ONLY skill file you may read is the absolute path above.

Read ${planPath} — that is the plan to review. It is a standalone plan document, not a codebase. Skip any codebase exploration or system-audit steps.

Proceed to Mode Selection, where the skill presents the 4 review-mode options to the user via AskUserQuestion.

Ask the user through the AskUserQuestion tool and wait for their answer.`;
  const controller = new AbortController();
  const capturedStop = new Error('Native mode question captured without an answer');
  const timeout = new Error(`${opts.testName}: AUQ capture failed (timeout)`);
  const model = resolveEvalModel('capture', opts.model);
  let ownedRoot: string | undefined, artifactDir: string | undefined;
  let outcome = 'error', diagnostic: string | undefined, actorFailure: Error | undefined;
  let captured: { toolUseId: string; input: Record<string, unknown>; question: NativePlanQuestion; text: string } | undefined;
  let terminal: { exitReason: string; turnsUsed: number; costUsd: number; sdkClaudeCodeVersion: string; errors?: string[] } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    clearTimeout(timer);
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort(timeout);
    else timer = setTimeout(() => controller.abort(timeout), remaining);
  };
  armDeadline();
  const fail = (reason: string, detail?: string): never => {
    outcome = reason;
    throw new Error(`${opts.testName}: AUQ capture failed (${reason})${detail ? `: ${detail}` : ''}`);
  };
  try {
    if (!isHermeticEnabled()) fail('hermetic_required');
    const binary = resolveClaudeBinary();
    if (!binary) fail('missing_binary');
    ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-mode-auq-'));
    const configDir = path.join(ownedRoot, '.claude'), stateDir = path.join(ownedRoot, 'gstack-home');
    fs.mkdirSync(configDir); fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(buildSeedConfig({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.GSTACK_ANTHROPIC_API_KEY,
      trustedDirs: [cwd],
    })), { mode: 0o600 });
    try {
      const result = await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' }, userPrompt: prompt,
        workingDirectory: cwd, model, maxTurns: 12, maxRetries: 0,
        allowedTools: ['Read', 'Write', 'AskUserQuestion'], permissionMode: 'default', settingSources: [],
        pathToClaudeCodeExecutable: binary, signal: controller.signal,
        onAdmission: opts.caseDeadline === undefined ? undefined : () => {
          deadline = Math.min(opts.caseDeadline!, Date.now() + 240_000);
          armDeadline();
        },
        env: { CLAUDE_CONFIG_DIR: configDir, GSTACK_HOME: stateDir, GSTACK_HEADLESS: '' },
        testName: opts.testName, runId: opts.runId,
        canUseTool: async (name, input, options) => {
          try {
            if (Date.now() >= deadline || controller.signal.reason === timeout) fail('timeout');
            if (name !== 'AskUserQuestion') {
              if (!['Read', 'Write'].includes(name)) fail('unexpected_tool', name);
              return { behavior: 'allow', updatedInput: input };
            }
            if (captured || controller.signal.aborted) fail('duplicate_capture');
            if (!isModeSelectionQuestion(input) || !options.toolUseID) fail('invalid_mode_question');
            // Keep the exact native fields. The serializer adds neutral separators
            // only; it never fills missing format or recommendation text.
            const question = structuredClone(input.questions[0]);
            captured = { toolUseId: options.toolUseID, input: structuredClone(input), question, text: serializeNativeAuq(question) };
            controller.abort(capturedStop);
          } catch (error) {
            actorFailure = error instanceof Error ? error : new Error(String(error));
            controller.abort(actorFailure);
          }
          // No permission answer (including deny) is submitted. The runner's
          // abort closes this owned query, leaving the native tool unanswered.
          return new Promise<never>(() => {});
        },
      });
      // The terminal result can carry a refusal without any assistant text.
      // Inspect only that public result shape, never private content blocks.
      const lastResult = result.events.findLast(event => event.type === 'result');
      const errors = lastResult && 'errors' in lastResult && Array.isArray(lastResult.errors)
        ? lastResult.errors.filter((error): error is string => typeof error === 'string') : undefined;
      terminal = { exitReason: result.exitReason, turnsUsed: result.turnsUsed,
        costUsd: result.costUsd, sdkClaudeCodeVersion: result.sdkClaudeCodeVersion, errors };
      if (actorFailure) throw actorFailure;
      fail(result.exitReason === 'success' ? 'missing_question' : result.exitReason,
        [result.output.trim(), ...(errors ?? [])].filter(Boolean).join('\n').slice(0, 2000));
    } catch (error) {
      if (actorFailure) throw actorFailure;
      if (error !== capturedStop || controller.signal.reason !== capturedStop || !captured) throw error;
      outcome = 'question_captured';
    }
  } catch (error) {
    if (error === timeout) outcome = 'timeout';
    diagnostic = String(error).slice(0, 2000);
    throw error;
  } finally {
    clearTimeout(timer);
    let cleanupError: string | undefined, artifactError: string | undefined;
    try { if (ownedRoot) fs.rmSync(ownedRoot, { recursive: true, force: true }); }
    catch (error) { cleanupError = String(error); }
    if (cleanupError && outcome === 'question_captured') outcome = 'cleanup_error';
    try {
      if (process.env.GSTACK_EVAL_DIR || process.env.EVALS_RUN_ID || opts.runId) {
        const segment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'run';
        const runId = opts.runId || process.env.EVALS_RUN_ID || 'local';
        const root = path.resolve(process.env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'native-auq', segment(runId));
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        artifactDir = fs.mkdtempSync(path.join(root, `${segment(opts.testName)}-`));
        fs.writeFileSync(path.join(artifactDir, 'capture.json'), JSON.stringify({
          ...captured, source: 'can_use_tool', outcome, workflowCompleted: false, answered: false,
          diagnostic, cleanupError, terminal, billing: terminal ? 'terminal_result' : 'unavailable',
          model, cwd, runId, testName: opts.testName, maxTurns: 12, timeoutMs: 240_000,
          elapsedMs: Date.now() - startedAt, at: new Date().toISOString(),
        }, null, 2) + '\n', { mode: 0o600 });
      }
    } catch (error) { artifactError = String(error); }
    console.log(`[AUQ-mode ${opts.testName}] outcome=${outcome} workflowCompleted=false`
      + (artifactDir ? ` artifact=${artifactDir}` : '')
      + (artifactError ? ` artifactError=${artifactError}` : '')
      + (cleanupError ? ` cleanupError=${cleanupError}` : ''));
    if ((outcome === 'question_captured' && artifactError) || outcome === 'cleanup_error')
      throw new Error(`${opts.testName}: AUQ capture failed (${cleanupError ? 'cleanup_error' : 'artifact_error'}): ${cleanupError || artifactError}`);
  }
  return captured!.text;
}

/** Native schema plus the existing four-mode fixture contract, not a grade. */
function isModeSelectionQuestion(input: Record<string, unknown>): input is { questions: [NativePlanQuestion] } {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (Object.keys(input).some(key => !['questions', 'metadata', 'answers', 'annotations'].includes(key)) ||
      !Array.isArray(input.questions) || input.questions.length !== 1) return false;
  // Native input has optional analytics metadata and UI completion fields.
  // Empty completion defaults are harmless; a supplied answer/note is outside
  // this before-answer capture boundary.
  if (['answers', 'annotations'].some(key => input[key] !== undefined &&
      (!object(input[key]) || Object.keys(input[key]).length !== 0))) return false;
  if (input.metadata !== undefined && (!object(input.metadata) || Object.keys(input.metadata).some(key => key !== 'source') ||
      (input.metadata.source !== undefined && typeof input.metadata.source !== 'string'))) return false;
  const q = input.questions[0];
  if (!q || typeof q !== 'object' || Object.keys(q).some(key => !['header', 'question', 'options', 'multiSelect'].includes(key)) ||
      typeof q.header !== 'string' || !q.header.trim() || typeof q.question !== 'string' || !q.question.trim() ||
      (q.multiSelect !== undefined && q.multiSelect !== false) || !Array.isArray(q.options) || q.options.length !== 4 ||
      !q.options.every((o: any) => o && typeof o === 'object' && Object.keys(o).every(key => ['label', 'description', 'preview'].includes(key)) &&
        typeof o.label === 'string' && o.label.trim() && (o.description === undefined || typeof o.description === 'string') &&
        (o.preview === undefined || typeof o.preview === 'string')) ||
      new Set(q.options.map((o: any) => o.label)).size !== 4) return false;
  // Pinned CLI 2.1.251 also permits option.preview. Retain it in the receipt;
  // a visual artifact preview does not replace the decision brief being graded.
  // Native labels can be concise while the decision brief names the full modes.
  const publicText = serializeNativeAuq(q);
  return ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION']
    .every(mode => new RegExp(`\\b${mode}\\b`, 'i').test(publicText));
}
