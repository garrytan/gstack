import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import { withPendingExit } from './helpers/plan-count-pending-exit';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/devex-handoff-n-call.json';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-completed-handoff-'));
  const report = path.join(dir, 'plan.md');
  const pending = path.join(dir, 'pending.json');
  fs.writeFileSync(report, captured.reportContent);
  fs.writeFileSync(pending, JSON.stringify(captured.pendingExit));
  const written = captured.provenance.reportMtimeMs / 1000;
  fs.utimesSync(report, written, written);
  const calls = structuredClone(captured.calls) as NativePlanQuestionCall[];
  const started = Date.parse('2026-09-09T01:06:22Z');
  const raw = { status: 'ready' as const, calls, assistantMessages: [] };
  const observed = withPendingExit(raw, pending, captured.provenance.capture.cwd,
    captured.provenance.capture.claudeConfigDir, started, captured.screen);
  return { dir, report, pending, written, started, calls, raw, observed,
    ready: () => hasNativePlanTerminal(observed, report, started, 'plan_ready'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('completed DX handoff with a result recap after its navigation question', () => {
  test('the exact native handoff is the only later answer excluded from report freshness', () => {
    const f = fixture();
    try {
      expect(f.calls).toHaveLength(7);
      expect(Date.parse(f.calls.at(-2)!.answeredAt!)).toBeLessThan(f.written * 1000);
      expect(Date.parse(f.calls.at(-1)!.answeredAt!)).toBeGreaterThan(f.written * 1000);
      expect(f.observed.planReadyRequests?.[0]?.source).toBe('pre_tool_use');
      expect(f.ready()).toBe(true);
      expect(hasNativePlanTerminal(f.raw, f.report, f.started, 'plan_ready')).toBe(false);
    } finally { f.cleanup(); }
  });

  test('finished headings and navigation labels cannot hide a new issue, TODO or unresolved obligation', () => {
    const mutations: Array<(call: NativePlanQuestionCall) => void> = [
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('is complete.', 'is complete only after fixing authentication.'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('5 issues found and resolved', '5 issues found but not resolved'); },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('5 issues found and resolved', '5 issues found and resolved (not all resolved)'); },
      call => { call.questions[0]!.question += ' This is complete only if we fix the missing auth test.'; },
      call => { call.questions[0]!.question = call.questions[0]!.question.replace('What’s next?', 'Should I add a missing test?'); },
      call => { call.questions[0]!.question += ' Should I package another example?'; },
      call => { call.questions[0]!.question += ' We should fix the missing auth test.'; },
      call => { call.questions[0]!.question += ' One issue remains unresolved.'; },
      call => { call.questions[0]!.question += ' <gstack-qid:devex-auth-fix>'; },
      call => { call.questions[0]!.question += ' <gstack-qid'; },
      call => { call.questions[0]!.header = 'TODO'; },
      call => { call.questions[0]!.options[1]!.label = 'Implement another missing example now'; },
      call => { call.questions[0]!.options[2]!.description = 'Proceed to fix the missing auth test.'; },
      call => { call.questions[0]!.options[2]!.description = 'Do you want me to fix the missing auth test?'; },
      call => { call.questions[0]!.options[0]!.description = 'An optional review before shipping.'; },
      call => { call.questions[0]!.options[2]!.description = 'The authentication issue remains unresolved.'; },
      call => { call.questions[0]!.multiSelect = true; },
      call => { call.questions.push(structuredClone(captured.calls[1]!.questions[0]!)); },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      try {
        const call = f.calls.at(-1)!;
        mutate(call);
        call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
        expect(f.ready()).toBe(false);
      } finally { f.cleanup(); }
    }
  });

  test('all real answers still need a fresh complete report and current successful native identity', () => {
    const f = fixture();
    try {
      const substantive = f.calls.at(-2)!;
      const stale = Date.parse(substantive.answeredAt!) / 1000 - 1;
      fs.utimesSync(f.report, stale, stale);
      expect(f.ready()).toBe(false);
      fs.utimesSync(f.report, f.written, f.written);
      f.observed.planReadyRequests![0]!.failed = true;
      expect(f.ready()).toBe(false);
      f.observed.planReadyRequests![0]!.failed = false;
      const last = f.calls.at(-1)!;
      last.unansweredQuestionIndices = [0];
      expect(f.ready()).toBe(false);
      last.unansweredQuestionIndices = [];
      last.answers = { [last.questions[0]!.question]: 'Add a new feature' };
      expect(f.ready()).toBe(false);
      last.answers = structuredClone(captured.calls.at(-1)!.answers);
      last.failed = true;
      expect(f.ready()).toBe(false);
      last.failed = false;
      f.observed.planReadyRequests![0]!.sessionId = 'foreign-session';
      expect(f.ready()).toBe(false);
      f.observed.planReadyRequests![0]!.sessionId = last.sessionId;
      fs.writeFileSync(f.report, '# Incomplete report\n');
      expect(f.ready()).toBe(false);
    } finally { f.cleanup(); }
  });
});
