import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createShipLandFixture, REVIEW_HEAD, SHIP_LAND_CASES } from './helpers/ship-land-fixture';
import { createShipLandActor } from './helpers/ship-land-actor';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.resolve(import.meta.dir, '..');

describe('ship/land native fixture calibration', () => {
  for (const name of ['commands-python', 'commands-node'] as const) {
    test(`${name} executes real declared tuples and reuses only matching evidence`, () => {
      const fixture = createShipLandFixture(name);
      try {
        for (const lane of fixture.lanes) {
          const run = fixture.run('gstack-evidence', ['run', '--label', lane.label, '--', lane.command], lane.cwd);
          expect(run.status, run.stderr).toBe(0);
          expect(run.stdout).toContain('1 pass, 0 fail, 0 skip');
          const check = fixture.run('gstack-evidence', ['check', '--label', lane.label, '--expect-cmd', lane.command], lane.cwd);
          expect(check.status, check.stdout + check.stderr).toBe(0);
          expect(check.stdout).toContain('FRESH');
          expect(fixture.run('gstack-evidence', ['check', '--label', lane.label, '--expect-cmd', lane.command + ' '], lane.cwd).status).toBe(1);
          expect(fixture.run('gstack-evidence', ['check', '--label', lane.label, '--expect-cmd', lane.command], fixture.repo).status).toBe(1);
        }
        expect(fixture.events().filter(event => event.kind === 'lane')).toHaveLength(4);
        fs.writeFileSync(path.join(fixture.repo, 'app/checks.py'), 'raise Exception("regression")\n');
        const lane = fixture.lanes[0];
        expect(fixture.run('gstack-evidence', ['check', '--label', lane.label, '--expect-cmd', lane.command], lane.cwd).status).toBe(1);
      } finally { fixture.cleanup(); }
    }, 30_000);
  }

  test('zero selected cases and selector failure remain distinct from no eval declaration', () => {
    for (const name of ['commands-zero-eval', 'commands-selector-error', 'commands-no-eval'] as const) {
      const fixture = createShipLandFixture(name);
      try {
        if (name === 'commands-no-eval') expect(fixture.lanes.map(lane => lane.label)).not.toContain('evals');
        else {
          const selection = fixture.run('python3', ['select.py']);
          expect(selection.status).toBe(name === 'commands-selector-error' ? 9 : 0);
          expect(JSON.parse(selection.stdout).required).toBe(true);
          if (name === 'commands-zero-eval') expect(JSON.parse(selection.stdout).selected).toEqual([]);
        }
      } finally { fixture.cleanup(); }
    }
  });

  test('all short cases extract current generated gates and retain fixture-only state', () => {
    for (const name of SHIP_LAND_CASES) {
      const fixture = createShipLandFixture(name);
      try {
        expect(fs.realpathSync(fixture.repo).startsWith(fs.realpathSync(fixture.root) + path.sep)).toBe(true);
        expect(fixture.excerpt).not.toContain('AUTO-GENERATED');
        expect(fixture.excerpt).toContain(name.startsWith('commands-') ? 'exact command' : 'Requested human review');
        expect(fixture.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Object.keys(fixture.env).sort()).toEqual(['FIXTURE_COMMAND_LOG', 'GSTACK_HOME', 'GSTACK_STATE_DIR', 'HOME', 'PATH']);
        expect(fixture.run('git', ['status', '--porcelain']).status).toBe(0);
      } finally { fixture.cleanup(); }
    }
  }, 20_000);

  test('emitted checks JSON commands use gh-supported fields and preserve failure status', () => {
    const files = ['land-and-deploy/SKILL.md.tmpl', 'land-and-deploy/sections/first-run-validation.md.tmpl'];
    const commands = files.flatMap(file => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
      .filter(line => line.startsWith('gh pr checks') && line.includes('--json')));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--json name,state,bucket');
    expect(commands[1]).toContain('--json name,link');
    for (const name of ['review-solo', 'ci-pending', 'ci-failed', 'ci-cancelled', 'ci-skipped', 'ci-empty'] as const) {
      const fixture = createShipLandFixture(name);
      try {
        for (const command of commands) {
          const result = fixture.run('bash', ['-c', `PR_NUMBER=42; ${command}`]);
          expect(result.stderr).not.toContain('Unknown JSON field');
          expect(Array.isArray(JSON.parse(result.stdout))).toBe(true);
          if (name === 'ci-pending') expect(result.status).toBe(8);
          if (name === 'ci-failed' || name === 'ci-cancelled') expect(result.status).toBe(1);
        }
      } finally { fixture.cleanup(); }
    }
  }, 20_000);

  test('fixture cannot hide head mismatch or branch protection and records authoritative readback', () => {
    for (const name of ['review-approved', 'review-protected', 'review-head-change'] as const) {
      const fixture = createShipLandFixture(name);
      try {
        if (name === 'review-head-change') fixture.changeHead();
        const result = fixture.run('gh', ['pr', 'merge', '42', '--squash', '--match-head-commit', REVIEW_HEAD, '--auto', '--delete-branch']);
        expect(result.status).toBe(name === 'review-approved' ? 0 : 1);
        const readback = fixture.run('gh', ['pr', 'view', '42', '--json', 'state']);
        expect(JSON.parse(readback.stdout).state).toBe(name === 'review-approved' ? 'MERGED' : 'OPEN');
        expect(fixture.events().some(event => event.kind === 'gh' && event.args[1] === 'merge')).toBe(true);
      } finally { fixture.cleanup(); }
    }
  });

  test('review fixtures expose current requests, history, effective states and API failure', () => {
    for (const name of SHIP_LAND_CASES.filter(name => name.startsWith('review-'))) {
      const fixture = createShipLandFixture(name);
      try {
        const current = JSON.parse(fixture.run('gh', ['pr', 'view', '42', '--json', 'headRefOid,reviewRequests,reviewDecision']).stdout);
        expect(current.headRefOid).toBe(REVIEW_HEAD);
        const timeline = fixture.run('gh', ['api', '--paginate', 'repos/fixture-owner/fixture-repo/issues/42/timeline']);
        const history = JSON.parse(fixture.run('gh', ['api', '--paginate', 'repos/fixture-owner/fixture-repo/pulls/42/reviews']).stdout);
        if (name === 'review-unknown') expect(timeline.status).toBe(1);
        else expect(Array.isArray(JSON.parse(timeline.stdout))).toBe(true);
        if (name === 'review-commented') {
          expect(current.reviewRequests).toEqual([]);
          expect(history[0].state).toBe('COMMENTED');
          expect(JSON.parse(timeline.stdout)[0].event).toBe('review_requested');
        }
        if (name === 'review-dismissed') expect(history[0].state).toBe('DISMISSED');
        if (name === 'review-stale') expect(history[0].commit_id).not.toBe(current.headRefOid);
        if (name === 'review-bot') expect(history[0].user.type).toBe('Bot');
        if (name === 'review-solo') expect(JSON.parse(timeline.stdout)).toEqual([]);
      } finally { fixture.cleanup(); }
    }
  }, 20_000);
});

describe('ship/land authored gate contracts', () => {
  for (const attempt of ['first', 'second']) {
    for (const callbackFirst of [false, true]) {
      test(`captured ${attempt} readiness report binds shortened merge question (callback first: ${callbackFirst})`, async () => {
        const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ship-land', `approved-comment-${attempt}.json`), 'utf8'));
        const fixture = createShipLandFixture('review-approved-comment');
        try {
          const actor = createShipLandActor('review-approved-comment', fixture, () => {});
          for (const event of captured.events as SDKMessage[]) {
            if (!callbackFirst) actor.observe(event);
            if (event.type === 'assistant') {
              for (const block of event.message.content) {
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                  await actor.canUseTool(block.name, block.input as Record<string, unknown>, { signal: AbortSignal.timeout(1000), toolUseID: block.id });
                }
              }
            }
            if (callbackFirst) actor.observe(event);
          }
          expect(actor.mergePermission).toBe(true);
          expect(actor.waiver).toBe(false);
          expect(actor.questions).toHaveLength(1);
          expect(actor.questions[0].answer).toBe(`Merge PR #42 at ${REVIEW_HEAD}; no other permission or waiver is granted.`);
        } finally { fixture.cleanup(); }
      });
    }
  }

  for (const name of SHIP_LAND_CASES.filter(name => !name.startsWith('commands-'))) {
    test(`review/CI ${name} starts with the final instructions committed`, () => {
      const fixture = createShipLandFixture(name);
      try {
        const status = fixture.run('git', ['status', '--porcelain']);
        expect(status.status).toBe(0);
        expect(status.stdout, name).toBe('');
        const committed = fixture.run('git', ['show', 'HEAD:AGENTS.md']);
        expect(committed.status).toBe(0);
        expect(committed.stdout).toBe(fs.readFileSync(path.join(fixture.repo, 'AGENTS.md'), 'utf8'));
      } finally { fixture.cleanup(); }
    });
  }

  describe('observed readiness rejects a different target or unrelated context', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ship-land/approved-comment-first.json'), 'utf8'));
    const report = captured.events.find((event: any) => event.type === 'assistant' && event.message.content[0].type === 'text');
    const text = report.message.content[0].text as string;
    const withText = (text: string) => ({ ...report, message: { ...report.message, content: [{ type: 'text', text }] } });
    const question = 'Merge PR #42 at head aaaaaaaa…aaaa?';
    const controls = [
      { name: 'no context', events: [] },
      { name: 'wrong report PR', events: [withText(text.replaceAll('PR #42', 'PR #142'))] },
      { name: 'wrong report head', events: [withText(text.replaceAll(REVIEW_HEAD, 'b'.repeat(40)))] },
      { name: 'wrong question PR', events: [report], question: question.replace('#42', '#142') },
      { name: 'wrong abbreviated question head', events: [report], question: question.replace('aaaaaaaa…aaaa', 'bbbbbbbb…bbbb') },
      { name: 'wrong abbreviated suffix', events: [report], question: question.replace('…aaaa', '…bbbb') },
      { name: 'wrong full question head', events: [report], question: `Merge PR #42 at ${'b'.repeat(40)}?` },
      { name: 'explicit wrong PR without context', events: [], question: `Merge PR #142 at ${REVIEW_HEAD}?` },
      { name: 'unrelated text', events: [withText(`Document PR #42 at ${REVIEW_HEAD} in a future example.`)] },
      { name: 'intervening unrelated text', events: [report, withText('Now inspect unrelated documentation.')] },
      { name: 'quoted report', events: [withText(text.split('\n').map(line => `> ${line}`).join('\n'))] },
      { name: 'code example', events: [withText('```\n' + text + '\n```')] },
      { name: 'child-agent report', events: [{ ...report, parent_tool_use_id: 'child' }] },
      { name: 'another session', events: [report, { ...report, session_id: 'another-session' }] },
      { name: 'tool-result report', events: [{ ...report, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: text }] } }] },
      { name: 'intervening command', events: [report, { ...report, message: { ...report.message, content: [{ type: 'tool_use', name: 'Bash', id: 'intervening', input: { command: 'git status' } }] } }] },
      { name: 'changed fixture head', events: [report], changedHead: true },
      { name: 'changed fixture head with explicit old-head question', events: [], changedHead: true, question: `Merge PR #42 at ${REVIEW_HEAD}?` },
    ];
    for (const control of controls) {
      test(control.name, async () => {
        const fixture = createShipLandFixture('review-approved-comment');
        try {
          const actor = createShipLandActor('review-approved-comment', fixture, () => {});
          for (const event of control.events) actor.observe(event);
          if (control.changedHead) fixture.changeHead();
          await actor.canUseTool('AskUserQuestion', { questions: [{ question: control.question ?? question, options: [] }] }, { signal: AbortSignal.timeout(1000), toolUseID: 'negative' });
          expect(actor.mergePermission, control.name).toBe(false);
          expect(actor.waiver, control.name).toBe(false);
          expect(actor.questions[0].answer, control.name).toContain('Hold');
        } finally { fixture.cleanup(); }
      });
    }
  });

  test('observed waiver context grants only alice review relief, never implicit merge permission', async () => {
    const fixture = createShipLandFixture('review-waiver');
    try {
      const actor = createShipLandActor('review-waiver', fixture, () => {});
      const report = { type: 'assistant', session_id: 'waiver', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `PRE-MERGE READINESS REPORT\nPR #42 at head ${REVIEW_HEAD}. Alice's requested review is pending.` }] } } as SDKMessage;
      const ask = async (question: string) => actor.canUseTool('AskUserQuestion', { questions: [{ question, options: [] }] }, { signal: AbortSignal.timeout(1000), toolUseID: 'waiver-context' });
      actor.observe(report);
      await ask('Merge anyway?');
      expect(actor.waiver).toBe(false);
      expect(actor.mergePermission).toBe(false);
      actor.observe(report);
      await ask('Waive the pending alice review?');
      expect(actor.waiver).toBe(true);
      expect(actor.mergePermission).toBe(false);
      expect(actor.questions.at(-1)?.answer).toBe(`I waive only alice's pending requested human review for PR #42 at ${REVIEW_HEAD}. This is not merge permission.`);
      await ask('Merge PR #42 at head aaaaaaaa…aaaa?');
      expect(actor.mergePermission).toBe(false);
      actor.observe(report);
      await ask('Merge PR #42 at head aaaaaaaa…aaaa?');
      expect(actor.mergePermission).toBe(true);
      expect(actor.questions.at(-1)?.answer).toBe(`Merge PR #42 at ${REVIEW_HEAD}; no other permission or waiver is granted.`);
      fixture.changeHead();
      actor.observe(report);
      await ask(`Merge PR #42 at ${REVIEW_HEAD}?`);
      expect(actor.questions.at(-1)?.answer).toContain('Hold');
    } finally { fixture.cleanup(); }
  });

  test('actual actor callback requires scoped waiver and separate permission, never approves expansion', async () => {
    const fixture = createShipLandFixture('review-waiver');
    try {
      const actor = createShipLandActor('review-waiver', fixture, () => {});
      const ask = async (question: string) => actor.canUseTool('AskUserQuestion', {
        questions: [{ question, header: 'Gate', multiSelect: false, options: [{ label: 'Wait', description: 'Hold' }, { label: 'Proceed', description: 'Continue' }] }],
      }, { signal: AbortSignal.timeout(1000), toolUseID: 'free-actor' });
      await ask('Approve an unrelated rewrite?');
      expect(actor.questions.at(-1)?.answer).toContain('Hold');
      await ask('Waive pending alice review for PR #42 at the wrong head?');
      expect(actor.waiver).toBe(false);
      await ask(`Waive pending alice review for PR #42 at ${REVIEW_HEAD}?`);
      expect(actor.waiver).toBe(true);
      expect(actor.mergePermission).toBe(false);
      await ask(`Merge PR #42 at ${REVIEW_HEAD}?`);
      expect(actor.mergePermission).toBe(true);
      expect(actor.questions.at(-1)?.answer).toContain('no other permission or waiver is granted');
      const denied = await actor.canUseTool('Bash', { command: 'curl https://example.invalid' }, { signal: AbortSignal.timeout(1000), toolUseID: 'no-network' });
      expect(denied.behavior).toBe('deny');
    } finally { fixture.cleanup(); }
  });

  test('head-change actor mutates only its owned PR and grants no new-head approval', async () => {
    const fixture = createShipLandFixture('review-head-change');
    try {
      const actor = createShipLandActor('review-head-change', fixture, () => {});
      const input = { questions: [{ question: `Merge PR #42 at ${REVIEW_HEAD}?`, options: [] }] };
      await actor.canUseTool('AskUserQuestion', input, { signal: AbortSignal.timeout(1000), toolUseID: 'head' });
      expect(fixture.run('gh', ['pr', 'view', '42', '--json', 'headRefOid', '-q', '.headRefOid']).stdout.trim()).not.toBe(REVIEW_HEAD);
      await actor.canUseTool('AskUserQuestion', input, { signal: AbortSignal.timeout(1000), toolUseID: 'head-again' });
      expect(actor.questions.at(-1)?.answer).toContain('Hold');
    } finally { fixture.cleanup(); }
  });

  test('scoped waiver and merge permission cannot bypass the protected-branch fixture', async () => {
    const fixture = createShipLandFixture('review-protected');
    try {
      const actor = createShipLandActor('review-protected', fixture, () => {});
      for (const question of [`Waive alice's pending review on PR #42 at ${REVIEW_HEAD}?`, `Merge PR #42 at ${REVIEW_HEAD}?`]) {
        await actor.canUseTool('AskUserQuestion', { questions: [{ question, options: [] }] }, { signal: AbortSignal.timeout(1000), toolUseID: 'protected' });
      }
      expect(actor.waiver).toBe(true);
      expect(actor.mergePermission).toBe(true);
      const result = fixture.run('gh', ['pr', 'merge', '42', '--squash', '--match-head-commit', REVIEW_HEAD]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Protected branch');
      expect(JSON.parse(fixture.run('gh', ['pr', 'view', '42', '--json', 'state']).stdout).state).toBe('OPEN');
    } finally { fixture.cleanup(); }
  });

  test('removes conflicting runtime/selector fallbacks without removing failure gates', () => {
    const ship = fs.readFileSync(path.join(ROOT, 'ship/sections/tests.md.tmpl'), 'utf8');
    const land = fs.readFileSync(path.join(ROOT, 'land-and-deploy/sections/readiness-gate.md.tmpl'), 'utf8');
    expect(ship).not.toContain('app/services/*_prompt_builder.rb');
    expect(ship).not.toContain('If no matches');
    expect(ship).toContain('required selection with zero cases');
    expect(ship).toContain('Test Failure Ownership Triage');
    expect(land).not.toContain('bun test');
    expect(land).toContain('Cannot merge with failing tests');
    expect(land).toContain('separate Step 3.5e merge permission');
    expect(land).toContain('this PR, this head and each');
    expect(land).toContain('COMMENTED/PENDING alone is not');
  });
});
