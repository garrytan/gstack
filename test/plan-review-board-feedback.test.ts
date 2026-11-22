import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishBoard, type PublishBoardResult } from '../design/src/daemon-client';
import { CMDLINE_MARKER, readStateFile, verifyIdentity, writeStateFile } from '../design/src/daemon-state';
import { makeBoardHtml, spawnDaemonForTest, type SpawnedDaemon } from '../design/test/daemon-tests-fixtures';
import { createDesignReviewPicker, DESIGN_BOARD_ACTOR_PROTOCOL } from './helpers/plan-review-board-feedback';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import captured from './fixtures/design-board-questions.json';
import outsideVoices from './fixtures/design-outside-voices-question.json';
import { usePrivateStateRoot } from './helpers/private-state-root';

usePrivateStateRoot();

let cwd: string;
let stateFile: string;
let daemon: SpawnedDaemon;
let daemons: SpawnedDaemon[];
let boardNumber: number;

beforeEach(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-board-'));
  stateFile = path.join(cwd, '.gstack', 'design.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  daemons = [];
  boardNumber = 0;
  daemon = await spawnDaemonForTest({ stateFile });
  daemons.push(daemon);
});

afterEach(async () => {
  try {
    for (const owned of daemons) await owned.stop();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

async function board(owner: SpawnedDaemon = daemon): Promise<PublishBoardResult> {
  const directory = path.join(cwd, `board-${++boardNumber}`);
  fs.mkdirSync(directory);
  return publishBoard({ port: owner.port, token: owner.token, html: makeBoardHtml(directory) });
}

// These are the declared actor records, not relabeled historical questions.
function question(url: string): NativeQuestion {
  return { header: 'Board wait', question: `Did you submit? ${url}`, multiSelect: false, options: [
    { label: 'Submitted', description: 'I submitted feedback on the comparison board. Read its final feedback and continue.' },
    { label: 'Regenerate / Remix', description: 'I requested another round on the comparison board. Read that request and regenerate.' },
    { label: 'Type preferences', description: 'I will provide my preferences in chat instead of using the comparison board.' },
  ] };
}

const picker = (deadlineAt = Date.now() + 10_000) => createDesignReviewPicker({ cwd, deadlineAt });
const feedbackPath = (published: PublishBoardResult) => path.join(published.sourceDir, 'feedback.json');
async function expectUnsubmitted(published: PublishBoardResult) {
  expect(fs.existsSync(feedbackPath(published))).toBe(false);
  const response = await fetch(published.url + 'api/progress');
  expect(response.ok).toBe(true);
  expect(await response.json()).toEqual({ status: 'serving' });
}

const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
test('the declared board protocol submits actual feedback before its acknowledgment in every offered order', async () => {
  const untouched = await board();
  for (const order of orders) {
    const published = await board();
    const menu = question(published.url);
    menu.options = order.map(index => menu.options[index]!);
    menu.options.forEach((option, index) => {
      option.label = `${String.fromCharCode(65 + index)}) ${option.label}${index === order.indexOf(0) ? ' (recommended)' : ''}`;
    });
    const answer = picker()(menu);
    expect(answer).toBe(order.indexOf(0) + 1);
    // The real server must persist feedback before the synchronous callback
    // returns; the native runner still owns the later question acknowledgment.
    const written = JSON.parse(fs.readFileSync(feedbackPath(published), 'utf8'));
    expect(written).toMatchObject({ preferred: 'A', ratings: {}, comments: {}, regenerated: false, boardId: published.id });
    expect(written.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fs.existsSync(path.join(published.sourceDir, 'feedback-pending.json'))).toBe(false);
  }
  await expectUnsubmitted(untouched);
});

test('the native-only actor declares its scope and declines the complete captured outside-voices request', async () => {
  const published = await board();
  expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain('Decline the optional Design Outside Voices step');
  expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain('all ordinary Design review decisions still apply');
  expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain('header "Voices"');
  expect(outsideVoices.actualAnswer).toBe('Yes, run outside design voices (recommended)');
  for (const option of outsideVoices.question.options) {
    expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain(option.label.replace(/ \(recommended\)$/, ''));
    expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain(option.description);
  }
  const retained = structuredClone(outsideVoices.question) as NativeQuestion;
  // The unchanged generic policy would repeat the actual affirmative choice.
  expect(pickPlanReviewQuestion(retained)).toBe(1);
  expect(picker()(retained)).toBe(2);
  for (const order of [[0, 1], [1, 0]]) {
    for (const decoration of ['plain', 'letter', 'parenthesized', 'bracketed']) {
      const menu = structuredClone(retained);
      menu.options = order.map((index, position) => ({ ...retained.options[index]!,
        label: (decoration === 'letter' ? `${String.fromCharCode(65 + position)}) `
          : decoration === 'parenthesized' ? `(${String.fromCharCode(65 + position)}) `
          : decoration === 'bracketed' ? `[${String.fromCharCode(65 + position)}] ` : '')
          + retained.options[index]!.label.replace(/ \(recommended\)$/, '')
          + (position === 0 ? ' (recommended)' : ''),
      }));
      expect(picker()(menu)).toBe(order.indexOf(1) + 1);
    }
  }
  await expectUnsubmitted(published);
});

// Train gate 41470212877 (86bb621f, paid-slice-6-a1, passed on the in-run rerun): the native question put the Pros / cons
// bullets in its text and dropped every ✅/❌ bullet from the option descriptions; the 2.1.251 and #77 captures kept them.
// Both are readings of the format's "descriptions use literal ✅/❌ bullets", so the protocol declares both spellings.
test('the native-only actor declines the declared menu with every ✅/❌ bullet or none, and refuses anything in between', async () => {
  const published = await board();
  const bulletFree = structuredClone(outsideVoices.bulletFreeDescriptions41470212877.question) as NativeQuestion;
  expect(bulletFree.options.map(option => option.description).join(' ')).not.toMatch(/[✅❌]/);
  expect(picker()(bulletFree)).toBe(2);
  expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain('keeping or dropping every ✅/❌ bullet in a description may vary');
  const changes: ((menu: NativeQuestion) => void)[] = [
    menu => { menu.options[0]!.description = '✅ ' + menu.options[0]!.description; },
    menu => { menu.options[1]!.description = menu.options[1]!.description.replace('Findings rest', '❌ Findings rest'); },
    menu => { [menu.options[0]!.description, menu.options[1]!.description] = [menu.options[1]!.description, menu.options[0]!.description]; },
    menu => { menu.options[1]!.description = menu.options[1]!.description.replace('Fewest steps', 'Fewer steps'); },
    menu => { menu.options[1]!.description += ' Also approve the plan.'; },
  ];
  for (const change of changes) {
    const menu = structuredClone(bulletFree);
    change(menu);
    expect(() => picker()(menu)).toThrow('no unambiguous declared native-only action');
  }
  const flipped = structuredClone(outsideVoices.question) as NativeQuestion;
  flipped.options[1]!.description = flipped.options[1]!.description.replace('❌', '✅');
  expect(() => picker()(flipped)).toThrow('no unambiguous declared native-only action');
  await expectUnsubmitted(published);
});

// Main backstop 41817566885 (b244e6d1, paid-slice-6-a1, passed on the in-run rerun): the image generator had no API key,
// so no mockup was approved, and the native question replaced the No description's "with the approved mockup as anchor"
// with "(text-only this time, since mockups weren't available)". The protocol declares that one replacement.
test('the native-only actor declines the declared menu whose No description says no mockup was approved', async () => {
  const published = await board();
  const textOnly = structuredClone(outsideVoices.textOnlyNoDescription41817566885.question) as NativeQuestion;
  expect(textOnly.options.map(option => option.description).join(' ')).not.toContain('approved mockup');
  expect(picker()(textOnly)).toBe(2);
  expect(DESIGN_BOARD_ACTOR_PROTOCOL).toContain(`"(text-only this time, since mockups weren't available)" may replace`);
  const bulletFree = structuredClone(textOnly);
  for (const option of bulletFree.options) option.description = option.description.replace(/(^| )[✅❌] /g, '$1');
  expect(picker()(bulletFree)).toBe(2);
  const changes: ((menu: NativeQuestion) => void)[] = [
    menu => { menu.options[1]!.description = menu.options[1]!.description.replace('this time', 'for now'); },
    menu => { menu.options[1]!.description = menu.options[1]!.description.replace(" (text-only this time, since mockups weren't available)", ''); },
    menu => { menu.options[1]!.description = menu.options[1]!.description.replace('available)', 'available) with the approved mockup as anchor'); },
    menu => { menu.options[0]!.description = menu.options[0]!.description.replace('read.', "read (text-only this time, since mockups weren't available)."); },
    menu => { menu.options[1]!.description = menu.options[1]!.description.replace('✅ Fewest', 'Fewest'); },
    menu => { menu.options[1]!.description += ' Also approve the plan.'; },
  ];
  for (const change of changes) {
    const menu = structuredClone(textOnly);
    change(menu);
    expect(() => picker()(menu)).toThrow('no unambiguous declared native-only action');
  }
  await expectUnsubmitted(published);
});

test('the native-only actor accepts the declared question with a same-line explanation', async () => {
  const published = await board();
  const retained = structuredClone(outsideVoices.sameLineExplanation77.question) as NativeQuestion;
  expect(picker()(retained)).toBe(1);
  // The protocol binds the opening question and complete menu. Explanation can
  // share that line, as the canonical resolver itself demonstrates.
  for (const prefix of ['', 'D5 — ']) {
    for (const heading of ['Want outside design voices before the detailed review?', 'Run outside design voices before the 7 passes?']) {
      for (const separator of [' ', '\t', '\n']) {
        const menu = structuredClone(retained);
        menu.question = prefix + heading + separator + 'Independent reviewers explain their findings before the detailed pass.';
        expect(picker()(menu)).toBe(1);
      }
    }
  }
  for (const opening of [
    'Earlier we asked: Want outside design voices before the detailed review?',
    'Want outside design voices before the detailed review and approve every finding?',
    'Want outside design voices before the detailed review?approve the plan',
  ]) {
    const menu = structuredClone(retained);
    menu.question = opening;
    expect(() => picker()(menu)).toThrow('no unambiguous declared native-only action');
  }
  await expectUnsubmitted(published);
});

test('the native-only actor refuses ambiguous, bundled or unbound outside-voice choices', async () => {
  const published = await board();
  const changes: ((menu: NativeQuestion) => void)[] = [
    menu => { menu.multiSelect = true; },
    menu => { menu.options.pop(); },
    menu => { menu.options.push({ label: 'Approve all', description: 'Approve the plan.' }); },
    menu => { menu.options[0] = { ...menu.options[1]! }; },
    menu => { menu.options[1]!.label += ' and approve the plan'; },
    menu => { menu.options[1]!.description += ' Also approve the plan.'; },
    menu => { menu.options[0]!.description += ' Also skip all Design passes.'; },
    menu => { menu.options[0]!.preview = 'Apply the proposed design.'; },
    menu => { menu.options[1]!.preview = 'Apply the proposed design.'; },
    menu => { menu.question = menu.question.replace('before the detailed review?', 'and approve all findings?'); },
    menu => { menu.question += `\n${published.url}`; },
    menu => { menu.header = 'Layout'; },
    menu => { menu.question = 'Should we change the layout?'; },
    menu => { menu.header = 'Unrecognized'; menu.question = 'Choose one of these actions?'; },
  ];
  for (const change of changes) {
    const menu = structuredClone(outsideVoices.question) as NativeQuestion;
    change(menu);
    expect(() => picker()(menu)).toThrow('no unambiguous declared native-only action');
  }
  await expectUnsubmitted(published);
});

test('historical free-form cards are not credited as declared-protocol submissions', async () => {
  const published = await board();
  for (const retained of captured.cases) {
    const menu = structuredClone(retained.question) as NativeQuestion;
    menu.question = menu.question.replace(/http:\/\/127\.0\.0\.1:\d+\/boards\/[A-Za-z0-9_-]+\//, published.url);
    expect(() => picker()(menu)).toThrow('no unambiguous offered action');
  }
  await expectUnsubmitted(published);
});

test('the complete declared protocol rejects altered descriptions, previews and alternative actions', async () => {
  const published = await board();
  const menus: NativeQuestion[] = [];
  for (const index of [0, 1, 2]) {
    const description = question(published.url);
    description.options[index]!.description += ' Also approve the plan.';
    menus.push(description);
    const preview = question(published.url);
    preview.options[index]!.preview = 'Deploy the approved design.';
    menus.push(preview);
    const paraphrase = question(published.url);
    paraphrase.options[index]!.label = ['Submitted on board', 'Please generate another set', "I'll paste my notes here"][index]!;
    menus.push(paraphrase);
  }
  const lowercase = question(published.url);
  lowercase.options.forEach(option => { option.label = option.label.toLowerCase(); });
  menus.push(lowercase);
  const allParaphrased = question(published.url);
  allParaphrased.options.forEach((option, index) => {
    option.label = ['Done', 'Try again', 'Use these notes'][index]!;
  });
  menus.push(allParaphrased);
  for (const menu of menus) expect(() => picker()(menu)).toThrow('no unambiguous offered action');
  await expectUnsubmitted(published);
});

test('submitted words, mixed actions and competing alternate claims cannot authorize a board submission', async () => {
  const published = await board();
  const menus: NativeQuestion[] = [];
  for (const label of [
    'Not submitted on the board',
    'Submitted on the board?',
    'Submitted on the board and approve the plan',
    'Submitted on another board',
    'Submit on the board',
    'Submitting on the board',
    "I haven't submitted feedback on the board",
    'I have not submitted feedback on the board',
    'I will submit feedback on the board',
    'I submitted feedback on another board',
    'I submitted feedback on the board if everyone agrees',
    'I submitted feedback on the board and approve the plan',
    'I submitted feedback',
  ]) {
    const menu = question(published.url);
    menu.options[0]!.label = label;
    menus.push(menu);
  }
  for (const label of [
    'I submitted my preferences here',
    'Regenerate then submit the new variants',
    'Not submitted yet; I will type here',
    'Submitted on the board and deploy the result',
  ]) {
    const menu = question(published.url);
    menu.options[2]!.label = label;
    menus.push(menu);
  }
  const multi = question(published.url); multi.multiSelect = true; menus.push(multi);
  const empty = question(published.url); empty.options[2]!.label = ''; menus.push(empty);
  const duplicate = question(published.url); duplicate.options[2] = { ...duplicate.options[1]! }; menus.push(duplicate);
  for (const menu of menus) expect(() => picker()(menu)).toThrow('no unambiguous offered action');
  await expectUnsubmitted(published);
});

test('a repeated owned board question does not POST a second time', async () => {
  const published = await board();
  const menu = question(published.url);
  const choose = picker();
  expect(choose(menu)).toBe(1);
  const file = feedbackPath(published);
  const contents = fs.readFileSync(file, 'utf8');
  // Give the real response file a distinguishable mtime; another server write
  // would replace it even when the submitted JSON is byte-identical.
  fs.utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  expect(choose(structuredClone(menu))).toBe(1);
  expect(fs.statSync(file).mtimeMs).toBe(1_000_000);
  expect(fs.readFileSync(file, 'utf8')).toBe(contents);
});

test('a regenerating board refuses cached approval, then a reloaded round receives new feedback', async () => {
  const published = await board();
  const menu = question(published.url);
  const choose = picker();
  expect(choose(menu)).toBe(1);
  const file = feedbackPath(published);
  fs.utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  const regenerate = await fetch(published.url + 'api/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred: 'A', regenerated: true }),
  });
  expect(await regenerate.json()).toEqual({ received: true, action: 'regenerate' });
  expect(() => choose(menu)).toThrow('not ready');
  expect(fs.statSync(file).mtimeMs).toBe(1_000_000);

  const html = makeBoardHtml(published.sourceDir, '<p>New round</p>');
  const reload = await fetch(published.url + 'api/reload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  expect(await reload.json()).toEqual({ reloaded: true });
  expect(choose(menu)).toBe(1);
  expect(fs.statSync(file).mtimeMs).not.toBe(1_000_000);
  const feedback = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(feedback.preferred).toBe('A');
  expect(feedback.regenerated).toBe(false);
  expect(feedback.boardId).toBe(published.id);
});

test('foreign host, credentials, route, query, fragment and legacy URL cannot submit', async () => {
  const published = await board();
  const variants = [
    published.url.replace('127.0.0.1', 'localhost'),
    published.url.replace('127.0.0.1', '[::1]'),
    published.url.replace('http:', 'https:'),
    published.url.replace('http://', 'http://fixture@'),
    published.url.replace(`/boards/${published.id}/`, '/'),
    published.url.slice(0, -1),
    published.url + 'api/feedback',
    published.url + '?board=another',
    published.url + '#another-board',
  ];
  for (const url of variants) expect(() => picker()(question(url))).toThrow();
  await expectUnsubmitted(published);
});

test('a real foreign daemon port is refused without changing either board', async () => {
  const published = await board();
  const otherState = path.join(cwd, 'other', '.gstack', 'design.json');
  fs.mkdirSync(path.dirname(otherState), { recursive: true });
  const other = await spawnDaemonForTest({ stateFile: otherState });
  daemons.push(other);
  const foreign = await board(other);
  expect(() => picker()(question(foreign.url))).toThrow();
  await expectUnsubmitted(published);
  await expectUnsubmitted(foreign);
});

test('multiple URLs or ambiguous action sets do not submit', async () => {
  const published = await board();
  const other = await board();
  const extraUrl = question(published.url);
  extraUrl.question += '\nAnother board: ' + other.url;
  const duplicate = question(published.url);
  duplicate.options.push({ ...duplicate.options[0]! });
  const extraAction = question(published.url);
  extraAction.options.push({ label: 'Delete the project', description: 'An unrelated action.' });
  const missingAction = question(published.url);
  missingAction.options.pop();
  for (const menu of [extraUrl, duplicate, extraAction, missingAction]) {
    expect(() => picker()(menu)).toThrow();
  }
  await expectUnsubmitted(published);
  await expectUnsubmitted(other);
});

test('free-form submission declarations do not bypass the declared actor interface', async () => {
  const published = await board();
  for (const label of [
    'Already submitted on the board (recommended)',
    'I submitted the board feedback (recommended)',
    'I have already submitted my feedback on the comparison board.',
    "I've submitted feedback to the board",
    'I submitted my board feedback',
  ]) {
    const menu = question(published.url);
    menu.options[0]!.label = label;
    expect(() => picker()(menu)).toThrow('no unambiguous offered action');
  }
  await expectUnsubmitted(published);
});

test('missing or malformed private daemon state cannot submit', async () => {
  const published = await board();
  fs.unlinkSync(stateFile);
  expect(() => picker()(question(published.url))).toThrow();
  fs.writeFileSync(stateFile, '{not-json');
  expect(() => picker()(question(published.url))).toThrow();
  await expectUnsubmitted(published);
});

test('a state file naming a real unrelated process does not confer daemon ownership', async () => {
  const published = await board();
  const state = readStateFile(stateFile)!;
  writeStateFile({ ...state, pid: process.pid, cmdlineMarker: 'bun' }, stateFile);
  expect(() => picker()(question(published.url))).toThrow();
  await expectUnsubmitted(published);
});

test('the submission child keeps its minimal environment without inheriting credentials or state overrides', async () => {
  const published = await board();
  const overrides = {
    PSModulePath: 'fixture-unowned-module-path',
    PSModuleAnalysisCachePath: 'fixture-unowned-module-cache',
    ANTHROPIC_API_KEY: 'fixture-provider-secret',
    OPENAI_API_KEY: 'fixture-provider-secret',
    GSTACK_HOME: 'fixture-unowned-state',
    DESIGN_DAEMON_STATE_FILE: 'fixture-unowned-daemon.json',
  };
  const saved = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  const actualSpawn = childProcess.spawnSync;
  const spawned = spyOn(childProcess, 'spawnSync').mockImplementation(actualSpawn);
  try {
    Object.assign(process.env, overrides);
    expect(picker()(question(published.url))).toBe(1);
    expect(spawned).toHaveBeenCalledTimes(1);
    const options = spawned.mock.calls[0]![2] as childProcess.SpawnSyncOptionsWithStringEncoding;
    expect(options.env?.PATH).toBe(process.env.PATH ?? '');
    expect(Object.keys(options.env!).sort()).toEqual([
      'PATH', ...(process.env.SystemRoot ? ['SystemRoot'] : []),
    ].sort());
    for (const key of Object.keys(overrides)) {
      expect(options.env?.[key]).toBeUndefined();
    }
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(2000);
    const written = JSON.parse(fs.readFileSync(feedbackPath(published), 'utf8'));
    expect(written).toMatchObject({ preferred: 'A', regenerated: false, boardId: published.id });
  } finally {
    spawned.mockRestore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an expired absolute deadline refuses before HTTP', async () => {
  const published = await board();
  expect(() => picker(Date.now() - 1)(question(published.url))).toThrow();
  await expectUnsubmitted(published);
});

test('a slow Windows identity query is terminated before its submission actor deadline', async () => {
  const published = await board();
  const queryPid = path.join(cwd, 'query.pid');
  const queryOptions = path.join(cwd, 'query-options.json');
  const preload = path.join(cwd, 'windows-query-adapter.ts');
  const stateModule = path.resolve(import.meta.dir, '../design/src/daemon-state.ts');
  // Exercise the actual picker and its child script. Substitute only the native
  // CIM executable with a real stalled process whose PID we can prove is gone.
  fs.writeFileSync(preload, `
import { mock } from 'bun:test';
import * as processApi from 'node:child_process';
import * as fs from 'node:fs';
const execute = processApi.execFileSync;
const queryExecutable = Bun.which('pwsh.exe', { PATH: process.env.PATH ?? '' }) ?? 'powershell.exe';
mock.module('child_process', () => ({ ...processApi, execFileSync(command, args, options) {
  if (command !== queryExecutable) return execute(command, args, options);
  fs.writeFileSync(${JSON.stringify(queryOptions)}, JSON.stringify(options));
  return execute(process.execPath, ['-e', ${JSON.stringify(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(queryPid)}, String(process.pid)); await Bun.sleep(10_000);`)}], options);
} }));
await import(${JSON.stringify(stateModule)});
Object.defineProperty(process, 'platform', { value: 'win32' });
`);
  const actualSpawn = childProcess.spawnSync;
  const spawned = spyOn(childProcess, 'spawnSync').mockImplementation((command, args, options) =>
    actualSpawn(command, ['--preload', preload, ...args!], options as any));
  let pid: number | undefined;
  try {
    expect(() => picker()(question(published.url))).toThrow('No matching owned design daemon');
    expect(spawned).toHaveBeenCalledTimes(1);
    const result = spawned.mock.results[0]!.value as childProcess.SpawnSyncReturns<string>;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    const options = JSON.parse(fs.readFileSync(queryOptions, 'utf8'));
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThan(1900);
    pid = Number(fs.readFileSync(queryPid, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    spawned.mockRestore();
    if (pid === undefined && fs.existsSync(queryPid)) pid = Number(fs.readFileSync(queryPid, 'utf8'));
    if (pid && Number.isSafeInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  await expectUnsubmitted(published);
});

test('a submission child past its deadline never starts a native identity query', async () => {
  const published = await board();
  const queried = path.join(cwd, 'query-started');
  const preload = path.join(cwd, 'expired-query-adapter.ts');
  const stateModule = path.resolve(import.meta.dir, '../design/src/daemon-state.ts');
  fs.writeFileSync(preload, `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
mock.module('child_process', () => ({ execFileSync() {
  fs.writeFileSync(${JSON.stringify(queried)}, 'unexpected native query');
  throw new Error('native query must not start');
} }));
await import(${JSON.stringify(stateModule)});
Object.defineProperty(process, 'platform', { value: 'win32' });
const now = Date.now.bind(Date);
Date.now = () => now() + 2000;
`);
  const actualSpawn = childProcess.spawnSync;
  const spawned = spyOn(childProcess, 'spawnSync').mockImplementation((command, args, options) =>
    actualSpawn(command, ['--preload', preload, ...args!], options as any));
  // Bind the assertion to the admission clock, not time spent building the
  // question before the picker starts its unchanged two-second child budget.
  const started = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(started);
  try {
    expect(() => picker()(question(published.url))).toThrow('Design feedback deadline exhausted');
    expect(spawned).toHaveBeenCalledTimes(1);
    const options = spawned.mock.calls[0]![2] as childProcess.SpawnSyncOptionsWithStringEncoding;
    expect(options.timeout).toBeLessThanOrEqual(2000);
    const input = JSON.parse(options.input as string);
    expect(input.deadlineAt).toBe(started + 2000);
    expect(fs.existsSync(queried)).toBe(false);
    const result = spawned.mock.results[0]!.value as childProcess.SpawnSyncReturns<string>;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
  } finally {
    clock.mockRestore();
    spawned.mockRestore();
  }
  await expectUnsubmitted(published);
});

test.skipIf(process.platform === 'win32')('a stalled owned daemon obeys the remaining deadline and leaves no fetch child', async () => {
  const published = await board();
  const owned = readStateFile(stateFile)!;
  expect(owned.pid).toBe(daemon.proc.pid!);
  expect(owned.cmdlineMarker).toBe(CMDLINE_MARKER);
  expect(Number.isFinite(Date.parse(owned.startedAt))).toBe(true);
  expect(daemon.proc.exitCode).toBeNull();
  expect(verifyIdentity(owned.pid, CMDLINE_MARKER)).toBe(true);

  const actualSpawn = childProcess.spawnSync;
  const spawned = spyOn(childProcess, 'spawnSync').mockImplementation(actualSpawn);
  let paused = false;
  try {
    paused = daemon.proc.kill('SIGSTOP');
    expect(paused).toBe(true);
    const remainingMs = 200;
    const deadlineAt = Date.now() + remainingMs;
    const started = performance.now();
    expect(() => picker(deadlineAt)(question(published.url))).toThrow('Design feedback failed');
    const elapsedMs = performance.now() - started;
    // Leave scheduler overhead while rejecting use of the ordinary 2s child
    // budget after the case has only 200ms remaining.
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(remainingMs + 750);
    expect(spawned).toHaveBeenCalledTimes(1);
    const result = spawned.mock.results[0]!.value as childProcess.SpawnSyncReturns<string>;
    expect(result.pid).toBeGreaterThan(0);
    expect(result.status).not.toBe(0);
    let childError: unknown;
    try { process.kill(result.pid, 0); } catch (error) { childError = error; }
    expect(childError).toMatchObject({ code: 'ESRCH' });
    expect(readStateFile(stateFile)).toMatchObject({ pid: owned.pid, startedAt: owned.startedAt });
    console.log('Design feedback deadline:', JSON.stringify({ remainingMs, elapsedMs,
      childExited: true, signal: result.signal, status: result.status }));
  } finally {
    spawned.mockRestore();
    if (paused) daemon.proc.kill('SIGCONT');
  }
  // An in-flight HTTP failure is ambiguous at the server. Do not fabricate a
  // no-write guarantee; the picker must fail, and normal owned cleanup follows.
});

test('an unknown board HTTP error does not produce a submitted answer', async () => {
  const published = await board();
  const unknown = published.url.replace(published.id, published.id + '-missing');
  expect(() => picker()(question(unknown))).toThrow('HTTP 404');
  await expectUnsubmitted(published);
});

test('the real daemon feedback-write error propagates without claiming submission', async () => {
  const published = await board();
  fs.mkdirSync(feedbackPath(published));
  expect(() => picker()(question(published.url))).toThrow('HTTP 500');
  expect(fs.readdirSync(feedbackPath(published))).toEqual([]);
  const response = await fetch(published.url + 'api/progress');
  expect(await response.json()).toEqual({ status: 'serving' });
});

test('a failed child launch retains its original error when stderr is null', async () => {
  const published = await board();
  const failedLaunch = spyOn(childProcess, 'spawnSync').mockReturnValue({
    error: Object.assign(new Error('spawn fixture-bun ENOENT'), { code: 'ENOENT' }),
    pid: 0, status: null, signal: null, output: [null, null, null],
    stdout: null, stderr: null,
  } as unknown as ReturnType<typeof childProcess.spawnSync>);
  try {
    expect(() => picker()(question(published.url))).toThrow('spawn fixture-bun ENOENT');
    expect(failedLaunch).toHaveBeenCalledTimes(1);
  } finally {
    failedLaunch.mockRestore();
  }
  await expectUnsubmitted(published);
});

test('ordinary decisions and manual review handoffs delegate without board side effects', async () => {
  const published = await board();
  const menus: NativeQuestion[] = [
    { header: 'Layout', question: 'Which panel should lead?', multiSelect: false, options: [
      { label: 'Activity', description: 'Show activity first.' },
      { label: 'Notifications (recommended)', description: 'Show notifications first.' },
    ] },
    { header: 'Voices', question: 'D5 — How should outside design voices inform this contrast finding?', multiSelect: false, options: [
      { label: 'Adopt accessible contrast (recommended)', description: 'Fix the text contrast.' },
      { label: 'Retain current', description: 'Keep current contrast.' },
    ] },
    { header: 'Next steps', question: 'D9 — Next steps?', multiSelect: false, options: [
      { label: 'Run /plan-eng-review next (recommended)', description: 'Continue review.' },
      { label: 'Skip, handle manually', description: 'Handle the next steps later.' },
    ] },
  ];
  for (const menu of menus) expect(picker()(menu)).toBe(pickPlanReviewQuestion(menu));
  await expectUnsubmitted(published);
});
