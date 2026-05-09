import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-game-design');

afterAll(() => {
  finalizeEvalCollector(evalCollector);
});

// Shared fixture setup helper
function makeGameDesignFixture(): { repoDir: string; gstackHome: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-game-design-'));
  const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-game-design-'));

  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: repoDir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  run('git', ['remote', 'add', 'origin', 'https://github.com/testuser/gate-runners-e2e']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Gate Runners E2E\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);

  return { repoDir, gstackHome };
}

// Read the SKILL.md contents to inline in the prompt (avoid context bloat
// from reading the full file at test time — extract just what's needed)
const SKILL_PATH = path.join(ROOT, 'game-design', 'SKILL.md');

// ---------------------------------------------------------------------------
// P1: Happy path — all 6 stages, all required fields populated
// ---------------------------------------------------------------------------
describeIfSelected('/game-design — happy path (all 6 stages)', ['game-design-happy-path'], () => {
  let repoDir: string;
  let gstackHome: string;

  beforeAll(() => {
    ({ repoDir, gstackHome } = makeGameDesignFixture());
  });

  afterAll(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(gstackHome, { recursive: true, force: true }); } catch {}
  });

  test('/game-design produces a valid design document with all required fields', async () => {
    if (!fs.existsSync(SKILL_PATH)) {
      console.warn('[game-design] SKILL.md not found — skipping');
      return;
    }

    const gstackSlug = 'testuser-gate-runners-e2e';
    const projDir = path.join(gstackHome, 'projects', gstackSlug);

    const result = await runSkillTest({
      prompt: `Read the file ${SKILL_PATH} for the /game-design skill instructions.

Run the /game-design skill now. Use these pre-prepared answers for every stage question.
Do NOT use AskUserQuestion interactively — apply these answers directly.
Override GSTACK_HOME to "${gstackHome}" for all file writes (use this as the GSTACK_HOME env var in bash blocks).
The GSTACK_SLUG for this session is "${gstackSlug}".
Write the draft file to: ${projDir}/

--- STAGE 1 ANSWERS ---
Feeling: "Tense cooperation — we're in this together, under pressure" (option A)
Story moment: "The moment we all realize the last gate is about to fall with no cards left — and somehow we pull through."
Tagline: "Close the gates before the darkness wins."

--- STAGE 2 ANSWERS ---
Primary action: "Drawing and playing cards" (option A)
Interesting decision: "Which card to play to a gate — the safe low-value card that slowly fills it, or the risky high-value card that could seal it but leaves your hand weak."
Title: "Gate Runners"
Slug: "gate-runners"
Hook: "Both players reveal their gate card simultaneously with no take-backs — you never know if you'll seal the gate or overshoot it."
AI mechanic suggestions: Skip (option B — no thanks).

--- STAGE 3 ANSWERS ---
Turn loop: "1. Draw 2 cards. 2. Play 1 card face-down to any open gate. 3. Partner plays to a gate. 4. Both reveal simultaneously — each gate's value rises by the card sum. 5. Draw 1 threat card; if it shows a demogorgon advance the tracker. 6. Replenish hands to 4 cards."
State change: "Gate values rise toward the 10-point seal threshold, and the threat tracker may advance."
Players: min 2, max 2
Session length: min 30 minutes, max 45 minutes

--- STAGE 4 ANSWERS ---
AI theme suggestions: Skip (option B — no thanks).
Theme: "Two detectives sealing supernatural rifts in 1980s Indiana"
Mechanic-theme fit: "Reinforces" (option A)

--- STAGE 5 ANSWERS ---
Win condition: "Seal all 5 gates with at least 2 players alive."
Lose condition: "The threat tracker reaches 5 demogorgons."
Rules summary: "Players draw 2 cards per turn and play 1 face-down to any open gate, adding its value when both cards are revealed simultaneously. Gates seal when their value reaches 10 or more. Each round a threat card is drawn — demogorgon cards advance the tracker by 1. Players may not reveal their card values before playing. The game ends immediately when all 5 gates are sealed (win) or the tracker reaches 5 (loss)."

--- STAGE 6 ANSWERS ---
Components: ["60 gate cards", "20 threat cards", "5 gate tiles", "1 threat tracker board", "10 demogorgon tokens"]
Open questions: ["Is 45 minutes the right session length?", "Does the hand size of 4 feel too small?"]

After writing the design document, run the JSON validation step and report whether it passed.`,
      workingDirectory: repoDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 35,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      timeout: 600_000,
    });

    logCost('game-design-happy-path', result);
    recordE2E(evalCollector, 'game-design-happy-path', result);

    expect(result.exitReason).toBe('success');

    // Verify the design document was written
    const files = fs.readdirSync(projDir).filter(f => f.startsWith('game-design-') && f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);

    const docPath = path.join(projDir, files[0]);
    const content = fs.readFileSync(docPath, 'utf-8');

    // JSON block must be present and parseable
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();

    const data = JSON.parse(jsonMatch![1]);

    // All required fields must be present and non-TBD
    const required = [
      'slug', 'title', 'tagline', 'hook', 'golden_feeling', 'target_audience',
      'player_count_min', 'player_count_max', 'session_length_min', 'session_length_max',
      'theme', 'core_mechanism', 'mechanic_theme_fit', 'core_loop',
      'win_condition', 'components', 'rules_summary', 'open_questions',
    ];
    for (const field of required) {
      expect(data[field]).toBeDefined();
      expect(data[field]).not.toBe('TBD');
    }

    // Specific field checks from canned inputs
    expect(data.title).toContain('Gate');
    expect(data.slug).toContain('gate');
    expect(data.mechanic_theme_fit).toBe('reinforces');
    expect(Array.isArray(data.components)).toBe(true);
    expect(data.components.length).toBeGreaterThan(0);
    expect(Array.isArray(data.open_questions)).toBe(true);
    expect(data.open_questions.length).toBeGreaterThan(0);

    // Numeric fields must be integers
    expect(typeof data.player_count_min).toBe('number');
    expect(typeof data.player_count_max).toBe('number');
    expect(typeof data.session_length_min).toBe('number');
    expect(typeof data.session_length_max).toBe('number');

    // mechanic_theme_fit_explanation should NOT be present for "reinforces"
    expect(data.mechanic_theme_fit_explanation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1: mechanic_theme_fit="fights" branch
// ---------------------------------------------------------------------------
describeIfSelected('/game-design — mechanic_theme_fit="fights" branch', ['game-design-fights-branch'], () => {
  let repoDir: string;
  let gstackHome: string;

  beforeAll(() => {
    ({ repoDir, gstackHome } = makeGameDesignFixture());
  });

  afterAll(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(gstackHome, { recursive: true, force: true }); } catch {}
  });

  test('/game-design captures mechanic_theme_fit_explanation when theme fights mechanics', async () => {
    if (!fs.existsSync(SKILL_PATH)) return;

    const gstackSlug = 'testuser-gate-runners-e2e';
    const projDir = path.join(gstackHome, 'projects', gstackSlug);

    const result = await runSkillTest({
      prompt: `Read the file ${SKILL_PATH} for the /game-design skill instructions.

Run the /game-design skill now. Use these pre-prepared answers. Do NOT use AskUserQuestion interactively.
Override GSTACK_HOME to "${gstackHome}". GSTACK_SLUG is "${gstackSlug}".

--- STAGE 1 ---
Feeling: "Tense cooperation" (option A)
Story moment: "The moment we seal the last gate."
Tagline: "Close the gates before the darkness wins."

--- STAGE 2 ---
Primary action: "Drawing and playing cards" (option A)
Decision: "Safe play vs. risky play."
Title: "Gate Runners"
Slug: "gate-runners"
Hook: "Skip"
AI suggestions: Skip (B).

--- STAGE 3 ---
Turn loop: "1. Draw 2. 2. Play 1 face-down. 3. Reveal. 4. Draw threat card."
State change: "Gates fill."
Players: min 2, max 2. Session: min 30, max 45.

--- STAGE 4 ---
AI theme suggestions: Skip (B).
Theme: "Corporate bean-counting office workers who are secretly spy handlers"
Mechanic-theme fit: "Fights" (option B — intentional, the bureaucratic card-counting contrasts with the spy-thriller theme deliberately)
Follow-up (when asked if intentional or signal): "Intentional — the tedious mechanics contrast with the high-stakes spy theme. That's the joke."

--- STAGE 5 ---
Win condition: "Complete all 5 handler assignments."
Lose condition: "Skip"
Rules: "Players draw and play cards. Whoever runs out of cards loses."

--- STAGE 6 ---
Components: ["52 cards", "5 assignment tiles"]
Open questions: ["Is the theme too obscure?"]`,
      workingDirectory: repoDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 30,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      timeout: 480_000,
    });

    logCost('game-design-fights-branch', result);
    recordE2E(evalCollector, 'game-design-fights-branch', result);

    expect(result.exitReason).toBe('success');

    const files = fs.readdirSync(projDir).filter(f => f.startsWith('game-design-') && f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(projDir, files[0]), 'utf-8');
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();

    const data = JSON.parse(jsonMatch![1]);
    expect(data.mechanic_theme_fit).toBe('fights');

    // mechanic_theme_fit_explanation MUST be present when fights + intentional
    expect(data.mechanic_theme_fit_explanation).toBeDefined();
    expect(typeof data.mechanic_theme_fit_explanation).toBe('string');
    expect(data.mechanic_theme_fit_explanation.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P2: Skip path — all questions skipped → TBD fields
// ---------------------------------------------------------------------------
describeIfSelected('/game-design — skip path', ['game-design-skip-path'], () => {
  let repoDir: string;
  let gstackHome: string;

  beforeAll(() => {
    ({ repoDir, gstackHome } = makeGameDesignFixture());
  });

  afterAll(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(gstackHome, { recursive: true, force: true }); } catch {}
  });

  test('/game-design writes file with TBD fields when user skips all stages', async () => {
    if (!fs.existsSync(SKILL_PATH)) return;

    const gstackSlug = 'testuser-gate-runners-e2e';
    const projDir = path.join(gstackHome, 'projects', gstackSlug);

    const result = await runSkillTest({
      prompt: `Read the file ${SKILL_PATH} for the /game-design skill instructions.

Run the /game-design skill now. For EVERY question in every stage, the answer is "skip".
Do NOT use AskUserQuestion interactively.
Override GSTACK_HOME to "${gstackHome}". GSTACK_SLUG is "${gstackSlug}".

When the skill asks anything — skip it. Answer "skip" to every stage.
The skill should still write a design document file with TBD values.
After completing, the skill should list all the TBD fields.`,
      workingDirectory: repoDir,
      env: { GSTACK_HOME: gstackHome },
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      timeout: 360_000,
    });

    logCost('game-design-skip-path', result);
    recordE2E(evalCollector, 'game-design-skip-path', result);

    expect(result.exitReason).toBe('success');

    // File should still be written
    const projFiles = fs.existsSync(projDir)
      ? fs.readdirSync(projDir).filter(f => f.startsWith('game-design-') && f.endsWith('.md'))
      : [];
    expect(projFiles.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(projDir, projFiles[0]), 'utf-8');
    // File should contain TBD for skipped fields
    expect(content).toContain('TBD');

    // Agent output should mention TBD fields at session end
    const output = result.output.toLowerCase();
    expect(output.includes('tbd') || output.includes('skipped')).toBe(true);
  });
});
