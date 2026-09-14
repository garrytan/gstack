import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoplanPhaseCompletions } from './helpers/autoplan-phase-observer';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const START = Date.parse('2026-09-08T16:00:00.000Z');
const transcript = (...messages: Array<[number, string]>): PlanCountTranscript => ({
  status: 'ready', calls: [],
  assistantMessages: messages.map(([ms, text]) => ({
    sessionId: 'autoplan-fixture', timestamp: new Date(START + ms).toISOString(), text,
  })),
});

describe('native autoplan phase observation', () => {
  test('AF public wrapped-up announcement retains its actual Phase 1 timestamp', () => {
    // Exact reader-projected public parent narration from the AF run; no raw
    // signature or private block is stored. The next-phase mention adds no hit.
    const announcement = {
      sessionId: '6ce27a04-7422-4687-9de9-138e68f308d8',
      text: 'Phase 1 wrapped up: 11 findings from the Claude subagent, 30 of 34 spec issues fixed after 3 review rounds, and 21 obligations carried forward with 3 disagreements flagged as taste items. Moving on to Phase 2 (design review) now that UI scope was detected.\n\n',
      timestamp: '2026-09-10T00:00:03.893Z',
    };
    const at = Date.parse(announcement.timestamp);
    expect(autoplanPhaseCompletions({ status: 'ready', calls: [],
      assistantMessages: [announcement] }, at - 1)).toEqual([{ phase: 1, ts: at }]);
  });

  test('AF bare done announcement retains Phase 2 without crediting its DX transition', () => {
    const announcement2 = {
      sessionId: "6ce27a04-7422-4687-9de9-138e68f308d8",
      text: "Phase 2 done: Claude subagent found 15 issues (1 critical, 8 high, 6 medium), with 14 fully accepted and 1 partially accepted; design score rose from 6/10 to 8.7/10, and 10 accepted items are now carried into the Implementation plan. Moving on to Phase 2.5 (DX Review) since developer-facing scope was detected.",
      timestamp: "2026-09-10T00:08:31.892Z",
    };
    const at = Date.parse(announcement2.timestamp);
    expect(autoplanPhaseCompletions({ status: 'ready', calls: [],
      assistantMessages: [announcement2] }, at - 1)).toEqual([{ phase: 2, ts: at }]);
  });

  test('AF named DX completion retains Phase 2.5 without crediting its Eng transition', () => {
    const announcement3 = {
      sessionId: "6ce27a04-7422-4687-9de9-138e68f308d8",
      text: "Phase 2.5 (DX review) is done: DX score rose from 5.1 to 8.0/10, all 19 findings reviewed with 12 items accepted into the plan and one taste item flagged for gating. All pre-checks pass, so I'm moving on to Phase 3, the final Engineering Review of the amended plan.\n\n",
      timestamp: "2026-09-10T00:16:29.888Z",
    };
    const at = Date.parse(announcement3.timestamp);
    expect(autoplanPhaseCompletions({ status: 'ready', calls: [],
      assistantMessages: [announcement3] }, at - 1)).toEqual([{ phase: 2.5, ts: at }]);
  });

  test('completed-state declarations retain supported phases, punctuation and first native time', () => {
    for (const state of ['wrapped up', 'done']) for (const phase of [1, 2, 2.5, 3]) for (const tail of ['', '.', ': Work retained.', '. Work retained.']) {
      expect(autoplanPhaseCompletions(transcript([1, `Phase ${phase} ${state}${tail}`]), START))
        .toEqual([{ phase, ts: START + 1 }]);
    }
    expect(autoplanPhaseCompletions(transcript([1, '**Phase 1 wrapped up.**']), START))
      .toEqual([{ phase: 1, ts: START + 1 }]);
    expect(autoplanPhaseCompletions(transcript([4, 'Phase 1 wrapped up.'],
      [2, 'Phase 3 wrapped up.'], [3, 'Phase 1 wrapped up: Moving to Phase 2.']), START))
      .toEqual([{ phase: 3, ts: START + 2 }, { phase: 1, ts: START + 3 }]);
  });

  test('affirmative completion words share punctuation and optional is without future tense', () => {
    for (const state of ['complete', 'completed', 'done', 'finished', 'wrapped up']) {
      for (const copula of ['', 'is ']) for (const tail of ['', '.', ': Work retained.']) {
        expect(autoplanPhaseCompletions(transcript([1, `Phase 3 ${copula}${state}${tail}`]), START))
          .toEqual([{ phase: 3, ts: START + 1 }]);
      }
      for (const text of [`Phase 3 ${state}?`, `Phase 3 will be ${state}.`,
        `Phase 3 is not ${state}.`, `Phase 3 ${state} if the reviewer finishes.`,
        `Phase 3 ${state} when the work ends.`, `**Phase 3 ${state}** if approved.`,
        `Example:\nPhase 3 ${state}.`, `> Phase 3 ${state}.`,
        `Phase 3 (Eng review) is not ${state}.`, `Phase 3 (Eng review) ${state} if approved.`]) {
        expect(autoplanPhaseCompletions(transcript([1, text]), START), text).toEqual([]);
      }
    }
  });

  test('known phase names must agree with their number and never supply completion alone', () => {
    const names = [[1, 'CEO'], [2, 'Design'], [2.5, 'DX'], [3, 'Eng'], [3, 'Engineering']] as const;
    for (const [phase, name] of names) for (const suffix of ['', ' review']) {
      const declaration = `Phase ${phase} (${name}${suffix}) is finished.`;
      expect(autoplanPhaseCompletions(transcript([1, declaration]), START)).toEqual([{ phase, ts: START + 1 }]);
      expect(autoplanPhaseCompletions(transcript([1, `**${declaration}**`]), START)).toEqual([{ phase, ts: START + 1 }]);
      for (const other of [1, 2, 2.5, 3].filter(n => n !== phase)) {
        expect(autoplanPhaseCompletions(transcript([1, declaration.replace(`Phase ${phase}`, `Phase ${other}`)]), START))
          .toEqual([]);
      }
    }
    for (const text of ['Phase 3 (Eng review).', 'Phase 2.5 (future DX review) is done.',
      'Phase 2.5 (DX review if approved) is done.', 'Phase 1 (source) complete.',
      'Phase 2.5 ((DX review)) is done.', 'Phase 2.5 (DX review) finished soon.',
      '# Phase 2.5 (DX review) is done.', 'Example:\nPhase 2.5 (DX review) is done.']) {
      expect(autoplanPhaseCompletions(transcript([1, text]), START), text).toEqual([]);
    }
  });

  test('future, conditional, negative and quoted wrap-up claims do not complete a phase', () => {
    for (const text of [
      'Phase 1 will wrap up.', 'Phase 1 has not wrapped up.', 'Phase 1 is not wrapped up.',
      'Phase 1 wrapped up if the reviewer finishes.', 'Phase 1 wrapped up when the review ends.',
      'Phase 1 wrapped up but is not complete.', 'Phase 1 wrapped up?',
      'Once Phase 1 wrapped up, we would start Phase 2.', 'I will announce Phase 1 wrapped up.',
      '**Phase 1 wrapped up** if the tests pass.', 'Phase 4 wrapped up.', 'Phase 2.1 wrapped up.',
      '# Phase 1 wrapped up.', '> Phase 1 wrapped up.', '"Phase 1 wrapped up."',
      '- Phase 1 wrapped up.', '| Phase 1 wrapped up. |', '    Phase 1 wrapped up.',
      '```text\nPhase 1 wrapped up.\n```', '~~~text\nPhase 1 wrapped up.\n~~~',
      'Example:\nPhase 1 wrapped up.\nPhase 2 wrapped up.',
      'The template says:\n\nPhase 1 wrapped up.',
      '**Phase 1 wrapped up.** Emit phase-transition summary:',
    ]) for (const declaration of [text, text.replace(/wrapped up/g, 'done')]) {
      expect(autoplanPhaseCompletions(transcript([1, declaration]), START), declaration).toEqual([]);
    }
  });

  test('wrapped-up declarations retain ready transcript and native timestamp requirements', () => {
    const current = transcript([1, 'Phase 1 wrapped up.']);
    for (const status of ['missing', 'error'] as const) {
      expect(autoplanPhaseCompletions({ ...current, status }, START)).toEqual([]);
    }
    expect(autoplanPhaseCompletions(current, START + 2)).toEqual([]);
    expect(autoplanPhaseCompletions({ ...current, assistantMessages: current.assistantMessages.map(
      message => ({ ...message, timestamp: 'invalid' })) }, START)).toEqual([]);
  });

  test('retains actual completion timestamps when several phases arrive between polls', () => {
    expect(autoplanPhaseCompletions(transcript(
      [1, '**Phase 1 complete.** Codex: 2 concerns. Native: 3 issues.'],
      [2, 'Phase 2 complete. Design outputs are in the plan.'],
      [3, '**Phase 2.5 complete.** DX overall: 8/10.'],
      [4, 'Phase 3 complete. Both engineering reviews finished.'],
    ), START)).toEqual([1, 2, 2.5, 3].map((phase, index) => ({ phase, ts: START + index + 1 })));
  });

  test('duplicate announcements retain their first timestamp without reordering phases', () => {
    expect(autoplanPhaseCompletions(transcript(
      [3, 'Phase 1 complete.'], [2, 'Phase 2 complete.'],
      [1, '**Phase 1 complete.**'], [4, '**Phase 3 complete.**'],
    ), START)).toEqual([{ phase: 1, ts: START + 1 }, { phase: 2, ts: START + 2 }, { phase: 3, ts: START + 4 }]);
  });

  test('headings, quoted skill text, examples, tables and planned checklists provide no completion', () => {
    for (const text of [
      '## Phase 3 complete.',
      '**PHASE 3 COMPLETE.** Emit phase-transition summary:',
      '> **Phase 3 complete.** Codex: [N concerns].',
      'The section says "**Phase 3 complete.**".',
      'Example: **Phase 3 complete.**',
      'Example announcement:\n**Phase 3 complete.**',
      'Example announcement:\nPhase 2 complete.\nPhase 3 complete.',
      'The template requires this completion marker:\n\n**Phase 3 complete.**',
      '    **Phase 3 complete.**',
      '\tPhase 3 complete.',
      '```markdown\n**Phase 3 complete.**\n```',
      '```markdown\n```still-code\nPhase 3 complete.\n```',
      '````markdown\n```\nPhase 3 complete.\n````',
      '~~~markdown\nPhase 3 complete.\n~~~',
      '```markdown\nPhase 3 complete.',
      '| **Phase 3 complete.** | pending |',
      '- [ ] **Phase 3 complete.**',
      '1. Phase 3 complete.',
      'I will announce **Phase 3 complete.** after the review.',
      'Phase 3 complete when the engineering review ends.',
      'Phase 3 complete?',
      'Phase 4 complete.',
    ]) expect(autoplanPhaseCompletions(transcript([1, text]), START), text).toEqual([]);
  });

  test('a real announcement after a closed example fence still establishes completion', () => {
    expect(autoplanPhaseCompletions(transcript([1, 'Example:\n```markdown\nPhase 3 complete.\n```\n\n**Phase 1 complete.**']), START))
      .toEqual([{ phase: 1, ts: START + 1 }]);
  });

  test('accepts a template-compliant quoted transition with actual consensus while rejecting quoted examples', () => {
    const actual = '> **Phase 1 complete.** Codex: 2 concerns. Claude subagent: 3 issues.\n' +
      '> Consensus: 4/6 confirmed, 2 disagreements → surfaced at gate.\n> Passing to Phase 2.';
    expect(autoplanPhaseCompletions(transcript([1, actual]), START)).toEqual([{ phase: 1, ts: START + 1 }]);
    expect(autoplanPhaseCompletions(transcript([1, actual.replace('Codex: 2 concerns.', 'Codex: unavailable.')]), START))
      .toEqual([{ phase: 1, ts: START + 1 }]);
    for (const quoted of [
      actual.replace('4/6', 'X/6'),
      actual.replace('2 concerns', '[N concerns]'),
      'The template contains this example:\n' + actual,
      'Example announcement:\n' + actual + '\n' + actual.replace('Phase 1', 'Phase 3'),
      '> **Phase 3 complete.**',
    ]) expect(autoplanPhaseCompletions(transcript([1, quoted]), START), quoted).toEqual([]);
  });

  test('missing/error transcripts and pre-command declarations cannot establish coverage', () => {
    const prior = transcript([-1, '**Phase 3 complete.**']);
    expect(autoplanPhaseCompletions(prior, START)).toEqual([]);
    for (const status of ['missing', 'error'] as const) {
      expect(autoplanPhaseCompletions({ ...transcript([1, '**Phase 3 complete.**']), status }, START)).toEqual([]);
    }
  });

  test('does not repair an out-of-order chain or synthesize omitted phases', () => {
    expect(autoplanPhaseCompletions(transcript([1, 'Phase 3 complete.'], [2, 'Phase 1 complete.']), START))
      .toEqual([{ phase: 3, ts: START + 1 }, { phase: 1, ts: START + 2 }]);
    expect(autoplanPhaseCompletions(transcript([1, 'Phase 2 skipped — no UI scope.']), START)).toEqual([]);
  });

  test('phase observer changes select the autoplan eval', () => {
    for (const file of ['test/helpers/autoplan-phase-observer.ts', 'test/autoplan-phase-observer.test.ts']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
    }
  });

  test.skipIf(process.platform === 'win32')('ANSI-rendered completions use native evidence while displayed Read/source markers do not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-phase-replay-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const recordFile = path.join(dir, 'events.jsonl');
    const resultFile = path.join(dir, 'result.json');
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
fs.writeFileSync(process.env.PHASE_RECORD, JSON.stringify({pid:process.pid}) + '\n');
const sessionId = 'fake-autoplan-session';
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
fs.mkdirSync(dir, {recursive:true});
const base = Date.now();
const write = (role, content, offset, extra = {}) => fs.appendFileSync(path.join(dir, sessionId + '.jsonl'), JSON.stringify({
  sessionId, cwd:process.cwd(), isSidechain:false, timestamp:new Date(base + offset).toISOString(), message:{role,content}, ...extra,
}) + '\n');
write('user', [{type:'tool_result', tool_use_id:'read', content:'**Phase 3 complete.**'}], 0);
write('assistant', [{type:'text', text:'> **Phase 3 complete.** is the quoted source marker.'}], 0);
write('assistant', [{type:'text', text:'**Phase 3 wrapped up.**'}], 0, {isSidechain:true});
write('assistant', [{type:'text', text:'**Phase 3 wrapped up.**'}], 0, {cwd:path.join(process.cwd(), 'foreign')});
process.stdin.setRawMode?.(true);
let sent = false;
process.stdin.on('data', data => {
  if (sent || !data.toString().includes('\r')) return;
  sent = true;
  process.stdout.write('\x1b[2J\x1b[H');
  [1, 2, 2.5, 3].forEach((phase, index) => {
    const message = '**Phase ' + phase + (phase === 1 ? ' wrapped up.**' : phase === 2 ? ' done.**' : phase === 2.5 ? ' (DX review) is finished.**' : ' complete.**');
    write('assistant', [{type:'text', text:message}], index + 1);
    process.stdout.write('● \x1b[1mPhase ' + phase + ' complete.\x1b[22m\n');
  });
  process.stdout.write('NATIVE_PHASES_READY\n');
});
process.stdout.write('Read: autoplan/sections/eng-phase.md\n> **Phase 3 complete.**\nSOURCE_READY\n');
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    const moduleUrl = (name: string) => pathToFileURL(path.resolve(import.meta.dir, 'helpers', name)).href;
    fs.writeFileSync(worker, `
import { launchClaudePty } from ${JSON.stringify(moduleUrl('claude-pty-runner.ts'))};
import { readPlanCountTranscript } from ${JSON.stringify(moduleUrl('plan-count-transcript.ts'))};
import { autoplanPhaseCompletions } from ${JSON.stringify(moduleUrl('autoplan-phase-observer.ts'))};
const start = Date.now();
const session = await launchClaudePty({cwd:${JSON.stringify(dir)}, timeoutMs:8000, env:{PHASE_RECORD:${JSON.stringify(recordFile)}}});
try {
  await session.waitFor('SOURCE_READY', {timeoutMs:4000, pollMs:20});
  const read = () => readPlanCountTranscript(session.hermeticConfigDir, ${JSON.stringify(dir)});
  const sourceOnly = autoplanPhaseCompletions(read(), start);
  const oldPattern = /\\*\\*Phase\\s+(\\d+(?:\\.\\d+)?)\\s+complete\\.?\\*\\*/g;
  const sourceFalsePositive = [...session.visibleText().matchAll(oldPattern)].length;
  const since = session.mark();
  session.send('\\r');
  await session.waitFor('NATIVE_PHASES_READY', {timeoutMs:4000, pollMs:20});
  const rendered = session.visibleSince(since);
  const oldPatternMissed = [...rendered.matchAll(oldPattern)].length;
  const hits = autoplanPhaseCompletions(read(), start);
  await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({sourceOnly, sourceFalsePositive, oldPatternMissed, hits, rendered}));
} finally { await session.close(); }
`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(result.sourceOnly).toEqual([]);
      expect(result.sourceFalsePositive).toBe(1);
      expect(result.oldPatternMissed).toBe(0);
      expect(result.rendered).toContain('Phase 3 complete.');
      expect(result.hits.map((hit: { phase: number }) => hit.phase)).toEqual([1, 2, 2.5, 3]);
      for (let index = 1; index < result.hits.length; index++) {
        expect(result.hits[index].ts).toBeGreaterThan(result.hits[index - 1].ts);
      }
      const pid = JSON.parse(fs.readFileSync(recordFile, 'utf8').split('\n')[0]!).pid;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(timer); child.kill('SIGKILL');
      if (fs.existsSync(recordFile)) {
        const pid = JSON.parse(fs.readFileSync(recordFile, 'utf8').split('\n')[0]!).pid;
        try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      fs.rmSync(dir, {recursive:true, force:true});
    }
  }, 15_000);
});
