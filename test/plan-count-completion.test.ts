/** Native completion/report regression; no model/API calls. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasNativePlanCompletion, classifyPlanCountFrame } from './helpers/claude-pty-runner';
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
