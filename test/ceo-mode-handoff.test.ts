import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ceoModeHandoffs, findNativeAutoDecision } from './helpers/native-auto-decide';
import { hasNativePostAnswerCeoPosture } from './helpers/ceo-mode-option';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import expansionCapture from './fixtures/ceo-expansion-auq-ac.json';

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

  test('an auto-decided handoff stands in for the unsent annotation, unless later withdrawn', () => {
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
    const sent = attempt();
    sent.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    expect(verdict(sent)).toMatchObject({ option: 'HOLD SCOPE', annotation: AUTO_LINE });
    const asked = attempt();
    asked.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE"`, 'Mode: HOLD SCOPE; approved decisions: none.'));
    expect(verdict(asked)).toBeNull();
    const withdrawn = attempt();
    withdrawn.tools.push(...handoff(sessionId, after, `${CMD} "HOLD SCOPE" --auto`, AUTO_LINE));
    withdrawn.transcript.assistantMessages.push({ sessionId, timestamp: '2026-09-10T02:19:05.000Z', text: 'Correction: I withdraw this auto-decision.' });
    expect(verdict(withdrawn)).toBeNull();
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
