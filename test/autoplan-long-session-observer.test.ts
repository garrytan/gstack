/**
 * ENG-6: the long-session case (CEO-15) observes the guard through its decision
 * log, not the PTY counting reader, which keeps a whole-file cap. Free proof on
 * a padded journal through the lower-only bound seams: the counting reader
 * refuses the journal while the guard reads it and logs a verified allow.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardFixture, section, type GuardFixture } from './helpers/autoplan-guard-fixture';
import { padBeforeCompactBoundary } from './helpers/journal-padding';
import { readPlanCountTranscript } from '../lib/claude-public-transcript';
import { OWNED_READ_APPROVAL } from '../autoplan/bin/owned-read';

const fixtures: GuardFixture[] = [];
const prior = process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES;
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  if (prior === undefined) delete process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES; else process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES = prior;
});

/** A typed first turn and its reply, then a real-shaped compact boundary and summary, then the fixture's /autoplan turn. */
function compactedPrelude(f: GuardFixture): void {
  f.journal(undefined, at => at === -1 ? [
    { type: 'user', message: { role: 'user', content: 'Earlier work in this long session.' }, extra: { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() } },
    { type: 'assistant', message: { role: 'assistant', id: 'msg_earlier', content: [{ type: 'text', text: 'Done with the earlier work.' }] } },
  ] : []);
  const rows = fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const reply = rows[1], boundary = { ...reply, uuid: randomUUID(), parentUuid: null, logicalParentUuid: reply.uuid, type: 'system',
    subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 1000 } };
  delete boundary.message;
  const summary = { ...rows[0], uuid: randomUUID(), parentUuid: boundary.uuid, isCompactSummary: true, promptSource: undefined,
    origin: undefined, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } };
  rows[2] = { ...rows[2], parentUuid: summary.uuid };
  fs.writeFileSync(f.transcript, [rows[0], reply, boundary, summary, ...rows.slice(2)].map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('a padded long-session journal: the counting reader refuses it, the guard log records a verified allow', async () => {
  const f = guardFixture(); fixtures.push(f);
  f.publish();
  compactedPrelude(f);
  const padded = padBeforeCompactBoundary(f.transcript, 1_536 * 1024, 64 * 1024);
  expect(padded.records).toBeGreaterThan(20);
  process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES = String(256 * 1024);
  const counting = readPlanCountTranscript(path.join(f.cwd, 'config'), f.cwd);
  expect(counting).toMatchObject({ status: 'error', reason: 'too_large' });
  expect(await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }))).toEqual(OWNED_READ_APPROVAL);
  expect(f.log()).toEqual([expect.objectContaining({ decision: 'allow', disposition: 'allow', code: null, path: 'payload' })]);
});

test('control: a padding record outside the parent chain (a sidechain) breaks ownership, so the guard denies', async () => {
  const f = guardFixture(); fixtures.push(f);
  f.publish();
  compactedPrelude(f);
  padBeforeCompactBoundary(f.transcript, 256 * 1024, 64 * 1024);
  const rows = fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const pad = rows.find(r => r.message?.id === 'msg_padding0');
  pad.isSidechain = true;
  fs.writeFileSync(f.transcript, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const output = await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }));
  expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(f.log().at(-1)).toMatchObject({ decision: 'deny' });
});
