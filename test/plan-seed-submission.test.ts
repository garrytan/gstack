import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { submitPlanSeed } from './helpers/plan-seed-submission';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import { launchClaudePty, runPlanSkillObservation, isProseAUQVisible, isNumberedOptionListVisible, isPermissionDialogVisible } from './helpers/claude-pty-runner';

// A real PTY process consumes the actual paste/Enter/slash bytes and publishes
// its own PID status and transcript. No provider or runner hooks are installed.
const CLI = fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'plan-seed-cli.ts'), 'utf8');

for (const scenario of ['success', 'completed-tool', 'status-updating', 'history-empty-box',
  'startup-placeholder', 'startup-placeholder-cursor', 'startup-placeholder-unicode',
  'startup-typed-hint', 'startup-partial-dim', 'startup-prior-conversation', 'startup-missing-styles',
  'startup-waiting', 'startup-prose-question', 'startup-permission', 'startup-fresh-waiting',
  'no-ack', 'fused', 'duplicate', 'session-switch', 'foreign-cwd',
  'pending-tool', 'question', 'prose-question', 'permission', 'no-end-turn', 'partial', 'wrong-pid',
  'typed-current', 'multiline-current', 'history-box-typed-current', 'history-box-multiline-current',
  'missing-current-top', 'missing-current-bottom', 'mismatched-current-rules', 'unframed-current',
  'history-no-current', 'history-missing-current-top', 'history-missing-current-bottom',
  'stray-prompt-after-current', 'stale-response-frame',
  ...(process.platform === 'linux' ? ['wrong-start', 'wrong-domain'] : [])]) {
  test.skipIf(process.platform === 'win32')(`seed submission owns each protocol step: ${scenario}`, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-')));
    const config = path.join(dir, '.claude'); fs.mkdirSync(config);
    const script = path.join(dir, 'cli.ts'); fs.writeFileSync(script, CLI);
    const decoder = new PtyCurrentScreen({ cols: 120, rows: 40 });
    let raw = '', exited = false;
    const launchedAt = Date.now();
    const proc = Bun.spawn([process.execPath, script], {
      cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: config, SEED_CASE: scenario },
      terminal: { cols: 120, rows: 40, data(_terminal, data) { const s = Buffer.from(data).toString(); raw += s; decoder.feed(s); } },
      onExit() { exited = true; },
    });
    const sent: string[] = [];
    const session = {
      pid: () => proc.pid, exited: () => exited, hermeticConfigDir: config,
      send(s: string) { sent.push(s); proc.terminal!.write(s); },
      sendKey(key: string) { expect(key).toBe('Enter'); sent.push('\r'); proc.terminal!.write('\r'); },
      mark: () => raw.length,
      currentScreen: async () => { const mark = raw.length; const frame = await decoder.snapshot();
        if (scenario === 'startup-fresh-waiting') {
          const statusFile = path.join(config, 'sessions', `${proc.pid}.json`);
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          fs.writeFileSync(statusFile, JSON.stringify({ ...status, waitingFor: 'permission prompt' }));
        }
        return { text: frame.text, rawEnd: scenario === 'stale-response-frame' && sent.includes('\r') ? mark - 1 : mark,
        ...(scenario === 'startup-missing-styles' ? {} : { styledText: frame.styledText }) }; },
    };
    const seed = 'Please review when I run the skill:\n\n# Plan\nKeep $HOME and `literal` text.\n';
    const deadlineAt = launchedAt + 1100;
    try {
      let failure: unknown;
      try { await submitPlanSeed(session, seed, { cwd: dir, launchedAt, deadlineAt,
        isQuestionOrPermission: text => isProseAUQVisible(text) || isNumberedOptionListVisible(text) || isPermissionDialogVisible(text) }); }
      catch (error) { failure = error; }
      if (['success', 'completed-tool', 'status-updating', 'history-empty-box', 'startup-placeholder', 'startup-placeholder-cursor', 'startup-placeholder-unicode'].includes(scenario)) {
        expect(failure).toBeUndefined();
        session.send('/plan-eng-review\r');
        await Bun.sleep(50);
        const events = fs.readFileSync(path.join(config, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        expect(events.map(e => e.kind)).toEqual(['paste', 'enter', 'end_turn', 'slash']);
        expect(events.slice(0, 3).every(e => e.value === seed)).toBe(true);
        expect(sent).toEqual([`\x1b[200~${seed}\x1b[201~`, '\r', '/plan-eng-review\r']);
      } else {
        expect(failure).toBeInstanceOf(Error);
        const expected = ({ fused: 'fused, duplicated, or changed', duplicate: 'fused, duplicated, or changed',
          'session-switch': 'native session changed', 'foreign-cwd': 'Foreign cwd',
          question: 'requires an answer', 'prose-question': 'requires an answer', 'wrong-pid': 'does not match this launch',
          'wrong-start': 'native process identity changed', 'wrong-domain': 'native process identity changed' } as Record<string, string>)[scenario]
          ?? 'existing case budget';
        expect((failure as Error).message).toContain(expected);
        expect(sent.some(s => s === '/plan-eng-review\r')).toBe(false);
        expect(sent.filter(s => s === '\r').length).toBeLessThanOrEqual(1);
        if (scenario.startsWith('startup-')) expect(sent).toEqual([]);
      }
      expect(Date.now() - deadlineAt).toBeLessThan(500);
    } finally {
      if (!exited) proc.kill();
      await proc.exited;
      proc.terminal?.close(); decoder.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 6000);
}

for (const inheritedTerm of ['dumb', '', 'xterm-256color']) test.skipIf(process.platform === 'win32')(`actual PTY launcher carries placeholder styling into owned seed submission: ${inheritedTerm || 'empty TERM'}`, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-launcher-')));
  const config = path.join(dir, '.claude'); fs.mkdirSync(config);
  const script = path.join(dir, 'cli.ts'); fs.writeFileSync(script, `#!${process.execPath}\n${CLI}`, { mode: 0o700 });
  const old = process.env.BROWSE_TERMINAL_BINARY; process.env.BROWSE_TERMINAL_BINARY = script;
  const launchedAt = Date.now(); let session: Awaited<ReturnType<typeof launchClaudePty>> | undefined;
  try {
    session = await launchClaudePty({ cwd: dir, observeScreen: true, permissionMode: 'plan', timeoutMs: 4000, model: 'fixture',
      env: { CLAUDE_CONFIG_DIR: config, SEED_CASE: 'startup-terminal-placeholder-cursor', TERM: inheritedTerm } });
    const seed = '# Real launcher seed\nKeep this exact plan.';
    await submitPlanSeed({...session, currentScreen: session.currentScreenFrame}, seed, { cwd: dir, launchedAt, deadlineAt: launchedAt + 2500,
      isQuestionOrPermission: text => isProseAUQVisible(text) || isNumberedOptionListVisible(text) || isPermissionDialogVisible(text) });
    session.send('/plan-eng-review\r'); await Bun.sleep(50);
    const events = fs.readFileSync(path.join(config, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events.map(e => e.kind)).toEqual(['paste', 'enter', 'end_turn', 'slash']);
    expect(events.slice(0, 3).every(e => e.value === seed)).toBe(true);
  } finally {
    try { await session?.close(); }
    finally {
      if (old === undefined) delete process.env.BROWSE_TERMINAL_BINARY; else process.env.BROWSE_TERMINAL_BINARY = old;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}, 6000);

for (const mode of ['unseeded-deadline', 'seeded-deadline', 'protocol-error']) test.skipIf(process.platform === 'win32')(`actual observation caller preserves preflight outcome: ${mode}`, async () => {
  const seeded = mode !== 'unseeded-deadline';
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-budget-')));
  const config = path.join(dir, '.claude'); fs.mkdirSync(config);
  const script = path.join(dir, 'cli.ts');
  fs.writeFileSync(script, `#!${process.execPath}\n${CLI}`, { mode: 0o700 });
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-timeout-artifacts-'));
  const priorEval = { EVALS_RUN_ID: process.env.EVALS_RUN_ID, GSTACK_EVAL_DIR: process.env.GSTACK_EVAL_DIR };
  process.env.EVALS_RUN_ID = 'seed-timeout'; process.env.GSTACK_EVAL_DIR = artifactRoot;
  const old = process.env.BROWSE_TERMINAL_BINARY;
  process.env.BROWSE_TERMINAL_BINARY = script;
  try {
    const run = runPlanSkillObservation({ skillName: 'plan-eng-review', cwd: dir,
      ...(seeded ? { initialPlanContent: '# Exact plan\nNo new work allowance.' } : {}), timeoutMs: mode === 'protocol-error' ? 10000 : 600, model: 'fixture',
      env: { CLAUDE_CONFIG_DIR: config, SEED_CASE: mode === 'protocol-error' ? 'wrong-pid' : 'success' } });
    if (mode === 'protocol-error') {
      await expect(run).rejects.toThrow('Plan seed PID status does not match this launch');
      expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
      return;
    }
    const obs = await run;
    expect(obs.outcome).toBe('timeout');
    expect(obs.summary).toContain('existing case budget');
    expect(obs.scopeGateAutoSelectObserved).toBe(false);
    expect(obs.elapsedMs).toBeLessThan(1600);
    expect(obs.artifactDir).toStartWith(artifactRoot);
    fs.rmSync(dir, { recursive: true, force: true });
    const saved = JSON.parse(fs.readFileSync(path.join(obs.artifactDir!, 'observation.json'), 'utf8'));
    expect(saved.state).toBe('plan_skill_preflight_timeout');
    expect(saved.summary).toBe(obs.summary);
    if (!seeded) expect(saved.viewportError).toContain('screen observation was not enabled');
    else expect(saved.viewportError).toBeUndefined();
    for (const name of ['terminal.raw.log', 'terminal.visible.log', ...(seeded ? ['terminal.screen.log'] : [])]) {
      expect(fs.existsSync(path.join(obs.artifactDir!, name))).toBe(true);
      expect(fs.statSync(path.join(obs.artifactDir!, name)).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
  } finally {
    if (old === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = old;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(priorEval)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 15000);

for (const entry of [
  { name: 'plan seed', seeded: true, inPlanMode: true, extraArgs: [], env: {}, expectedHint: 'active' },
  { name: 'outside plan mode', inPlanMode: false, extraArgs: [], env: {}, expectedHint: null },
  { name: 'explicit inactive hint', inPlanMode: true, extraArgs: [], env: { GSTACK_PLAN_MODE: 'inactive' }, expectedHint: 'inactive' },
  { name: 'explicit outside hint', inPlanMode: false, extraArgs: [], env: { GSTACK_PLAN_MODE: 'active' }, expectedHint: 'active' },
  { name: 'separate CLI override', inPlanMode: true, extraArgs: ['--permission-mode', 'auto'], env: {}, expectedHint: null },
  { name: 'equals CLI override', inPlanMode: true, extraArgs: ['--permission-mode=default'], env: {}, expectedHint: null },
  { name: 'unrelated CLI option', inPlanMode: true, extraArgs: ['--disallowedTools', 'AskUserQuestion'], env: {}, expectedHint: 'active' },
]) test.skipIf(process.platform === 'win32')(`actual observation launch preserves initial plan hint: ${entry.name}`, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-hint-')));
  const config = path.join(dir, '.claude'); fs.mkdirSync(config);
  const script = path.join(dir, 'cli.ts');
  fs.writeFileSync(script, `#!${process.execPath}\n${CLI}`, { mode: 0o700 });
  const old = process.env.BROWSE_TERMINAL_BINARY;
  process.env.BROWSE_TERMINAL_BINARY = script;
  try {
    const plan = '# Existing plan\nKeep the review scope.';
    const obs = await runPlanSkillObservation({ skillName: 'plan-eng-review', cwd: dir,
      inPlanMode: entry.inPlanMode, extraArgs: entry.extraArgs,
      ...(entry.seeded ? { initialPlanContent: plan } : {}), timeoutMs: entry.seeded ? 12000 : 600, model: 'fixture',
      env: { CLAUDE_CONFIG_DIR: config, SEED_CASE: entry.seeded ? 'observation-scope-hint' : 'success', ...entry.env } });
    const launch = JSON.parse(fs.readFileSync(path.join(config, 'launch.json'), 'utf8'));
    const sessionIndex = launch.argv.indexOf('--session-id');
    if (entry.seeded) expect(launch.argv[sessionIndex + 1]).toMatch(/^[0-9a-f-]{36}$/);
    else expect(sessionIndex).toBe(-1);
    expect(entry.seeded ? launch.argv.slice(0, sessionIndex) : launch.argv).toEqual([
      '--model', 'fixture', ...(entry.inPlanMode ? ['--permission-mode', 'plan'] : []),
      '--strict-mcp-config', ...entry.extraArgs]);
    expect(launch.planModeHint).toBe(entry.expectedHint);
    expect(launch.planModeForce).toBeNull();
    if (entry.seeded) {
      expect(obs.outcome).toBe('asked');
      // The fixture supplies no mode announcement: wiring proof is not native
      // announcement-compliance proof and must not manufacture that flag.
      expect(obs.scopeGateAutoSelectObserved).toBe(false);
      const seed = `Keep this draft plan as context. Briefly acknowledge receipt, then wait for my next message containing a slash command. Do not start the review or call tools yet.\n\n${plan}`;
      const events = fs.readFileSync(path.join(config, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(events.map(e => e.kind)).toEqual(['paste', 'enter', 'end_turn', 'slash']);
      expect(events.slice(0, 3).every(e => e.value === seed)).toBe(true);
      expect(events[3].value).toBe('/plan-eng-review\r');
    } else {
      expect(obs.outcome).toBe('timeout');
      expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
    }
  } finally {
    if (old === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 18000);
