/** Free regression coverage: real detector/verifier, owned fakes, no model calls. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHermeticEnv } from './helpers/hermetic-env';
import type { QueryProvider } from './helpers/agent-sdk-runner';
import type { EvalCollector, EvalTestEntry } from './helpers/eval-store';
import { createSetupGbrainSandbox, runSetupGbrainAttempt } from './helpers/setup-gbrain-sandbox';
import { chooseLocalPgliteFixtureAnswer } from './helpers/setup-gbrain-fixture';

const originalClaudeMd = '# Fixture project\nKeep this content.\n';
async function command(bin: string, args: string[], env: Record<string, string>) {
  const child = Bun.spawn([bin, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('setup-gbrain documented lock acquisition', () => {
  test.each(['fresh-home', 'existing-lock', 'parent-file', 'lock-file'])('%s retains the actual acquisition outcome', async scenario => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-lock-'));
    const parent = path.join(home, '.gstack');
    const lock = path.join(parent, '.setup-gbrain.lock.d');
    try {
      if (scenario === 'parent-file') fs.writeFileSync(parent, 'preserve parent file');
      if (scenario === 'existing-lock') {
        fs.mkdirSync(lock, { recursive: true });
        fs.writeFileSync(path.join(lock, 'owner'), 'preserve owner');
      }
      if (scenario === 'lock-file') {
        fs.mkdirSync(parent);
        fs.writeFileSync(lock, 'preserve lock file');
      }
      const source = fs.readFileSync(path.join(import.meta.dir, '..', 'setup-gbrain', 'SKILL.md.tmpl'), 'utf8');
      const script = source.match(/\*\*Concurrent-run lock\.\*\*[\s\S]*?```bash\n([\s\S]*?)\n  ```/)?.[1];
      expect(script).toBeDefined();
      const result = await command('bash', ['-c', script!], { ...process.env, HOME: home } as Record<string, string>);
      expect(result.exitCode).toBe(scenario === 'fresh-home' ? 0 : 1);
      if (scenario === 'fresh-home') {
        expect(fs.statSync(lock).isDirectory()).toBe(true);
        expect(result.stderr).toBe('');
      } else {
        expect(result.stderr).toContain('mkdir:');
        expect(result.stderr.includes('Another /setup-gbrain instance')).toBe(scenario === 'existing-lock');
        if (scenario === 'existing-lock') expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('preserve owner');
        if (scenario === 'parent-file') {
          expect(result.stderr).toContain('Cannot create setup-gbrain lock parent');
          expect(fs.readFileSync(parent, 'utf8')).toBe('preserve parent file');
        }
        if (scenario === 'lock-file') {
          expect(result.stderr).toContain('Cannot acquire setup-gbrain lock');
          expect(fs.readFileSync(lock, 'utf8')).toBe('preserve lock file');
        }
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('setup-gbrain owned Path 4 fixture', () => {
  for (const status of [401, 200] as const) {
    test(`real verifier/detector exercise ${status} with a fresh MCP state and explicit child token`, async () => {
      const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-free-evidence-'));
      const ambient = { HOME: process.env.HOME, PATH: process.env.PATH, GSTACK_HOME: process.env.GSTACK_HOME, GBRAIN_MCP_TOKEN: process.env.GBRAIN_MCP_TOKEN };
      const fixture = await createSetupGbrainSandbox({
        name: `http-${status}`, status, originalClaudeMd,
        sections: ['brain-init.md', 'claude-md-persist.md'], evidenceRoot,
      });
      try {
        // Deliberately contaminated parent: only explicit overrides should survive.
        const env = buildHermeticEnv({ PATH: process.env.PATH, EVALS_HERMETIC: '1', GBRAIN_MCP_TOKEN: 'ambient-wrong', GBRAIN_HOME: '/unowned' }, {}, fixture.env);
        expect(env.GBRAIN_MCP_TOKEN === fixture.token).toBe(true);
        expect(env.HOME).toBe(fixture.home);
        expect(Object.entries(ambient).every(([key, value]) => process.env[key] === value)).toBe(true);
        const skill = fs.readFileSync(fixture.skillPath, 'utf8');
        expect(skill.includes('~/.claude/skills/gstack/bin/')).toBe(false);
        expect(skill.includes(`${fixture.bin}'/gstack-gbrain-install`)).toBe(true);
        expect(skill.includes('Want symbol-aware code search')).toBe(true);
        const detectPath = path.join(fixture.bin, 'gstack-gbrain-detect');
        const before = await command(detectPath, [], env);
        expect(before.exitCode).toBe(0);
        expect(JSON.parse(before.stdout).gbrain_mcp_mode).toBe('none');
        expect(JSON.parse(before.stdout).gbrain_local_status).toBe('missing-config');
        const verifier = path.join(fixture.bin, 'gstack-gbrain-mcp-verify');
        // Missing-token contrast reproduces the original pre-HTTP failure safely.
        const missing = await command(verifier, [fixture.url], { ...env, GBRAIN_MCP_TOKEN: '' });
        expect(missing.exitCode).toBe(2);
        expect(fixture.requests.length).toBe(0);
        const verified = await command(verifier, [fixture.url], env);
        expect(verified.exitCode).toBe(status === 401 ? 1 : 0);
        const output = JSON.parse(verified.stdout);
        expect(output.status).toBe(status === 401 ? 'auth' : 'success');
        expect(output.error_class).toBe(status === 401 ? 'AUTH' : null);
        if (status === 401) expect(output.error_text.includes('rotate token on the brain host')).toBe(true);
        expect(fixture.requests.map((r) => r.rpcMethod)).toEqual(status === 401 ? ['initialize'] : ['initialize', 'tools/list']);
        expect(fixture.requests.every((r) => r.method === 'POST' && r.authorizationPresent && r.authorizationMatches && r.status === status)).toBe(true);
        expect(verified.stdout.includes(fixture.token)).toBe(false);
        expect(fixture.snapshot().mcp.registered).toBe(false);
        expect(fixture.snapshot().claudeMdUnchanged).toBe(true);
        if (status === 200) {
          const installer = await command(path.join(fixture.bin, 'gstack-gbrain-install'), [], env);
          expect(installer.exitCode).toBe(0);
          expect((await command(path.join(fixture.bin, 'gbrain'), ['init', '--pglite', '--json'], env)).exitCode).toBe(0);
          const registration = await command(path.join(fixture.bin, 'claude'), [
            'mcp', 'add', '--scope', 'user', '--transport', 'http', 'gbrain', fixture.url,
            '--header', `Authorization: Bearer ${fixture.token}`,
          ], { ...env, GBRAIN_MCP_TOKEN: '' });
          expect(registration.exitCode).toBe(0);
          const after = await command(detectPath, [], env);
          expect(after.exitCode).toBe(0);
          expect(JSON.parse(after.stdout).gbrain_mcp_mode).toBe('remote-http');
          expect(JSON.parse(after.stdout).gbrain_engine).toBe('pglite');
          expect(JSON.parse(after.stdout).gbrain_local_status).toBe('ok');
          expect((await command(path.join(fixture.bin, 'claude'), ['mcp', 'remove', 'gbrain'], env)).exitCode).toBe(0);
          expect(JSON.parse((await command(detectPath, [], env)).stdout).gbrain_mcp_mode).toBe('none');
        }
        const calls = fixture.commands();
        expect(calls.some((c) => c.command === 'gstack-gbrain-mcp-verify' && c.phase === 'start' && c.tokenPresent && c.tokenMatches && c.homeMatches && c.gstackHomeMatches)).toBe(true);
        expect(JSON.stringify(calls).includes(fixture.token)).toBe(false);
        fixture.retain({ stage: 'free-probe-completed' });
        const evidence = fs.readFileSync(fixture.evidencePath, 'utf8');
        expect(evidence.includes(fixture.token)).toBe(false);
        expect(JSON.parse(evidence).initial.mcp.registered).toBe(false);
        expect(JSON.parse(evidence).final.claudeMdTokenLeak).toBe(false);
      } finally {
        await fixture.cleanup();
        fs.rmSync(evidenceRoot, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test.each(['deadline', 'caller'])('SDK deadline or caller cancellation closes the query before cleanup (%s)', async mode => {
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-deadline-evidence-'));
    const fixture = await createSetupGbrainSandbox({
      name: 'deadline', status: 401, originalClaudeMd, sections: ['brain-init.md'], evidenceRoot,
    });
    let calls = 0;
    let closes = 0;
    let aborted = false;
    let validated = false;
    let aliveAtClose = false;
    const rows: EvalTestEntry[] = [];
    let release = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let callerTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const queryProvider: QueryProvider = (input) => {
      calls++;
      input.options!.abortController!.signal.addEventListener('abort', () => { aborted = true; });
      if (mode === 'caller') callerTimer = setTimeout(() => controller.abort(new Error('caller cancellation')), 250);
      return Object.assign((async function* () {
        yield { type: 'system', subtype: 'init' };
        // Finite fallback makes the baseline fail without leaving model work.
        await new Promise<void>(resolve => { release = resolve; timer = setTimeout(resolve, 900); });
        yield { type: 'result', subtype: 'success', num_turns: 0, total_cost_usd: 0 };
      })(), { close: () => {
        closes++;
        aliveAtClose = fs.existsSync(fixture.home);
        clearTimeout(timer);
        release();
      } }) as ReturnType<QueryProvider>;
    };
    try {
      let failure = '';
      try {
        await runSetupGbrainAttempt(fixture, {
          systemPrompt: '', userPrompt: 'free deadline probe', queryProvider,
          pathToClaudeCodeExecutable: '/nonexistent/free-test-never-spawn-claude',
          signal: controller.signal,
        }, () => { validated = true; }, mode === 'deadline' ? 250 : 1000, {
          collector: { addTest: (row: EvalTestEntry) => rows.push(row) } as EvalCollector,
          name: 'setup-gbrain-path4-local-pglite', suite: 'setup-gbrain',
        });
      } catch (error) { failure = String(error); }
      expect(failure).toContain(mode === 'deadline' ? 'attempt exceeded' : 'caller cancellation');
      expect(calls).toBe(1);
      expect(aborted).toBe(true);
      expect(closes).toBe(1);
      expect(aliveAtClose).toBe(true);
      expect(validated).toBe(false);
      expect(rows).toHaveLength(1);
      expect(rows[0].passed).toBe(false);
      expect(rows[0].exit_reason).toBe(mode === 'deadline' ? 'timeout' : 'harness_error');
      expect(rows[0].error).toContain(mode === 'deadline' ? 'attempt exceeded' : 'caller cancellation');
      expect(fs.existsSync(fixture.root)).toBe(false);
      const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath, 'utf8'));
      expect(evidence.stage).toBe('failed');
      expect(evidence.failure).toContain(mode === 'deadline' ? 'attempt exceeded' : 'caller cancellation');
    } finally {
      clearTimeout(timer);
      clearTimeout(callerTimer);
      release();
      await fixture.cleanup();
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test('caller cancellation during asynchronous validation retains failure', async () => {
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-validation-cancel-'));
    const fixture = await createSetupGbrainSandbox({
      name: 'validation-cancel', status: 401, originalClaudeMd, sections: ['brain-init.md'], evidenceRoot,
    });
    const controller = new AbortController();
    const rows: EvalTestEntry[] = [];
    const queryProvider: QueryProvider = () => (async function* () {
      yield { type: 'result', subtype: 'success', num_turns: 0, total_cost_usd: 0 };
    })() as ReturnType<QueryProvider>;
    try {
      await expect(runSetupGbrainAttempt(fixture, {
        systemPrompt: '', userPrompt: 'free validation cancellation probe', queryProvider,
        pathToClaudeCodeExecutable: '/nonexistent/free-test-never-spawn-claude', signal: controller.signal,
      }, async () => {
        await Promise.resolve();
        controller.abort(new Error('caller cancelled during validation'));
      }, 1000, {
        collector: { addTest: (row: EvalTestEntry) => rows.push(row) } as EvalCollector,
        name: 'setup-gbrain-path4-local-pglite', suite: 'setup-gbrain',
      })).rejects.toThrow('caller cancelled during validation');
      expect(rows).toHaveLength(1);
      expect(rows[0].passed).toBe(false);
      expect(rows[0].error).toContain('caller cancelled during validation');
      const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath, 'utf8'));
      expect(evidence.stage).toBe('failed');
      expect(evidence.failure).toContain('caller cancelled during validation');
      expect(fs.existsSync(fixture.root)).toBe(false);
    } finally {
      await fixture.cleanup();
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  test('SDK failure/exception evidence is unique, redacted, and retained before assertions and cleanup', async () => {
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-attempt-evidence-'));
    const paths: string[] = [];
    try {
      for (const mode of ['assertion', 'max-turns', 'throw', 'success'] as const) {
        const fixture = await createSetupGbrainSandbox({
          name: 'same-retry-name', status: 401, originalClaudeMd, sections: ['brain-init.md'], evidenceRoot,
        });
        paths.push(fixture.evidencePath);
        let assertionsRun = false;
        let providerCalls = 0;
        const rows: EvalTestEntry[] = [];
        const credentialUrl = ['https://fixture:', 'syntheticStreamCredential923', '@example.test/mcp'].join('');
        const privateBlock = { type: 'thinking',
          get thinking(): never { throw new Error('private stream thinking accessed'); },
          get signature(): never { throw new Error('private stream signature accessed'); } };
        const queryProvider: QueryProvider = (input) => {
          providerCalls++;
          expect(input.options?.env?.GBRAIN_MCP_TOKEN === fixture.token).toBe(true);
          expect(input.options?.env?.HOME).toBe(fixture.home);
          return (async function* () {
            yield { type: 'system', subtype: 'init', claude_code_version: 'fixture-cli',
              get apiKeySource(): never { throw new Error('private init credential field accessed'); } };
            const questions = [{ question: 'Want symbol-aware code search?', options: [{ label: 'Yes, local PGLite' }] }];
            await input.options!.canUseTool!('AskUserQuestion', { questions }, {
              signal: new AbortController().signal, toolUseID: 'fixture-question',
            });
            yield { type: 'assistant', message: { content: [privateBlock,
              { type: 'text', text: `synthetic diagnostic ${fixture.token} ${credentialUrl}` },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: `fixture probe ${credentialUrl}` } },
            ] } };
            yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1',
              content: [privateBlock, { type: 'text', text: `result ${fixture.token} ${credentialUrl}` }] }] } };
            if (mode === 'throw') throw new Error(`fixture stream failed ${fixture.token} ${credentialUrl}`);
            yield { type: 'result', subtype: mode === 'max-turns' ? 'error_max_turns' : 'success', num_turns: 1, total_cost_usd: 0,
              get result(): never { throw new Error('private raw result field accessed'); } };
          })() as ReturnType<QueryProvider>;
        };
        let thrown = '';
        try {
          await runSetupGbrainAttempt(fixture, {
            systemPrompt: '', userPrompt: 'free fixture probe', queryProvider,
            canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: {
              ...input, answers: { 'Want symbol-aware code search?': 'Yes, local PGLite' },
            } }),
          }, () => {
            assertionsRun = true;
            const before = fs.readFileSync(fixture.evidencePath, 'utf8');
            expect(before.includes(fixture.token)).toBe(false);
            expect(before).not.toContain('syntheticStreamCredential923');
            expect(before).not.toContain('thinking');
            expect(before).not.toContain('apiKeySource');
            expect(JSON.parse(before).stage).toBe('before-assertions');
            if (mode === 'assertion') {
              fs.appendFileSync(path.join(fixture.home, 'CLAUDE.md'), fixture.token);
              throw new Error(`assertion diagnostic ${fixture.token} ${credentialUrl}`);
            }
          }, undefined, {
            collector: { addTest: (row: EvalTestEntry) => rows.push(row) } as EvalCollector,
            name: 'setup-gbrain-path4-local-pglite', suite: 'setup-gbrain',
          });
        } catch (error) { thrown = String(error); }
        expect(thrown.includes(fixture.token)).toBe(false);
        expect(thrown).not.toContain('syntheticStreamCredential923');
        expect(thrown.length > 0).toBe(mode !== 'success');
        expect(rows).toHaveLength(1);
        expect(rows[0].passed).toBe(mode === 'success');
        expect(rows[0].exit_reason).toBe(mode === 'throw' ? 'harness_error' : mode === 'max-turns' ? 'error_max_turns' : 'success');
        expect(JSON.stringify(rows)).not.toContain(fixture.token);
        expect(JSON.stringify(rows)).not.toContain('syntheticStreamCredential923');
        expect(JSON.stringify(rows)).not.toContain('thinking');
        expect(JSON.stringify(rows)).not.toContain('apiKeySource');
        expect(providerCalls).toBe(1);
        expect(assertionsRun).toBe(mode === 'assertion' || mode === 'success');
        expect(fs.existsSync(fixture.root)).toBe(false);
        const raw = fs.readFileSync(fixture.evidencePath, 'utf8');
        expect(raw.includes(fixture.token)).toBe(false);
        expect(raw).not.toContain('syntheticStreamCredential923');
        expect(raw).not.toContain('thinking');
        expect(raw).not.toContain('apiKeySource');
        const evidence = JSON.parse(raw);
        expect(evidence.stage).toBe(mode === 'success' ? 'passed' : 'failed');
        expect(evidence.configuration.tokenPresent && evidence.configuration.tokenMatches).toBe(true);
        expect(evidence.configuration.homeMatches && evidence.configuration.gstackHomeMatches && evidence.configuration.ownedBinFirst).toBe(true);
        expect(evidence.events.some((e: { type: string }) => e.type === 'user')).toBe(true);
        expect(evidence.permissions[0].decision.updatedInput.answers['Want symbol-aware code search?']).toBe('Yes, local PGLite');
        expect(evidence.final.claudeMdTokenLeak).toBe(mode === 'assertion');
        expect(evidence.modelOutputTokenLeak).toBe(mode !== 'throw');
      }
      expect(new Set(paths).size).toBe(4);
      expect(paths.every((file) => fs.existsSync(file))).toBe(true);
    } finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }
  }, 30_000);
});

describe('setup-gbrain local-PGLite fixture answers', () => {
  // Captured failing Step 4d offer: its explanation mentions artifacts, while
  // the actual offered decision is whether to install local code search.
  const localQuestion = {
  "question": "Want symbol-aware code search on this machine?\n\nThe remote brain at http://127.0.0.1:39563/mcp is great for cross-machine knowledge, but symbol queries like `gbrain code-def` / `code-refs` / `code-callers` need a local index of THIS machine's code. We can spin up a tiny isolated PGLite database (~30 seconds, no accounts, ~120 MB disk) just for code, separate from your remote brain. Transcripts and artifacts continue routing through the artifacts repo to the remote brain — local PGLite stays code-only.\n\nStakes: without it, semantic code search in this repo's worktrees falls back to Grep.\nRecommendation: A — 30 seconds, no ongoing cost, unlocks the symbol tools.\nCompleteness: A=10/10 (full split-engine), B=7/10 (remote-only).",
  "header": "Code search",
  "options": [
    {
      "label": "Yes, set up local PGLite for code",
      "description": "Unlocks `gbrain code-def`, `code-refs`, `code-callers` per worktree. Independent engine — won't disturb remote brain or share transcripts. (Recommended)"
    },
    {
      "label": "No, remote MCP only",
      "description": "Zero local state — only ~/.claude.json MCP registration. Symbol code queries fall back to Grep in this repo's worktrees."
    }
  ],
  "multiSelect": false
};
  const artifactsQuestion = {
  "question": "Also sync your gstack artifacts (CEO plans, designs, reports, retros) to a private git repo that gbrain can index across machines?",
  "header": "Artifacts sync",
  "options": [
    {
      "label": "Yes, full sync",
      "description": "Sync everything allowlisted (plans, designs, retros, behavioral data) to a private git repo."
    },
    {
      "label": "Yes, artifacts-only",
      "description": "Sync plans, designs, retros — skip behavioral data."
    },
    {
      "label": "No thanks",
      "description": "Skip artifacts sync for now. You can set this up later."
    }
  ],
  "multiSelect": false
};

  test('opts into the captured local-PGLite offer despite artifacts context', () => {
    expect(chooseLocalPgliteFixtureAnswer(localQuestion)).toBe('Yes, set up local PGLite for code');
    expect(chooseLocalPgliteFixtureAnswer({ ...localQuestion, options: [...localQuestion.options].reverse() }))
      .toBe('Yes, set up local PGLite for code');
  });

  test.each([
    ['Yes, local PGLite', 'No, remote only'],
    ['Yes, local PGLite', 'No remote only'],
    ['A) Yes — local PGLite', 'B) No — remote only'],
  ])('remote-only spelling preserves the local setup decision: %s / %s', (yes, no) => {
    // The live SDK offered the first pair, then the callback threw before
    // recording its answer. The optional MCP qualifier changes no action.
    const question = { ...localQuestion, options: [{ label: yes }, { label: no }] };
    expect(chooseLocalPgliteFixtureAnswer(question)).toBe(yes);
    expect(chooseLocalPgliteFixtureAnswer({ ...question, options: [...question.options].reverse() })).toBe(yes);
  });

  test.each([
    'No, remote only and delete local state',
    'No, remote only (and upload transcripts)',
    'No, remote only; enable artifacts sync',
    'No, remote',
  ])('remote-only spelling does not authorize extra or incomplete actions: %s', no => {
    expect(() => chooseLocalPgliteFixtureAnswer({
      ...localQuestion, options: [{ label: 'Yes, local PGLite' }, { label: no }],
    })).toThrow('Unrecognized or ambiguous');
  });

  test('remote-only spelling still rejects duplicated declines and mixed decision families', () => {
    for (const extra of ['No, remote MCP only', 'Yes, full sync']) {
      expect(() => chooseLocalPgliteFixtureAnswer({
        ...localQuestion, options: ['Yes, local PGLite', 'No, remote only', extra].map(label => ({ label })),
      })).toThrow('Unrecognized or ambiguous');
    }
  });


  test('accepts captured formal local-code labels and returns the exact offered answer', () => {
    const capturedLabels = [
      ['A) Yes, set up local PGLite for code (Recommended)', 'B) No, remote MCP only'],
      ['A) Yes, set up local PGLite for code', 'B) No, remote MCP only'],
      ['A) Yes — set up local PGLite for code (recommended)', 'B) No — remote MCP only'],
      ['Yes — set up local PGLite for code (recommended)', 'No — remote MCP only'],
    ];
    for (const labels of capturedLabels) {
      const question = { ...localQuestion, options: labels.map(label => ({ label })) };
      expect(chooseLocalPgliteFixtureAnswer(question)).toBe(labels[0]);
      expect(chooseLocalPgliteFixtureAnswer({ ...question, options: [...question.options].reverse() })).toBe(labels[0]);
    }
    for (const [yes, no] of [
      ['1) Yes, local PGLite', '2) No, remote MCP only'],
      ['A. Yes, local PGLite', 'B. No, remote MCP only'],
    ]) expect(chooseLocalPgliteFixtureAnswer({ ...localQuestion, options: [{ label: yes }, { label: no }] })).toBe(yes);
    expect(chooseLocalPgliteFixtureAnswer({ ...artifactsQuestion, options: [
      { label: 'A) Yes, full sync (everything allowlisted)' },
      { label: 'B) Yes, artifacts-only' }, { label: 'C) No thanks' },
    ] })).toBe('C) No thanks');
    expect(chooseLocalPgliteFixtureAnswer({ question: 'Where should your brain live?', options: [
      { label: 'A) Local PGLite' }, { label: 'B) Remote gbrain MCP (Path 4)' },
    ] })).toBe('B) Remote gbrain MCP (Path 4)');
  });

  test('formal label normalization keeps inconsistent, unknown and mixed-action menus closed', () => {
    const yes = 'Yes, set up local PGLite for code';
    const no = 'No, remote MCP only';
    for (const labels of [
      [`A) ${yes}`, `A) ${no}`], // duplicate selector
      [`A) ${yes}`, `C) ${no}`], // incomplete inventory
      [`A) ${yes}`, no], // partial decoration
      [`A) ${yes}`, `2) ${no}`], // mixed selector families
      [`A) ${yes}`, `B. ${no}`], // mixed punctuation
      [`A) ${yes}`, `E) ${no}`], // unsupported selector
      [`A) ${yes}`, `B) ${no}`, 'C) Publish secrets'],
      [`A) ${yes}`, `B) ${no}`, 'C) Yes, full sync'],
      ['A) Yes — delete existing state and set up local PGLite for code', `B) ${no}`],
      [`A) ${yes}`, 'B) No — remote MCP only and publish diagnostics'],
      ['A) Yes (Recommended)', 'B) No thanks'],
      ['A) Local PGLite', 'B) Remote gbrain MCP (Path 40)'],
      ['A) Local PGLite', 'B) Path 40 — remote gbrain MCP'],
      ['A) Yes, full sync (including secrets)', 'B) No thanks'],
      ['A) Yes, artifacts-only (plans, designs, retros — skip behavioral data)', 'B) No thanks'],
    ]) expect(() => chooseLocalPgliteFixtureAnswer({
      question: 'Captured label guard', options: labels.map(label => ({ label })),
    })).toThrow('Unrecognized or ambiguous');
  });

  test('declines the actual captured artifacts-sync offer', () => {
    expect(chooseLocalPgliteFixtureAnswer(artifactsQuestion)).toBe('No thanks');
    expect(chooseLocalPgliteFixtureAnswer({
      ...artifactsQuestion, question: artifactsQuestion.question + ' Local PGLite remains code-only.',
    })).toBe('No thanks');
  });

  test('declines the September 8 captured full-sync qualifier without accepting other qualifiers', () => {
    // Captured native Step 7 menu: the qualifier describes the known full-sync action.
    const captured = {
      ...artifactsQuestion,
      options: [
        { label: 'Yes, full sync (everything allowlisted)' },
        { label: 'Yes, artifacts-only' },
        { label: 'No thanks' },
      ],
    };
    expect(chooseLocalPgliteFixtureAnswer(captured)).toBe('No thanks');
    expect(chooseLocalPgliteFixtureAnswer({ ...captured, options: [...captured.options].reverse() }))
      .toBe('No thanks');
    for (const label of [
      'Yes, full sync (including secrets)',
      'Yes, full sync (everything allowlisted; publish publicly)',
      'Yes, artifacts-only (everything allowlisted)',
    ]) {
      expect(() => chooseLocalPgliteFixtureAnswer({
        ...captured, options: [{ label }, ...captured.options.slice(1)],
      })).toThrow('Unrecognized or ambiguous');
    }
    expect(() => chooseLocalPgliteFixtureAnswer({
      ...captured, options: [...captured.options, localQuestion.options[0]],
    })).toThrow('Unrecognized or ambiguous');
  });

  test('preserves explicit Path 4 selection', () => {
    expect(chooseLocalPgliteFixtureAnswer({
      question: 'Where should your brain live?',
      options: [{ label: 'Local PGLite' }, { label: 'Remote gbrain MCP (Path 4)' }],
    })).toBe('Remote gbrain MCP (Path 4)');
  });

  test('does not accept an unrelated yes or recommended choice', () => {
    expect(() => chooseLocalPgliteFixtureAnswer({
      question: 'Upload diagnostics?',
      options: [{ label: 'Yes (Recommended)' }, { label: 'No thanks' }],
    })).toThrow('Unrecognized or ambiguous');
  });

  test('rejects mixed action menus rather than silently choosing one', () => {
    expect(() => chooseLocalPgliteFixtureAnswer({
      question: 'Select a setup action', options: [...localQuestion.options, ...artifactsQuestion.options],
    })).toThrow('Unrecognized or ambiguous');
  });
  test('rejects explicit remote choices mixed with local opt-in or sync actions', () => {
    for (const options of [
      [{ label: 'Remote MCP (Path4)' }, { label: 'Yes, artifacts-only' }, { label: 'No thanks' }],
      [...localQuestion.options, { label: 'Remote MCP (Path4)' }],
    ]) {
      expect(() => chooseLocalPgliteFixtureAnswer({ question: 'Choose a setup action', options }))
        .toThrow('Unrecognized or ambiguous');
    }
  });

  test('rejects unknown affirmative actions alongside a recognized decision', () => {
    for (const options of [
      [...localQuestion.options, { label: 'Yes, upload diagnostics' }],
      [...artifactsQuestion.options, { label: 'Yes, delete the remote database' }],
    ]) {
      expect(() => chooseLocalPgliteFixtureAnswer({ question: 'Choose a setup action', options }))
        .toThrow('Unrecognized or ambiguous');
    }
  });

  test('rejects destructive labels and Path40 substring collisions', () => {
    for (const options of [
      [{ label: 'Yes, remove local PGLite' }, { label: 'No, remote MCP only' }],
      [{ label: 'Local PGLite' }, { label: 'Remove remote MCP' }],
      [{ label: 'Local PGLite' }, { label: 'Path40' }],
    ]) {
      expect(() => chooseLocalPgliteFixtureAnswer({ question: 'Choose a setup action', options }))
        .toThrow('Unrecognized or ambiguous');
    }
  });

  test('preserves the canonical numbered Step 2 backend menu from the source', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, '..', 'setup-gbrain', 'SKILL.md.tmpl'), 'utf8');
    const labels = [...source.matchAll(/^- \*\*((?:1|2a|2b|3|4) — [^\n]*?)\*\*/gm)].map(match => match[1]!);
    expect(labels).toHaveLength(5);
    expect(chooseLocalPgliteFixtureAnswer({
      question: 'Where should your brain live?', options: labels.map(label => ({ label })),
    })).toBe('4 — Remote gbrain MCP.');
  });

});
