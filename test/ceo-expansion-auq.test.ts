import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findCeoModeOption, hasNativePostAnswerCeoPosture } from './helpers/ceo-mode-option';
import { parseNumberedOptions } from './helpers/claude-pty-runner';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/ceo-expansion-auq-ac.json';

const posture = /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
const selectedAt = Date.parse(captured.provenance.testSelectionLowerBound.at);
type Records = typeof captured.records;

function replay(change?: (records: Records) => void) {
  const records = structuredClone(captured.records);
  change?.(records);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-expansion-auq-'));
  const first = records[0]!;
  const project = path.join(root, 'projects', 'fixture');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${first.sessionId}.jsonl`),
    records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const events: NativePublicToolEvent[] = [];
  try {
    return { transcript: readPlanCountTranscript(root, first.cwd, event => events.push(event)), events };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function matches(evidence = replay()) {
  return hasNativePostAnswerCeoPosture(evidence.transcript, 'SCOPE EXPANSION', posture, selectedAt, evidence.events);
}

describe('CEO expansion posture in a completed native decision brief', () => {
  test('captured option 2 and subsequent answered expansion establish posture without standalone prose', () => {
    const evidence = replay();
    expect(findCeoModeOption(parseNumberedOptions(captured.visibleAtModeTail), 'SCOPE EXPANSION')).toBe(2);
    expect(evidence.transcript.calls.map(call => call.toolUseId)).toEqual([
      captured.modeToolUseId, captured.expansionToolUseId,
    ]);
    expect(evidence.transcript.assistantMessages.every(message => Date.parse(message.timestamp) < selectedAt)).toBe(true);
    expect(evidence.events.map(event => [event.toolUseId, event.timestamp])).toEqual([
      [captured.modeToolUseId, captured.requestReplyTimes[captured.modeToolUseId].request],
      [captured.modeToolUseId, captured.requestReplyTimes[captured.modeToolUseId].reply],
      [captured.expansionToolUseId, captured.requestReplyTimes[captured.expansionToolUseId].request],
      [captured.expansionToolUseId, captured.requestReplyTimes[captured.expansionToolUseId].reply],
    ]);
    expect(matches(evidence)).toBe(true);
    // Without the public native request/reply timestamps, no new evidence is inferred.
    expect(hasNativePostAnswerCeoPosture(evidence.transcript, 'SCOPE EXPANSION', posture, selectedAt)).toBe(false);
  });

  test.each([
    'wrong selected mode', 'pending selected mode', 'failed selected mode', 'selected answer before selection',
    'pending expansion', 'failed expansion', 'unrecognized expansion answer', 'foreign session',
    'pre-mode request', 'request after reply', 'reply timestamp mismatch', 'missing request', 'missing reply',
    'failed public reply', 'wrong tool name', 'foreign tool identity', 'conflicting request', 'conflicting reply',
    'request metadata mismatch', 'batched questions', 'multiselect', 'setup heading', 'quoted brief',
    'fenced brief', 'quoted expansion marker', 'wrong expansion choices',
  ])('%s cannot supply posture coverage', failure => {
    const evidence = replay();
    const [mode, expansion] = evidence.transcript.calls;
    const request = evidence.events[2]!;
    const reply = evidence.events[3]!;
    const question = expansion!.questions[0]!;
    switch (failure) {
      case 'wrong selected mode': mode!.answers![mode!.questions[0]!.question] = 'HOLD SCOPE'; break;
      case 'pending selected mode': mode!.answered = false; break;
      case 'failed selected mode': mode!.failed = true; break;
      case 'selected answer before selection': mode!.answeredAt = '2026-09-09T16:40:00.000Z'; break;
      case 'pending expansion': expansion!.answered = false; break;
      case 'failed expansion': expansion!.failed = true; break;
      case 'unrecognized expansion answer': expansion!.answers![question.question] = 'invented approval'; break;
      case 'foreign session': expansion!.sessionId = request.sessionId = reply.sessionId = 'unrelated-session'; break;
      case 'pre-mode request': request.timestamp = captured.requestReplyTimes[captured.modeToolUseId].request; break;
      case 'request after reply': request.timestamp = '2026-09-09T16:41:22.000Z'; break;
      case 'reply timestamp mismatch': reply.timestamp = '2026-09-09T16:41:22.000Z'; break;
      case 'missing request': evidence.events.splice(2, 1); break;
      case 'missing reply': evidence.events.splice(3, 1); break;
      case 'failed public reply': reply.isError = true; break;
      case 'wrong tool name': request.name = 'Read'; break;
      case 'foreign tool identity': request.toolUseId = 'unrelated-call'; break;
      case 'conflicting request': evidence.events.push({ ...request, timestamp: '2026-09-09T16:41:20.000Z' }); break;
      case 'conflicting reply': evidence.events.push({ ...reply, isError: true }); break;
      case 'request metadata mismatch': request.input = { questions: [] }; break;
      case 'batched questions': expansion!.questions.push(structuredClone(question)); break;
      case 'multiselect': question.multiSelect = true; break;
      case 'setup heading': question.question = question.question.replace(/^D5[^\n]+/, 'D5 — Choose the review mode?'); break;
      case 'quoted brief': question.question = question.question.split('\n').map(line => `> ${line}`).join('\n'); break;
      case 'fenced brief': question.question = '```text\n' + question.question + '\n```'; break;
      case 'quoted expansion marker': question.question = 'D5 — Which choice?\n> Expansion 1 of 8: scope opt-in'; break;
      case 'wrong expansion choices': question.options[1]!.label = 'Enable telemetry'; break;
    }
    // Keep parsed call metadata bound to the public request. This makes the
    // content negatives exercise semantic guards, not an accidental mismatch.
    if (['batched questions', 'multiselect', 'setup heading', 'quoted brief', 'fenced brief',
         'quoted expansion marker', 'wrong expansion choices'].includes(failure)) {
      request.input = { questions: expansion!.questions };
      expansion!.answers = { [question.question]: question.options[0]!.label };
    }
    expect(matches(evidence)).toBe(false);
  });

  test('the original caller regex and mode remain required', () => {
    const { transcript, events } = replay();
    expect(hasNativePostAnswerCeoPosture(transcript, 'SCOPE EXPANSION', /\bcathedral\b/i, selectedAt, events)).toBe(false);
    expect(hasNativePostAnswerCeoPosture(transcript, 'HOLD SCOPE', /\bhold\s*scope\b/i, selectedAt, events)).toBe(false);
    expect(hasNativePostAnswerCeoPosture(transcript, 'SCOPE EXPANSION', posture, Date.now(), events)).toBe(false);
  });

  test('reader-level foreign, sidechain, incomplete and failed records cannot create native evidence', () => {
    for (const change of [
      (records: Records) => { records[5]!.cwd = '/unrelated'; },
      (records: Records) => { records[5]!.isSidechain = true; },
      (records: Records) => { records.splice(6, 1); },
      (records: Records) => { records[6]!.message.content[0]!.is_error = true; },
    ]) expect(matches(replay(change))).toBe(false);
  });

  test('the new free test and captured fixture select the paid mode-routing case', () => {
    for (const file of ['test/ceo-expansion-auq.test.ts', 'test/fixtures/ceo-expansion-auq-ac.json']) {
      expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-mode-routing']);
    }
  });
});
