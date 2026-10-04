import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { childReportedSpawnedMarker } from './helpers/docsync-fixture';

// PR E2E run 37188668421: the child's hand-back omitted its SESSION_KIND echo;
// /ship asked that same child, which quoted its own skill-start result.
const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'docsync-followup-echo-37188668421.json'), 'utf8'));
const clone = () => structuredClone(captured) as { transcript: any[]; dispatch: { input: unknown; output: string } };
const reported = (f: ReturnType<typeof clone>) => childReportedSpawnedMarker({ transcript: f.transcript }, f.dispatch);
const sendMessage = (f: ReturnType<typeof clone>) => f.transcript.flatMap(e => e.message?.content ?? []).find((b: any) => b.name === 'SendMessage');
const reply = (f: ReturnType<typeof clone>) => f.transcript.find(e => e.subtype === 'task_notification' && e.tool_use_id === sendMessage(f).id);

describe('docs child spawned-marker report', () => {
  test('the captured hand-back alone lacks the echo; the same child quoting it on request supplies it', () => {
    const f = clone();
    expect(f.dispatch.output).not.toContain('SESSION_KIND: spawned');
    expect(reported(f)).toBe(true);
  });

  test('an echo in the hand-back itself is accepted without any follow-up', () => {
    const f = clone();
    f.transcript = f.transcript.filter(e => e !== reply(f));
    expect(reported(f)).toBe(false);
    f.dispatch.output = 'SESSION_KIND: spawned\n' + f.dispatch.output;
    expect(reported(f)).toBe(true);
  });

  test.each([
    ['a message to another agent', (f: ReturnType<typeof clone>) => { sendMessage(f).input.to = 'another-agent'; }],
    ['a reply without the echo', (f: ReturnType<typeof clone>) => { reply(f).summary = reply(f).summary.replaceAll('SESSION_KIND: spawned', 'SESSION_KIND: interactive'); }],
    ['an unfinished reply', (f: ReturnType<typeof clone>) => { reply(f).status = 'running'; }],
    ['a notification for a different call', (f: ReturnType<typeof clone>) => { reply(f).tool_use_id = 'toolu_other'; }],
    ['a different child behind the dispatch', (f: ReturnType<typeof clone>) => {
      f.transcript.find(e => e.subtype === 'task_started' && e.tool_use_id !== sendMessage(f).id).task_id = 'someone-else';
    }],
    ['no matching dispatch', (f: ReturnType<typeof clone>) => { f.dispatch.input = { prompt: 'other' }; }],
  ])('rejects %s', (_name, mutate) => {
    const f = clone();
    mutate(f);
    expect(reported(f)).toBe(false);
  });
});
