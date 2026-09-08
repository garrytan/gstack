/** Native completion/report regression; no model/API calls. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasNativePlanCompletion, hasNativePlanTerminal, isPlanReadyVisible, classifyPlanCountFrame } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

const CAPTURED_CALL = {
  "sessionId": "b5c582af-870e-48ac-ac1e-c85458932136",
  "toolUseId": "toolu_017PNDKgKXk1VyxRT9BVdDbt",
  "answered": true,
  "failed": false,
  "answeredAt": "2026-09-08T17:45:31.244Z",
  "questions": [
    {
      "header": "P5: v1\u2192v2 break",
      "question": "D7 \u2014 Pass 5, Finding 6: The v1\u2192v2 upgrade removes `Client.evaluate()` immediately with zero migration support, guaranteeing broken production installs on pip upgrade. <gstack-qid:plan-devex-review-v1-v2-migration>",
      "options": [
        {
          "label": "A \u2014 Migration guide + deprecation alias (Recommended)",
          "description": "Plan must include: (1) migration guide in changelog ('replace .evaluate() with .run()'), (2) v2 ships a .evaluate() compatibility alias that raises DeprecationWarning('use Client.run() instead'), (3) one-paragraph upgrade section in README. Upgrade is boring, not scary. (human: ~2h / CC: ~20min)"
        },
        {
          "label": "B \u2014 Migration guide only (no alias)",
          "description": "Add a migration guide in the changelog with the one-line fix. No compatibility alias \u2014 v1 users who miss the guide still break. Better than nothing but still relies on developers reading the changelog."
        },
        {
          "label": "C \u2014 Accept immediate removal, document in release notes",
          "description": "Keep the current plan (immediate removal, no alias). Add a prominent breaking-change banner to release notes. Honest about the break, but production projects that auto-upgrade still break silently."
        }
      ]
    }
  ],
  "answers": {
    "D7 \u2014 Pass 5, Finding 6: The v1\u2192v2 upgrade removes `Client.evaluate()` immediately with zero migration support, guaranteeing broken production installs on pip upgrade. <gstack-qid:plan-devex-review-v1-v2-migration>": "A \u2014 Migration guide + deprecation alias (Recommended)"
  }
};
const CAPTURED_FINAL = {
  "sessionId": "b5c582af-870e-48ac-ac1e-c85458932136",
  "text": "DX review complete. Here's what was found and resolved:\n\n**6 findings across 5 review passes \u2014 all resolved interactively:**\n\n| # | Pass | Issue | Fix |\n|---|------|-------|-----|\n| D2 | Getting Started | `examples/first_eval.py` referenced in README but absent from package | Remove reference; make terminal demo the single path |\n| D3 | Getting Started | Demo triggers mandatory 5-min CI gate despite using bundled offline data; TTHW 6 min vs <2 min target | Exempt `evalkit.demo` from CI gate; TTHW drops to ~1-2 min |\n| D4 | API Design | `run_eval(dataset, evaluator)` and `run_batch(evaluator, dataset)` have reversed positional order \u2014 silent wrong-result bugs | Enforce keyword-only args on both functions |\n| D5 | Error Messages | `AuthError(\"request failed\")` \u2014 no code, no cause, no fix | Replace with `AuthError(\"Invalid API key \u2014 check EVALKIT_API_KEY or visit ...\", code=\"auth_invalid_key\")` |\n| D6 | Documentation | No expected output shown after demo command | Add expected output block to README |\n| D7 | Upgrade Path | `Client.evaluate()` removed immediately with no migration path | Ship deprecation shim + migration guide + README upgrade section |\n\n**Score:** 4/10 \u2192 8/10. TTHW: 6 min \u2192 ~1-2 min (Champion tier).\n\n**Critical blocker:** The CI gate finding (D3) is architecturally non-trivial \u2014 the plan currently says \"retains this gate\" but the TTHW target requires exempting demo mode. `/plan-eng-review` should validate the gate bypass implementation before this ships.\n\nPlan written to: `/tmp/gstack-paid-shard-qDnJUI/tmp/gstack-e2e-plan-devex-VWDg0F/gstack-test-plan-devex.md`",
  "timestamp": "2026-09-08T17:49:33.033Z"
};
const CAPTURED_PATH = "/tmp/gstack-paid-shard-qDnJUI/tmp/gstack-e2e-plan-devex-VWDg0F/gstack-test-plan-devex.md";
const REPORT = '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n' +
  '| Review | Status | Findings |\n|---|---|---|\n| DX Review | clean | resolved |\n\n' +
  'VERDICT: DX CLEARED — eng review required\n\nNO UNRESOLVED DECISIONS\n';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-plan-completion-'));
  const file = path.join(dir, 'review.md');
  const startedAt = Date.parse('2026-09-08T17:39:30.000Z');
  fs.writeFileSync(file, REPORT);
  const modified = Date.parse('2026-09-08T17:48:30.000Z') / 1000;
  fs.utimesSync(file, modified, modified);
  const transcript: PlanCountTranscript = {
    status: 'ready', calls: [structuredClone(CAPTURED_CALL)],
    assistantMessages: [{ ...CAPTURED_FINAL, text: CAPTURED_FINAL.text.replace(CAPTURED_PATH, file) }],
  };
  return { dir, file, startedAt, transcript, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('native plan completion and final report', () => {
  test('recognizes captured completed native DevEx prose despite a nonmatching terminal heading', () => {
    const f = fixture();
    try {
      const visible = '●' + f.transcript.assistantMessages[0]!.text.replace(/ /g, '') + '\nCrunched for 10m 9s ·done 5:49PM\n❯ ';
      expect(classifyPlanCountFrame(visible)).toBeNull();
      expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(true);
    } finally { f.cleanup(); }
  });

  test('rejects pending, failed, missing, mixed-session and untimestamped native coverage', () => {
    const f = fixture();
    try {
      for (const change of [
        (t: any) => { t.status = 'missing'; },
        (t: any) => { t.status = 'error'; },
        (t: any) => { t.calls = []; },
        (t: any) => { t.calls[0].answered = false; },
        (t: any) => { t.calls[0].failed = true; },
        (t: any) => { t.calls[0].answeredAt = undefined; },
        (t: any) => { t.calls[0].sessionId = 'foreign'; },
        (t: any) => { t.assistantMessages.push({ ...t.assistantMessages[0], sessionId: 'foreign' }); },
        (t: any) => { t.assistantMessages = []; },
      ]) {
        const t = structuredClone(f.transcript); change(t);
        expect(hasNativePlanCompletion(t, f.file, f.startedAt)).toBe(false);
      }
    } finally { f.cleanup(); }
  });

  test('requires the latest native announcement to follow every answer', () => {
    const f = fixture();
    try {
      f.transcript.calls[0]!.answeredAt = '2026-09-08T17:50:00.000Z';
      expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(false);
      f.transcript.calls[0]!.answeredAt = CAPTURED_CALL.answeredAt;
      f.transcript.assistantMessages.push({ ...CAPTURED_FINAL, text: 'Please answer the remaining question.', timestamp: '2026-09-08T17:50:00.000Z' });
      expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(false);
    } finally { f.cleanup(); }
  });

  test('quoted completions, refusals, provisional writes, wrong paths and waiting questions are not done', () => {
    const f = fixture();
    try {
      const complete = f.transcript.assistantMessages[0]!.text;
      for (const text of [
        '> ' + complete, '```text\n' + complete + '\n```',
        'Example completion:\n' + complete,
        "I cannot complete this review.\nPlan written to: `" + f.file + '`',
        'Now writing the complete plan file with all resolved findings and the review report.',
        complete.replace(f.file, f.file + '.other'),
        complete.replace('Plan written to:', 'Should I proceed?\nPlan written to:'),
        complete.replace('Plan written to:', 'Waiting for your decision.\nPlan written to:'),
      ]) {
        f.transcript.assistantMessages[0]!.text = text;
        expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt), text).toBe(false);
      }
    } finally { f.cleanup(); }
  });

  test('missing, stale, changed-after-announcement and provisional reports cannot complete', () => {
    const f = fixture();
    try {
      for (const date of ['2026-09-08T17:38:00Z', '2026-09-08T17:44:00Z', '2026-09-08T17:50:00Z']) {
        const time = Date.parse(date) / 1000; fs.utimesSync(f.file, time, time);
        expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(false);
      }
      for (const report of ['# Draft\n', '## GSTACK REVIEW REPORT\n', REPORT + '\n## Still editing\n']) {
        fs.writeFileSync(f.file, report); const time = Date.parse('2026-09-08T17:48:30Z') / 1000; fs.utimesSync(f.file, time, time);
        expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(false);
      }
      fs.rmSync(f.file);
      expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(false);
      expect(hasNativePlanCompletion(f.transcript, 'review.md', f.startedAt)).toBe(false);
    } finally { f.cleanup(); }
  });

  test('a fenced report example or an unclosed fence never supplies completion markers', () => {
    const f = fixture();
    try {
      for (const report of [
        '# Plan\nExample report:\n```markdown\n' + REPORT + '\n```\n',
        '# Plan\nExample report:\n~~~markdown\n' + REPORT + '\n~~~\n',
        '```markdown\n' + REPORT,
        '~~~markdown\n' + REPORT,
        // An apparent shorter/mismatched/annotated close leaves the report
        // inside the original code fence, rather than making it a real report.
        '````markdown\n```\n' + REPORT + '\n````\n',
        '~~~markdown\n```\n' + REPORT + '\n~~~\n',
        '```markdown\n```still-code\n' + REPORT + '\n```\n',
        '   ~~~~markdown\n   ~~~\n' + REPORT + '\n   ~~~~\n',
        REPORT + '\n```unclosed\n',
      ]) {
        fs.writeFileSync(f.file, report);
        const time = Date.parse('2026-09-08T17:48:30Z') / 1000;
        fs.utimesSync(f.file, time, time);
        expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt), report).toBe(false);
      }
    } finally { f.cleanup(); }
  });

  test('real code fences before the final report do not hide that report', () => {
    const f = fixture();
    try {
      for (const prefix of [
        '```typescript\nconst answer = 42;\n```\n',
        '~~~typescript\nconst answer = 42;\n~~~~~\n',
        '   ````typescript\n```still-code\n   ````` \t\n',
        '```markdown\n' + REPORT + '\n```\n',
      ]) {
        fs.writeFileSync(f.file, '# Plan\n' + prefix + '\n' + REPORT);
        const time = Date.parse('2026-09-08T17:48:30Z') / 1000;
        fs.utimesSync(f.file, time, time);
        expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt), prefix).toBe(true);
      }
    } finally { f.cleanup(); }
  });

  test.skipIf(process.platform === 'win32')('real PTY completes from a native report without a display alias', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-completion-pty-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const output = path.join(dir, 'plan.md');
    const record = path.join(dir, 'inputs.jsonl');
    const result = path.join(dir, 'result.json');
    const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const sessionId = 'native-completion-fixture';
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, { recursive: true });
const file = path.join(project, sessionId + '.jsonl');
const native = (role, content, extra = {}) => fs.appendFileSync(file, JSON.stringify({
  cwd: process.cwd(), sessionId, isSidechain: false,
  timestamp: new Date().toISOString(), message: { role, content }, ...extra,
}) + '\n');
let sent = false;
process.stdin.setRawMode?.(true);
process.stdin.on('data', data => {
  fs.appendFileSync(process.env.PROBE_INPUTS, JSON.stringify(data.toString()) + '\n');
  if (sent) return; sent = true;
  const q = { header: 'Error quality', question: 'D1 — Fix the missing error recovery path?', options: [{ label: 'Add recovery hint' }, { label: 'Keep vague message' }] };
  native('assistant', [{ type: 'tool_use', id: 'finding', name: 'AskUserQuestion', input: { questions: [q] } }]);
  const answeredAt = new Date(Date.now() - 100).toISOString();
  native('user', [{ type: 'tool_result', tool_use_id: 'finding', content: 'Answered.' }], {
    timestamp: answeredAt, toolUseResult: { answers: { [q.question]: q.options[0].label } },
  });
  fs.writeFileSync(process.env.PROBE_PLAN, process.env.PROBE_REPORT);
  const text = 'DX review complete. One finding resolved interactively.\n\nPlan written to: ' + String.fromCharCode(96) + process.env.PROBE_PLAN + String.fromCharCode(96);
  native('assistant', [{ type: 'text', text }], { timestamp: new Date(Date.now() + 5).toISOString() });
  process.stdout.write('407 +NO UNRESOLVED DECISIONS\n●' + text.replace(/ /g, '') + '\nCrunched for 10m 9s ·done 5:49PM\n❯ ');
});
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    fs.writeFileSync(worker, `import { runPlanSkillCounting } from ${JSON.stringify(runner)};\n` +
      `const result = await runPlanSkillCounting({skillName:'plan-devex-review',slashCommand:'/plan-devex-review',followUpPrompt:'# Native completion fixture',expectedPlanPath:${JSON.stringify(output)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:8,timeoutMs:20000,env:${JSON.stringify({PROBE_PLAN:output,PROBE_INPUTS:record,PROBE_REPORT:REPORT})}});\n` +
      `await Bun.write(${JSON.stringify(result)},JSON.stringify(result));\n`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, EVALS_HERMETIC: '1', EVALS_RUN_ID: '', BROWSE_TERMINAL_BINARY: fake },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
      const observation = JSON.parse(fs.readFileSync(result, 'utf8'));
      expect(observation.outcome).toBe('completion_summary');
      expect(observation.summary).toContain('native review completion and final report verified');
      expect(observation.reviewCount).toBe(1);
      expect(observation.step0Count).toBe(0);
      expect(observation.transcript.calls).toHaveLength(1);
      expect(fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(['/plan-devex-review\r']);
      expect(fs.existsSync(output)).toBe(true);
    } finally { clearTimeout(timer); child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 40000);
});

// Last answered call and last finalized native text at the exact G soft-terminal race.
const CAPTURED_ENG_STREAM = {
  "status": "ready",
  "calls": [
    {
      "sessionId": "4c3d29fb-2a00-4e5d-b3c6-9b584986e340",
      "toolUseId": "toolu_011KrMyU6fjW7RQ7aAVJ4DfA",
      "questions": [
        {
          "question": "D7 — Performance: 5 sequential IDP calls that could be Promise.all'd\nProject/branch/task: Multi-tenant Auth Refactor on main\nELI10: During token validation, the code makes 5 API calls to the identity provider (IDP) one at a time. But the calls are independent — none uses the result of the previous one. Changing from sequential to Promise.all([…]) takes one line of code and cuts auth latency by ~5x. At 100ms per call, sequential = ~500ms; parallel = ~100ms. This matters most under load: auth is on the critical path of every authenticated request.\nStakes if we pick wrong: Every authenticated request pays a 400ms tax that could be eliminated with one line. Under load, slow auth creates timeout cascades — auth is typically among the first things to degrade.\nRecommendation: A — trivially fix it now. The plan itself says “calls are independent” and “trivially” parallelizable. The only reason not to is if there’s a hidden ordering dependency the plan doesn’t mention.\nCompleteness: Note: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Parallelize the 5 IDP calls with Promise.all in this PR (recommended)\n  ✅ 5x latency reduction on the auth critical path for free — one line change\n  ✅ Under load, parallel calls bound latency to the slowest single call instead of sum of all\n  ❌ If any hidden ordering dependency exists (not mentioned in the plan), it will surface as a test failure — easily caught\nB) Defer parallelization to a follow-up performance PR\n  ✅ Keeps this PR focused on the refactor\n  ❌ The plan already flagged this as trivial; deferring creates a PR that self-documents debt without resolving it\nNet: The plan already identified this as trivial. Doing it now costs 5 minutes and makes the auth path meaningfully faster for all users. <gstack-qid:plan-eng-review-perf-idp-sequential-calls>",
          "header": "Performance",
          "options": [
            {
              "label": "A) Parallelize IDP calls now (Recommended)",
              "description": "Promise.all the 5 independent calls. ~5 min, 5x auth latency improvement."
            },
            {
              "label": "B) Defer to a follow-up PR",
              "description": "Keeps this PR focused on refactor; acknowledged debt."
            }
          ],
          "multiSelect": false
        }
      ],
      "answered": true,
      "failed": false,
      "answers": {
        "D7 — Performance: 5 sequential IDP calls that could be Promise.all'd\nProject/branch/task: Multi-tenant Auth Refactor on main\nELI10: During token validation, the code makes 5 API calls to the identity provider (IDP) one at a time. But the calls are independent — none uses the result of the previous one. Changing from sequential to Promise.all([…]) takes one line of code and cuts auth latency by ~5x. At 100ms per call, sequential = ~500ms; parallel = ~100ms. This matters most under load: auth is on the critical path of every authenticated request.\nStakes if we pick wrong: Every authenticated request pays a 400ms tax that could be eliminated with one line. Under load, slow auth creates timeout cascades — auth is typically among the first things to degrade.\nRecommendation: A — trivially fix it now. The plan itself says “calls are independent” and “trivially” parallelizable. The only reason not to is if there’s a hidden ordering dependency the plan doesn’t mention.\nCompleteness: Note: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Parallelize the 5 IDP calls with Promise.all in this PR (recommended)\n  ✅ 5x latency reduction on the auth critical path for free — one line change\n  ✅ Under load, parallel calls bound latency to the slowest single call instead of sum of all\n  ❌ If any hidden ordering dependency exists (not mentioned in the plan), it will surface as a test failure — easily caught\nB) Defer parallelization to a follow-up performance PR\n  ✅ Keeps this PR focused on the refactor\n  ❌ The plan already flagged this as trivial; deferring creates a PR that self-documents debt without resolving it\nNet: The plan already identified this as trivial. Doing it now costs 5 minutes and makes the auth path meaningfully faster for all users. <gstack-qid:plan-eng-review-perf-idp-sequential-calls>": "A) Parallelize IDP calls now (Recommended)"
      },
      "unansweredQuestionIndices": [],
      "answeredAt": "2026-09-08T18:46:43.934Z"
    }
  ],
  "assistantMessages": [
    {
      "sessionId": "4c3d29fb-2a00-4e5d-b3c6-9b584986e340",
      "text": "Tests decision: add characterization tests for legacyAuthFlow() before rewriting. Moving to Section 4: Performance Review.\n\n**Finding 4 [P2] (confidence: 9/10):** The plan states: \"Token validation issues 5 sequential API calls to the IDP; they could be parallelized via Promise.all trivially (calls are independent).\"\n\nThis is a free 5x latency improvement being left on the table. At 100ms per IDP call (typical), sequential = ~500ms per auth validation. Parallel via Promise.all = ~100ms.",
      "timestamp": "2026-09-08T18:46:30.531Z"
    }
  ]
};
const CAPTURED_DX_HANDOFF = {
  "sessionId": "cc1b321f-f306-4086-a236-34dd30f457be",
  "toolUseId": "toolu_01AGy3uosDrjJJUv1aKGkhRY",
  "questions": [
    {
      "question": "DX review done. 5 findings resolved, 7 implementation tasks written. What's next?\n\nEvalKit SDK / DX POLISH review / main\nThe DX review found API design issues (argument order, auth error), a broken getting-started path, a TTHW gap, and a cliff-edge upgrade. All resolved with user decisions. The full output is at gstack-test-plan-devex.md. Eng review is the required gate before shipping.\n<gstack-qid:devex-next-steps>",
      "header": "Next step",
      "multiSelect": false,
      "options": [
        {
          "label": "Run /plan-eng-review (Recommended)",
          "description": "Required gate. The arg-order fix and --skip-ci flag both have architectural implications that eng review should validate."
        },
        {
          "label": "Ready to implement",
          "description": "Start building the 7 tasks. Run /devex-review after shipping to measure actual TTHW vs the <2-min target."
        },
        {
          "label": "Skip, handle manually",
          "description": "You'll manage next steps outside this session."
        }
      ]
    }
  ],
  "answered": true,
  "failed": false,
  "answers": {
    "DX review done. 5 findings resolved, 7 implementation tasks written. What's next?\n\nEvalKit SDK / DX POLISH review / main\nThe DX review found API design issues (argument order, auth error), a broken getting-started path, a TTHW gap, and a cliff-edge upgrade. All resolved with user decisions. The full output is at gstack-test-plan-devex.md. Eng review is the required gate before shipping.\n<gstack-qid:devex-next-steps>": "Run /plan-eng-review (Recommended)"
  },
  "unansweredQuestionIndices": [],
  "answeredAt": "2026-09-08T18:46:16.771Z"
};

describe('guarded native terminal and report lifecycle', () => {
  test('G Eng streamed summary cannot finish while native text/file is still pending', () => {
    const f = fixture();
    try {
      const visible = '● Performance decision: parallelize the 5 IDP calls. All 4 review sections complete.\n\nCompletionSummary:\n- Step 0: Scope reduced\n- Architecture Review:1 issue found\n- Code Quality Review:1 issue found\n';
      expect(classifyPlanCountFrame(visible)).toBe('completion_summary');
      const t: PlanCountTranscript = structuredClone(CAPTURED_ENG_STREAM);
      const answerTime = Math.max(...t.calls.map(c => Date.parse(c.answeredAt!)));
      fs.utimesSync(f.file, (answerTime + 1) / 1000, (answerTime + 1) / 1000);
      expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'completion_summary')).toBe(false);
      t.assistantMessages.push({ sessionId: t.calls[0]!.sessionId, timestamp: new Date(answerTime + 2).toISOString(),
        text: 'Completion Summary:\n- Architecture Review: 1 issue resolved\n- Code Quality Review: 1 issue resolved\n- Test Review: 1 gap resolved\n- Performance Review: 1 issue resolved\n' });
      for (const content of ['', '# Draft\n', '## GSTACK REVIEW REPORT\n', REPORT.replace('NO UNRESOLVED DECISIONS', ''), REPORT.replace('| DX Review | clean | resolved |\n', '')]) {
        fs.writeFileSync(f.file, content); fs.utimesSync(f.file, (answerTime + 3) / 1000, (answerTime + 3) / 1000);
        expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'completion_summary'), content).toBe(false);
      }
      fs.writeFileSync(f.file, REPORT); fs.utimesSync(f.file, (answerTime + 3) / 1000, (answerTime + 3) / 1000);
      expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'completion_summary')).toBe(true);
    } finally { f.cleanup(); }
  });

  test('the actual post-report DX handoff does not require rewriting an unchanged report', () => {
    const f = fixture();
    try {
      const t: PlanCountTranscript = structuredClone(f.transcript);
      const sessionId = t.calls[0]!.sessionId;
      t.calls.push({ ...structuredClone(CAPTURED_DX_HANDOFF), sessionId });
      t.planReadyRequests = [{ sessionId, toolUseId: 'exit', timestamp: '2026-09-08T18:46:27.000Z', failed: false }];
      expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'plan_ready')).toBe(true);
      // Unknown, free-form, partly unanswered and substantive menus remain
      // freshness boundaries, even if they reuse the same next-step header.
      for (const mutate of [
        (c: any) => { c.questions[0].question = c.questions[0].question.replace('devex-next-steps', 'new-change'); },
        (c: any) => { c.answers[c.questions[0].question] = 'Also change the SDK auth behavior'; },
        (c: any) => { c.questions[0].options.push({ label: 'Change the error message now' }); },
        (c: any) => { c.unansweredQuestionIndices = [1]; },
      ]) {
        const changed = structuredClone(t); mutate(changed.calls[1]);
        expect(hasNativePlanTerminal(changed, f.file, f.startedAt, 'plan_ready')).toBe(false);
      }
      t.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'plan_ready')).toBe(false);
    } finally { f.cleanup(); }
  });

  test('pending/refused/mixed calls, stale or incomplete reports and quoted summaries cannot complete', () => {
    const f = fixture();
    try {
      const t = structuredClone(f.transcript);
      t.planReadyRequests = [{ sessionId: t.calls[0]!.sessionId, toolUseId: 'exit', timestamp: CAPTURED_FINAL.timestamp, failed: false }];
      expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'plan_ready')).toBe(true);
      const retried = structuredClone(t);
      retried.calls.unshift({ ...structuredClone(retried.calls[0]!), toolUseId: 'failed-before-retry', answered: false, failed: true, answers: undefined });
      expect(hasNativePlanTerminal(retried, f.file, f.startedAt, 'plan_ready')).toBe(true);
      retried.calls[0]!.questions[0]!.question = 'A different unresolved question';
      expect(hasNativePlanTerminal(retried, f.file, f.startedAt, 'plan_ready')).toBe(false);
      for (const mutate of [
        (t: any) => { t.calls[0].answered = false; },
        (t: any) => { t.calls[0].failed = true; },
        (t: any) => { t.calls[0].sessionId = 'other'; },
        (t: any) => { t.planReadyRequests[0].failed = true; },
        (t: any) => { t.planReadyRequests[0].timestamp = t.calls[0].answeredAt; },
        (t: any) => { t.planReadyRequests = []; },
        (t: any) => { t.status = 'missing'; },
      ]) { const changed = structuredClone(t); mutate(changed); expect(hasNativePlanTerminal(changed, f.file, f.startedAt, 'plan_ready')).toBe(false); }
      const summary = 'Completion Summary:\n- Review: 4 findings resolved\n';
      for (const text of ['> ' + summary, 'Example:\n' + summary, '```text\n' + summary + '```', 'Here is an example:\n\n' + summary, 'Here is a quoted result:\n```text\n' + summary + '```', 'I cannot complete the review.\n' + summary, 'Completion Summary:\n', summary + 'Waiting for your answer.']) {
        t.assistantMessages[0]!.text = text;
        expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'completion_summary'), text).toBe(false);
      }
      const old = Date.parse('2026-09-08T17:40:00Z') / 1000; fs.utimesSync(f.file, old, old);
      expect(hasNativePlanTerminal(t, f.file, f.startedAt, 'plan_ready')).toBe(false);
    } finally { f.cleanup(); }
  });
});

test.skipIf(process.platform === 'win32')('real PTY waits through streamed summary, another question and partial report writes', async () => {
  await Promise.all(['completion_summary', 'plan_ready', 'compact_plan_ready', 'ready_with_unsanctioned_write'].map(async (terminal) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-terminal-pty-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const output = path.join(dir, 'plan.md');
    const record = path.join(dir, 'inputs.jsonl');
    const events = path.join(dir, 'events.jsonl');
    const result = path.join(dir, 'result.json');
    const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const sessionId = 'guarded-terminal-fixture';
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, { recursive: true });
const file = path.join(project, sessionId + '.jsonl');
const native = (role, content, extra = {}) => fs.appendFileSync(file, JSON.stringify({
  cwd: process.cwd(), sessionId, isSidechain: false, timestamp: new Date().toISOString(), message: { role, content }, ...extra,
}) + '\n');
const event = name => fs.appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({ name, at: Date.now() }) + '\n');
const q = { header: 'Tests', question: 'D2 — Test “Would you like to proceed?” <gstack-qid:plan-eng-test-retry>', options: [{ label: 'Add retry assertion' }, { label: 'Leave untested' }] };
const ask = id => native('assistant', [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [q] } }]);
const answer = id => native('user', [{ type: 'tool_result', tool_use_id: id, content: 'Answered.' }], { toolUseResult: { answers: { [q.question]: q.options[0].label } } });
const summary = 'Completion Summary:\n- Architecture Review: 1 issue resolved\n- Test Review: 1 missing test resolved\n';
const compact = process.env.PROBE_TERMINAL === 'compact_plan_ready';
const ready = () => process.stdout.write(process.env.PROBE_TERMINAL === 'ready_with_unsanctioned_write'
  ? '\x1b[2J\x1b[H⏺ Write(src/unreviewed.ts)\nClaude has written up a plan and is ready to execute.\n'
  : compact
  ? '\x1b[2J\x1b[HExit plan mode?\n\nClaude wants to exit plan mode\n\n❯ 1. Yes, and switch to default (ask each time) for this session\n  2. No\n'
  : '\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n❯ 1. Yes, and use auto mode\n  2. Yes, manually approve edits\n  3. Tell Claude what to change\n');
let stage = 0;
process.stdin.setRawMode?.(true);
process.stdin.on('data', data => {
  fs.appendFileSync(process.env.PROBE_INPUTS, JSON.stringify(data.toString()) + '\n');
  if (stage === 0) {
    stage = 1; ask('first'); answer('first');
    event('streamed-heading'); process.stdout.write('● Completion Summary:\n- Architecture Review: 1 issue resolved\n');
    if (compact) {
      // Native metadata for an unrelated question and a prior permission
      // cannot authorize this ExitPlanMode menu. No report exists yet.
      ask('second');
      process.stdout.write('Do you want to make this edit to plan.md?\n❯ 1. Yes\n  2. Yes, and allow all edits\n  3. No\nEsc to cancel · Tab to amend\n⎿ Added 1 line\n');
      event('unverified-compact-gate'); ready();
    }
    setTimeout(() => {
      if (!compact) ask('second'); event('pending-question');
      process.stdout.write('\n☐ Tests\n' + q.question + '\n❯ 1. Add retry assertion\n  2. Leave untested\nEnter to select · ↑/↓ to navigate · Esc to cancel\n');
    }, 3500);
    return;
  }
  if (stage === 1 && data.toString().includes('1')) {
    stage = 2; answer('second'); event('answered-second');
    fs.writeFileSync(process.env.PROBE_PLAN, '# Draft\n');
    native('assistant', [{ type: 'text', text: summary }], { timestamp: new Date(Date.now() + 1).toISOString() });
    process.stdout.write('\n● ' + summary);
    if (compact) ready();
    setTimeout(() => {
      event('partial-report'); fs.writeFileSync(process.env.PROBE_PLAN, process.env.PROBE_REPORT.split('VERDICT:')[0]);
    }, 3000);
    setTimeout(() => {
      event('complete-report'); fs.writeFileSync(process.env.PROBE_PLAN, process.env.PROBE_REPORT);
      if (process.env.PROBE_TERMINAL !== 'completion_summary') {
        native('assistant', [{ type: 'tool_use', id: 'rejected-ready', name: 'ExitPlanMode', input: {} }]);
        native('user', [{ type: 'tool_result', tool_use_id: 'rejected-ready', is_error: true, content: 'Gate not ready' }]);
        ready();
        setTimeout(() => {
          event('valid-native-ready'); native('assistant', [{ type: 'tool_use', id: 'valid-ready', name: 'ExitPlanMode', input: {} }]); ready();
        }, 2500);
      }
    }, 6000);
  } else if (stage === 2) event('unexpected-plan-approval-input');
});
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    fs.writeFileSync(worker, `import { runPlanSkillCounting } from ${JSON.stringify(runner)};\n` +
      `const result = await runPlanSkillCounting({skillName:'plan-eng-review',slashCommand:'/plan-eng-review',followUpPrompt:'# Completion fixture',expectedPlanPath:${JSON.stringify(output)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:8,timeoutMs:30000,env:${JSON.stringify({PROBE_PLAN:output,PROBE_INPUTS:record,PROBE_EVENTS:events,PROBE_REPORT:REPORT,PROBE_TERMINAL:terminal})}});\n` +
      `await Bun.write(${JSON.stringify(result)},JSON.stringify(result));\n`);
    const child = Bun.spawn([process.execPath, worker], { env: { ...process.env,
      EVALS_HERMETIC: '1', EVALS_RUN_ID: '', BROWSE_TERMINAL_BINARY: fake }, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
      const observation = JSON.parse(fs.readFileSync(result, 'utf8'));
      expect(fs.existsSync(output), `D19: report must exist before stopping; ${observation.summary}`).toBe(true);
      expect(observation.outcome, JSON.stringify(observation)).toBe(
        terminal === 'ready_with_unsanctioned_write' ? 'silent_write' :
        terminal === 'compact_plan_ready' ? 'plan_ready' : terminal,
      );
      expect(observation.reviewCount).toBe(2);
      expect(fs.readFileSync(output, 'utf8')).toBe(REPORT);
      const recorded = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(recorded.map(e => e.name)).toEqual(['streamed-heading', ...(terminal === 'compact_plan_ready' ? ['unverified-compact-gate'] : []), 'pending-question', 'answered-second', 'partial-report', 'complete-report', ...(terminal !== 'completion_summary' ? ['valid-native-ready'] : [])]);
      expect(fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(['/plan-eng-review\r', '1']);
      if (terminal !== 'completion_summary') expect(observation.transcript.planReadyRequests.map(r => r.failed)).toEqual([true, false]);
    } finally { clearTimeout(timer); child.kill('SIGKILL'); await child.exited; fs.rmSync(dir, { recursive: true, force: true }); }
  }));
}, 50000);

// Actual finalized CEO prose uses a relative output name, not the DevEx fallback's
// exact “Plan written to:” sentence. Its caller-owned file is checked independently.
test('captured completed CEO prose supports the ordinary summary path', () => {
  const f = fixture();
  try {
    f.transcript.assistantMessages = [{
      sessionId: f.transcript.calls[0]!.sessionId,
      timestamp: "2026-09-08T17:58:52.319Z",
      text: "CEO review complete. Here's the summary:\n\n**Plan:** Payment Processing — Test Coverage\n**Mode:** HOLD SCOPE | **Verdict:** CLEARED (with 4 additions)\n\n**4 gaps found and resolved through interactive review:**\n\n1. **CRITICAL** — \"assert correct receipt is generated\" is too vague. Spec: assert `charge_id`, `amount`, `currency` (at minimum) match the charge response.\n2. **WARNING** — \"fails clean\" doesn't name what's raised. Spec: `assert raises <PaymentFailedError>` (resolve exact class from error hierarchy at implementation).\n3. **WARNING** — Retry count is implicit. Spec: `assert len(mock_stripe_call_history) == 2` explicitly in Test 2.\n4. **WARNING** — No test file path. Spec: resolve by convention-matching existing test structure.\n\nEverything else (architecture, security, data flow, performance, observability, deployment, trajectory) is clean. Section 11 skipped — no UI scope. Review output written to `gstack-test-plan-ceo-paired.md`."
    }];
    expect(hasNativePlanCompletion(f.transcript, f.file, f.startedAt)).toBe(false);
    expect(hasNativePlanTerminal(f.transcript, f.file, f.startedAt, 'completion_summary')).toBe(true);
    f.transcript.calls = [];
    expect(hasNativePlanTerminal(f.transcript, f.file, f.startedAt, 'completion_summary')).toBe(false);
  } finally { f.cleanup(); }
});


const CAPTURED_NUMBERED_DX_HANDOFF = {
  "sessionId": "0b7d664e-8d15-4c0e-8be2-d03a833d5d33",
  "toolUseId": "toolu_01RgoUjV9vFRaSFoySjm5QqY",
  "questions": [
    {
      "question": "D8 — DX review complete. 5 friction points resolved, DX score 4/10 → 8/10, TTHW target achievable. What’s next? <gstack-qid:devex-next-steps>",
      "header": "Next steps",
      "options": [
        {
          "label": "Run /plan-eng-review next (recommended)",
          "description": "Three of the five fixes (CI skip flag, auth error upgrade, deprecated alias) have architectural implications. Eng review validates the contracts before implementation."
        },
        {
          "label": "Ready to implement — run /devex-review after shipping",
          "description": "Skip eng review for now. Implement the five recommendations, then run /devex-review on the live beta to verify TTHW <2 min is achieved."
        },
        {
          "label": "Skip — I'll handle next steps manually",
          "description": "No further review automation. You have the five recommendations; implementation is up to you."
        }
      ],
      "multiSelect": false
    }
  ],
  "answered": true,
  "failed": false,
  "answers": {
    "D8 — DX review complete. 5 friction points resolved, DX score 4/10 → 8/10, TTHW target achievable. What’s next? <gstack-qid:devex-next-steps>": "Run /plan-eng-review next (recommended)"
  },
  "unansweredQuestionIndices": [],
  "answeredAt": "2026-09-08T20:49:56.950Z"
};


describe('numbered completed DX handoff preserves native report freshness', () => {
  function completedHandoffTranscript(f: ReturnType<typeof fixture>): PlanCountTranscript {
    const transcript = structuredClone(f.transcript);
    const sessionId = transcript.calls[0]!.sessionId;
    transcript.calls.push({ ...structuredClone(CAPTURED_NUMBERED_DX_HANDOFF), sessionId });
    transcript.planReadyRequests = [{
      sessionId,
      toolUseId: 'toolu_01QwXDuSELZNrgexVf88bQxG',
      timestamp: '2026-09-08T20:50:30.273Z',
      failed: false,
    }];
    return transcript;
  }

  test('the captured three-choice handoff changes orchestration without requiring another report write', () => {
    const f = fixture();
    try {
      const transcript = completedHandoffTranscript(f);
      expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(true);
      transcript.planReadyRequests![0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
      transcript.planReadyRequests = [];
      expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test('substantive, incomplete, unanswered and mixed menus remain report freshness boundaries', () => {
    const f = fixture();
    try {
      for (const mutate of [
        (call: any) => { call.questions[0].question = call.questions[0].question.replace('review complete.', 'review still has unresolved auth behavior.'); },
        (call: any) => { call.questions[0].question = call.questions[0].question.replace('devex-next-steps', 'devex-auth-finding'); },
        (call: any) => { call.questions[0].header = 'Auth policy'; },
        (call: any) => { call.questions[0].options.push({ label: 'Add retry support to the SDK now' }); },
        (call: any) => { call.questions[0].options[1].label = 'Ready to implement — change authentication first'; },
        (call: any) => { call.questions[0].options[2].label = 'Skip — keep the broken authentication'; },
        (call: any) => { call.answers[call.questions[0].question] = 'First implement the missing retry fix'; },
        (call: any) => { call.unansweredQuestionIndices = [0]; },
        (call: any) => { call.questions.push(structuredClone(CAPTURED_CALL.questions[0])); },
      ]) {
        const transcript = completedHandoffTranscript(f);
        mutate(transcript.calls[1]);
        expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
      }
    } finally {
      f.cleanup();
    }
  });

  test('a later actual review answer still requires a fresh complete report', () => {
    const f = fixture();
    try {
      const transcript = completedHandoffTranscript(f);
      transcript.calls.splice(1, 0, {
        ...structuredClone(CAPTURED_CALL),
        toolUseId: 'later-review-decision',
        answeredAt: '2026-09-08T20:49:00.000Z',
      });
      expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
      fs.utimesSync(f.file, Date.parse('2026-09-08T20:49:20Z') / 1000, Date.parse('2026-09-08T20:49:20Z') / 1000);
      expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(true);
      fs.writeFileSync(f.file, '## GSTACK REVIEW REPORT\n');
      expect(hasNativePlanTerminal(transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});


// Source-I Eng displayed this compact native approval after ExitPlanMode.
// Its classification must not itself claim a completed review/report.
const CAPTURED_COMPACT_PLAN_GATE = `Exit plan mode?

Claude wants to exit plan mode

❯ 1. Yes, and switch to default (ask each time) for this session
  2. No`;

test('the captured compact ExitPlanMode menu is an approval gate, not an ordinary answer', () => {
  expect(isPlanReadyVisible(CAPTURED_COMPACT_PLAN_GATE)).toBe(true);
  expect(classifyPlanCountFrame(CAPTURED_COMPACT_PLAN_GATE)).toBe('plan_ready');
  const f = fixture();
  try {
    expect(hasNativePlanTerminal(f.transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
    f.transcript.planReadyRequests = [{ sessionId: f.transcript.calls[0]!.sessionId,
      toolUseId: 'exit', timestamp: CAPTURED_FINAL.timestamp, failed: false }];
    fs.writeFileSync(f.file, '# Draft\n');
    expect(hasNativePlanTerminal(f.transcript, f.file, f.startedAt, 'plan_ready')).toBe(false);
  } finally { f.cleanup(); }
});

test('compact approval recognition rejects quoted, incomplete and superseded menus', () => {
  for (const visible of [
    'Should the application show an Exit plan mode? confirmation?',
    '> ' + CAPTURED_COMPACT_PLAN_GATE.replaceAll('\n', '\n> '),
    CAPTURED_COMPACT_PLAN_GATE.replace('Claude wants to exit plan mode', 'The documentation mentions exiting plan mode'),
    CAPTURED_COMPACT_PLAN_GATE.replace('  2. No', ''),
    CAPTURED_COMPACT_PLAN_GATE + '\nTests\nAdd retry coverage?\n❯ 1. Add test\n  2. Skip\nEnter to select · Esc to cancel',
  ]) expect(isPlanReadyVisible(visible), visible).toBe(false);
});
