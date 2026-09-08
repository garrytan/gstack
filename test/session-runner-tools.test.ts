import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  const observed = {
    args: process.argv.slice(2), prompt, stateHome,
    stateRoot: process.env.GSTACK_STATE_ROOT ?? null,
    outsideDisabled: /^codex_reviews:\s*disabled\s*$/m.test(config),
  };
  fs.writeFileSync('observed.json', JSON.stringify(observed));
  const outputFile = fs.existsSync('active-plan-output') ? 'PLAN.md' : 'REPORT.md';
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  if (fs.existsSync('fail-cli')) {
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
      expect(flagValue(observed().args, '--allowed-tools')).toBe('Read');
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
      expect(flagValue(observed().args, '--tools')).toBe('Read,Grep,Glob,Write');
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
      expect(observed().prompt).toContain('to ' + path.join(dir, 'PLAN.md') + '.');
      expect(observed().prompt).toContain('After all required writes are complete');
      expect(result.readSections.has('review-sections.md')).toBe(true);
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
      expect(child.prompt).toContain(path.join(child.stateHome, 'config.yaml'));
      expect(child.prompt).toContain('Complete all native review sections and the full required report.');
      expect(child.prompt).toContain('report outside coverage as disabled');
      expect(fs.existsSync(child.stateHome)).toBe(false);
      expect(fs.readFileSync(path.join(hostState, 'config.yaml'), 'utf8')).toBe(hostConfig);
      expect(fs.existsSync(sharedConfigPath) ? fs.readFileSync(sharedConfigPath, 'utf8') : null).toBe(sharedBefore);
      expect(result.reportProduced).toBe(true);
      expect(result.output).toContain('Outside review: disabled');
    });
  });

  test.each(['nonzero', 'is_error', 'error'])('a %s capture cannot pass using a report left behind before failure', async (failure) => {
    await withFakeClaude(async (dir, observed) => {
      fs.writeFileSync(path.join(dir, 'fail-cli'), failure);
      const result = await captureSectionReads({
        planDir: dir, skillName: 'plan-ceo-review', scenario: 'Review the full plan',
        testName: 'section-tools-failed', nativeReviewOnly: true, timeout: 5_000,
        reportMarker: /^## GSTACK REVIEW REPORT\s*$/m,
      });
      expect(observed().outsideDisabled).toBe(true);
      expect(fs.existsSync(observed().stateHome)).toBe(false);
      expect(result.reportProduced).toBe(false);
      // Preserve useful diagnostics; failed completion does not erase output.
      expect(result.output).toContain('## GSTACK REVIEW REPORT');
    });
  });
});
