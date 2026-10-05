import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateQAExploratory, generateQAMethodReads, generateQAReview, generateQAReviewPreflight } from '../scripts/resolvers/qa';
import { generatePlanVerificationExec } from '../scripts/resolvers/plan-gates';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { qaProbeNames } from './helpers/qa-probe-names';
import { expectMentions } from './helpers/prompt-structure';

const startCommand = (text: string) => { const n = qaProbeNames(text); return `bun ${n.guard} start ${n.deadline} SECONDS`; };

function assertPreparation(text: string) {
  expectMentions(text, [['before', 'charters', 'writing']], 'text');
  expect(text).toMatch(/Await their results before the first probe, never in the same response\.|Await each successful Read result before continuing\./i);
  expectMentions(text, [['do not', 'completed', 'already']], 'text');
  const stages = ['Read `sections/scope.md`', '**Functional surfaces:**', 'Read `sections/system-functional.md`',
    '**Browser surfaces only:**', 'Read `sections/qa-patterns.md`', '## 1. Charter and preflight',
    startCommand(text), '1. First demonstrate success'];
  const positions = stages.map(stage => text.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  for (const section of ['scope', 'system-functional', 'qa-patterns']) {
    expect(text.split(`Read \`sections/${section}.md\``)).toHaveLength(2);
  }
}

function assertBoundsAndLayout(text: string) {
  for (const contract of ['Browser Quick: SECONDS=180', 'Browser Full/Regression: SECONDS=900']) expect(text).toContain(contract);
  for (const rule of [
    /functional full, quick and regression have no default total timer/i,
    /shorter mode\/caller limit/i,
    new RegExp(`without a total time limit, do not (?:start|create) ${qaProbeNames(text).deadline}`, 'i'),
    /finite command timeouts/i,
    /mixed standalone runs use REPORT_DIR\/browser and REPORT_DIR\/functional/i,
    /one final report at REPORT_DIR/i,
    /caller paths win/i,
  ]) expect(text).toMatch(rule);
  expect(text.search(/caller paths win/i)).toBeLessThan(text.indexOf(startCommand(text)));
}

function assertPlanExecution(text: string, shared = generateQAExploratory({ host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude })) {
  const step = text.slice(text.indexOf('**3. Run smoke and plan checks.**'), text.indexOf('**4. Check freshness before reporting.**')).replace(/\s+/g, ' ');
  for (const rule of [
    /shared Probe loop for smoke checks and replays until the smoke limit/i,
    /required plan checks and revalidation, even after smoke expires/i,
    /same procedure but no smoke guard; never reset the clock/i,
    /capped at the caller's remaining time/i,
    /deadline expires, mark unfinished checks not-run/i,
    /await clock\/guard results before acting/i,
  ]) expect(step).toMatch(rule);
  expect(step.indexOf('Follow the shared Probe loop')).toBeLessThan(step.indexOf('Then run required plan checks'));
  expect(step.indexOf('Then run required plan checks')).toBeLessThan(step.indexOf('same procedure'));
  for (const rule of [/demonstrate success: output and durable effects/i,
    /wait for successful checkpoint publication before dispatch/i,
    /replay the exact failing command\/request from the same initial fixture state/i]) {
    expect(shared).toMatch(rule);
  }
}

describe('QA probe entry and checkpoint gates', () => {
  test('the native CI preparation excerpt lacks the required acknowledged-read gate', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/qa-functional-ci-36505065023.json'), 'utf8'));
    const output = captured.omittedReadEvents.flatMap(event => event.message.content)
      .find(block => block.type === 'tool_result' && typeof block.content === 'string' && block.content.includes('# Shared exploratory QA')).content;
    const old = output.replace(/^\s*\d+(?:→|\t)/gm, '');
    expect(old).toContain('Read `sections/scope.md`');
    expect(old).toContain('Read `sections/system-functional.md`');
    const current = generateQAExploratory({ host: 'claude', skillName: 'qa-only', tmplPath: '', paths: HOST_PATHS.claude });
    for (const clause of ['## 0. Preparation gate', 'Await each successful Read result before continuing',
      'complete it now before Charter and preflight']) {
      expect(old).not.toContain(clause);
      expect(current).toContain(clause);
    }
    assertPreparation(current);
  });

  test('the report template no longer asks agents to sanitize public state paths', () => {
    const report = fs.readFileSync(path.join(import.meta.dir, '../qa/templates/functional-report-template.md'), 'utf8');
    expect(report).toContain('EXACT SAFE OUTPUT AND STATE PATHS');
    expect(report).toContain('REDACTION AND REPRODUCIBILITY LIMITS');
    expect(report).not.toContain('SANITIZED OUTPUT/STATE PATHS');
  });

  test('parent QA instructions resolve nested methods and reports from the same installed QA directory', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['review', 'ship']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const preflight = generateQAReviewPreflight(ctx).replace(/\s+/g, ' ');
        const body = generateQAReview(ctx).replace(/\s+/g, ' ');
        expect(preflight).toMatch(/`sections\/\.\.\.` and `templates\/\.\.\.` paths from that installed QA SKILL\.md directory, not the caller or product directory/i);
        expect(body).toContain('Read QA\'s `sections/browser-setup.md`');
        expect(body).toContain('Read QA\'s `templates/functional-report-template.md`');
        if (skillName === 'review') {
          expect(body).toContain('Read QA\'s `templates/qa-report-template.md`');
          expect(body).toContain('Step 4\'s surfaces');
          expectMentions(body, [['do not', 'completed', 'repeat']], 'body');
        }
      }
    }
  });

  test('composes and checks a complete note before immutable publication on every host', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['qa', 'qa-only']) {
        const text = generateQAExploratory({ host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] });
        const stages = [...(skillName === 'qa-only' ? ['Classify the last result before copying it'] : []),
          'Check fields before publication', "--after PREV --hypothesis 'why' -- CMD",
          'Browser checkpoints use Write', 'Wait for successful checkpoint publication', '3. Run that exact probe'];
        const positions = stages.map(stage => text.indexOf(stage));
        expect(positions.every(position => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expectMentions(text, [['cannot', 'corrections', 'published']], 'text');
        if (skillName === 'qa-only') {
          expectMentions(text, [['never', 'substitute', 'identity']], 'text');
          expectMentions(text, [['stop', 'affected', 'probe']], 'text');
        } else {
          expectMentions(text, [['stop', 'withhold', 'disclose']], 'text');
        }
      }
    }
  });

  test('mode bounds and checkpoint nesting are explicit before dispatch', () => {
    for (const skillName of ['qa', 'qa-only']) {
      const text = generateQAExploratory({ host: 'claude', skillName, tmplPath: '', paths: HOST_PATHS.claude });
      for (const contract of [
        'Reuse resolved REPORT_DIR',
        'exactly four top-level fields:', 'observationCommand:', 'observed:', 'hypothesis:', 'nextCommand:',
        'QA_DEADLINE receipts are not observations',
      ]) expect(text).toContain(contract);
      assertBoundsAndLayout(text);
      expect(text.indexOf('Browser Quick: SECONDS=180')).toBeLessThan(text.indexOf(startCommand(text)));
    }
  });

  test('each shared loop loads its selected methods before choosing or executing probes', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['qa', 'qa-only']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const text = generateQAExploratory(ctx);
        const methods = generateQAMethodReads(ctx);
        expect(text).toContain(methods);
        expect(text.indexOf(methods)).toBeLessThan(text.indexOf('1. First demonstrate success'));
        assertPreparation(text);
        const decision = text.indexOf('Decide whether another probe is needed');
        const write = text.indexOf('**Publish before probing.**');
        expect(decision).toBeGreaterThan(-1);
        expect(decision).toBeLessThan(write);
        expectMentions(text.slice(decision, write), [['not', 'checkpoint', 'report']], 'text.slice(decision, write)');
        expect(text.slice(decision, write)).toMatch(/if expired/i);
        expect(text.slice(decision, write)).not.toContain('If done or blocked');
        if (skillName === 'qa-only') {
        } else {
          expect(text).toMatch(/preserve every safe program-JSON key\/value and identity hash unchanged/i);
        }
        expect(text).toMatch(new RegExp(`${qaProbeNames(text).recorder} supplies observed; never transcribe it`, 'i'));
      }
    }
  });

  test('expiry branches precede baseline, checkpoint, probe and replay execution on every host', () => {
    for (const host of ALL_HOST_CONFIGS) for (const skillName of ['qa', 'qa-only', 'review', 'ship']) {
      const text = generateQAExploratory({ host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] });
      const steps = text.slice(text.indexOf('1. First demonstrate success')).split(/\n(?=[2-5]\. )/);
      expect(steps).toHaveLength(5);
      expect(text).toContain('/gstack-qa-deadline');
      const n = qaProbeNames(text);
      for (const name of Object.values(n)) expect(name.length).toBeGreaterThan(3);
      expect(text).toContain(`bun ${n.guard} start ${n.deadline} SECONDS [EARLIER_UTC]`);
      expect(text).toContain(`\`bun ${n.guard} run ${n.deadline} -- COMMAND ARGS\``);
      expect(text).toContain(`\`bun ${n.recorder} capture ${n.dir} NNN [--public] --deadline ${n.deadline} -- COMMAND ARGS\``);
      expect(text).toContain(`\`bun ${n.recorder} materialize ${n.dir} annotations.json\``);
      expect(text).toMatch(new RegExp(`never reset ${n.deadline}\\W+bypass ${n.guard}`, 'i'));
      expect(text).toMatch(new RegExp(`invalid/missing ${n.deadline} stops probes`, 'i'));
      expect(steps[1]).toContain(`\`bun ${n.guard} status ${n.deadline}\``);
      expect(steps[1].indexOf('If expired')).toBeLessThan(steps[1].indexOf('**Publish before probing.**'));
      expectMentions(steps[1], [['stop', 'exploration', 'report']], 'steps[1]');
      expect(steps[2]).toContain(`${n.guard} enforces the deadline`);
      expect(steps[2]).toMatch(/refusals as not-run/i);
      expect(steps[3]).toContain('via steps 2–3');
      expect(steps[4]).toContain('return to step 2');
    }
  });

  test('parent QA makes method loading a stop gate even for plan verification', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['review', 'ship']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const text = (skillName === 'review' ? generateQAReviewPreflight(ctx) : '') + generateQAReview(ctx);
        const gate = text.search(/before any probe, including plan checks, complete the ordered scope\/method Reads/i);
        expect(gate).toBeGreaterThan(-1);
        expect(text).toContain('{{QA_RESOURCE:exploratory}}');
        expect(text).not.toContain('{{QA_RESOURCE:scope}}');
        expect(text).not.toContain('Read `sections/system-functional.md`');
        const shared = generateQAExploratory({ ...ctx, skillName: 'qa' });
        assertPreparation(shared);
        assertPlanExecution(text);
        const required = text.indexOf(skillName === 'review'
          ? '**2. Check readiness and list required checks.**' : '**2. List required checks');
        expect(required).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(required);
        if (skillName === 'review') {
          const isolation = text.indexOf('**1. Set the charter and isolation.**');
          const setup = text.indexOf("Read QA's `sections/browser-setup.md`");
          expect(isolation).toBeGreaterThan(gate);
          expect(setup).toBeGreaterThan(required);
          expect(text.slice(isolation, required).replace(/\s+/g, ' ')).toMatch(/isolation\/permission preflight before setup/i);
          expect(text).toMatch(/Step 4 is read-only: defer charters, setup and probes to Step 4\.7/i);
        } else {
          const setup = text.indexOf("For browsers, Read QA's `sections/browser-setup.md`");
          expect(setup).toBeGreaterThan(required);
          expect(setup).toBeLessThan(text.indexOf('**3. Run smoke and plan checks'));
        }
      }
    }
  });

  test('preparation controls reject reordered scope, duplicate Reads and early charters', () => {
    const text = generateQAExploratory({ host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude });
    assertPreparation(text);
    const method = 'Read `sections/system-functional.md` in full.';
    for (const changed of [
      method + '\n' + text.replace(method, ''),
      text.replace(method, method + '\n' + method),
      '## 1. Charter and preflight\n' + text,
      text.replace('Do not repeat a Read already completed in this invocation', 'Repeat all Reads'),
      text.replace('Read `sections/qa-patterns.md` in full.', '').replace('## 1. Charter and preflight', '## 1. Charter and preflight\nRead `sections/qa-patterns.md` in full.'),
      // ci-36641820398-1-gate-census-7 ship-exploratory-small-cli dispatched its first probe with the resource Reads.
      text.replace(' Await their results before the first probe, never in the same response.', ''),
    ]) expect(() => assertPreparation(changed)).toThrow();
  });

  test('layout and bounds controls reject mixed caller overrides, split reports and unbounded commands', () => {
    const text = generateQAExploratory({ host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude });
    assertBoundsAndLayout(text);
    for (const [before, after] of [
      ['mixed standalone runs', 'all mixed runs'],
      ['REPORT_DIR/browser and REPORT_DIR/functional', 'REPORT_DIR'],
      ['with one final report at REPORT_DIR', 'write a final report per surface'],
      ['Caller paths win.', 'Surface paths win.'],
      ['finite command timeouts', 'unbounded command timeouts'],
      ["shorter mode/caller limit", 'the mode duration regardless of caller'],
    ]) expect(() => assertBoundsAndLayout(text.replace(before, after))).toThrow();
  });

  test('required plan checks cannot inherit the expired smoke guard or lose caller bounds and checkpoints', () => {
    for (const skillName of ['review', 'ship']) {
      const text = generateQAReview({ host: 'claude', skillName, tmplPath: '', paths: HOST_PATHS.claude }).replace(/\s+/g, ' ');
      assertPlanExecution(text);
      for (const [before, after] of [
        ['Then run required plan checks and revalidation, even after smoke expires', 'Skip plan checks when smoke expired'],
        ['no smoke guard; never reset the clock', 'restart and use the smoke guard'],
        ['same procedure', 'Start a new checkpoint sequence'],
        ['at the caller\'s remaining time', 'with no caller cap'],
        ['When the caller\'s deadline expires, mark unfinished checks not-run', 'If that deadline expired, mark the check passed'],
        ['Await clock/guard results before acting', 'Ignore clock results'],
        ['plan checks and revalidation, even', 'plan checks, even'],
        ['smoke checks and replays until', 'smoke checks, replays and revalidation until'],
      ]) {
        expect(text).toContain(before);
        expect(() => assertPlanExecution(text.replace(before, after))).toThrow();
      }
      const smoke = 'Follow the shared Probe loop for smoke checks and replays until the smoke limit.';
      expect(() => assertPlanExecution(text.replace(smoke, '').replace('**4. Check', smoke + '\n**4. Check'))).toThrow();
      const shared = generateQAExploratory({ host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude });
      for (const contract of ['First demonstrate success: output AND durable effects',
        'Wait for successful checkpoint publication before dispatch',
        'Replay the exact failing command/request from the same initial fixture state']) {
        expect(() => assertPlanExecution(text, shared.replace(contract, 'Optional evidence'))).toThrow();
      }
    }
  });

  test('core review collects runtime checks without executing them ahead of QA setup', () => {
    for (const [file, step] of [['review/SKILL.md.tmpl', 'Step 4.7'], ['ship/sections/review-army.md.tmpl', 'Step 9.2.1']]) {
      const template = fs.readFileSync(path.join(import.meta.dir, '..', file), 'utf8');
      const text = template.replace('{{QA_REVIEW_PREFLIGHT}}', generateQAReviewPreflight({ host: 'claude', skillName: 'review', tmplPath: '', paths: HOST_PATHS.claude }));
      const staticRule = step === 'Step 4.7' ? 'Step 4 is read-only: defer charters, setup and probes to Step 4.7' : `This pass is static; defer product probes to ${step}`;
      expect(text).toContain(staticRule);
      expect(text.indexOf(staticRule)).toBeLessThan(text.indexOf('{{QA_REVIEW}}'));
      if (step === 'Step 4.7') {
        expect(template.indexOf('{{QA_REVIEW_PREFLIGHT}}')).toBeGreaterThan(template.indexOf('## Step 4:'));
        expect(text.indexOf(staticRule)).toBeLessThan(text.indexOf('Apply both checklist passes in order'));
      }
    }
  });

  test('plan execution waits for the actual shared method reads, not just collection', () => {
    const text = generatePlanVerificationExec({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude });
    expectMentions(text, [['do not', 'invoke', 'entire']], 'text');
    expectMentions(text, [['before', 'complete', 'command']], 'text');
  });
});

// Lane S C2: gaps the qa-only/review/ship workflow judges named in their rationales.
describe('judge-named QA workflow gaps (C2)', () => {
  const ctx = (skillName: string) => ({ host: 'claude' as const, skillName, tmplPath: '', paths: HOST_PATHS.claude });

  test('Browser Quick leaves time for its six page probes, and the method states the same budget', () => {
    for (const skillName of ['qa', 'qa-only']) {
      const seconds = Number(/Browser Quick: SECONDS=(\d+)\./.exec(generateQAExploratory(ctx(skillName)))?.[1]);
      // homepage + top 5 targets, each a checkpoint write plus one guarded command: 30 s left ~5 s per probe.
      expect(seconds / 6).toBeGreaterThanOrEqual(20);
      const patterns = fs.readFileSync(path.join(import.meta.dir, '..', 'qa', 'sections', 'qa-patterns.md'), 'utf8');
      expect(patterns).toContain(`${seconds / 60} minutes: homepage + top 5 navigation targets`);
    }
  });

  test('PROBE_DIR names its source line, and stopping goes to the final report steps', () => {
    for (const skillName of ['qa', 'qa-only']) {
      const text = generateQAExploratory(ctx(skillName));
      const layout = text.indexOf('mixed standalone runs use REPORT_DIR/browser and REPORT_DIR/functional');
      const probeDir = text.indexOf("PROBE_DIR: this surface's owned probe directory per the line above.");
      expect(layout).toBeGreaterThan(-1);
      expect(probeDir).toBeGreaterThan(layout);
      expect(text.slice(layout, probeDir).split('\n')).toHaveLength(3);
      expect(text).toContain('write the report (§4), not a checkpoint.');
      const final = text.indexOf('## 4. Final report');
      expect(final).toBeGreaterThan(-1);
      expect(text.indexOf('annotations.json', final)).toBeLessThan(text.indexOf('materialize PROBE_DIR', final));
    }
  });

  test('/review and /ship: step 4c revalidation does not rerun smoke checks after smoke expiry', () => {
    for (const skillName of ['review', 'ship']) {
      const text = generateQAReview(ctx(skillName));
      const rule = text.indexOf('Post-expiry smoke rechecks are not-run, even in 4c.');
      expect(rule).toBeGreaterThan(-1);
      expect(rule).toBeLessThan(text.indexOf('c. Re-review changed or uncertain coverage and repeat step 3 for affected checks.'));
    }
  });
});
