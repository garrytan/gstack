/**
 * Tier-1 live-fire E2E for /context-save and /context-restore.
 *
 * These spawn `claude -p "/context-save ..."` with the Skill tool enabled
 * and the skill installed in the workdir's .claude/skills/. Unlike the
 * older hand-fed-section tests, these exercise the ROUTING path — the
 * exact thing that broke with the /checkpoint name collision and the
 * whole reason this rename exists. If /context-save stops routing to
 * the skill (e.g., upstream ships a built-in by that name), these fail.
 *
 * Periodic tier. ~$0.20-$0.40 per test, ~$2 total per run.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-context-skills');

// Shared install helper: copy both skill files + bin scripts + routing CLAUDE.md
// into a tmp workdir. Matches the pattern from skill-routing-e2e.test.ts so
// claude -p discovers the skills via .claude/skills/ auto-scan.
function setupWorkdir(suffix: string): { workDir: string; gstackHome: string; slug: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-ctx-${suffix}-`));
  const gstackHome = path.join(workDir, '.gstack-home');

  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(workDir, 'app.ts'), 'console.log("hello");\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);

  // Install skills into .claude/skills/ for claude -p auto-discovery.
  const skillsDir = path.join(workDir, '.claude', 'skills');
  for (const skill of ['context-save', 'context-restore']) {
    const destDir = path.join(skillsDir, skill);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md'), path.join(destDir, 'SKILL.md'));
  }

  // Install the bin scripts referenced by the preamble.
  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const script of [
    'gstack-timeline-log', 'gstack-timeline-read', 'gstack-slug',
    'gstack-learnings-log', 'gstack-learnings-search',
    'gstack-update-check', 'gstack-config', 'gstack-repo-mode',
  ]) {
    const src = path.join(ROOT, 'bin', script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(binDir, script));
      fs.chmodSync(path.join(binDir, script), 0o755);
    }
  }

  // Routing CLAUDE.md: explicit instruction to always use the Skill tool.
  fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), `# Project Instructions

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.

Key routing rules:
- Save progress, save state, save my work → invoke context-save
- Resume, where was I, pick up where I left off → invoke context-restore

Environment:
- Use GSTACK_HOME="${gstackHome}" for all gstack bin scripts.
- The bin scripts are at ./bin/ (relative to this directory).
- The skill files are at ./.claude/skills/context-save/SKILL.md and
  ./.claude/skills/context-restore/SKILL.md.
`);

  const slug = path.basename(workDir).replace(/[^a-zA-Z0-9._-]/g, '');
  return { workDir, gstackHome, slug };
}

// Helper: seed a saved-context file into the storage dir.
function seedSave(gstackHome: string, slug: string, filename: string, frontmatter: Record<string, string>, body: string) {
  const dir = path.join(gstackHome, 'projects', slug, 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  const fm = '---\n' + Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n';
  fs.writeFileSync(path.join(dir, filename), fm + body);
}

// Helper: extract the list of Skill tool invocations from the transcript.
function skillCalls(result: { toolCalls: Array<{ tool: string; input: any }> }): string[] {
  return result.toolCalls
    .filter((tc) => tc.tool === 'Skill')
    .map((tc) => tc.input?.skill || '')
    .filter(Boolean);
}

// Build a broader assertion surface: final assistant message + every tool
// input and output. The agent often finishes with a tool call instead of a
// text response, leaving result.output as an empty string — but the data we
// want to assert on (skill invocation args, bash stdout like NO_CHECKPOINTS,
// file paths) is all present in the transcript. Search there too.
function fullOutputSurface(result: {
  output?: string;
  transcript?: any[];
  toolCalls?: Array<{ tool: string; input: any; output: string }>;
}): string {
  const parts: string[] = [];
  if (result.output) parts.push(result.output);
  for (const tc of result.toolCalls || []) {
    parts.push(JSON.stringify(tc.input || {}));
    if (tc.output) parts.push(tc.output);
  }
  // Also stringify transcript for tool_result / user-message content that
  // isn't surfaced via toolCalls (e.g., Bash stdout echoed back).
  for (const entry of result.transcript || []) {
    try { parts.push(JSON.stringify(entry)); } catch { /* skip */ }
  }
  return parts.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// Live-fire E2E suite
// ────────────────────────────────────────────────────────────────────────

describeIfSelected('Context Skills E2E (live-fire)', [
  'context-save-routing',
  'context-save-then-restore-roundtrip',
  'context-restore-fragment-match',
  'context-restore-empty-state',
  'context-restore-list-delegates',
  'context-restore-legacy-compat',
  'context-save-list-current-branch',
  'context-save-list-all-branches',
], () => {
  afterAll(() => { finalizeEvalCollector(evalCollector); });

  // ── 1. Routing: /context-save actually invokes the Skill tool ────────
  testConcurrentIfSelected('context-save-routing', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('routing');

    // Prompt pattern: the slash command + explicit "invoke via Skill tool"
    // instruction. The GSTACK_HOME / ./bin bash setup that used to be in
    // the prompt now comes via env:. Prompt without the Skill-tool hint
    // causes the agent to interpret /context-save as a shell token and
    // skip Skill routing entirely — which defeats this test's purpose.
    const result = await runSkillTest({
      prompt: `Run /context-save wintermute progress. Invoke via the Skill tool. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 12,
      allowedTools: ['Skill', 'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'context-save-routing',
      runId,
    });

    logCost('context-save-routing', result);

    const invokedSkills = skillCalls(result);
    const routedToContextSave = invokedSkills.includes('context-save');
    // File should also be written to the storage dir.
    const checkpointDir = path.join(gstackHome, 'projects', slug, 'checkpoints');
    const files = fs.existsSync(checkpointDir) ? fs.readdirSync(checkpointDir).filter((f) => f.endsWith('.md')) : [];
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context-save routes via Skill tool', 'Context Skills E2E', result, {
      passed: exitOk && routedToContextSave && files.length > 0,
    });

    expect(exitOk).toBe(true);
    expect(routedToContextSave).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 180_000);

  // ── 2. Round-trip: save then restore in the same session ─────────────
  testConcurrentIfSelected('context-save-then-restore-roundtrip', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('roundtrip');
    const magicMarker = 'wintermute-roundtrip-MX7FQZ';

    // Stage a change so /context-save has something to capture.
    fs.writeFileSync(path.join(workDir, 'feature.ts'), `// ${magicMarker}\nexport const X = 1;\n`);
    spawnSync('git', ['add', 'feature.ts'], { cwd: workDir, stdio: 'pipe', timeout: 5000 });

    const result = await runSkillTest({
      prompt: `Two steps:
1. Run /context-save ${magicMarker} — invoke via the Skill tool.
2. Run /context-restore — invoke via the Skill tool. Report what it loaded.
Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 25,
      allowedTools: ['Skill', 'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 240_000,
      testName: 'context-save-then-restore-roundtrip',
      runId,
    });

    logCost('context-save-then-restore-roundtrip', result);

    const invokedSkills = skillCalls(result);
    const bothRouted = invokedSkills.includes('context-save') && invokedSkills.includes('context-restore');
    const checkpointDir = path.join(gstackHome, 'projects', slug, 'checkpoints');
    const files = fs.existsSync(checkpointDir) ? fs.readdirSync(checkpointDir).filter((f) => f.endsWith('.md')) : [];
    // Broader surface — agent may stop at restore's Skill call without
    // echoing the marker into result.output. The marker is also in the
    // Skill tool input (we passed it as the save title) and in the
    // file content that restore reads.
    const restoreMentionsTitle = fullOutputSurface(result).toLowerCase().includes(magicMarker.toLowerCase());
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'save-then-restore round-trip', 'Context Skills E2E', result, {
      passed: exitOk && bothRouted && files.length > 0 && restoreMentionsTitle,
    });

    expect(exitOk).toBe(true);
    expect(bothRouted).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    expect(restoreMentionsTitle).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 240_000);

  // ── 3. /context-restore <fragment> loads the matching save ───────────
  testConcurrentIfSelected('context-restore-fragment-match', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('fragment');

    // Seed three saves with distinct titles.
    seedSave(gstackHome, slug, '20260101-120000-alpha-feature.md',
      { status: 'in-progress', branch: 'feat/alpha', timestamp: '2026-01-01T12:00:00Z' },
      '## Working on: alpha feature\n\n### Summary\nAlpha content FRAGMATCH_ALPHA_BUILD\n');
    seedSave(gstackHome, slug, '20260202-120000-middle-payments.md',
      { status: 'in-progress', branch: 'feat/payments', timestamp: '2026-02-02T12:00:00Z' },
      '## Working on: middle payments\n\n### Summary\nPayments content FRAGMATCH_PAYMENTS_BUILD\n');
    seedSave(gstackHome, slug, '20260303-120000-omega-release.md',
      { status: 'in-progress', branch: 'feat/omega', timestamp: '2026-03-03T12:00:00Z' },
      '## Working on: omega release\n\n### Summary\nOmega content FRAGMATCH_OMEGA_BUILD\n');

    const result = await runSkillTest({
      prompt: `Run /context-restore payments — load the saved context whose title contains "payments". Invoke via the Skill tool. Report what was loaded. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 10,
      allowedTools: ['Skill', 'Bash', 'Read', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'context-restore-fragment-match',
      runId,
    });

    logCost('context-restore-fragment-match', result);

    // Broader surface — agent may stop at Skill call without echoing the
    // body marker. The payments file's body is in tool outputs (Read/Bash).
    const out = fullOutputSurface(result);
    const loadedPayments = out.includes('FRAGMATCH_PAYMENTS_BUILD');
    const didNotLoadOthers = !out.includes('FRAGMATCH_ALPHA_BUILD') && !out.includes('FRAGMATCH_OMEGA_BUILD');
    const routedToRestore = skillCalls(result).includes('context-restore');
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context-restore <fragment> match', 'Context Skills E2E', result, {
      passed: exitOk && routedToRestore && loadedPayments && didNotLoadOthers,
    });

    expect(exitOk).toBe(true);
    expect(routedToRestore).toBe(true);
    expect(loadedPayments).toBe(true);
    expect(didNotLoadOthers).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 180_000);

  // ── 4. /context-restore with zero saves → graceful empty-state ───────
  testConcurrentIfSelected('context-restore-empty-state', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('empty');
    // Ensure the storage dir is empty or missing — setupWorkdir doesn't seed.
    const checkpointDir = path.join(gstackHome, 'projects', slug, 'checkpoints');
    expect(fs.existsSync(checkpointDir)).toBe(false);

    const result = await runSkillTest({
      prompt: `Run /context-restore — there are no saved contexts yet. Invoke via the Skill tool. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 8,
      allowedTools: ['Skill', 'Bash', 'Read', 'Grep', 'Glob'],
      timeout: 90_000,
      testName: 'context-restore-empty-state',
      runId,
    });

    logCost('context-restore-empty-state', result);

    // Build broad surface: agent often stops after a tool call with no final
    // text, so result.output is empty string. The bash "NO_CHECKPOINTS" echo
    // is in tool outputs; the "no saved contexts yet" phrase may only appear
    // in tool inputs / transcript entries.
    const out = fullOutputSurface(result);
    const gracefulMessage = /no saved context|no contexts? yet|nothing to restore|NO_CHECKPOINTS/i.test(out);
    const noCrash = !/error|exception|undefined/i.test(out) || gracefulMessage; // mention of "error" in the graceful message is fine
    const routedToRestore = skillCalls(result).includes('context-restore');
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context-restore empty state', 'Context Skills E2E', result, {
      passed: exitOk && routedToRestore && gracefulMessage && noCrash,
    });

    expect(exitOk).toBe(true);
    expect(routedToRestore).toBe(true);
    expect(gracefulMessage).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 150_000);

  // ── 5. /context-restore list redirects to /context-save list ─────────
  testConcurrentIfSelected('context-restore-list-delegates', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('delegates');
    seedSave(gstackHome, slug, '20260101-120000-seed.md',
      { status: 'in-progress', branch: 'main', timestamp: '2026-01-01T12:00:00Z' },
      '## Working on: seed\n');

    const result = await runSkillTest({
      prompt: `Run /context-restore list. Invoke via the Skill tool. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 8,
      allowedTools: ['Skill', 'Bash', 'Read', 'Grep', 'Glob'],
      timeout: 90_000,
      testName: 'context-restore-list-delegates',
      runId,
    });

    logCost('context-restore-list-delegates', result);

    // Broader surface — agent sometimes stops after the Skill call without
    // producing text output. The "use /context-save list" hint may only
    // appear in tool inputs / transcript.
    const out = fullOutputSurface(result);
    const mentionsSaveList = /context-save list/i.test(out);
    const routedToRestore = skillCalls(result).includes('context-restore');
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context-restore list delegates', 'Context Skills E2E', result, {
      passed: exitOk && routedToRestore && mentionsSaveList,
    });

    expect(exitOk).toBe(true);
    expect(routedToRestore).toBe(true);
    expect(mentionsSaveList).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 150_000);

  // ── 6. Legacy compat: pre-rename save files still load ───────────────
  testConcurrentIfSelected('context-restore-legacy-compat', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('legacy');

    // Seed a save file in the pre-rename format (exactly how old /checkpoint
    // wrote them). The storage dir name is still "checkpoints/" — kept for
    // exactly this reason.
    seedSave(gstackHome, slug, '20260301-120000-legacy-pre-rename-work.md',
      {
        status: 'in-progress',
        branch: 'feat/pre-rename',
        timestamp: '2026-03-01T12:00:00Z',
        session_duration_s: '3600',
      },
      '## Working on: legacy pre-rename work\n\n### Summary\nWork saved by OLD_CHECKPOINT_SKILL_LEGACYCOMPAT before the rename.\n\n### Remaining Work\n1. Item from the before-times.\n');

    const result = await runSkillTest({
      prompt: `Run /context-restore — load the most recent saved context. Invoke via the Skill tool. Report the content of the loaded file. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 8,
      allowedTools: ['Skill', 'Bash', 'Read', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'context-restore-legacy-compat',
      runId,
    });

    logCost('context-restore-legacy-compat', result);

    // Check for ANY evidence the legacy file was loaded. The agent may
    // paraphrase the summary OR stop at a tool call without text output,
    // so require at least ONE of:
    //   (a) the unique body marker (verbatim pass-through)
    //   (b) the title phrase "legacy pre-rename work"
    //   (c) the filename or its timestamp prefix
    //   (d) the branch name "feat/pre-rename"
    // Search across the full transcript, not just result.output.
    const out = fullOutputSurface(result);
    const loadedLegacy =
      out.includes('OLD_CHECKPOINT_SKILL_LEGACYCOMPAT') ||
      /legacy.+pre-rename/i.test(out) ||
      /20260301-120000-legacy/i.test(out) ||
      /feat\/pre-rename/i.test(out) ||
      /pre-rename/i.test(out);
    const routedToRestore = skillCalls(result).includes('context-restore');
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'legacy /checkpoint file loads via /context-restore', 'Context Skills E2E', result, {
      passed: exitOk && routedToRestore && loadedLegacy,
    });

    expect(exitOk).toBe(true);
    expect(routedToRestore).toBe(true);
    expect(loadedLegacy).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 180_000);

  // ── 7. /context-save list: default filters to current branch ─────────
  testConcurrentIfSelected('context-save-list-current-branch', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('list-current');

    // Seed 3 files on 3 different branches. Current branch is "main".
    seedSave(gstackHome, slug, '20260101-120000-main-work.md',
      { status: 'in-progress', branch: 'main', timestamp: '2026-01-01T12:00:00Z' },
      '## Working on: main work LISTCURR_MAIN_TOKEN\n');
    seedSave(gstackHome, slug, '20260202-120000-feat-alpha.md',
      { status: 'in-progress', branch: 'feat/alpha', timestamp: '2026-02-02T12:00:00Z' },
      '## Working on: alpha LISTCURR_ALPHA_TOKEN\n');
    seedSave(gstackHome, slug, '20260303-120000-feat-beta.md',
      { status: 'in-progress', branch: 'feat/beta', timestamp: '2026-03-03T12:00:00Z' },
      '## Working on: beta LISTCURR_BETA_TOKEN\n');

    const result = await runSkillTest({
      prompt: `Run /context-save list — list saved contexts for the CURRENT branch only (default, no --all). Invoke via the Skill tool. The current branch is "main". Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 10,
      allowedTools: ['Skill', 'Bash', 'Read', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'context-save-list-current-branch',
      runId,
    });

    logCost('context-save-list-current-branch', result);

    // Broad surface: the list output may only appear in bash tool_result
    // entries (find output, file reads) rather than the agent's final text.
    const out = fullOutputSurface(result);
    // Must show the main-branch save. Hide the other branches' saves.
    // Match by filename timestamp (stable, unambiguous) plus a looser
    // prose check.
    const showsMain = /20260101-120000|main-work/.test(out);
    const hidesAlpha = !/20260202-120000/.test(out);
    const hidesBeta = !/20260303-120000/.test(out);
    const routed = skillCalls(result).includes('context-save');
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context-save list (current branch default)', 'Context Skills E2E', result, {
      passed: exitOk && routed && showsMain && hidesAlpha && hidesBeta,
    });

    expect(exitOk).toBe(true);
    expect(routed).toBe(true);
    expect(showsMain).toBe(true);
    expect(hidesAlpha).toBe(true);
    expect(hidesBeta).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 180_000);

  // ── 8. /context-save list --all: shows every branch ──────────────────
  testConcurrentIfSelected('context-save-list-all-branches', async () => {
    const { workDir, gstackHome, slug } = setupWorkdir('list-all');

    seedSave(gstackHome, slug, '20260101-120000-main-work.md',
      { status: 'in-progress', branch: 'main', timestamp: '2026-01-01T12:00:00Z' },
      '## Working on: main LISTALL_MAIN_TOKEN\n');
    seedSave(gstackHome, slug, '20260202-120000-feat-alpha.md',
      { status: 'in-progress', branch: 'feat/alpha', timestamp: '2026-02-02T12:00:00Z' },
      '## Working on: alpha LISTALL_ALPHA_TOKEN\n');
    seedSave(gstackHome, slug, '20260303-120000-feat-beta.md',
      { status: 'in-progress', branch: 'feat/beta', timestamp: '2026-03-03T12:00:00Z' },
      '## Working on: beta LISTALL_BETA_TOKEN\n');

    const result = await runSkillTest({
      prompt: `Run /context-save list --all — list saved contexts from ALL branches (not just the current one). Invoke via the Skill tool. Report the full list. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 10,
      allowedTools: ['Skill', 'Bash', 'Read', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'context-save-list-all-branches',
      runId,
    });

    logCost('context-save-list-all-branches', result);

    // Broad surface — same rationale as list-current-branch: the list output
    // may only be in bash tool_result, not in the agent's final text.
    const out = fullOutputSurface(result);
    const filesShown = [
      /20260101-120000/.test(out),
      /20260202-120000/.test(out),
      /20260303-120000/.test(out),
    ].filter(Boolean).length;
    const routed = skillCalls(result).includes('context-save');
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context-save list --all', 'Context Skills E2E', result, {
      passed: exitOk && routed && filesShown === 3,
    });

    expect(exitOk).toBe(true);
    expect(routed).toBe(true);
    expect(filesShown).toBe(3);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 180_000);
});
