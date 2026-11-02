import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closePacketReadAfterNotice, dispatchPromptDelta, prepareGuardSession, stoppedAtPhaseBoundary } from './helpers/autoplan-guard-pty';

const base = '/home/runner/.cache/gstack-paid-shard-x/tmp/ap-guard-pty-y';

test('the close-packet check accepts a Read in the notice turn and rejects one made before the notice', () => {
  // PR gate 39069171159 (b789898, pass): the CEO reviewer's notice started the turn that read the close packet.
  expect(closePacketReadAfterNotice([
    `Read ${base}/project/.gstack/tmp/autoplan/autoplan-ceo-oMVeYz/close-packet.md`,
    'Bash true autoplan-published ceo',
    `Read ${base}/home/.claude/skills/gstack/autoplan/sections/design-phase.md`,
    'Agent Design review',
  ])).toBe(true);
  // PR gate 39070276914 (dc739be, fail): the actor read the close packet in the dispatch turn, before the notice.
  expect(closePacketReadAfterNotice([
    'Bash true autoplan-published ceo',
    `Read ${base}/home/.claude/skills/gstack/autoplan/sections/design-phase.md`,
    `Bash cat "${base}/project/.gstack/tmp/autoplan/dispatch-design.txt"`,
    'Agent Design review',
  ])).toBe(false);
});

test('the scripted actor ends its turn after a background CEO dispatch and reads the close packet only after the reviewer finishes', () => {
  const s = prepareGuardSession(undefined);
  try {
    const skill = fs.readFileSync(path.join(s.project, '.claude', 'skills', fs.readdirSync(path.join(s.project, '.claude', 'skills'))[0]!, 'SKILL.md'), 'utf8');
    const step = (n: number) => skill.slice(skill.indexOf(`\n${n}. `) + 1, skill.indexOf(`\n${n + 1}. `));
    expect(step(5)).toContain('If its result says the agent is running in the background, end your turn at once with no further tool call; the completion notification starts your next turn.');
    expect(step(5)).not.toContain('If the agent runs in the background, end your turn and wait');
    expect(step(6).startsWith('6. Only after the CEO review agent has finished (in the turn its completion notification starts, when it ran in the background), Read the file whose path step 3 printed')).toBe(true);
    expect(skill.indexOf('\n6. ')).toBeGreaterThan(skill.indexOf('\n5. '));
  } finally { s.cleanup(); }
});

// PR gate 39099195754 (ce1da4e, fail): the actor published Phase 1, printed "Phase 1 complete." and ended its
// turn, so the run idled to its 480 s deadline with 2 of 4 guarded allows (the same 489 s shape as 38976253774).
const STOP_SCREEN = fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'autoplan-guard-pty-phase-boundary-stop-screen.txt'), 'utf8');

test('the captured phase-boundary stop is named; a run still working or already in Phase 2 is not', () => {
  expect(STOP_SCREEN).toContain('Phase 1 complete.');
  expect(stoppedAtPhaseBoundary(STOP_SCREEN)).toBe(true);
  const working = STOP_SCREEN.slice(0, STOP_SCREEN.indexOf('✻ Brewed'));
  expect(stoppedAtPhaseBoundary(working)).toBe(false);
  const continued = working + '●Step8:ReadingtheDesignphasefile\n\nRead 1 file\n\n●Step9:ReadingtheDesigndispatchfile\n\n✻ Brewed for 80s · done 5:17 AM\n❯\n';
  expect(stoppedAtPhaseBoundary(continued)).toBe(false);
  expect(stoppedAtPhaseBoundary('✻ Brewed for 10s · done 5:00 AM\n❯\n')).toBe(false);
});

test('the scripted actor keeps going through the phase boundary: nothing between step 7 and step 11 lets it end its turn there', () => {
  const s = prepareGuardSession(undefined);
  try {
    const skill = fs.readFileSync(path.join(s.project, '.claude', 'skills', fs.readdirSync(path.join(s.project, '.claude', 'skills'))[0]!, 'SKILL.md'), 'utf8');
    const step = (n: number) => skill.slice(skill.indexOf(`\n${n}. `) + 1, skill.indexOf(`\n${n + 1}. `));
    const intro = skill.slice(skill.indexOf('\n---\n', 4) + 5, skill.indexOf('\n1. '));
    expect(intro).toContain('from step 1 through step 11 in one continuous run');
    expect(intro).toContain('End your turn before step 11 only where step 5 or step 10 says to wait for a background agent.');
    expect(intro).toContain('**Phase 1 complete.** is a phase boundary, not the end of the task.');
    expect(step(7)).toContain('Do not end your turn after it: when its result arrives, go straight on to step 8.');
    expect(step(8).startsWith("8. As your next assistant message, in the same turn as step 7's result (no user input is coming), Read the file")).toBe(true);
    // The publication and the Phase 2 entry stay in separate messages: the guard's boundary is unchanged.
    expect(step(7)).toContain('make exactly one tool call in that same message: the Bash command `true autoplan-published ceo`');
    for (const n of [6, 7, 8, 9]) expect(step(n)).not.toMatch(/end your turn(?! after it)|wait for (its|a) completion/i);
  } finally { s.cleanup(); }
});

// Train gate 40992022983 (paid-slice-1-a1, passed on the in-run rerun): the guard denied the Design dispatch with
// dispatch_prompt, and the journal summary cut every input at 160 characters, so the differing bytes were lost.
test('a dispatch_prompt deny names the bytes the actor changed, read from the journal before cleanup', () => {
  const s = prepareGuardSession(undefined);
  try {
    const design = '[DESIGN] Native phase review\nRead file: /p/native-prompt.md\nApply every criterion.\nReturn findings.\n';
    fs.writeFileSync(path.join(s.project, '.gstack', 'tmp', 'autoplan', 'dispatch-design.txt'), design);
    const journal = path.join(s.config, 'projects', 'p');
    fs.mkdirSync(journal, { recursive: true });
    const sent = design.replace('every criterion', 'all criteria');
    fs.writeFileSync(path.join(journal, 'session.jsonl'), JSON.stringify({ message: { content: [
      { type: 'tool_use', name: 'Agent', input: { description: 'Design review', prompt: sent } }] } }) + '\n');
    const [delta] = s.dispatchPromptDeltas();
    expect(delta).toContain(`Design review: expected ${design.length} chars, sent ${sent.length}; first difference at offset ${design.indexOf('every')}`);
    expect(delta).toContain('Apply every criterion.');
    expect(delta).toContain('Apply all criteria.');
    expect(dispatchPromptDelta(design, design)).toBe(`identical (${design.length} chars)`);
  } finally { s.cleanup(); }
});
