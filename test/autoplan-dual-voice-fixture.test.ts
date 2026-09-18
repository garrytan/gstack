import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const ORIGINAL_PLAN = `# Test Plan: add /greet skill

## Context
Add /greet to the existing Skill Toolbox project, using its current template,
registration and generation conventions. Its only behavior is to print "hello".

## Scope
- Author greet/SKILL.md.tmpl with frontmatter name "greet", description "Print a welcome message.", and body 'Print "hello".'
- Append "greet" to the package.json skills array, preserving "about". Run the existing gen:skill-docs command to generate greet/SKILL.md and .claude/skills/greet/SKILL.md from that template.
- Add one test/greet.test.ts unit test asserting the expected frontmatter and body, and byte equality between the template and both generated files. Keep the existing about test.
`;

// Exercise the actual paid registration and Bun retry lifecycle with only the
// provider replaced. The cab3 public first attempt left accepted requirements
// and a review record in TEST_PLAN; the next attempt read those as its input.
test.each(['retry', 'runner', 'no-agent', 'no-codex', 'no-progress', 'success', 'project', 'runtime', 'runtime-missing', 'setup-failure', 'temp', 'temp-retry'])(
  'dual-voice attempt owns fresh inputs and cleanup: %s', scenario => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-dual-free-')));
    const childHome = path.join(directory, 'home');
    fs.mkdirSync(childHome);
    const script = path.join(directory, 'registration.test.ts');
    const facts = path.join(directory, 'facts.json');
    fs.writeFileSync(script, `
import { describe, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const scenario = ${JSON.stringify(scenario)};
const attempts = [];
fs.writeFileSync(${JSON.stringify(facts)}, '[]');
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-helpers.ts'))}, () => ({
  ROOT: ${JSON.stringify(ROOT)}, runId: 'free-dual-voice', evalsEnabled: true,
  describeIfSelected: (name, ids, body) => describe(name, body),
  copyDirSync: (from, to) => {
    if (scenario === 'setup-failure') throw Error('controlled fixture copy failure');
    fs.cpSync(from, to, {recursive: true});
  },
  createEvalCollector: () => ({}), finalizeEvalCollector: () => {},
  logCost: () => {}, recordE2E: () => {},
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    const cwd = opts.workingDirectory;
    const plan = path.join(cwd, 'TEST_PLAN.md');
    const state = opts.env?.GSTACK_HOME;
    const config = opts.env?.CLAUDE_CONFIG_DIR;
    const entryPath = JSON.parse(/^Read ("[^\\n]+") and execute the standalone CEO dual-voice review described there\\.$/.exec(opts.prompt)?.[1] ?? 'null');
    const entry = entryPath ? fs.readFileSync(entryPath, 'utf8') : '';
    const actualCore = fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'autoplan/SKILL.md'), 'utf8');
    const actualPhase = fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'autoplan/sections/ceo-phase.md'), 'utf8');
    const exactDual = actualPhase.slice(actualPhase.indexOf('Step 0.5 (Dual Voices):'), actualPhase.indexOf('Sections 1-11 —'));
    const exactPreflight = actualCore.slice(actualCore.indexOf('## Phase 0.5: Outside reviewer preflight'), actualCore.indexOf('## Phase 1: CEO Review'));
    const actualPlan = fs.readFileSync(path.join(opts.env.HOME, 'active-plan.md'), 'utf8');
    const fact = {cwd, initial: fs.readFileSync(plan, 'utf8'), env: opts.env,
      prompt: opts.prompt, entryPath, entry: {exactDual: entry.includes(exactDual), exactPreflight: entry.includes(exactPreflight),
        scopeDeclared: entry.includes('Step 0 and its\\nSpec Review Loop have not run in this fixture'),
        noPriorReview: actualPlan.split('## Review record')[1].trim() === '',
        originalRestore: fs.readFileSync(path.join(opts.env.HOME, 'restore.md'), 'utf8') === fs.readFileSync(plan, 'utf8'),
        currentInput: actualPlan.includes(fs.readFileSync(plan, 'utf8')),
        hasActualRanges: /ranges: \\[\\{\"offset\":1,\"limit\":/.test(entry)},
      timeout: opts.timeout, maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools, tools: opts.tools,
      appendedPrompt: opts.appendSystemPrompt, model: opts.model,
      trusted: config ? JSON.parse(fs.readFileSync(path.join(config, '.claude.json'), 'utf8')).projects?.[cwd]?.hasTrustDialogAccepted : null,
      disabledCodex: state ? /^codex_reviews: disabled$/m.test(fs.readFileSync(path.join(state, 'config.yaml'), 'utf8')) : null,
      stateHadPriorArtifact: state ? fs.existsSync(path.join(state, 'prior-report.md')) : null,
      configHadPriorSession: config ? fs.existsSync(path.join(config, 'prior-session.json')) : null};
    attempts.push(fact);
    if (scenario === 'runtime' || scenario === 'runtime-missing') {
      const runtime = path.join(opts.env.HOME ?? '', '.claude', 'skills', 'gstack');
      const tool = path.join(runtime, 'bin/gstack-autoplan-snapshot.ts');
      if (scenario === 'runtime-missing') fs.unlinkSync(tool); // Remove only the owned link, never its source.
      fact.runtime = {home: opts.env.HOME, configMatchesHome: config === path.join(opts.env.HOME ?? '', '.claude'),
        toolExists: fs.existsSync(tool)};
      fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
      if (!fact.runtime.toolExists) throw Error('Required Autoplan snapshot runtime is absent from the actual child HOME');
      const {hermeticChildEnv, getHermeticDirs} = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/hermetic-env.ts'))});
      const env = hermeticChildEnv({GSTACK_HEADLESS: '1', ...opts.env});
      const defaults = getHermeticDirs();
      try {
      const calls = [];
      const run = (command, args) => {
        const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
        calls.push({command: path.basename(command), operation: args[0] === tool ? args[1] : path.basename(args[0]), status: result.status});
        if (result.error || result.status !== 0) throw Error('Actual fixture runtime failed: ' + (result.error?.message ?? result.stderr));
        return result.stdout;
      };
      const invoke = (...args) => JSON.parse(run(process.execPath, [tool, ...args]));
      const preamble = run('bash', [path.join(runtime, 'bin/gstack-skill-start'), '--skill', 'autoplan', '--model', 'none', '--parent-pid', String(process.pid)]);
      const paths = run('bash', [path.join(runtime, 'bin/gstack-paths')]);
      const active = path.join(config, 'plans', 'active.md');
      const restore = path.join(state, 'restore.md');
      fs.mkdirSync(path.dirname(active), {recursive: true});
      invoke('init', plan, active, restore);
      const scope = invoke('scope', active);
      const method = invoke('methodology', 'ceo', path.join(runtime, 'plan-ceo-review/SKILL.md'), restore);
      const methodology = fs.readFileSync(method.methodologyPath, 'utf8');
      const checkpoint = invoke('create', 'ceo', active, restore, method.methodologyPath);
      const requirement = '- Keep the greeting deterministic and cover its exact public output.';
      fs.appendFileSync(active, '\\n<!-- autoplan-accepted:ceo -->\\n' + requirement + '\\n<!-- /autoplan-accepted:ceo -->\\n');
      const amended = invoke('amend-input', 'ceo', active, checkpoint.snapshotPath, restore, method.methodologyPath);
      const input = fs.readFileSync(amended.reviewInputPath, 'utf8');
      const lines = input.split('\\n');
      const readback = amended.readRanges.flatMap(range => lines.slice(range.offset - 1, range.endLine)).join('\\n');
      const expectedRoot = ${JSON.stringify(ROOT)};
      const assets = ['bin/gstack-autoplan-snapshot.ts', 'bin/gstack-skill-start', 'bin/gstack-paths',
        'bin/gstack-config', 'bin/gstack-review-log', 'bin/gstack-codex-probe', 'lib/fs-atomic.ts',
        'autoplan/sections/phase-close.md', 'plan-ceo-review/SKILL.md', 'plan-ceo-review/sections/review-sections.md'];
      fact.runtime = {...fact.runtime, calls, preambleReady: preamble.includes('SKILL_START_PROTO: 1'),
        stateBound: paths.includes('GSTACK_STATE_ROOT=' + state), scopeBound: scope.activePlan === fs.realpathSync(active),
        methodComplete: methodology.split('\\n').length === method.lines,
        immutableCheckpoint: fs.readFileSync(checkpoint.snapshotPath, 'utf8') === fact.initial,
        currentInput: input.includes(requirement), completeReadback: readback === input,
        inputOwned: fs.realpathSync(amended.reviewInputPath).startsWith(path.dirname(restore) + path.sep),
        sourceAssets: assets.every(asset => fs.realpathSync(path.join(runtime, asset)) === fs.realpathSync(path.join(expectedRoot, asset))),
        excludedTreesAbsent: ['.context', 'node_modules', 'test'].every(asset => !fs.existsSync(path.join(runtime, asset))),
        codexHome: env.CODEX_HOME, originalCodexHome: process.env.CODEX_HOME || path.join(process.env.HOME, '.codex')};
      fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
      } finally {
        // The probe owns the runner's unused default seed as well as this
        // callback's overrides; the real model runner is replaced in this test.
        if (!fs.realpathSync(defaults.runRoot).startsWith(fs.realpathSync(path.dirname(cwd)) + path.sep))
          throw Error('Unexpected default hermetic root outside the free fixture');
        fs.rmSync(defaults.runRoot, {recursive: true, force: true});
      }
    }
    fs.writeFileSync(plan, fact.initial + '\\n## Review record\\nPrior attempt review\\n<!-- autoplan-accepted:ceo -->\\nPrior accepted requirement\\n<!-- /autoplan-accepted:ceo -->\\n');
    if (state) fs.writeFileSync(path.join(state, 'prior-report.md'), 'prior attempt artifact');
    if (config) fs.writeFileSync(path.join(config, 'prior-session.json'), '{}');
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
    if (scenario === 'project') {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const run = args => spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 5000});
      const generated = run(['run', 'gen:skill-docs']);
      const baseline = run(['test', 'test/about.test.ts']);
      const about = fs.readFileSync(path.join(cwd, 'about/SKILL.md'), 'utf8');
      fact.project = {generator: generated.status, baseline: baseline.status,
        installed: fs.readFileSync(path.join(cwd, '.claude/skills/about/SKILL.md'), 'utf8') === about,
        proposedGreetAbsent: !fs.existsSync(path.join(cwd, 'greet'))};
      fs.mkdirSync(path.join(cwd, 'sample'));
      fs.writeFileSync(path.join(cwd, 'sample/SKILL.md.tmpl'), '---\\nname: sample\\ndescription: Existing generator control.\\n---\\nPrint sample.\\n');
      pkg.skills.push('sample');
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg));
      fact.project.registration = run(['run', 'gen:skill-docs']).status;
      fact.project.registered = fs.readFileSync(path.join(cwd, 'sample/SKILL.md'), 'utf8')
        === fs.readFileSync(path.join(cwd, '.claude/skills/sample/SKILL.md'), 'utf8');
      fs.writeFileSync(path.join(cwd, 'about/SKILL.md'), 'broken existing skill');
      fact.project.regression = run(['test', 'test/about.test.ts']).status;
      fs.rmSync(path.join(cwd, 'sample/SKILL.md.tmpl'));
      fact.project.missingTemplate = run(['run', 'gen:skill-docs']).status;
      fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
    }
    if (scenario === 'runner') throw Error('controlled dual-voice runner failure');
    const noAgent = scenario === 'no-agent' || ['retry', 'temp-retry'].includes(scenario) && attempts.length === 1;
    const {prepareMethodology, createSnapshot} = await import(${JSON.stringify(path.join(ROOT, 'bin/gstack-autoplan-snapshot.ts'))});
    const {autoplanDualVoiceEvidence, loadAutoplanDualCommandContract} = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/autoplan-dual-voice-evidence.ts'))});
    const active = path.join(opts.env.HOME, 'active-plan.md'), restore = path.join(opts.env.HOME, 'restore.md');
    const methodology = prepareMethodology('ceo', path.join(${JSON.stringify(ROOT)}, 'plan-ceo-review/SKILL.md'), restore);
    const snapshot = createSnapshot('ceo', active, restore, methodology.methodologyPath);
    let calls = [
      ...(!noAgent ? [{id: 'native', tool: 'Agent', input: {prompt: scenario === 'no-progress' ? 'Calculate one plus one' : snapshot.nativeDispatchPrompt}, output: 'INPUT: ceo ' + snapshot.sha256 + '\\nFree review output.'}] : []),
      ...(scenario !== 'no-codex' ? [{id: 'probe', tool: 'Bash', input: {command: loadAutoplanDualCommandContract(${JSON.stringify(ROOT)}).probe}, output: 'CODEX_MODE: not_installed'}] : []),
    ];
    const transcript = calls => calls.flatMap(c => [
      {type: 'assistant', session_id: 'free-parent', message: {content: [{type: 'tool_use', id: c.id, name: c.tool, input: c.input}]}},
      ...(c.output === undefined ? [] : [{type: 'user', session_id: 'free-parent', message: {content: [{type: 'tool_result', tool_use_id: c.id, content: c.output, is_error: false}]}}])]);
    if (scenario === 'temp' || scenario === 'temp-retry') {
      const {hermeticChildEnv, getHermeticDirs} = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/hermetic-env.ts'))});
      // Same final environment merge as session-runner. The original cf74
      // command created its file in inherited shard TMPDIR, beside both roots.
      const env = hermeticChildEnv({GSTACK_HEADLESS: '1', ...opts.env});
      const defaults = getHermeticDirs();
      const cleanupFiles = [];
      try {
        const command = 'umask 077; mktemp "$' + '{TMPDIR:-/tmp}/gstack-plan-prompt.XXXXXXXX"';
        const made = spawnSync('bash', ['-c', command], {cwd, env, encoding: 'utf8', timeout: 5000});
        if (made.error || made.status !== 0) throw Error('Actual prompt mktemp failed: ' + made.stderr);
        const prompt = made.stdout.trim();
        const freeRoot = fs.realpathSync(${JSON.stringify(directory)});
        if (fs.realpathSync(prompt) !== prompt || !prompt.startsWith(freeRoot + path.sep))
          throw Error('Refusing to write a prompt outside this free fixture');
        cleanupFiles.push(prompt);
        const content = 'You are a CEO/founder advisor reviewing a development plan.\\n'
          + 'File: ' + snapshot.snapshotPath + '\\n' + fs.readFileSync(snapshot.snapshotPath, 'utf8');
        fs.writeFileSync(prompt, content);
        const contract = loadAutoplanDualCommandContract(${JSON.stringify(ROOT)});
        // Public ACK's exact terminal execution marker from cf74
        // toolu_01VL37mje4949BYX4AzTZwyr. No provider is executed here.
        const output = 'OUTSIDE_STATUS: completed provider=codex host=claude';
        const packet = file => [
          {id: 'probe', tool: 'Bash', input: {command: contract.probe}, output: 'CODEX_MODE: ready'},
          {id: 'native', tool: 'Agent', input: {prompt: snapshot.nativeDispatchPrompt}, output: 'INPUT: ceo ' + snapshot.sha256 + '\\nFree review output.'},
          {id: 'write', tool: 'Write', input: {file_path: file, content}, output: 'File created successfully at: ' + file},
          {id: 'outside', tool: 'Bash', input: {command: contract.outside.replace("'<prepared-prompt-file>'", "'" + file + "'")}, output},
        ];
        const options = {ownedRoots: [cwd, opts.env.HOME], cwd, activePlan: active,
          methodologySha256: methodology.sha256, commands: contract};
        const evidence = rows => autoplanDualVoiceEvidence(transcript(rows), options);
        const outside = path.join(freeRoot, 'foreign-prompt-' + attempts.length);
        fs.writeFileSync(outside, content, {mode: 0o600}); cleanupFiles.push(outside);
        const link = path.join(opts.env.HOME, 'linked-prompt');
        fs.symlinkSync(outside, link); // Never write through this link.
        const missingAck = packet(prompt).map(c => c.id === 'outside' ? {...c, output: undefined} : c);
        const previous = attempts.length > 1 ? attempts[0].temp.prompt : outside;
        fact.temp = {
          prompt, env: {TMPDIR: env.TMPDIR, TEMP: env.TEMP, TMP: env.TMP},
          directoryMode: fs.statSync(path.dirname(prompt)).mode & 0o777,
          promptMode: fs.statSync(prompt).mode & 0o777,
          owned: evidence(packet(prompt)),
          outside: evidence(packet(outside)),
          symlink: evidence(packet(link)),
          missingAck: evidence(missingAck),
          previous: evidence(packet(previous)),
          previousGone: attempts.length < 2 || !fs.existsSync(previous),
        };
        calls = packet(prompt).filter(c => !noAgent || c.id !== 'native');
        fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
      } finally {
        for (const file of cleanupFiles) fs.rmSync(file, {force: true});
        // getHermeticDirs caches the unused default across the mock's retry.
        if (fs.existsSync(defaults.runRoot)) {
          if (!fs.realpathSync(defaults.runRoot).startsWith(fs.realpathSync(path.dirname(cwd)) + path.sep))
            throw Error('Unexpected default hermetic root outside the free fixture');
          fs.rmSync(defaults.runRoot, {recursive: true, force: true});
        }
      }
    }
    return {output: '', toolCalls: calls, transcript: transcript(calls),
      exitReason: noAgent ? 'timeout' : 'success', model: 'free-fixture',
      costEstimate: {estimatedCost: 0, turnsUsed: 1}};
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-autoplan-dual-voice.test.ts'))});
`);
    try {
      const child = spawnSync(process.execPath, ['test', ...(['retry', 'temp-retry'].includes(scenario) ? ['--retry', '1'] : []), script], {
        cwd: ROOT, encoding: 'utf8', timeout: 15_000,
        env: { PATH: process.env.PATH ?? '', HOME: childHome, TMPDIR: directory, TMP: directory, TEMP: directory,
          GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}) },
      });
      expect(child.error, child.stderr).toBeUndefined();
      const shouldPass = ['retry', 'success', 'project', 'runtime', 'temp', 'temp-retry'].includes(scenario);
      expect(child.status, child.stderr).toBe(shouldPass ? 0 : 1);
      const attempts = JSON.parse(fs.readFileSync(facts, 'utf8'));
      expect(attempts).toHaveLength(scenario === 'setup-failure' ? 0 : ['retry', 'temp-retry'].includes(scenario) ? 2 : 1);
      if (['retry', 'temp-retry'].includes(scenario)) expect(attempts[1].initial).toBe(attempts[0].initial);
      for (const attempt of attempts) {
        expect(attempt.initial).toBe(ORIGINAL_PLAN);
        expect(attempt.prompt).toBe(`Read ${JSON.stringify(attempt.entryPath)} and execute the standalone CEO dual-voice review described there.`);
        expect(attempt.entryPath).toBe(path.join(attempt.env.HOME, 'ceo-dual-entry.md'));
        expect(attempt.entry).toEqual({exactDual: true, exactPreflight: true, scopeDeclared: true, noPriorReview: true, originalRestore: true, currentInput: true, hasActualRanges: true});
        expect(attempt.timeout).toBe(600_000);
        expect(attempt.maxTurns).toBe(40);
        expect(attempt.allowedTools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'Skill']);
        expect(attempt.tools).toBeUndefined();
        expect(attempt.appendedPrompt).toBeUndefined();
        expect(attempt.model).toBeUndefined();
        expect(attempt.trusted).toBe(true);
        expect(attempt.disabledCodex).toBe(false);
        expect(fs.existsSync(attempt.cwd)).toBe(false);
        expect(attempt.env?.GSTACK_STATE_ROOT).toBe(attempt.env?.GSTACK_HOME);
        expect(attempt.stateHadPriorArtifact).toBe(false);
        expect(attempt.configHadPriorSession).toBe(false);
        expect(fs.existsSync(attempt.env.GSTACK_HOME)).toBe(false);
        expect(fs.existsSync(attempt.env.CLAUDE_CONFIG_DIR)).toBe(false);
        expect(attempt.env.CLAUDE_CONFIG_DIR).toBe(path.join(attempt.env.HOME, '.claude'));
        expect(fs.existsSync(attempt.env.HOME)).toBe(false);
        if (attempt.temp) {
          const temp = attempt.temp;
          const expected = path.join(attempt.env.HOME, 'tmp');
          expect(temp.env).toEqual({TMPDIR: expected, TEMP: expected, TMP: expected});
          expect(path.dirname(temp.prompt)).toBe(expected);
          expect(temp.directoryMode).toBe(0o700);
          expect(temp.promptMode).toBe(0o600);
          expect(temp.owned.claudeVoiceFired).toBe(true);
          expect(temp.owned.codexVoiceFired).toBe(true);
          for (const name of ['outside', 'symlink', 'missingAck', 'previous']) {
            expect(temp[name].claudeVoiceFired, name).toBe(true);
            expect(temp[name].codexVoiceFired, name).toBe(false);
            expect(temp[name].codexAttempted, name).toBe(false);
            expect(temp[name].codexUnavailable, name).toBe(false);
          }
          expect(temp.previousGone).toBe(true);
          expect(fs.existsSync(temp.prompt)).toBe(false);
          expect(fs.existsSync(expected)).toBe(false);
        }
      }
      if (['retry', 'temp-retry'].includes(scenario)) {
        expect(attempts[0].cwd).not.toBe(attempts[1].cwd);
        expect(attempts[0].env.GSTACK_HOME).not.toBe(attempts[1].env.GSTACK_HOME);
        expect(attempts[0].env.HOME).not.toBe(attempts[1].env.HOME);
        expect(attempts[0].env.CLAUDE_CONFIG_DIR).not.toBe(attempts[1].env.CLAUDE_CONFIG_DIR);
        if (scenario === 'temp-retry') expect(attempts[0].temp.prompt).not.toBe(attempts[1].temp.prompt);
      }
      if (scenario === 'runtime-missing') expect(child.stderr).toContain('Required Autoplan snapshot runtime is absent');
      if (scenario === 'runner') expect(child.stderr).toContain('controlled dual-voice runner failure');
      if (scenario === 'runtime') {
        const runtime = attempts[0].runtime;
        for (const key of ['toolExists', 'configMatchesHome', 'preambleReady', 'stateBound', 'scopeBound', 'methodComplete',
          'immutableCheckpoint', 'currentInput', 'completeReadback', 'inputOwned', 'sourceAssets', 'excludedTreesAbsent'])
          expect(runtime[key], key).toBe(true);
        expect(runtime.calls).toHaveLength(7);
        expect(runtime.calls.every(call => call.status === 0)).toBe(true);
        expect(runtime.codexHome).toBe(runtime.originalCodexHome);
      }
      if (scenario === 'project') expect(attempts[0].project).toEqual({generator: 0, baseline: 0,
        installed: true, proposedGreetAbsent: true, registration: 0, registered: true, regression: 1, missingTemplate: 1});
      if (scenario === 'setup-failure') expect(child.stderr).toContain('controlled fixture copy failure');
      expect(fs.readdirSync(directory).sort()).toEqual(['facts.json', 'home', 'registration.test.ts']);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }, 20_000,
);
