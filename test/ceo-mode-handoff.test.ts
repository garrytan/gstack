import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ceoModeHandoffs, findNativeAutoDecision, HANDOFF_REMINDER } from './helpers/native-auto-decide';
import { hasNativePostAnswerCeoPosture } from './helpers/ceo-mode-option';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import expansionCapture from './fixtures/ceo-expansion-auq-ac.json';
import stateCapture from './fixtures/auto-decide-state-cab3.json';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-ceo-mode-handoff');
const CMD = '"$HOME/.claude/skills/gstack/bin/gstack-ceo-mode-handoff"';
const AUTO_LINE = 'Auto-decided review mode → HOLD SCOPE (your preference). Change with /plan-tune. Approved decisions: none.';

function run(...args: string[]) {
  return spawnSync(BIN, args, { encoding: 'utf8', timeout: 10_000 });
}

function handoff(sessionId: string, at: number, command: string, content: string, id = 'toolu_handoff'): NativePublicToolEvent[] {
  return [
    { sessionId, toolUseId: id, kind: 'use', name: 'Bash', timestamp: new Date(at).toISOString(), input: { command } },
    { sessionId, toolUseId: id, kind: 'result', timestamp: new Date(at + 500).toISOString(), content, isError: false },
  ];
}

describe('gstack-ceo-mode-handoff', () => {
  test('prints the exact Step 0E handoff line for asked and auto-decided modes', () => {
    expect(run('HOLD_SCOPE', '--auto').stdout).toBe(`${AUTO_LINE}\n`);
    expect(run('SCOPE EXPANSION', '--decisions', 'D1 (A): keep the CLI.').stdout)
      .toBe('Mode: SCOPE EXPANSION; approved decisions: D1 (A): keep the CLI.\n');
    expect(run('SCOPE REDUCTION', '--decisions', ' ').stdout).toBe('Mode: SCOPE REDUCTION; approved decisions: none.\n');
  });

  test('reminds the model on stderr to start its next chat message with the line (periodic red 37272185151)', () => {
    const r = run('HOLD_SCOPE', '--auto');
    expect(r.stdout).toBe(`${AUTO_LINE}\n`);
    expect(r.stderr).toBe(`${HANDOFF_REMINDER}\n`);
  });

  test('rejects unknown modes and arguments without printing a handoff', () => {
    for (const args of [['BIG'], [], ['HOLD SCOPE', '--decisions'], ['HOLD SCOPE', '--force']]) {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    }
  });
});

describe('native handoff evidence', () => {
  const at = Date.parse('2026-10-04T06:00:00.000Z');

  test('accepts only a successful literal invocation whose output matches its arguments', () => {
    expect(ceoModeHandoffs(handoff('s', at, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE), 's'))
      .toMatchObject([{ option: 'HOLD SCOPE', auto: true, line: AUTO_LINE }]);
    const rejected: Array<[string, string, (events: NativePublicToolEvent[]) => void]> = [
      ['wrong output', `${CMD} "HOLD SCOPE" --auto`, events => { events[1]!.content = AUTO_LINE.replace('HOLD SCOPE', 'SCOPE EXPANSION'); }],
      ['missing --auto', `${CMD} "HOLD SCOPE"`, () => {}],
      ['failed result', `${CMD} "HOLD SCOPE" --auto`, events => { events[1]!.isError = true; }],
      ['echoed line', `echo "${AUTO_LINE}"`, () => {}],
      ['chained command', `${CMD} "HOLD SCOPE" --auto; true`, () => {}],
      ['relative path', 'bin/gstack-ceo-mode-handoff "HOLD SCOPE" --auto', () => {}],
      ['foreign session', `${CMD} "HOLD SCOPE" --auto`, events => { events[1]!.sessionId = 'other'; }],
      ['result before use', `${CMD} "HOLD SCOPE" --auto`, events => { events[1]!.timestamp = new Date(at - 1).toISOString(); }],
    ];
    for (const [name, command, mutate] of rejected) {
      const events = handoff('s', at, command, AUTO_LINE);
      mutate(events);
      expect(ceoModeHandoffs(events, 's'), name).toEqual([]);
    }
  });

  test('the merged tool result (line, then the stderr reminder) is the helper output; any other trailing text is not', () => {
    expect(ceoModeHandoffs(handoff('s', at, `${CMD} "HOLD SCOPE" --auto`, `${AUTO_LINE}\n${HANDOFF_REMINDER}`), 's'))
      .toMatchObject([{ option: 'HOLD SCOPE', auto: true, line: AUTO_LINE }]);
    expect(ceoModeHandoffs(handoff('s', at, `${CMD} "HOLD SCOPE" --auto`, `${AUTO_LINE}\nAnything else`), 's')).toEqual([]);
  });

  // The helper's Bash result is collapsed in the terminal (Claude Code 2.1.284), so it locates the
  // witness but is not one: the chat must begin with the printed line (integration decision 2026-10-04).
  test('an auto-decided handoff counts only once the chat begins with its line, unless later withdrawn', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/native-auto-decide-ag.json'), 'utf8'));
    const attempt = () => {
      const f = structuredClone(captured.attempts[0]);
      // Census 37179171083 shape: the decision was logged but the line never reached chat.
      const message = f.transcript.assistantMessages.find((m: any) => m.text.includes('Auto-decided'));
      message.text = 'Continuing with the HOLD SCOPE review.';
      return f;
    };
    const verdict = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
    const unsent = attempt();
    expect(verdict(unsent)).toBeNull();
    const sessionId = unsent.options.sessionId;
    const after = Date.parse('2026-09-10T02:19:00.000Z');
    const helperOnly = attempt();
    helperOnly.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    expect(verdict(helperOnly)).toBeNull();
    const sent = attempt();
    sent.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    sent.transcript.assistantMessages.push({ sessionId, timestamp: '2026-09-10T02:19:02.000Z', text: `${AUTO_LINE}\n\nContinuing with the review.` });
    expect(verdict(sent)).toMatchObject({ option: 'HOLD SCOPE', annotation: AUTO_LINE });
    const asked = attempt();
    asked.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE"`, 'Mode: HOLD SCOPE; approved decisions: none.'));
    expect(verdict(asked)).toBeNull();
    const withdrawn = attempt();
    withdrawn.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    withdrawn.transcript.assistantMessages.push({ sessionId, timestamp: '2026-09-10T02:19:02.000Z', text: AUTO_LINE });
    withdrawn.transcript.assistantMessages.push({ sessionId, timestamp: '2026-09-10T02:19:05.000Z', text: 'Correction: I withdraw this auto-decision.' });
    expect(verdict(withdrawn)).toBeNull();
  });

  test('with the owned decision record, a handoff the chat never repeated is still a miss', () => {
    const attempt = () => {
      const f = structuredClone(stateCapture) as any;
      const use = f.tools.find((e: any) => e.input?.command?.includes('gstack-question-log'));
      const record = JSON.parse(/gstack-question-log '(\{[^\n]*\})'/.exec(use.input.command)![1]!);
      record.source = 'agent';
      record.ts = f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === use.toolUseId).timestamp;
      f.options.stateEvidence = { questionId: 'plan-ceo-review-mode', preference: 'never-ask', records: [record] };
      f.transcript.assistantMessages.find((m: any) => m.text.startsWith('**Mode:')).text = 'Continuing with the review.';
      return { f, loggedAt: Date.parse(record.ts) };
    };
    const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
    const { f: unsent } = attempt();
    expect(decide(unsent)).toBeNull();
    const { f: helperOnly, loggedAt: helperAt } = attempt();
    helperOnly.tools.push(...handoff(helperOnly.options.sessionId, helperAt + 1000, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    expect(decide(helperOnly)).toBeNull();
    const { f: sent, loggedAt } = attempt();
    sent.tools.push(...handoff(sent.options.sessionId, loggedAt + 1000, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    sent.transcript.assistantMessages.push({ sessionId: sent.options.sessionId, timestamp: new Date(loggedAt + 2000).toISOString(), text: AUTO_LINE });
    expect(decide(sent)).toMatchObject({ option: 'HOLD SCOPE', annotation: AUTO_LINE, stateRecord: sent.options.stateEvidence.records[0] });
    const { f: early } = attempt();
    const started = Date.parse(early.tools.find((e: any) => e.kind === 'result' && String(e.content).includes('SKILL_START_PROTO')).timestamp);
    early.tools.push(...handoff(early.options.sessionId, started - 5000, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    expect(decide(early)).toBeNull();
    const { f: changed, loggedAt: changedAt } = attempt();
    changed.tools.push(...handoff(changed.options.sessionId, changedAt + 1000, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    changed.transcript.assistantMessages.push({ sessionId: changed.options.sessionId,
      timestamp: new Date(changedAt + 3000).toISOString(), text: 'Mode: SCOPE EXPANSION (saved preference).' });
    expect(decide(changed)).toBeNull();
  });

  test('captured trial: the documented AUTO_DECIDE line with its decisions suffix is the declaration', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/auto-decide-handoff-line-e354.json'), 'utf8'));
    const attempt = () => {
      const f = structuredClone(captured);
      const use = f.tools.find((e: any) => e.kind === 'use' && e.input?.command?.includes('gstack-question-log'));
      const record = JSON.parse(/gstack-question-log '(\{[^\n]*\})'/.exec(use.input.command)![1]!);
      record.source = 'agent';
      record.ts = f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === use.toolUseId).timestamp;
      f.options.stateEvidence = { questionId: 'plan-ceo-review-mode', preference: 'never-ask', records: [record] };
      return f;
    };
    const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
    const line = (f: any) => f.transcript.assistantMessages.find((m: any) => m.text.startsWith('Auto-decided review mode'));
    expect(decide(attempt())).toMatchObject({ option: 'HOLD SCOPE' });
    for (const [name, mutate] of Object.entries({
      'no decisions suffix': (f: any) => { line(f).text = line(f).text.replace(/ Approved decisions: /, ' Decisions: '); },
      'different mode': (f: any) => { line(f).text = line(f).text.replace('→ HOLD SCOPE', '→ SCOPE EXPANSION'); },
      'quoted line': (f: any) => { line(f).text = '> ' + line(f).text; },
      'later withdrawal': (f: any) => { line(f).text += '\n\nCorrection: I withdraw this decision.'; },
      'missing record': (f: any) => { f.options.stateEvidence.records = []; },
    })) {
      const f = attempt(); mutate(f); expect(decide(f), name).toBeNull();
    }
  });

  test('census 37182865432: the handoff ran but its line never reached the chat, so it is a miss', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/auto-decide-handoff-before-log-37182865432.json'), 'utf8'));
    const attempt = () => {
      const f = structuredClone(captured);
      const use = f.tools.find((e: any) => e.kind === 'use' && e.input?.command?.includes('gstack-question-log'));
      const record = JSON.parse(/gstack-question-log '(\{[^\n]*\})'/.exec(use.input.command)![1]!);
      record.source = 'agent';
      record.ts = f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === use.toolUseId).timestamp;
      f.options.stateEvidence = { questionId: 'plan-ceo-review-mode', preference: 'never-ask', records: [record] };
      return f;
    };
    const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
    // As captured: the helper printed the line in a collapsed Bash result and the chat said
    // "I'm defaulting to HOLD SCOPE…" then "**Mode decided: HOLD SCOPE.**"; neither is the line.
    expect(decide(attempt())).toBeNull();
    const shown = () => {
      const f = attempt();
      f.transcript.assistantMessages.find((m: any) => m.text.startsWith('**Mode decided:')).text = `${AUTO_LINE}\n\nWrapping up this invocation.`;
      return f;
    };
    expect(decide(shown())).toMatchObject({ option: 'HOLD SCOPE', annotation: AUTO_LINE });
    for (const [name, mutate] of Object.entries({
      'line not at the start of the chat': (f: any) => { const m = f.transcript.assistantMessages.find((x: any) => x.text.startsWith(AUTO_LINE)); m.text = `Note: ${m.text}`; },
      'record names another mode': (f: any) => { f.options.stateEvidence.records[0].user_choice = 'SCOPE EXPANSION'; f.options.stateEvidence.records[0].recommended = 'SCOPE EXPANSION'; },
      'later withdrawal': (f: any) => { f.transcript.assistantMessages.push({ sessionId: f.options.sessionId, timestamp: new Date(f.options.now - 1000).toISOString(), text: 'Correction: I withdraw this decision.' }); },
      'missing record': (f: any) => { f.options.stateEvidence.records = []; },
    })) {
      const f = shown(); mutate(f); expect(decide(f), name).toBeNull();
    }
    const pending = attempt();
    pending.transcript.assistantMessages.find((m: any) => m.text.startsWith('**Mode decided:')).text = '**Mode pending: HOLD SCOPE.**';
    expect(decide(pending)).toBeNull();
  });

  test('an answered mode handoff establishes that mode posture, and only that mode', () => {
    const records = structuredClone(expansionCapture.records);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-handoff-'));
    const project = path.join(root, 'projects', 'fixture');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${records[0]!.sessionId}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    let transcript;
    try { transcript = readPlanCountTranscript(root, records[0]!.cwd, () => {}); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
    const posture = /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
    const selectedAt = Date.parse(expansionCapture.provenance.testSelectionLowerBound.at);
    const mode = transcript.calls.find(call => call.toolUseId === expansionCapture.modeToolUseId)!;
    const answeredAt = Date.parse(mode.answeredAt!);
    const check = (events: NativePublicToolEvent[]) =>
      hasNativePostAnswerCeoPosture(transcript!, 'SCOPE EXPANSION', posture, selectedAt, events);
    expect(check([])).toBe(false);
    const line = 'Mode: SCOPE EXPANSION; approved decisions: none.';
    expect(check(handoff(mode.sessionId, answeredAt + 1000, `${CMD} "SCOPE EXPANSION"`, line))).toBe(true);
    expect(check(handoff(mode.sessionId, answeredAt - 5000, `${CMD} "SCOPE EXPANSION"`, line))).toBe(false);
    expect(check(handoff(mode.sessionId, answeredAt + 1000, `${CMD} "HOLD SCOPE"`, 'Mode: HOLD SCOPE; approved decisions: none.'))).toBe(false);
    expect(check(handoff(mode.sessionId, answeredAt + 1000, `${CMD} "SCOPE EXPANSION" --auto`,
      AUTO_LINE.replace('HOLD SCOPE', 'SCOPE EXPANSION')))).toBe(false);
  });
});
