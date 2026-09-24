import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { captureSectionReads, hasDisabledOutsideReview, LONG_SECTION_CAPTURE_MS } from './helpers/auq-sdk-capture';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { getHermeticDirs } from './helpers/hermetic-env';
import { runSkillTest } from './helpers/session-runner';

interface Observed {
  args: string[];
  prompt: string;
  stateHome: string;
  stateRoot: string | null;
  outsideDisabled: boolean;
  workingDirectory: string;
  promptConfigPath: string | null;
  promptConfig: string | null;
  promptConfigMatchesState: boolean;
}

describe('outside-review disabled status in a completed report', () => {
  const report = (status: string) => [
    '## GSTACK REVIEW REPORT', '',
    '| Review | Trigger | Why | Runs | Status | Findings |',
    '| Outside Review | codex_reviews | Independent review | 0 | ' + status + ' | None |',
  ].join('\n');

  test.each(['disabled', 'Disabled', '**disabled**', '`disabled`',
    'disabled (codex_reviews)', '__Disabled__ — configured opt-out'])('accepts semantic status %s', (status) => {
    expect(hasDisabledOutsideReview(report(status))).toBe(true);
  });

  test.each(['', 'unavailable', 'completed', 'not disabled', 'disabledness'])('rejects status %s', (status) => {
    expect(hasDisabledOutsideReview(report(status))).toBe(false);
  });

  test('requires the Outside Review row in the final report section', () => {
    expect(hasDisabledOutsideReview('Outside coverage: disabled')).toBe(false);
    expect(hasDisabledOutsideReview(report('disabled') + '\n\n' + report('completed'))).toBe(false);
    expect(hasDisabledOutsideReview('## GSTACK REVIEW REPORT\n\n## Other context\n'
      + '| Outside Review | codex_reviews | Independent review | 0 | disabled | None |')).toBe(false);
  });
});

const FAKE_CLAUDE = String.raw`
  const fs = require('node:fs');
  const path = require('node:path');
  const prompt = await Bun.stdin.text();
  const stateHome = process.env.GSTACK_HOME;
  let config = '';
  try { config = fs.readFileSync(path.join(stateHome, 'config.yaml'), 'utf8'); } catch {}
  const promptConfigPath = prompt.match(/^- Read (.+), the isolated gstack configuration for this capture\./m)?.[1] ?? null;
  let promptConfig = null;
  let promptConfigMatchesState = false;
  if (promptConfigPath) {
    try {
      const file = path.resolve(process.cwd(), promptConfigPath);
      promptConfig = fs.readFileSync(file, 'utf8');
      promptConfigMatchesState = fs.realpathSync(file) === fs.realpathSync(path.join(stateHome, 'config.yaml'));
    } catch {}
  }
  const observed = {
    args: process.argv.slice(2), prompt, stateHome,
    stateRoot: process.env.GSTACK_STATE_ROOT ?? null,
    outsideDisabled: /^codex_reviews:\s*disabled\s*$/m.test(config),
    workingDirectory: process.cwd(), promptConfigPath, promptConfig, promptConfigMatchesState,
  };
  fs.writeFileSync('observed.json', JSON.stringify(observed));
  const coordinatedState = fs.existsSync('coordinate-configs') ? path.basename(stateHome) : null;
  if (coordinatedState) {
    fs.writeFileSync('pending-observed-' + coordinatedState + '.json', JSON.stringify(observed));
    fs.renameSync('pending-observed-' + coordinatedState + '.json', 'observed-' + coordinatedState + '.json');
  }
  const outputFile = fs.existsSync('active-plan-output') ? 'PLAN.md' : 'REPORT.md';
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  if (fs.existsSync('auq-case.json')) {
    const spec = JSON.parse(fs.readFileSync('auq-case.json', 'utf8'));
    if (spec.write) fs.writeFileSync('ask-capture.md', spec.write);
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'PRIVATE_AUQ_REASONING', signature: 'PRIVATE_AUQ_SIGNATURE' },
    ] } }));
    console.log(JSON.stringify({ type: 'result', subtype: spec.subtype ?? 'success',
      is_error: !!spec.is_error, result: spec.result ?? 'Finished',
    }));
    process.exitCode = spec.exitCode ?? 0;
  } else if (fs.existsSync('diagnostic-case')) {
    if (fs.readFileSync('diagnostic-case', 'utf8') === 'non-objects') {
      for (const value of [null, ['PRIVATE_NON_OBJECT'], 'PRIVATE_NON_OBJECT', 42, true]) console.log(JSON.stringify(value));
    }
    const emit = event => console.log(JSON.stringify({ type: 'stream_event', session_id: 'fixture-session', event }));
    emit({ type: 'message_start', message: { id: 'fixture-message' } });
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE_START' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_DELTA' } });
    emit({ type: 'content_block_stop', index: 0 });
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'PRIVATE_COMPLETE', signature: 'PRIVATE_SIGNATURE' },
      { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' },
    ] } }));
    emit({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'partial-write', name: 'Write', input: {} } });
    for (const partial_json of ['{"file_path":"PLAN.md",', '"content":"marker😀"}']) {
      emit({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } });
    }
    emit({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'partial-read', name: 'Read', input: {} } });
    emit({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"sections/review-sections.md"}' } });
    emit({ type: 'content_block_stop', index: 2 });
    if (fs.readFileSync('diagnostic-case', 'utf8') !== 'partial') {
      emit({ type: 'content_block_stop', index: 1 });
      console.log(JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'real-read', name: 'Read', input: { file_path: 'sections/review-sections.md' } },
        { type: 'tool_use', id: 'real-write', name: 'Write', input: { file_path: 'PLAN.md', content: 'complete report' } },
      ] } }));
      emit({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
      emit({ type: 'message_stop' });
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Finished' }));
    } else {
      // An old report marker and partial Read/Write blocks cannot satisfy capture.
      fs.writeFileSync(outputFile, '## GSTACK REVIEW REPORT\nold artifact');
      await Bun.sleep(60_000);
    }
  } else if (fs.existsSync('incremental-edit')) {
    const exposed = observed.args[observed.args.indexOf('--tools') + 1]?.split(',') ?? [];
    const allowed = observed.args.slice(observed.args.indexOf('--allowed-tools') + 1);
    if (!exposed.includes('Edit') || !allowed.includes('Edit') || exposed.includes('Agent') || !exposed.includes('Bash') || !prompt.includes('Bash may additionally run exactly') || !prompt.includes('date -u +%Y-%m-%dT%H:%M:%SZ')) throw new Error('Wrong native local-edit interface');
    const file_path = path.join(process.cwd(), outputFile);
    const old_string = fs.readFileSync(file_path, 'utf8');
    const new_string = old_string + '\n## GSTACK REVIEW REPORT\nCompleted through a scoped Edit.\n';
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id:'section', name:'Read', input:{file_path:path.join(process.cwd(),'plan-ceo-review/sections/review-sections.md')} },
      { type: 'tool_use', id:'before', name:'Read', input:{file_path} },
      { type: 'tool_use', id:'edit', name:'Edit', input:{file_path,old_string,new_string} },
    ] } }));
    fs.writeFileSync(file_path,new_string);
    console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'edit',content:'File edited successfully.'}]}}));
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'after',name:'Read',input:{file_path}}]}}));
    console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'after',content:fs.readFileSync(file_path,'utf8')}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',result:'Complete; report verified.'}));
  } else if (fs.existsSync('fail-cli')) {
    const failure = fs.readFileSync('fail-cli', 'utf8');
    const report = '## GSTACK REVIEW REPORT\nA report written before the run failed.\n';
    fs.writeFileSync(outputFile, report);
    console.log(JSON.stringify({ type: 'result',
      subtype: failure === 'error' ? 'error_during_execution' : 'success',
      is_error: failure !== 'nonzero', result: report,
    }));
    process.exitCode = failure === 'is_error' ? 0 : 1;
  } else {
    const file_path = path.join(process.cwd(), 'plan-ceo-review', 'sections', 'review-sections.md');
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Read', input: { file_path } },
    ] } }));
    if (coordinatedState) {
      while (!fs.existsSync('release-' + coordinatedState)) await Bun.sleep(5);
    }
    if (fs.existsSync('wait-for-report')) {
      fs.writeFileSync('work-ready', '');
      while (!fs.existsSync('release-report')) await Bun.sleep(5);
    }
    fs.writeFileSync(outputFile, '## GSTACK REVIEW REPORT\nFull native review fixture.\nOutside review: '
      + (observed.outsideDisabled ? 'disabled' : 'default') + '\n');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(observed) }));
  }
`;

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

async function withFakeClaude(run: (dir: string, readObserved: () => Observed) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tools-'));
  const shimDir = path.join(dir, 'shim');
  const script = path.join(dir, 'fake-claude.ts');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(script, FAKE_CLAUDE);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  // Explicit POSIX shim: Windows CreateProcess does not interpret /bin/sh.
  fs.writeFileSync(path.join(shimDir, 'claude'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const saved = Object.fromEntries(['PATH', 'EVALS_HERMETIC', 'GSTACK_HOME', 'GSTACK_STATE_ROOT']
    .map((key) => [key, process.env[key]]));
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.EVALS_HERMETIC = '1';
  try {
    await run(dir, () => JSON.parse(fs.readFileSync(path.join(dir, 'observed.json'), 'utf8')));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('session-runner explicit tool availability', () => {
  // First-question and mode capture have actual native-boundary controls in
  // auq-native-capture.test.ts and auq-mode-capture.test.ts respectively.

  test('long section work fits the existing long capture tier with reporting headroom', () => {
    expect(LONG_SECTION_CAPTURE_MS).toBeGreaterThan(CAPTURE_MS);
    expect(CAPTURE_LONG_MS - LONG_SECTION_CAPTURE_MS).toBe(120_000);
  });

  test('a long capture can finish after the ordinary deadline; the default still times out', async () => {
    // Run the controlled clock in a subprocess: it cannot affect sibling tests
    // or hooks in Bun's shared shard. The fake CLI blocks after a real Read
    // event until the worker advances time and allows report completion.
    for (const long of [false, true]) {
      await withFakeClaude(async (dir) => {
        fs.writeFileSync(path.join(dir, 'wait-for-report'), '');
        const worker = path.join(dir, 'budget-worker.ts');
        const captureModule = path.resolve(import.meta.dir, 'helpers/auq-sdk-capture.ts');
        fs.writeFileSync(worker, `
          import * as fs from 'node:fs';
          import { captureSectionReads, LONG_SECTION_CAPTURE_MS } from ${JSON.stringify(captureModule)};
          const realNow = Date.now;
          const realSetTimeout = globalThis.setTimeout;
          const realClearTimeout = globalThis.clearTimeout;
          let advanced = 0;
          const timers = new Map();
          Date.now = () => realNow() + advanced;
          globalThis.setTimeout = ((callback, delay = 0, ...args) => {
            const id = realSetTimeout(() => {
              timers.delete(id);
              callback(...args);
            }, delay);
            timers.set(id, { callback, args, delay, due: Date.now() + delay });
            return id;
          });
          globalThis.clearTimeout = ((id) => { timers.delete(id); realClearTimeout(id); });
          const pause = () => new Promise(resolve => realSetTimeout(resolve, 5));
          let pending;
          let finished = false;
          try {
            pending = captureSectionReads({
              planDir: process.cwd(), skillName: 'plan-ceo-review', scenario: 'Complete the full review',
              testName: 'section-budget', ${long ? 'timeout: LONG_SECTION_CAPTURE_MS,' : ''}
            });
            const waitStarted = realNow();
            while (!fs.existsSync('work-ready') || ![...timers.values()].some(timer => timer.delay > 200_000)) {
              if (realNow() - waitStarted > 5_000) throw new Error('Fake CLI did not enter the work phase');
              await pause();
            }
            // 360s is beyond the ordinary 300s work limit, inside the existing
            // 480s long-workflow limit. No real-time deadline is relaxed.
            advanced = 360_000;
            for (const [id, timer] of [...timers]) {
              if (timer.due <= Date.now()) {
                globalThis.clearTimeout(id);
                timer.callback(...timer.args);
              }
            }
            fs.writeFileSync('release-report', '');
            const result = await pending;
            finished = true;
            console.log(JSON.stringify({
              reportProduced: result.reportProduced,
              readSection: result.readSections.has('review-sections.md'),
            }));
          } finally {
            // A failed handshake must still terminate the fake CLI through
            // the runner's own scoped timeout, not orphan it behind the worker.
            if (!finished) {
              for (const [id, timer] of [...timers]) {
                if (timer.delay >= 10_000) {
                  globalThis.clearTimeout(id);
                  timer.callback(...timer.args);
                }
              }
              await pending?.catch(() => {});
            }
            for (const id of timers.keys()) realClearTimeout(id);
            Date.now = realNow;
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
          }
        `);
        const result = Bun.spawnSync([process.execPath, worker], {
          cwd: dir, env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(JSON.parse(result.stdout.toString())).toEqual({ reportProduced: long, readSection: true });
      });
    }
  }, 35_000);

  test('passes available tools separately from the approval allowlist and preserves stdin', async () => {
    await withFakeClaude(async (dir, observed) => {
      const prompt = 'Read the literal text: `$(do not execute)` and "quotes".\nSecond line.';
      const result = await runSkillTest({
        prompt, workingDirectory: dir, allowedTools: ['Read'], tools: ['Read', 'Write'],
        model: 'capture-model', maxTurns: 7, timeout: 5_000,
      });
      expect(result.exitReason).toBe('success');
      expect(observed().prompt).toBe(prompt);
      expect(flagValue(observed().args, '--allowed-tools')).toBe('Read');
      expect(flagValue(observed().args, '--tools')).toBe('Read,Write');
      expect(flagValue(observed().args, '--model')).toBe('capture-model');
      expect(flagValue(observed().args, '--max-turns')).toBe('7');
    });
  });

  test('omitting tools preserves default tool availability for existing callers', async () => {
    await withFakeClaude(async (dir, observed) => {
      await runSkillTest({ prompt: 'Default tools', workingDirectory: dir, allowedTools: ['Read'], timeout: 5_000 });
      expect(observed().args).not.toContain('--tools');
      expect(observed().args).not.toContain('--include-partial-messages');
      expect(flagValue(observed().args, '--allowed-tools')).toBe('Read');
    });
  });

  test('public stream diagnostics retain timing and input sizes without counting partial tools', async () => {
    await withFakeClaude(async (dir, observed) => {
      fs.writeFileSync(path.join(dir, 'diagnostic-case'), 'complete');
      const result = await runSkillTest({ prompt: 'diagnose', workingDirectory: dir,
        publicStreamDiagnostics: true, tools: ['Read', 'Write'], timeout: 5_000 });
      expect(observed().args).toContain('--include-partial-messages');
      expect(result.exitReason).toBe('success');
      expect(result.output).toBe('Finished');
      expect(result.toolCalls).toEqual([
        { tool: 'Read', input: { file_path: 'sections/review-sections.md' }, output: '' },
        { tool: 'Write', input: { file_path: 'PLAN.md', content: 'complete report' }, output: '' },
      ]);
      const diagnostics = result.transcript.filter(e => e.type === 'public_stream_diagnostic');
      const stop = diagnostics.find(e => e.kind === 'content_block_stop' && e.index === 1);
      const input = '{"file_path":"PLAN.md","content":"marker😀"}';
      expect(stop).toMatchObject({ messageId: 'fixture-message', session_id: 'fixture-session',
        blockType: 'tool_use', toolName: 'Write', inputBytes: Buffer.byteLength(input),
        inputSha256: createHash('sha256').update(input).digest('hex') });
      expect(diagnostics.every(e => Number.isInteger(e.elapsedMs) && e.elapsedMs >= 0)).toBe(true);
      expect(diagnostics.some(e => e.kind === 'content_block_start' && e.blockType === 'thinking')).toBe(true);
      expect(diagnostics.some(e => e.kind === 'content_block_stop' && e.blockType === 'thinking')).toBe(true);
      expect(diagnostics.find(e => e.kind === 'message_delta').stopReason).toBe('tool_use');
      const retained = JSON.stringify(result.transcript);
      expect(retained).not.toContain('PRIVATE_');
      expect(retained).not.toContain('partial_json');
      expect(retained).not.toContain('marker😀');
    });
  });

  test.each(['plan-ceo-review', 'plan-eng-review'])('%s capture: partial Write and old report still time out', async skillName => {
    await withFakeClaude(async (dir, observed) => {
      fs.writeFileSync(path.join(dir, 'diagnostic-case'), 'partial');
      const started = Date.now();
      const result = await captureSectionReads({ planDir: dir, skillName,
        scenario: 'Complete the review', testName: 'partial-write', timeout: 1_500,
        reportMarker: /## GSTACK REVIEW REPORT/ });
      expect(observed().args).toContain('--include-partial-messages');
      expect(result.toolCalls).toEqual([]);
      expect([...result.readSections]).toEqual([]);
      expect(result.reportProduced).toBe(false);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(result.output).toContain('## GSTACK REVIEW REPORT');
    });
  }, 5_000);

  test('public diagnostics consume non-object JSON without ending the stream', async () => {
    await withFakeClaude(async (dir) => {
      fs.writeFileSync(path.join(dir, 'diagnostic-case'), 'non-objects');
      for (const publicStreamDiagnostics of [false, true]) {
        const result = await runSkillTest({ prompt: 'diagnose', workingDirectory: dir,
          publicStreamDiagnostics, tools: ['Read', 'Write'], timeout: 5_000 });
        expect(result.exitReason).toBe('success');
        expect(result.output).toBe('Finished');
        expect(result.toolCalls.map(c => c.tool)).toEqual(['Read', 'Write']);
        if (publicStreamDiagnostics) {
          const rows = result.transcript.filter(e => e?.kind === 'non_object_line');
          expect(rows).toHaveLength(5);
          expect(rows.every(e => e.bytes > 0 && e.elapsedMs >= 0)).toBe(true);
          expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
        }
      }
    });
  });

  test('an explicit empty list uses the CLI no-tools argument', async () => {
    await withFakeClaude(async (dir, observed) => {
      await runSkillTest({ prompt: 'No tools', workingDirectory: dir, tools: [], timeout: 5_000 });
      expect(flagValue(observed().args, '--tools')).toBe('');
    });
  });

  test('section capture exposes only its declared tools without opting out of outside reviews by default', async () => {
    await withFakeClaude(async (dir, observed) => {
      const result = await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review the full plan',
        testName: 'section-tools-default', timeout: 5_000,
      });
      expect(flagValue(observed().args, '--tools')).toBe('Read,Grep,Glob,Write,Edit,Agent,Bash');
      expect(observed().stateHome).toBe(getHermeticDirs().gstackHome);
      expect(observed().prompt).not.toContain('codex_reviews: disabled');
      expect(result.readSections.has('review-sections.md')).toBe(true);
      expect(result.reportProduced).toBe(true);
    });
  });

  test('the active plan can hold the final report without a second output file', async () => {
    await withFakeClaude(async (dir, observed) => {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Original plan\nA seeded defect.\n');
      fs.writeFileSync(path.join(dir, 'active-plan-output'), '');
      const result = await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review PLAN.md in full',
        reportFile: 'PLAN.md', reportMarker: /^## GSTACK REVIEW REPORT\s*$/m,
        testName: 'section-active-plan', nativeReviewOnly: true, timeout: 5_000,
      });
      expect(result.reportProduced).toBe(true);
      expect(result.output).toBe(fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8'));
      expect(fs.existsSync(path.join(dir, 'REPORT.md'))).toBe(false);
      expect(observed().prompt).toContain('to ' + path.join(dir, 'PLAN.md') + ' with Write/Edit');
      expect(observed().prompt).toContain('After all required writes are complete');
      expect(result.readSections.has('review-sections.md')).toBe(true);
    });
  });

  test('CEO report writing retains the complete method and decision evidence without a repeated walkthrough', async () => {
    await withFakeClaude(async (dir, observed) => {
      const scenario = 'Preserve this plan, review every section, and amend accepted requirements.';
      await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario, reportFile: 'PLAN.md',
        testName: 'ceo-report-writing', nativeReviewOnly: true, timeout: 5_000,
      });
      const child = observed();
      expect(child.prompt).toContain(scenario);
      expect(child.prompt).toContain('Preserve original requirements and accepted plan amendments');
      expect(child.prompt).toContain('concrete evidence, the selected remedy, residual risks, and verification');
      expect(child.prompt).toContain('all 11 sections, giving each an explicit outcome (including no issues or justified skips)');
      expect(child.prompt).toContain('complete required registries, applicable diagrams, tasks, completion summary, and exact GSTACK REVIEW REPORT table');
      expect(child.prompt).toContain('Cross-reference saved IDs instead of repeating findings, option deliberations, diagrams or registries');
      expect(child.prompt).toContain('Use compact outcomes, short option bullets and table cells. Execute checklists without copying their questions or narrating every check.');
      expect(child.prompt).toContain('Preserve every finding and original requirement, required decision fields and comparisons, exact approvals and verification; every diagram must retain its specified format.');
      expect(child.prompt).toContain('unless needed to specify an accepted change');
      expect(child.prompt).toContain('Complete every required artifact and verification before returning');
      expect(child.prompt).toContain('MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers');
      expect(child.prompt).toContain('report outside coverage as disabled');
      expect(child.prompt).toContain('After all required writes are complete');
      expect(child.prompt).toContain('with Write/Edit at the workflow checkpoints below');
      expect(child.prompt).toContain('Save the evolving plan and review outputs to ' + path.join(dir, 'PLAN.md'));
      const before = child.prompt.indexOf('save its full currentDecision question/header');
      const verify = child.prompt.indexOf('Read back and verify those fields');
      const answer = child.prompt.indexOf('Then record the authorized auto-decision and exact scope');
      const next = child.prompt.indexOf('Read back before taking another row');
      expect(before).toBeGreaterThan(-1); expect(verify).toBeGreaterThan(before);
      expect(answer).toBeGreaterThan(verify); expect(next).toBeGreaterThan(answer);
      expect(child.prompt).toContain('Before auto-selecting, save its full currentDecision question/header, every labeled option and full description, commitment comparison and source citations');
      expect(child.prompt).toContain('Read back the assembled plan and verify the full required outputs');
      expect(child.prompt).not.toContain('When the workflow is complete, write');
      const allowed = child.args.slice(child.args.indexOf('--allowed-tools') + 1, child.args.indexOf('--allowed-tools') + 7);
      expect(allowed).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']);
      expect(flagValue(child.args, '--tools')).toBe('Read,Grep,Glob,Write,Edit,Bash');
    });
  });

  test('engineering capture preserves complete decision evidence while avoiding whole-plan rewrites', async () => {
    await withFakeClaude(async (dir, observed) => {
      const scenario = 'Review the existing batch-read plan without changing its requirements.';
      await captureSectionReads({ planDir: dir, skillName: 'plan-eng-review', scenario,
        reportFile: 'PLAN.md', testName: 'eng-report-writing', timeout: 5_000 });
      const child = observed();
      expect(child.prompt).toContain(scenario);
      expect(child.prompt).toContain('all four review sections, including an explicit "No issues found" when applicable');
      expect(child.prompt).toContain('the required diagrams, test-plan artifact, tasks, TODOS dispositions, completion summary and GSTACK REVIEW REPORT');
      expect(child.prompt).toContain('give it one ID and one authoritative decision record');
      expect(child.prompt).toContain('findings may reference several choice IDs');
      expect(child.prompt).toContain('complete question and every option before selecting');
      expect(child.prompt).toContain('apply answers and amendments with scoped Edit operations');
      expect(child.prompt).toContain('do not regenerate unchanged records or repeat their briefs in the final report');
      expect(child.prompt).toContain('Do not write full implementation or test code unless needed to specify an accepted change');
      expect(child.prompt).toContain('Every required section, finding, approval and output still has to be completed');
      expect(child.prompt).toContain('After all required writes are complete');
      expect(flagValue(child.args, '--tools')).toBe('Read,Grep,Glob,Write,Edit,Agent,Bash');
      expect(child.prompt).not.toContain('codex_reviews: disabled');
      expect(child.prompt).not.toContain('all 11 sections');
    });
  });

  test('a fixture decision policy replaces blanket recommendation authority without changing tools or completion checks', async () => {
    await withFakeClaude(async (dir, observed) => {
      const options = { planDir: dir, skillName: 'plan-eng-review', scenario: 'Review PLAN.md.',
        reportFile: 'PLAN.md', testName: 'bounded-decisions', timeout: 5_000 };
      const first = await captureSectionReads(options);
      const original = observed();
      const policy = '- Choose only alternatives that preserve the supplied scope and required proofs; decline excluded work.';
      const second = await captureSectionReads({ ...options, decisionPolicy: policy });
      const bounded = observed();
      const blanket = "- At any decision point that would call AskUserQuestion, silently pick the skill's recommended option and continue. Do NOT stop to ask.";
      expect(original.prompt.split(blanket)).toHaveLength(2);
      expect(bounded.prompt).toBe(original.prompt.replace(blanket, policy));
      const stableArgs = (args: string[]) => args.map((arg, i) => i === args.indexOf('--append-system-prompt') + 1
        ? arg.replace(/^(Runner entry|Hard deadline|Completion reserve starts) UTC:.*$/gm, '$1 UTC: <clock>') : arg);
      expect(stableArgs(bounded.args)).toEqual(stableArgs(original.args));
      expect([...second.readSections]).toEqual([...first.readSections]);
      expect(second.exitReason).toBe(first.exitReason);
    });
  });

  test.each([
    ['changed error contract', 'Consider converting a database error into undefined.', 'existing contracts'],
    ['omitted required proof', 'Consider dropping the closed-database batch acceptance test.', 'missing required proof still requires resolution'],
    ['optional batch cap', 'Consider rejecting batches larger than 100 keys.', 'arbitrary size limits'],
    ['routine mechanics authority', 'Plan the necessary code, tests and existing-documentation synchronization using current conventions.', 'scope and proposed steps are in PLAN.md'],
    ['optional polish', 'Consider a new documentation surface and independent instrumentation project.', 'Do not authorize optional scope'],
    ['authority conflict', 'An offered alternative changes an author-fixed contract and has no compatible option.', 'do not hide it or claim approval'],
  ])('bounded Eng actor receives the accepted recipe and rejection constraint for %s', async (_name, proposal, constraint) => {
    // This proves delivery to the actual capture/CLI boundary, not a fake model's
    // semantic choice. Only a subsequent paid invocation can prove that choice.
    const { repositoryPlanFixtures } = await import('./helpers/carve-plan-fixture');
    const registration = fs.readFileSync(path.join(import.meta.dir, 'helpers/carve-section-case.ts'), 'utf8');
    const literal = /decisionPolicy: guard\.skill === 'plan-eng-review'\s*\? ('[^\n]+')\s*:/.exec(registration)?.[1];
    expect(literal).toBeDefined();
    const policy = new Function('return ' + literal)() as string;
    await withFakeClaude(async (dir, observed) => {
      const fixtures = repositoryPlanFixtures('# Ignored Eng seed', 'plan-eng-review');
      for (const [relative, contents] of Object.entries(fixtures)) {
        const target = path.resolve(dir, relative);
        expect(path.relative(dir, target).startsWith('..')).toBe(false);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      await captureSectionReads({ planDir: dir, skillName: 'plan-eng-review',
        scenario: 'Review PLAN.md. ' + proposal, decisionPolicy: policy,
        reportFile: 'PLAN.md', testName: 'bounded-recipe-delivery', timeout: 5_000 });
      const child = observed();
      expect(child.prompt).toContain(proposal);
      expect(child.prompt).toContain(policy);
      expect(child.prompt).toContain(constraint);
      expect(child.prompt).toContain('do not hide it or claim approval when no offered alternative meets these constraints');
      expect(child.prompt).not.toContain("silently pick the skill's recommended option");
      expect(child.prompt).toContain('Every required section, finding, approval and output still has to be completed');
      expect(child.prompt).toContain('MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers');
      expect(child.prompt).toContain('After all required writes are complete');
      expect(flagValue(child.args, '--tools')).toBe('Read,Grep,Glob,Write,Edit,Agent,Bash');
      expect(fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8')).toBe(fixtures['PLAN.md']);
      expect(fixtures['PLAN.md']).toContain('accepted requirements to review against');
      expect(fixtures['PLAN.md']).toContain('implementation itself remains proposed and unapproved');
      expect(fixtures['PLAN.md']).toContain('author delegates routine mechanics');
      expect(fixtures['PLAN.md']).toContain('not separate scope or approval questions');
      expect(fixtures['PLAN.md']).toContain('material contract change, missing required proof');
      expect(fixtures['PLAN.md']).toContain('report the unresolved\nconflict');
      expect(fixtures['PLAN.md']).toContain('Optional polish, duplicate contract');
    });
  });

  test('CEO-specific writing guidance leaves another skill capture prompt unchanged', async () => {
    await withFakeClaude(async (dir, observed) => {
      const scenario = 'Keep the requested release workflow and report.';
      await captureSectionReads({
        planDir: dir, skillName: 'ship', scenario, testName: 'ship-report-writing', timeout: 5_000,
      });
      const skillPath = path.join(dir, 'ship', 'SKILL.md');
      expect(observed().prompt).toBe(`You are running an automated skill-execution test. No human is present, so AskUserQuestion is unavailable. The ONLY skill file you may read is this absolute path: ${skillPath}. Do NOT Glob/find/search for any other SKILL.md anywhere — especially nothing under ~/.claude or /Users.

Read ${skillPath} and EXECUTE its workflow for this scenario:

${scenario}

Rules for this run:
- Skip system-audit, environment-setup, telemetry, and unrelated codebase exploration. Read the supplied plan's referenced fixture files when its review requires them.
- At any decision point that would call AskUserQuestion, silently pick the skill's recommended option and continue. Do NOT stop to ask.
- This skill's body has been carved into on-demand sections/. When the skill gives a STOP-Read directive (for example "Read \`.../sections/<file>\` and execute it in full"), you MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers. Do not work from memory.
- Resolve installed-root paths for section and companion Markdown files under ${dir}, where this fixture's skill package is copied.
- Do NOT run git, gh, commit, push, or any mutating command.
- When the workflow is complete, write the skill's final output (the full review report / ship plan, including any required report table) to ${path.join(dir, 'REPORT.md')}.
- After all required writes are complete, return a brief completion message and STOP. Do not reproduce the full report in the final response.`);
    });
  });

  test('native-only capture gives its child real isolated disabled config and cleans only that state', async () => {
    await withFakeClaude(async (dir, observed) => {
      const hostState = path.join(dir, 'host-state');
      fs.mkdirSync(hostState);
      const hostConfig = 'codex_reviews: enabled\nmarker: preserve\n';
      fs.writeFileSync(path.join(hostState, 'config.yaml'), hostConfig);
      process.env.GSTACK_HOME = hostState;
      process.env.GSTACK_STATE_ROOT = hostState;
      const sharedConfigPath = path.join(getHermeticDirs().gstackHome, 'config.yaml');
      const sharedBefore = fs.existsSync(sharedConfigPath) ? fs.readFileSync(sharedConfigPath, 'utf8') : null;
      const result = await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review the full plan',
        testName: 'section-tools-native', nativeReviewOnly: true, timeout: 5_000,
      });
      const child = observed();
      expect(child.outsideDisabled).toBe(true);
      expect(child.stateRoot).toBe(child.stateHome);
      expect(child.stateHome).not.toBe(hostState);
      expect(child.stateHome).not.toBe(getHermeticDirs().gstackHome);
      expect(path.isAbsolute(child.stateHome)).toBe(true);
      expect(path.dirname(child.stateHome)).toBe(path.resolve(dir));
      expect(child.promptConfigPath).toBe(path.join(path.basename(child.stateHome), 'config.yaml'));
      expect(child.promptConfig).toBe('codex_reviews: disabled\n');
      expect(child.promptConfigMatchesState).toBe(true);
      expect(child.prompt).toContain('Complete all native review sections and the full required report.');
      expect(child.prompt).toContain('report outside coverage as disabled');
      expect(fs.existsSync(child.stateHome)).toBe(false);
      expect(fs.readFileSync(path.join(hostState, 'config.yaml'), 'utf8')).toBe(hostConfig);
      expect(fs.existsSync(sharedConfigPath) ? fs.readFileSync(sharedConfigPath, 'utf8') : null).toBe(sharedBefore);
      expect(result.reportProduced).toBe(true);
      expect(result.output).toContain('Outside review: disabled');
    });
  });

  test('native-only review can update and read back its owned plan with Edit while provider dispatch stays disabled', async () => {
    await withFakeClaude(async (dir, observed) => {
      const original='# Original requirements\nKeep this accepted contract.\n';
      fs.writeFileSync(path.join(dir,'PLAN.md'),original);
      fs.writeFileSync(path.join(dir,'active-plan-output'),'');
      fs.writeFileSync(path.join(dir,'incremental-edit'),'');
      const result=await captureSectionReads({planDir:dir,skillName:'plan-ceo-review',scenario:'Review the full plan',
        reportFile:'PLAN.md',reportMarker:/^## GSTACK REVIEW REPORT$/m,testName:'native-local-edit',nativeReviewOnly:true,timeout:5000});
      expect(result.exitReason).toBe('success'); expect(result.reportProduced).toBe(true); expect(result.reportWritten).toBe(true);
      expect(result.output.startsWith(original)).toBe(true); expect(result.readSections.has('review-sections.md')).toBe(true);
      expect(result.toolCalls.map(call=>call.tool)).toEqual(['Read','Read','Edit','Read']);
      expect(result.toolCalls[2]!.output).toBe('File edited successfully.');
      expect(result.toolCalls[3]!.output).toBe(result.output);
      expect(flagValue(observed().args,'--tools')).toBe('Read,Grep,Glob,Write,Edit,Bash');
      expect(observed().outsideDisabled).toBe(true); expect(observed().promptConfigMatchesState).toBe(true);
      expect(fs.existsSync(observed().stateHome)).toBe(false);
    });
  });

  test('native-only config resolves from the prompt inside a nested fixture working directory', async () => {
    await withFakeClaude(async (dir) => {
      const planDir = path.join(dir, 'gstack-paid-shard-fixture', 'tmp', 'review fixture');
      fs.mkdirSync(planDir, { recursive: true });
      const result = await captureSectionReads({
        planDir, skillName: 'plan-ceo-review',
        scenario: 'Review the full plan', testName: 'section-config-nested',
        nativeReviewOnly: true, timeout: 5_000,
      });
      const child: Observed = JSON.parse(fs.readFileSync(path.join(planDir, 'observed.json'), 'utf8'));
      expect(fs.realpathSync(child.workingDirectory)).toBe(fs.realpathSync(planDir));
      expect(path.isAbsolute(child.stateHome)).toBe(true);
      expect(path.dirname(child.stateHome)).toBe(path.resolve(planDir));
      expect(child.stateRoot).toBe(child.stateHome);
      expect(child.promptConfigPath).toMatch(/^\.gstack-section-state-[^/\\]+[/\\]config\.yaml$/);
      expect(path.isAbsolute(child.promptConfigPath!)).toBe(false);
      expect(child.promptConfig).toBe('codex_reviews: disabled\n');
      expect(child.promptConfigMatchesState).toBe(true);
      expect(child.outsideDisabled).toBe(true);
      expect(result.reportProduced).toBe(true);
      expect(fs.existsSync(child.stateHome)).toBe(false);
      expect(fs.readdirSync(planDir).filter(name => name.startsWith('.gstack-section-state-'))).toEqual([]);
    });
  });

  test('overlapping native-only captures in one fixture retain independent config until each exits', async () => {
    await withFakeClaude(async (dir) => {
      fs.writeFileSync(path.join(dir, 'coordinate-configs'), '');
      const captures = [0, 1].map(index => captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review the full plan',
        testName: 'section-config-overlap-' + index, nativeReviewOnly: true, timeout: 5_000,
      }));
      const readChildren = (): Observed[] => fs.readdirSync(dir)
        .filter(name => /^observed-.*\.json$/.test(name))
        .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      let children: Observed[] = [];
      try {
        const deadline = Date.now() + 3_000;
        while ((children = readChildren()).length < 2 && Date.now() < deadline) await Bun.sleep(5);
        expect(children).toHaveLength(2);
        expect(new Set(children.map(child => child.stateHome)).size).toBe(2);
        for (const child of children) {
          expect(path.dirname(child.stateHome)).toBe(path.resolve(dir));
          expect(child.stateRoot).toBe(child.stateHome);
          expect(child.promptConfigMatchesState).toBe(true);
          expect(child.promptConfig).toBe('codex_reviews: disabled\n');
        }
        fs.writeFileSync(path.join(dir, 'release-' + path.basename(children[0].stateHome)), '');
        expect((await Promise.race(captures)).reportProduced).toBe(true);
        expect(fs.existsSync(children[0].stateHome)).toBe(false);
        expect(fs.readFileSync(path.join(children[1].stateHome, 'config.yaml'), 'utf8')).toBe('codex_reviews: disabled\n');
      } finally {
        for (const child of readChildren()) fs.writeFileSync(path.join(dir, 'release-' + path.basename(child.stateHome)), '');
        const results = await Promise.all(captures);
        expect(results.every(result => result.reportProduced)).toBe(true);
      }
      for (const child of children) expect(fs.existsSync(child.stateHome)).toBe(false);
    });
  }, 10_000);

  test.each(['nonzero', 'is_error', 'error'])('a %s capture cannot pass using a report left behind before failure', async (failure) => {
    await withFakeClaude(async (dir, observed) => {
      fs.writeFileSync(path.join(dir, 'fail-cli'), failure);
      const result = await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review the full plan',
        testName: 'section-tools-failed', nativeReviewOnly: true, timeout: 5_000,
        reportMarker: /^## GSTACK REVIEW REPORT\s*$/m,
      });
      expect(observed().outsideDisabled).toBe(true);
      expect(observed().promptConfigMatchesState).toBe(true);
      expect(fs.existsSync(observed().stateHome)).toBe(false);
      expect(result.reportProduced).toBe(false);
      // Preserve useful diagnostics; failed completion does not erase output.
      expect(result.output).toContain('## GSTACK REVIEW REPORT');
    });
  });

  test('a timed-out native-only capture removes its config after the CLI has read it', async () => {
    await withFakeClaude(async (dir, observed) => {
      fs.writeFileSync(path.join(dir, 'wait-for-report'), '');
      const result = await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review the full plan',
        testName: 'section-config-timeout', nativeReviewOnly: true, timeout: 1_500,
      });
      expect(fs.existsSync(path.join(dir, 'work-ready'))).toBe(true);
      expect(observed().promptConfigMatchesState).toBe(true);
      expect(observed().promptConfig).toBe('codex_reviews: disabled\n');
      expect(fs.existsSync(observed().stateHome)).toBe(false);
      expect(result.reportProduced).toBe(false);
      expect(fs.existsSync(path.join(dir, 'REPORT.md'))).toBe(false);
    });
  }, 5_000);
});
