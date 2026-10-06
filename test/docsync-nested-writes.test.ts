import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOC_PATH, fixtureDocs } from './helpers/docsync-fixture';
import { docsWriteFailures, observeDocsWrites } from './helpers/docsync-observer';
import { parseNDJSON, type SkillTestResult } from './helpers/session-runner';
import type { QAWriteObservation } from './helpers/qa-functional-observer';

const parentId = 'toolu_014GJr2NN4xPDBKHdzuJXDVJ';
const editId = 'toolu_016LK8W4hbcBWwCRsh9ZVLR8';
type Capture = { fixture: ReturnType<typeof fixtureDocs>; result: SkillTestResult; observation: QAWriteObservation };

async function captureNested(names: Array<'Edit' | 'Write'>, restore = false): Promise<Capture> {
  const fixture = fixtureDocs('updated');
  const target = path.join(fixture.repo, DOC_PATH);
  const initial = fs.readFileSync(target, 'utf8');
  const observer = await observeDocsWrites(fixture);
  const transcript: any[] = [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: parentId, name: 'Agent',
    input: { description: 'Run /document-release doc audit', subagent_type: 'general-purpose', run_in_background: false, prompt: 'Execute /document-release as a SPAWNED ship-owned subagent.' } }] } }];
  for (const [index, name] of names.entries()) {
    const id = index === 0 ? editId : `toolu_nested_${index}`;
    const original = fs.readFileSync(target, 'utf8');
    const content = restore && index > 0 ? initial : index === 0 ? original.replace('Default format: text.', 'Default format: json.') : original + '\nAdditional native content.\n';
    const input = name === 'Edit' ? { replace_all: false, file_path: target, old_string: 'Default format: text.', new_string: 'Default format: json.' }
      : { file_path: target, content };
    transcript.push({ type: 'assistant', parent_tool_use_id: parentId, message: { content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }] } });
    const sibling = path.join(path.dirname(target), `replacement-${index}`);
    const fd = fs.openSync(sibling, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, fs.statSync(target).mode & 0o777);
    fs.closeSync(fd);
    fs.renameSync(sibling, target);
    observer.drain();
    transcript.push({ type: 'user', parent_tool_use_id: parentId, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result',
      content: `The file ${target} has been updated successfully. (file state is current in your context — no need to Read it back)` }] } });
  }
  transcript.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ tool_use_id: parentId, type: 'tool_result',
    content: [{ type: 'text', text: 'Captured parent completion content is not attribution authority.' }] }] }, tool_use_result: { status: 'completed' } });
  const result = { ...parseNDJSON(transcript.map(event => JSON.stringify(event))), exitReason: 'success' } as unknown as SkillTestResult;
  return { fixture, result, observation: observer.stop() };
}

let edit: Capture;
let write: Capture;
const verdict = (capture: Capture) => docsWriteFailures(capture.observation, [DOC_PATH], capture);
const copy = (capture = edit): Capture => ({ fixture: { ...capture.fixture, before: structuredClone(capture.fixture.before) },
  result: structuredClone(capture.result), observation: structuredClone(capture.observation) });

(process.platform === 'linux' ? describe : describe.skip)('omitted forwarded native document metadata', () => {
  beforeAll(async () => { edit = await captureNested(['Edit']); write = await captureNested(['Write']); });
  afterAll(() => { edit?.fixture.clean(); write?.fixture.clean(); });

  test.each(['Edit', 'Write'])('binds captured public parent-scoped %s envelopes to owned bytes and real kernel cookies', name => {
    const captured = name === 'Edit' ? edit : write;
    expect(Object.hasOwn(captured.result.transcript[2], 'tool_use_result')).toBe(false);
    expect(captured.observation.complete).toBe(true);
    expect(verdict(captured)).toEqual([]);
    expect(docsWriteFailures(captured.observation, [DOC_PATH]).length).toBeGreaterThan(0);
  });

  test('does not use success prose as authority or mutate the captured evidence', () => {
    const captured = copy();
    const before = structuredClone(captured.observation);
    captured.result.transcript[2].message.content[0].content = 'No success assertion in this text.';
    captured.result.transcript[3].message.content[0].content = 'No success assertion here either.';
    expect(verdict(captured)).toEqual([]);
    expect(captured.observation).toEqual(before);
  });

  const corruptions: Record<string, (capture: Capture) => void> = {
    'missing baseline': c => { delete c.fixture.before.contents[DOC_PATH]; },
    'invalid base64 baseline': c => { c.fixture.before.contents[DOC_PATH] += '!'; },
    'noncanonical baseline': c => { c.fixture.before.contents[DOC_PATH] += '='; },
    'different owned baseline': c => { c.fixture.before.contents[DOC_PATH] = Buffer.from('unrelated').toString('base64'); },
    'invalid UTF-8 baseline': c => { c.fixture.before.contents[DOC_PATH] = Buffer.from([255]).toString('base64'); },
    'top-level omitted payload': c => { c.result.transcript[1].parent_tool_use_id = null; c.result.transcript[2].parent_tool_use_id = null; },
    'present null payload': c => { c.result.transcript[2].tool_use_result = null; },
    'present undefined payload': c => { c.result.transcript[2].tool_use_result = undefined; },
    'present invalid payload': c => { c.result.transcript[2].tool_use_result = {}; },
    'failed child': c => { c.result.transcript[2].message.content[0].is_error = true; },
    'malformed child error flag': c => { c.result.transcript[2].message.content[0].is_error = 'false'; },
    'missing child completion': c => { c.result.transcript.splice(2, 1); },
    'orphan parent identity': c => { c.result.transcript[1].parent_tool_use_id = 'orphan'; c.result.transcript[2].parent_tool_use_id = 'orphan'; },
    'cross-parent result': c => { c.result.transcript[2].parent_tool_use_id = 'orphan'; },
    'missing parent dispatch': c => { c.result.transcript.shift(); },
    'missing parent completion': c => { c.result.transcript.pop(); },
    'failed parent': c => { c.result.transcript[3].message.content[0].is_error = true; },
    'malformed parent error flag': c => { c.result.transcript[3].message.content[0].is_error = 'false'; },
    'background parent': c => { c.result.transcript[0].message.content[0].input.run_in_background = true; },
    'non-dispatch parent': c => { c.result.transcript[0].message.content[0].name = 'Read'; },
    'missing root metadata': c => { delete c.result.transcript[3].tool_use_result; },
    'null root metadata': c => { c.result.transcript[3].tool_use_result = null; },
    'unsettled root metadata': c => { c.result.transcript[3].tool_use_result.status = 'async_launched'; },
    'parent starts after child': c => { [c.result.transcript[0], c.result.transcript[1]] = [c.result.transcript[1], c.result.transcript[0]]; },
    'parent ends before child': c => { [c.result.transcript[2], c.result.transcript[3]] = [c.result.transcript[3], c.result.transcript[2]]; },
    'cyclic parent': c => { c.result.transcript[0].parent_tool_use_id = parentId; c.result.transcript[3].parent_tool_use_id = parentId; },
    'duplicate parent dispatch': c => { c.result.transcript.unshift(structuredClone(c.result.transcript[0])); },
    'ambiguous parent ID across scopes': c => {
      const start = structuredClone(c.result.transcript[0]), end = structuredClone(c.result.transcript[3]);
      start.parent_tool_use_id = 'other-scope'; end.parent_tool_use_id = 'other-scope';
      c.result.transcript.unshift(start); c.result.transcript.push(end);
    },
    'wrong input path': c => { c.result.transcript[1].message.content[0].input.file_path = path.join(c.fixture.repo, 'README.md'); },
    'wrong old content': c => { c.result.transcript[1].message.content[0].input.old_string = 'not in the document'; },
    'ambiguous old content': c => { c.result.transcript[1].message.content[0].input.old_string = '.'; },
    'empty old content': c => { c.result.transcript[1].message.content[0].input.old_string = ''; },
    'wrong final content': c => { c.result.transcript[1].message.content[0].input.new_string = 'forged content'; },
    'invalid replace-all flag': c => { c.result.transcript[1].message.content[0].input.replace_all = 'false'; },
    'reused rename cookie': c => { c.observation.events.push({ ...c.observation.events.find(event => event.mask === 0x40)! }); },
    'missing rename cookie': c => { c.observation.events.forEach(event => { event.cookie = 0; }); },
    'changed mode': c => { c.observation.after[DOC_PATH] = c.observation.after[DOC_PATH].replace(/^\d+:/, '384:'); },
    'unobserved final content': c => { c.observation.after[DOC_PATH] = c.observation.before[DOC_PATH]; },
    'incomplete observer': c => { c.observation.complete = false; },
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    test(`rejects ${name}`, () => {
      const captured = copy();
      expect(verdict(captured)).toEqual([]);
      corrupt(captured);
      expect(verdict(captured).length).toBeGreaterThan(0);
    });
  }

  test.each(['wrong-content', 'non-string-content'])('rejects nested Write %s', fault => {
    const captured = copy(write);
    captured.result.transcript[1].message.content[0].input.content = fault === 'wrong-content' ? 'forged' : null;
    expect(verdict(captured).length).toBeGreaterThan(0);
  });

  test('preserves full validation when nested payload is present', () => {
    const captured = copy();
    const input = captured.result.transcript[1].message.content[0].input;
    captured.result.transcript[2].tool_use_result = { filePath: input.file_path, userModified: false,
      originalFile: Buffer.from(captured.fixture.before.contents[DOC_PATH], 'base64').toString('utf8'),
      oldString: input.old_string, newString: input.new_string, replaceAll: false };
    expect(verdict(captured)).toEqual([]);
    captured.result.transcript[2].tool_use_result.newString = 'forged';
    expect(verdict(captured).length).toBeGreaterThan(0);
  });

  test.each(['valid', 'orphan', 'failed', 'invalid-payload'])('checks every recursive ancestor: %s', fault => {
    const captured = copy();
    const innerStart = structuredClone(captured.result.transcript[0]), innerEnd = structuredClone(captured.result.transcript[3]);
    innerStart.parent_tool_use_id = parentId;
    innerStart.message.content[0].id = 'inner-agent';
    innerEnd.parent_tool_use_id = parentId;
    innerEnd.message.content[0].tool_use_id = 'inner-agent';
    delete innerEnd.tool_use_result;
    captured.result.transcript[1].parent_tool_use_id = 'inner-agent';
    captured.result.transcript[2].parent_tool_use_id = 'inner-agent';
    captured.result.transcript.splice(1, 0, innerStart);
    captured.result.transcript.splice(4, 0, innerEnd);
    if (fault === 'orphan') { innerStart.parent_tool_use_id = 'missing'; innerEnd.parent_tool_use_id = 'missing'; }
    if (fault === 'failed') innerEnd.message.content[0].is_error = true;
    if (fault === 'invalid-payload') innerEnd.tool_use_result = null;
    if (fault === 'valid') expect(verdict(captured)).toEqual([]);
    else expect(verdict(captured).length).toBeGreaterThan(0);
  });

  test.each(['ordered', 'overlap', 'restore'])('binds omitted-metadata replacement chains: %s', async fault => {
    const captured = await captureNested(['Edit', 'Write'], fault === 'restore');
    try {
      if (fault === 'overlap') [captured.result.transcript[2], captured.result.transcript[3]] = [captured.result.transcript[3], captured.result.transcript[2]];
      if (fault === 'ordered') expect(verdict(captured)).toEqual([]);
      else expect(verdict(captured).length).toBeGreaterThan(0);
    } finally { captured.fixture.clean(); }
  });

  test('read-only and undeclared Git commands still block omitted-metadata attribution', () => {
    expect(docsWriteFailures(edit.observation, [], edit).length).toBeGreaterThan(0);
    const captured = copy();
    captured.result.toolCalls.push({ tool: 'Bash', input: { command: `git --git-dir ${captured.fixture.repo}/.git status` }, output: '' });
    expect(verdict(captured).length).toBeGreaterThan(0);
  });
});

test('the actual ship mutation callback distinguishes whole subcommands from merge-base', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-ship-docsync.test.ts'), 'utf8');
  const start = source.indexOf('const actualMutation = calls.filter');
  const end = source.indexOf('expect(actualMutation).toEqual([]);', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const callback = new Function('calls', `${source.slice(start, end)}return actualMutation;`);
  const commands = ['git merge-base main HEAD', 'git merge-base --is-ancestor main HEAD', 'git status',
    ...['add', 'commit', 'push', 'reset', 'checkout', 'stash', 'merge', 'pull', 'rebase'].flatMap(command =>
      [`git ${command}`, `git ${command} argument`, `git ${command}\targument`, `git ${command}; next`, `git ${command}&& next`, `git ${command}>out`])];
  expect(callback(commands.map(command => ({ tool: 'Bash', input: { command } })))).toEqual(commands.slice(3));
});

(process.platform === 'linux' ? describe : describe.skip)('replay of PR run 37239016858 ship-docsync-completion', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/docsync-replay/37239016858-completion-native.json'), 'utf8'));
  const replay = (edit: (text: string) => string = text => text, events = captured.observation.events) => {
    const fixture = fixtureDocs('updated');
    const lines = captured.transcript.map((event: unknown) => edit(JSON.stringify(event).replaceAll('<HOME>', fixture.home)));
    const result = { ...parseNDJSON(lines), exitReason: 'success' } as unknown as SkillTestResult;
    try {
      return docsWriteFailures({ ...captured.observation, events }, [DOC_PATH], { result, fixture, scripts: [path.join(fixture.home, 'fixture-publish.ts')] });
    } finally { fixture.clean(); }
  };

  test("the child's native atomic replacement of the authored doc is proven, with the helper's --help declared", () => {
    expect(replay()).toEqual([]);
  });

  test('an undeclared helper command still denies the atomic proof and the red line names it', () => {
    expect(replay(text => text.replace('gstack-docs-candidate --help', 'gstack-docs-candidate --version'))).toEqual([
      'forbidden docs write: handbook/reference/commands/widget.md.tmpl.tmp.834.e81a3a0233c1 (atomic replacement unproven at docsync-observer.ts:29 (command outside declared docs observation interface))',
    ]);
  });

  test('a temp file left behind or renamed elsewhere is not an atomic replacement', () => {
    const events = captured.observation.events as QAWriteObservation['events'];
    const leftBehind = events.filter(event => event.cookie === 0 || event.mask !== 0x40 && event.mask !== 0x80);
    expect(replay(undefined, leftBehind)).toContainEqual(expect.stringMatching(/^forbidden docs write: handbook\/reference\/commands\/widget\.md\.tmpl\.tmp\.834\.e81a3a0233c1/));
    const elsewhere = events.map(event => event.mask === 0x80 ? { ...event, path: 'handbook/reference/commands/other.md' } : event);
    expect(replay(undefined, elsewhere)).toContainEqual(expect.stringMatching(/^forbidden docs write: handbook\/reference\/commands\/other\.md/));
  });
});
