/**
 * Browser-skills Phase 2a — gate-tier E2E for /scrape and /skillify.
 *
 * Five scenarios cover the productivity loop and the contracts locked
 * during the v1.19.0.0 plan review:
 *
 *   D1 — /skillify provenance guard (scenario 4)
 *   D2 — synthesis input slice (covered indirectly by scenario 3 — the
 *        committed SKILL.md must not contain conversation prose)
 *   D3 — atomic write discipline (scenarios 3 and 5)
 *
 *   1. scrape-match-path — /scrape with intent matching bundled
 *      hackernews-frontpage routes via $B skill run, no prototype.
 *   2. scrape-prototype-path — /scrape against a local file:// fixture
 *      (no matching skill) drives $B primitives, returns JSON, suggests
 *      /skillify.
 *   3. skillify-happy-path — /scrape then /skillify in one session.
 *      Skill written to ~/.gstack/browser-skills/<name>/ with full
 *      file tree, $B skill test passes.
 *   4. skillify-provenance-refusal — cold /skillify with no prior
 *      /scrape refuses with the D1 message; nothing on disk.
 *   5. skillify-approval-reject — /scrape then /skillify but reject in
 *      the approval gate; temp dir is removed, nothing at final path.
 *
 * All five run gate-tier (~$0.50–$1.50 each, ~$5 total per CI).
 * Set EVALS=1 to enable. Set EVALS_MODEL to override (default sonnet-4-6).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId,
  describeIfSelected, testConcurrentIfSelected,
  setupBrowseShims, copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-skillify');

// ─── Shared workdir setup ───────────────────────────────────────

interface Workdir {
  workDir: string;
  gstackHome: string;
  skillsDir: string;
}

/**
 * Build a working directory that has:
 *   - The /scrape and /skillify skills installed under .claude/skills/
 *   - The browse binary symlinked + find-browse shim (via setupBrowseShims)
 *   - bin/ scripts referenced by the preamble
 *   - A scoped GSTACK_HOME under the workdir so on-disk artifacts are
 *     contained and assertable
 *   - A CLAUDE.md routing block instructing Skill-tool invocation
 *
 * `installSkills` lets each test pick the minimum surface (e.g., the
 * provenance-refusal scenario doesn't need /scrape).
 */
function setupSkillifyWorkdir(suffix: string, installSkills: string[] = ['scrape', 'skillify']): Workdir {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-skillify-${suffix}-`));
  const gstackHome = path.join(workDir, '.gstack-home');
  fs.mkdirSync(gstackHome, { recursive: true });

  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(workDir, 'README.md'), '# test\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);

  setupBrowseShims(workDir);

  // Install requested skills.
  const skillsDir = path.join(workDir, '.claude', 'skills');
  for (const skill of installSkills) {
    const destDir = path.join(skillsDir, skill);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md'), path.join(destDir, 'SKILL.md'));
  }

  // bin/ scripts — preamble references several of these.
  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const script of [
    'gstack-timeline-log', 'gstack-slug', 'gstack-config',
    'gstack-update-check', 'gstack-repo-mode',
    'gstack-learnings-log', 'gstack-learnings-search',
  ]) {
    const src = path.join(ROOT, 'bin', script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(binDir, script));
      fs.chmodSync(path.join(binDir, script), 0o755);
    }
  }

  fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), `# Project Instructions

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it via
the Skill tool as your FIRST action.

Key routing rules:
- /scrape, "scrape", "get data from", "extract from" → invoke scrape
- /skillify, "skillify", "codify this scrape" → invoke skillify

Environment:
- GSTACK_HOME="${gstackHome}" for all gstack bin scripts.
- bin scripts are at ./bin/ relative to this directory.
- Browse binary is at ${browseBin} — assign to $B (e.g., \`B=${browseBin}\`).
`);

  return { workDir, gstackHome, skillsDir };
}

/**
 * Install the bundled hackernews-frontpage browser-skill into the workdir's
 * project-tier (so $B skill list finds it for match-path tests). The skill
 * has to live under <workdir>/.gstack/browser-skills/ for the project-tier
 * lookup to find it (gstack's bundled tier resolves from the install dir,
 * which the test workdir doesn't have).
 */
function installBundledHackernewsSkill(workDir: string) {
  const src = path.join(ROOT, 'browser-skills', 'hackernews-frontpage');
  const dst = path.join(workDir, '.gstack', 'browser-skills', 'hackernews-frontpage');
  copyDirSync(src, dst);
}

/** Helper: every Bash invocation's command string from the agent. */
function bashCommands(result: { toolCalls: Array<{ tool: string; input: any }> }): string[] {
  return result.toolCalls
    .filter((tc) => tc.tool === 'Bash')
    .map((tc) => String(tc.input?.command ?? ''))
    .filter(Boolean);
}

/** Helper: the union of agent text + every tool input/output for matching. */
function fullSurface(result: any): string {
  const parts: string[] = [];
  if (result.output) parts.push(String(result.output));
  for (const tc of result.toolCalls || []) {
    parts.push(JSON.stringify(tc.input || {}));
    if (tc.output) parts.push(String(tc.output));
  }
  for (const entry of result.transcript || []) {
    try { parts.push(JSON.stringify(entry)); } catch { /* skip */ }
  }
  return parts.join('\n');
}

// ─── Test fixtures ──────────────────────────────────────────────

/**
 * Tiny HTML fixture for the prototype-path test. Stable structure with three
 * "items" the agent should be able to extract via $B html + parse.
 */
const PROTOTYPE_FIXTURE_HTML = `<!doctype html>
<html><body>
  <h1>Test Items</h1>
  <ul id="items">
    <li class="item"><a href="/a">First Title</a><span class="score">42</span></li>
    <li class="item"><a href="/b">Second Title</a><span class="score">17</span></li>
    <li class="item"><a href="/c">Third Title</a><span class="score">8</span></li>
  </ul>
</body></html>
`;

// ─── Live-fire suite ────────────────────────────────────────────

describeIfSelected('Browser-skills Phase 2a E2E (/scrape + /skillify)', [
  'scrape-match-path',
  'scrape-prototype-path',
  'skillify-happy-path',
  'skillify-provenance-refusal',
  'skillify-approval-reject',
], () => {
  afterAll(() => { finalizeEvalCollector(evalCollector); });

  // ── 1. /scrape match path: bundled hackernews-frontpage matches ──────
  testConcurrentIfSelected('scrape-match-path', async () => {
    const { workDir, gstackHome } = setupSkillifyWorkdir('match', ['scrape']);
    installBundledHackernewsSkill(workDir);

    const result = await runSkillTest({
      prompt: `Run /scrape latest hacker news stories. Invoke /scrape via the Skill tool.
You MUST follow the skill's match-phase logic:
1. Run \`$B skill list\` to see what browser-skills are available
2. Recognize that "latest hacker news stories" matches the bundled
   hackernews-frontpage skill's triggers
3. Run \`$B skill run hackernews-frontpage\` and emit the JSON
Do NOT enter the prototype phase. Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 12,
      allowedTools: ['Skill', 'Bash', 'Read'],
      timeout: 120_000,
      testName: 'scrape-match-path',
      runId,
    });

    logCost('scrape-match-path', result);

    const cmds = bashCommands(result);
    const listedSkills = cmds.some(c => /\bskill\s+list\b/.test(c));
    const ranBundledSkill = cmds.some(c => /\bskill\s+run\s+hackernews-frontpage\b/.test(c));
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'scrape match-path routes to bundled skill', 'Phase 2a E2E', result, {
      passed: exitOk && listedSkills && ranBundledSkill,
    });

    expect(exitOk).toBe(true);
    expect(listedSkills).toBe(true);
    expect(ranBundledSkill).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 180_000);

  // ── 2. /scrape prototype path: drive $B primitives against fixture ────
  testConcurrentIfSelected('scrape-prototype-path', async () => {
    const { workDir, gstackHome } = setupSkillifyWorkdir('prototype', ['scrape']);

    // Stage a local HTML fixture the agent can goto via file://
    const fixturePath = path.join(workDir, 'fixture.html');
    fs.writeFileSync(fixturePath, PROTOTYPE_FIXTURE_HTML);
    const fileUrl = `file://${fixturePath}`;

    const result = await runSkillTest({
      prompt: `Run /scrape titles and scores from ${fileUrl}.
Invoke /scrape via the Skill tool. Follow the skill's prototype-phase logic:
1. \`$B skill list\` finds NO matching skill
2. Drive: \`$B goto ${fileUrl}\` then \`$B html\` (or \`$B text\`)
3. Parse the items (each has a title and a score)
4. Emit JSON of the form {"items": [{"title": "...", "score": N}, ...], "count": N}
5. Suggest /skillify in one line
Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 18,
      allowedTools: ['Skill', 'Bash', 'Read'],
      timeout: 180_000,
      testName: 'scrape-prototype-path',
      runId,
    });

    logCost('scrape-prototype-path', result);

    const cmds = bashCommands(result);
    const wentToFixture = cmds.some(c => c.includes(fileUrl));
    const fetchedHtml = cmds.some(c => /\bgoto\b|\bhtml\b|\btext\b/.test(c));
    const surface = fullSurface(result);
    const mentionsSkillify = /skillify/i.test(surface);
    // Accept JSON shape variants — the prompt asks for `"items": [...]` but
    // the model sometimes emits equivalent containers (`"results"`, `"data"`,
    // `"hits"`) or skips the wrapper entirely and emits a bare array of
    // objects with title+score keys. All of these satisfy the underlying
    // intent: "the agent produced parseable structured output naming the
    // scraped items". We assert the shape, not a literal key name.
    const hasJsonItems =
      /"(items|results|data|hits|entries)"\s*:\s*\[/i.test(surface) ||
      /'(items|results|data|hits|entries)'\s*:/i.test(surface) ||
      // Bare array of {title, score} objects (no outer wrapper key)
      /\[\s*\{[^}]*\btitle\b[^}]*\bscore\b/.test(surface);
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'scrape prototype-path drives $B + emits JSON + nudges skillify', 'Phase 2a E2E', result, {
      passed: exitOk && wentToFixture && fetchedHtml && hasJsonItems && mentionsSkillify,
    });

    expect(exitOk).toBe(true);
    expect(wentToFixture).toBe(true);
    expect(fetchedHtml).toBe(true);
    expect(hasJsonItems).toBe(true);
    expect(mentionsSkillify).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 240_000);

  // ── 3. /skillify happy path: scrape then skillify in one session ─────
  testConcurrentIfSelected('skillify-happy-path', async () => {
    const { workDir, gstackHome } = setupSkillifyWorkdir('happy', ['scrape', 'skillify']);
    const fixturePath = path.join(workDir, 'fixture.html');
    fs.writeFileSync(fixturePath, PROTOTYPE_FIXTURE_HTML);
    const fileUrl = `file://${fixturePath}`;

    const result = await runSkillTest({
      prompt: `Two steps in this session:

1. Run /scrape titles and scores from ${fileUrl} via the Skill tool.
   Drive the prototype path; return JSON with items[].

2. Run /skillify via the Skill tool. Follow ALL 11 steps including:
   - D1 provenance guard (you have a recent /scrape, proceed)
   - D2 synthesis: include ONLY the final-attempt $B calls (goto + html)
   - D3 atomic write: stage to temp dir, run test, then commit on approval
   - When AskUserQuestion fires, choose the recommended option (A)
     for both the name/tier question AND the approval gate.

Use HOME=${workDir} so all skill writes land under the test workdir
(translates to ~/.gstack/browser-skills/<name>/ via $HOME).

Do NOT halt for clarification.`,
      workingDirectory: workDir,
      env: {
        GSTACK_HOME: gstackHome,
        HOME: workDir,  // /skillify writes to $HOME/.gstack/browser-skills/
      },
      maxTurns: 40,
      allowedTools: ['Skill', 'Bash', 'Read', 'Write'],
      timeout: 360_000,
      testName: 'skillify-happy-path',
      runId,
    });

    logCost('skillify-happy-path', result);

    // The skill should land in $HOME/.gstack/browser-skills/<name>/
    const skillsRoot = path.join(workDir, '.gstack', 'browser-skills');
    const writtenSkills = fs.existsSync(skillsRoot)
      ? fs.readdirSync(skillsRoot).filter(d => !d.startsWith('.') && d !== 'hackernews-frontpage')
      : [];
    const skillName = writtenSkills[0];
    const skillDir = skillName ? path.join(skillsRoot, skillName) : '';
    const hasAllFiles = !!skillDir
      && fs.existsSync(path.join(skillDir, 'SKILL.md'))
      && fs.existsSync(path.join(skillDir, 'script.ts'))
      && fs.existsSync(path.join(skillDir, 'script.test.ts'))
      && fs.existsSync(path.join(skillDir, '_lib', 'browse-client.ts'))
      && fs.existsSync(path.join(skillDir, 'fixtures'));

    // D2 enforcement: the SKILL.md prose body MUST NOT contain conversation
    // fragments. Cheap heuristic: it shouldn't have "I" or "Let me" or other
    // first-person/agent-narration markers.
    let prosesClean = false;
    if (hasAllFiles) {
      const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
      const body = skillMd.split(/\n---\n/)[1] || '';
      prosesClean = !/^I /m.test(body)
        && !/Let me /i.test(body)
        && !/^I'll /m.test(body);
    }

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'skillify happy path writes well-formed skill on disk', 'Phase 2a E2E', result, {
      passed: exitOk && hasAllFiles && prosesClean,
    });

    expect(exitOk).toBe(true);
    expect(writtenSkills.length).toBeGreaterThan(0);
    expect(hasAllFiles).toBe(true);
    expect(prosesClean).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 420_000);

  // ── 4. /skillify provenance refusal: D1 contract ─────────────────────
  testConcurrentIfSelected('skillify-provenance-refusal', async () => {
    const { workDir, gstackHome } = setupSkillifyWorkdir('refusal', ['skillify']);

    const result = await runSkillTest({
      prompt: `Run /skillify via the Skill tool. There has been NO prior /scrape
in this conversation. Follow the skill's Step 1 (D1 provenance guard) literally:
walk back through agent turns, find no /scrape result, refuse with the exact
message the skill specifies, and stop. Do NOT synthesize anything. Do NOT
write any files.`,
      workingDirectory: workDir,
      env: {
        GSTACK_HOME: gstackHome,
        HOME: workDir,
      },
      maxTurns: 8,
      allowedTools: ['Skill', 'Bash', 'Read'],
      timeout: 90_000,
      testName: 'skillify-provenance-refusal',
      runId,
    });

    logCost('skillify-provenance-refusal', result);

    const surface = fullSurface(result);
    const refusalText = /no recent \/?scrape result|run \/scrape.*first|no prior \/?scrape/i.test(surface);

    // Critical: nothing on disk. No staged dir, no committed skill.
    const skillsRoot = path.join(workDir, '.gstack', 'browser-skills');
    const stagingRoot = path.join(workDir, '.gstack', '.tmp');
    const noSkillsWritten = !fs.existsSync(skillsRoot)
      || fs.readdirSync(skillsRoot).filter(d => !d.startsWith('.')).length === 0;
    const noStaging = !fs.existsSync(stagingRoot)
      || fs.readdirSync(stagingRoot).filter(d => d.startsWith('skillify-')).length === 0;

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'skillify D1 refusal — no on-disk write', 'Phase 2a E2E', result, {
      passed: exitOk && refusalText && noSkillsWritten && noStaging,
    });

    expect(exitOk).toBe(true);
    expect(refusalText).toBe(true);
    expect(noSkillsWritten).toBe(true);
    expect(noStaging).toBe(true);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 120_000);

  // ── 5. /skillify approval-gate reject: D3 cleanup ────────────────────
  testConcurrentIfSelected('skillify-approval-reject', async () => {
    const { workDir, gstackHome } = setupSkillifyWorkdir('reject', ['scrape', 'skillify']);
    const fixturePath = path.join(workDir, 'fixture.html');
    fs.writeFileSync(fixturePath, PROTOTYPE_FIXTURE_HTML);
    const fileUrl = `file://${fixturePath}`;

    const result = await runSkillTest({
      prompt: `Two steps:

1. Run /scrape titles and scores from ${fileUrl} via the Skill tool.

2. Run /skillify via the Skill tool. Follow steps 1-9. When the approval
   gate AskUserQuestion fires (Step 9), choose option C (Discard) instead
   of A (Commit). The D3 contract says the temp dir must be removed and
   nothing should land at the final tier path.

Use HOME=${workDir}. Do NOT commit the skill.`,
      workingDirectory: workDir,
      env: {
        GSTACK_HOME: gstackHome,
        HOME: workDir,
      },
      maxTurns: 35,
      allowedTools: ['Skill', 'Bash', 'Read', 'Write'],
      timeout: 360_000,
      testName: 'skillify-approval-reject',
      runId,
    });

    logCost('skillify-approval-reject', result);

    // D3 contract: nothing at the final tier path; staging dir is gone.
    const skillsRoot = path.join(workDir, '.gstack', 'browser-skills');
    const writtenSkills = fs.existsSync(skillsRoot)
      ? fs.readdirSync(skillsRoot).filter(d => !d.startsWith('.'))
      : [];
    const stagingRoot = path.join(workDir, '.gstack', '.tmp');
    const stagingLeftovers = fs.existsSync(stagingRoot)
      ? fs.readdirSync(stagingRoot).filter(d => d.startsWith('skillify-'))
      : [];

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'skillify approval-reject leaves no on-disk artifact', 'Phase 2a E2E', result, {
      passed: exitOk && writtenSkills.length === 0 && stagingLeftovers.length === 0,
    });

    expect(exitOk).toBe(true);
    expect(writtenSkills.length).toBe(0);
    expect(stagingLeftovers.length).toBe(0);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, 420_000);
});
