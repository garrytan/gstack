import { afterEach, describe, expect, jest, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializePlan, prepareMethodology, createSnapshot, preparePhaseClose, prepareAmendedInput } from '../bin/gstack-autoplan-snapshot';
import { evaluateAutoplanPublication, runPublicationHook, autoplanReadRange, type PublicationHookInput } from '../autoplan/bin/phase-publication-hook.ts';
import { readOwnedClaudePublicTranscript, type ClaudeParentPublicEvent } from '../lib/claude-public-transcript';
import { prematureAutoplanPhaseEntry } from './helpers/autoplan-method-read-audit';
import captured from './fixtures/autoplan-publication-boundary-361c.json';
import consumption from './fixtures/autoplan-phase-consumption-491.json';

const ROOT = fs.realpathSync(path.join(import.meta.dir, '..'));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const phaseNumber = { ceo: 1, design: 2, dx: 2.5, eng: 3 };
type Phase = keyof typeof phaseNumber;
const clock = Date.parse('2026-09-17T04:00:00Z');

async function withNativeProjectDirectory<T>(cwd: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  if (cwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = cwd;
  try { return await work(); }
  finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  }
}

async function withPublicationClock<T>(work: () => Promise<T>): Promise<T> {
  expect(jest.isFakeTimers()).toBe(false);
  const immediate = globalThis.setImmediate;
  jest.useFakeTimers();
  try {
    let settled = false;
    const pending = Promise.resolve().then(work);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    for (let elapsed = 0; elapsed <= 2_000; elapsed += 50) {
      await new Promise<void>(resolve => immediate(resolve));
      if (settled) return await pending;
      if (elapsed < 2_000) jest.advanceTimersByTime(50);
    }
    throw new Error('Publication hook did not settle within its 2000ms polling budget.');
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
}

function fixture(phase: Phase = 'ceo', next = 'design') {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'autoplan-publication-'))); dirs.push(cwd);
  const source = path.join(cwd, 'source.md'), active = path.join(cwd, 'active.md'), restore = path.join(cwd, 'restore.md');
  fs.writeFileSync(source, '# Current plan\nKeep documented behavior.\n');
  const init = initializePlan(source, active, restore);
  const skill = path.join(cwd, 'SKILL.md');
  fs.writeFileSync(skill, `---\nname: plan-${phase === 'dx' ? 'devex' : phase}-review\n---\n## Review Sections\nApply every current review criterion.\n`);
  const method = prepareMethodology(phase, skill, restore).methodologyPath;
  const checkpoint = createSnapshot(phase, active, restore, method).snapshotPath;
  fs.appendFileSync(active, `<!-- autoplan-accepted:${phase} -->\nNone: retain the current behavior.\n<!-- /autoplan-accepted:${phase} -->\n`);
  const packet = preparePhaseClose(phase, active, checkpoint, restore, method);
  const sessionId = randomUUID(), events: ClaudeParentPublicEvent[] = [];
  const add = (event: any) => {
    const full = { sessionId, timestamp: new Date(clock + events.length).toISOString(), order: events.length, ...event };
    events.push(full); return full;
  };
  const use = (id: string, name: string, input: object) => add({ kind: 'use', toolUseId: id, name, input });
  const result = (id: string, extra: object) => add({ kind: 'result', toolUseId: id, isError: false, ...extra });
  const read = (id: string, file: string, offset = 1, limit?: number) => {
    const text = fs.readFileSync(fs.realpathSync(file), 'utf8'), lines = text.split('\n');
    const count = Math.min(limit ?? lines.length, lines.length - offset + 1);
    use(id, 'Read', { file_path: file, offset, ...(limit === undefined ? {} : { limit }) });
    result(id, { file: { filePath: file, content: lines.slice(offset - 1, offset - 1 + count).join('\n'),
      startLine: offset, numLines: count, totalLines: lines.length } });
  };
  use('init', 'Bash', { command: `cd '${cwd}'\nbun "${ROOT}/bin/gstack-autoplan-snapshot.ts" init \\\n "${source}" "${active}" "${restore}"` });
  result('init', { content: JSON.stringify(init) });
  read('entry', path.join(ROOT, 'autoplan', 'sections', `${phase}-phase.md`));
  read('close', packet.closePacketPath);
  const message = (text = `Phase ${phaseNumber[phase]} complete.`) => add({ kind: 'message', text });
  const target = path.join(ROOT, 'autoplan', 'sections', next === 'tasks' ? 'tasks-aggregator.md' : `${next}-phase.md`);
  const input: PublicationHookInput = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd,
    transcript_path: path.join(cwd, 'config', 'projects', 'fixture', `${sessionId}.jsonl`),
    tool_name: 'Read', tool_use_id: 'next', tool_input: { file_path: target } };
  const current = () => use('next', 'Read', input.tool_input);
  const evaluate = () => evaluateAutoplanPublication(input, ROOT, events);
  const reorder = () => events.forEach((e, i) => { e.order = i; });
  const journal = () => {
    fs.mkdirSync(path.dirname(input.transcript_path), { recursive: true });
    let parent: string | null = null;
    const record = (role: string, content: unknown, extra: object = {}) => {
      const uuid = randomUUID(); const r = { uuid, parentUuid: parent, cwd, sessionId, isSidechain: false,
        timestamp: new Date(clock).toISOString(), type: role, message: { role, content }, ...extra };
      parent = uuid; return r;
    };
    const rows = [record('user', '<command-message>autoplan</command-message>\n<command-name>/autoplan</command-name>',
      { origin: { kind: 'human' }, promptId: randomUUID() })];
    for (const e of events) {
      if (e.kind === 'use') rows.push(record('assistant', [{ type: 'tool_use', id: e.toolUseId, name: e.name, input: e.input }], { timestamp: e.timestamp }));
      else if (e.kind === 'result') rows.push(record('user', [{ type: 'tool_result', tool_use_id: e.toolUseId,
        content: e.content ?? 'Read complete.', is_error: e.isError }], { timestamp: e.timestamp, toolUseResult: { file: e.file } }));
      else if (e.kind === 'message') rows.push(record('assistant', [{ type: 'text', text: e.text }], { timestamp: e.timestamp }));
    }
    fs.writeFileSync(input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    return { rows, record };
  };
  return { cwd, source, active, restore, init, method, checkpoint, packet, sessionId, events, input,
    add, use, result, read, message, current, evaluate, reorder, journal };
}

describe('Autoplan parent publication guard', () => {
  function checkpointWriter(f: ReturnType<typeof fixture>) {
    const create = (phase: Phase, id: string) => {
      const skill = path.join(f.cwd, id, 'SKILL.md');
      fs.mkdirSync(path.dirname(skill));
      fs.writeFileSync(skill, `---\nname: plan-${phase === 'dx' ? 'devex' : phase}-review\n---\n## Review Sections\nApply every current review criterion.\n`);
      const method = prepareMethodology(phase, skill, f.restore).methodologyPath;
      f.use(id, 'Bash', { command: `bun "${ROOT}/bin/gstack-autoplan-snapshot.ts" create ${phase} "${f.active}" "${f.restore}" "${method}"` });
      const snapshot = createSnapshot(phase, f.active, f.restore, method);
      f.result(id, { content: JSON.stringify(snapshot) });
      return { method, snapshot };
    };
    return create;
  }
  function completedCycle() {
    const f = fixture(); f.message();
    const create = checkpointWriter(f), first = new Map<Phase, ReturnType<typeof create>>();
    let unread: ReturnType<typeof create>;
    for (const phase of ['design', 'dx', 'eng'] as const) {
      f.read(`${phase}-entry`, path.join(ROOT, 'autoplan/sections', `${phase}-phase.md`));
      const generation = create(phase, `${phase}-create`);
      first.set(phase, generation);
      f.read(`${phase}-snapshot`, path.join(path.dirname(generation.snapshot.snapshotPath), 'snapshot.json'));
      // This old snapshot is acknowledged before closing, but never Read.
      if (phase === 'eng') unread = create('eng', 'unread-historical-create');
      fs.appendFileSync(f.active, `<!-- autoplan-accepted:${phase} -->\nNone: retain the current behavior.\n<!-- /autoplan-accepted:${phase} -->\n`);
      const close = preparePhaseClose(phase, f.active, generation.snapshot.snapshotPath, f.restore, generation.method);
      f.read(`${phase}-close`, close.closePacketPath); f.message(`Phase ${phaseNumber[phase]} complete.`);
    }
    const tasks = path.join(ROOT, 'autoplan/sections/tasks-aggregator.md');
    f.read('first-tasks', tasks);
    return { f, create, first, unread: unread!, tasks };
  }
  test('a fresh Eng checkpoint after tasks requires a new close and parent publication', async () => {
    const { f, create, tasks } = completedCycle();
    const rerun = create('eng', 'rerun-create');
    f.read('rerun-snapshot', path.join(path.dirname(rerun.snapshot.snapshotPath), 'snapshot.json'));
    f.input.tool_input = { file_path: tasks }; f.current(); f.journal();
    const output: any = await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT));
    expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    f.events.pop();
    const close = preparePhaseClose('eng', f.active, rerun.snapshot.snapshotPath, f.restore, rerun.method);
    f.read('rerun-close', close.closePacketPath); f.current(); f.journal();
    expect(await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT)))
      .toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('Publish the filled Phase 3') } });
    f.events.pop(); f.message('Phase 3 complete.'); f.current(); f.journal();
    expect(await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT))).toEqual({});
  });

  for (const phase of ['ceo', 'design', 'dx', 'eng'] as const)
    test(`a fresh ${phase} checkpoint reopens its own publication boundary after tasks`, () => {
      const { f, create } = completedCycle(), rerun = create(phase, 'rerun-create');
      // Creation supplies no forward-phase credit, but the owned new checkpoint
      // invalidates the earlier cycle even before its first snapshot Read.
      const next = { ceo: 'design-phase', design: 'eng-phase', dx: 'eng-phase', eng: 'tasks-aggregator' }[phase];
      f.input.tool_input = { file_path: path.join(ROOT, 'autoplan/sections', `${next}.md`) }; f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining(`Phase ${phaseNumber[phase]} close procedure`) });
      f.events.pop();
      f.use('rerun-review', 'Agent', { prompt: rerun.snapshot.nativeDispatchPrompt });
      f.result('rerun-review', { content: 'Native reviewer launched.' });
      const close = preparePhaseClose(phase, f.active, rerun.snapshot.snapshotPath, f.restore, rerun.method);
      f.read('rerun-close', close.closePacketPath); f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining(`Publish the filled Phase ${phaseNumber[phase]}`) });
      f.events.pop(); f.message(`Phase ${phaseNumber[phase]} complete.`); f.current();
      expect(f.evaluate()).toEqual({ allow: true });
    });

  test('historical driver, methodology and previously unread snapshot recovery does not reopen a phase', () => {
    const { f, first, unread, tasks } = completedCycle();
    for (const [id, file] of [['driver', path.join(ROOT, 'autoplan/sections/ceo-phase.md')],
      ['methodology', first.get('design')!.method], ['snapshot', unread.snapshot.snapshotPath]] as const) f.read(`history-${id}`, file);
    f.input.tool_input = { file_path: tasks }; f.current();
    expect(f.evaluate()).toEqual({ allow: true });
  });

  test('an old close and a new report cannot close a different rerun checkpoint', () => {
    const { f, tasks } = completedCycle(), create = checkpointWriter(f);
    const oldClose = f.events.find(e => e.kind === 'use' && e.toolUseId === 'eng-close')!;
    create('eng', 'new-generation');
    f.read('old-close-replayed', oldClose.input!.file_path as string); f.message('Phase 3 complete.');
    f.input.tool_input = { file_path: tasks }; f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('earlier checkpoint') });
  });

  for (const status of ['partial', 'failed', 'pending'] as const)
    test(`a ${status} rerun close cannot borrow the first cycle's completed report`, () => {
      const { f, create, tasks } = completedCycle(), rerun = create('eng', 'rerun');
      const close = preparePhaseClose('eng', f.active, rerun.snapshot.snapshotPath, f.restore, rerun.method);
      f.read('new-close', close.closePacketPath, 1, status === 'partial' ? 1 : undefined);
      if (status === 'failed') f.events.at(-1)!.isError = true;
      if (status === 'pending') f.events.pop();
      f.input.tool_input = { file_path: tasks }; f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Read every line') });
    });

  for (const kind of ['failed', 'unpaired', 'orphan-result', 'result-before-use', 'foreign-active',
    'foreign-restore', 'reflected-old', 'altered-identity', 'altered-prompt', 'altered-baseline'] as const)
    test(`a ${kind} checkpoint result cannot reopen historical phase state`, () => {
      const { f, create, first, tasks } = completedCycle();
      const old = first.get('eng')!.snapshot, fresh = create('eng', 'untrusted-create');
      const use = f.events.at(-2)!, result = f.events.at(-1)!;
      if (kind === 'failed') result.isError = true;
      if (kind === 'unpaired') f.events.pop();
      if (kind === 'orphan-result') f.events.splice(-2, 1);
      if (kind === 'result-before-use') f.events.splice(-2, 2, result, use);
      let output = fresh.snapshot;
      if (kind === 'reflected-old') output = old;
      if (kind === 'foreign-active' || kind === 'foreign-restore') {
        const foreign = fixture('eng', 'tasks');
        output = createSnapshot('eng', foreign.active, foreign.restore, foreign.method);
        if (kind === 'foreign-restore') {
          const method = prepareMethodology('eng', path.join(foreign.cwd, 'SKILL.md'), foreign.restore).methodologyPath;
          output = createSnapshot('eng', f.active, foreign.restore, method);
        }
      }
      if (kind === 'altered-identity') output = { ...output, sourceBytes: output.sourceBytes + 1 };
      if (kind === 'altered-prompt') output = { ...output, nativePrompt: output.nativePrompt + 'Forged.' };
      if (kind === 'altered-baseline') output = { ...output, baselineEdits: { ...output.baselineEdits, record: 'Forged checkpoint.' } };
      result.content = JSON.stringify(output); f.reorder();
      f.input.tool_input = { file_path: tasks }; f.current();
      expect(f.evaluate()).toEqual({ allow: true });
    });

  for (const operation of ['prepare-close', 'amend-input'] as const)
    test(`an internal ${operation} export does not start a new checkpoint generation`, () => {
      const { f, first, tasks } = completedCycle(), prior = first.get('eng')!;
      f.use('internal-export', 'Bash', { command: operation });
      const output = operation === 'prepare-close'
        ? preparePhaseClose('eng', f.active, prior.snapshot.snapshotPath, f.restore, prior.method)
        : prepareAmendedInput('eng', f.active, prior.snapshot.snapshotPath, f.restore, prior.method);
      f.result('internal-export', { content: JSON.stringify(output) });
      f.input.tool_input = { file_path: tasks }; f.current();
      expect(f.evaluate()).toEqual({ allow: true });
    });

  test('CEO second voice creation preserves its fixed Step-0 checkpoint', () => {
    const f = fixture(); f.events.splice(4); const create = checkpointWriter(f);
    const step0 = create('ceo', 'step0'), voice = create('ceo', 'voice');
    f.read('voice-input', voice.snapshot.snapshotPath);
    const close = preparePhaseClose('ceo', f.active, step0.snapshot.snapshotPath, f.restore, step0.method);
    f.read('step0-close', close.closePacketPath); f.message(); f.current();
    expect(f.evaluate()).toEqual({ allow: true });
  });

  test('preparing a later checkpoint cannot advance past an unpublished rerun', () => {
    const { f, create, tasks } = completedCycle();
    const design = create('design', 'design-rerun'); create('eng', 'prepared-eng');
    f.input.tool_input = { file_path: tasks }; f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Phase 2 close procedure') });
    f.events.pop(); f.read('current-recovery', design.method);
    f.input.tool_input = { file_path: design.method }; f.current();
    expect(f.evaluate()).toEqual({ allow: true });
  });

  function changedDirectory(publish = true, next = 'design-phase.md') {
    const f = fixture();
    const registry = path.join(f.cwd, 'registry');
    fs.mkdirSync(registry); fs.symlinkSync(path.join(ROOT, 'autoplan'), path.join(registry, 'autoplan'));
    const currentCwd = fs.realpathSync(path.join(registry, 'autoplan/sections'));
    f.use('cd', 'Bash', { command: `cd '${registry}/autoplan/sections' && pwd` });
    f.result('cd', { content: currentCwd });
    if (publish) f.message();
    f.input.cwd = currentCwd;
    f.input.tool_input = { file_path: next };
    f.current();
    const { rows } = f.journal();
    const change = rows.findIndex(r => Array.isArray(r.message.content) &&
      r.message.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === 'cd'));
    for (const row of rows.slice(change)) row.cwd = currentCwd;
    const save = () => fs.writeFileSync(f.input.transcript_path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    save(); return { f, rows, save };
  }

  test('native project ownership survives a Bash cd through the installed skill link', async () => {
    const { f } = changedDirectory();
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.input.cwd, f.sessionId).transcript.status).toBe('missing');
    expect(await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT))).toEqual({});
  });

  test('native project ownership still requires publication and permits same-phase repair after cd', async () => {
    const { f } = changedDirectory(false);
    const output: any = await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT));
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Publish the filled Phase 1');
    const same = changedDirectory(false, 'ceo-phase.md');
    expect(await withNativeProjectDirectory(same.f.cwd, () => runPublicationHook(same.f.input, ROOT))).toEqual({});
  });

  test('the literal init parser retains Windows drive and UNC identities', () => {
    const source = fs.readFileSync(path.join(ROOT, 'autoplan/bin/phase-publication-hook.ts'), 'utf8');
    const fn = source.slice(source.indexOf('function initArguments('), source.indexOf('\nfunction invocation('));
    const parse = new Function('path', 'fs', 'process', 'ownPath',
      new Bun.Transpiler({ loader: 'ts' }).transformSync(fn) + '\nreturn initArguments;')(
      path.win32, { realpathSync: (file: string) => file }, { platform: 'win32' },
      (value: unknown) => typeof value === 'string' && path.win32.isAbsolute(value) && path.win32.normalize(value) === value);
    for (const root of [String.raw`C:\repo`, String.raw`\\server\share\repo`]) {
      const args = ['source.md', 'active.md', 'restore.md'].map(file => path.win32.join(root, file));
      const script = path.win32.join(root, 'bin/gstack-autoplan-snapshot.ts');
      const singleQuoted = [script, ...args].map(value => `'${value}'`);
      const command = `bun ${singleQuoted[0]} init ${singleQuoted.slice(1).join(' ')}`;
      expect(parse(command, root)).toEqual(args);
      const forward = [script, ...args].map(value => '"' + value.replaceAll('\\', '/') + '"');
      expect(parse(`bun ${forward[0]} init ${forward.slice(1).join(' ')}`, root)).toEqual(args);
      if (!root.startsWith('\\\\')) {
        const native = [script, ...args].map(value => '"' + value + '"');
        expect(parse(`bun ${native[0]} init ${native.slice(1).join(' ')}`, root)).toEqual(args);
      }
      for (const bad of [command + ' && true', command.replace('source.md', String.raw`..\source.md`),
        command.replace('source.md', 'nested/../source.md'), command.replace(script, path.win32.join(root, 'foreign.ts'))]) {
        expect(parse(bad, root)).toBeUndefined();
      }
    }
  });

  test('native hook accepts platform paths without evaluating shell escapes', async () => {
    // The same actual hook receives native separators in Windows CI.
    const f = fixture();
    f.message(); f.current(); f.journal();
    expect(await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT))).toEqual({});
    const command = f.events[0]!.input!.command as string;
    for (const suffix of ['; true', ' && true', ' | cat']) {
      f.events[0]!.input!.command = command + suffix; f.journal();
      const output: any = await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT));
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    }
    for (const escaped of ['\\$HOME', '\\`whoami\\`', '\\"quoted']) {
      f.events[0]!.input!.command = command.replace(f.source, f.source + escaped); f.journal();
      const output: any = await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT));
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  test('native project ownership preserves the absent-env same-directory adapter', async () => {
    const f = fixture(); f.message(); f.current(); f.journal();
    expect(await withNativeProjectDirectory(undefined, () => runPublicationHook(f.input, ROOT))).toEqual({});
  });

  for (const project of ['absent', 'empty', 'relative', 'foreign', 'unnormalized'] as const) {
    test.serial(`native project ownership rejects ${project} original-directory evidence after cd`, async () => {
      const { f } = changedDirectory();
      const value = project === 'absent' ? undefined : project === 'empty' ? '' : project === 'relative' ? 'relative' :
        project === 'foreign' ? path.join(f.cwd, 'foreign') : f.cwd + '/.';
      const output: any = await withNativeProjectDirectory(value, () => withPublicationClock(() => runPublicationHook(f.input, ROOT)));
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  }

  for (const mutation of ['foreign-root', 'sidechain', 'dangling', 'competing-root', 'duplicate-root',
    'foreign-session', 'wrong-current-input', 'incomplete-current'] as const) {
    test.serial(`native project ownership retains ${mutation} rejection after cd`, async () => {
      const { f, rows, save } = changedDirectory();
      const current = rows.at(-1)!;
      if (mutation === 'foreign-root') rows[0]!.cwd = path.join(f.cwd, 'foreign');
      if (mutation === 'sidechain') current.isSidechain = true;
      if (mutation === 'dangling') current.parentUuid = randomUUID();
      if (mutation === 'competing-root') rows.push({ ...rows[0]!, uuid: randomUUID() });
      if (mutation === 'duplicate-root') rows.push({ ...rows[0]! });
      if (mutation === 'foreign-session') current.sessionId = randomUUID();
      if (mutation === 'wrong-current-input') f.input.tool_input = { file_path: 'eng-phase.md' };
      save();
      if (mutation === 'incomplete-current') {
        const bytes = fs.readFileSync(f.input.transcript_path, 'utf8');
        fs.writeFileSync(f.input.transcript_path, bytes.slice(0, -1));
      }
      const output: any = await withNativeProjectDirectory(f.cwd, () => withPublicationClock(() => runPublicationHook(f.input, ROOT)));
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  }

  for (const [phase, next] of [['ceo', 'design'], ['design', 'dx'], ['design', 'eng'], ['dx', 'eng'], ['eng', 'tasks']] as const) {
    test(`${phase} closes before ${next}; only the parent publication unlocks entry`, () => {
      const f = fixture(phase, next); f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled') });
      f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    });
  }

  for (const capture of captured.cases) test(`original ${capture.phase} omission remains a failure through the complete guard adapter`, () => {
    const next = capture.native.next[0] as any, ack = capture.native.next[1] as any;
    const close = capture.native.close[1] as any;
    expect(close.file.startLine).toBe(1); expect(close.file.numLines).toBe(close.file.totalLines);
    const actualTranscript = { status: 'ready' as const, calls: [], assistantMessages: capture.messages };
    expect(prematureAutoplanPhaseEntry([...capture.native.close, ...capture.native.next] as any, actualTranscript,
      [{ phase: capture.nextPhase as any, requiredPhase: phaseNumber[capture.phase as Phase] as any,
        paths: [next.input.file_path], content: ack.file.content }], 0)).toMatchObject({ readToolUseId: next.toolUseId });
    // Explicit adapter: current filesystem identities come from actual snapshot
    // APIs. Every captured parent message remains complete and unchanged; no
    // original artifact or paid outcome is rewritten to manufacture a success.
    const f = fixture(capture.phase as Phase, capture.nextPhase);
    const nativeInit: any = capture.native.init[0], initResult = JSON.parse((capture.native.init[1] as any).content);
    (f.events[0] as any).input.command = nativeInit.input.command
      .replace('/home/vercel-sandbox/gstack/bin/gstack-autoplan-snapshot.ts', `${ROOT}/bin/gstack-autoplan-snapshot.ts`)
      .replace(initResult.sourcePlan, f.source).replace(initResult.activePlan, f.active).replace(initResult.restorePath, f.restore);
    [...capture.native.init, ...capture.native.entry, ...capture.native.close].forEach((e, i) => { f.events[i]!.timestamp = e.timestamp; });
    for (const m of capture.messages) f.add({ kind: 'message', text: m.text, timestamp: m.timestamp });
    f.events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); f.reorder();
    const closeOrder = f.events.find(e => e.kind === 'result' && e.toolUseId === 'close')!.order;
    expect(capture.messages.filter(m => m.timestamp > close.timestamp && m.timestamp < next.timestamp)).toEqual([]);
    f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled') });
    f.events.pop(); f.message(`Phase ${phaseNumber[capture.phase as Phase]} complete.`); f.current();
    expect(f.events.filter(e => e.kind === 'message').at(-1)!.order).toBeGreaterThan(closeOrder);
    expect(f.evaluate()).toEqual({ allow: true }); // Counterfactual recovery only.
    expect(capture.behaviorCredit).toBe(0);
  });

  for (const text of ['Phase 2 complete.', 'Phase 1 will be complete.', 'Phase 1 complete if the reviewer succeeds.',
    '> Phase 1 complete.', '```\nPhase 1 complete.\n```', '    Phase 1 complete.', 'Example:\nPhase 1 complete.',
    'Phase 1 is not complete.', 'Phase 1 complete with all review work finished.\nCorrection: this phase is withdrawn.']) {
    test(`does not use noncurrent publication: ${JSON.stringify(text)}`, () => {
      const f = fixture(); f.message(text); f.current(); expect(f.evaluate().allow).toBe(false);
    });
  }

  for (const mutation of ['no-close', 'partial-close', 'error-close', 'missing-ack', 'foreign-session', 'duplicate-use',
    'pre-close-publication', 'after-current-publication', 'changed-plan', 'modified-immutable-packet', 'aliased-packet', 'wrong-init',
    'failed-init', 'missing-init', 'forged-init-command', 'wrong-restore', 'pending-phase', 'ambiguous-order'] as const) {
    test(`rejects ${mutation}`, () => {
      const f = fixture(); f.message(); f.current();
      if (mutation === 'no-close') f.events.splice(4, 2);
      if (mutation === 'partial-close') (f.events[5] as any).file.numLines--;
      if (mutation === 'error-close') (f.events[5] as any).isError = true;
      if (mutation === 'missing-ack') f.events.splice(5, 1);
      if (mutation === 'foreign-session') f.events[6]!.sessionId = randomUUID();
      if (mutation === 'duplicate-use') f.events.splice(5, 0, structuredClone(f.events[4]!));
      if (mutation === 'pre-close-publication') f.events.splice(4, 0, ...f.events.splice(6, 1));
      if (mutation === 'after-current-publication') f.events.push(...f.events.splice(6, 1));
      if (mutation === 'changed-plan') fs.writeFileSync(f.active, fs.readFileSync(f.active, 'utf8').replace('Keep documented behavior.', 'Change behavior.'));
      if (mutation === 'modified-immutable-packet') {
        fs.chmodSync(f.packet.closePacketPath, 0o644);
        // Windows has no POSIX write-bit contract; preserve the rejection
        // through the actual artifact bytes instead of a no-op chmod.
        if (process.platform === 'win32') fs.appendFileSync(f.packet.closePacketPath, '\nChanged after the native Read.\n');
      }
      if (mutation === 'aliased-packet') { const alias = path.join(f.cwd, 'packet'); fs.renameSync(f.packet.closePacketPath, alias); fs.symlinkSync(alias, f.packet.closePacketPath); }
      if (mutation === 'wrong-init') (f.events[1] as any).content = JSON.stringify({ ...f.init, activePlan: f.source });
      if (mutation === 'failed-init') (f.events[1] as any).isError = true;
      if (mutation === 'missing-init') f.events.splice(0, 2);
      if (mutation === 'forged-init-command') (f.events[0] as any).input.command = `printf '${JSON.stringify(f.init)}'`;
      if (mutation === 'wrong-restore') { fs.chmodSync(f.restore, 0o600); fs.writeFileSync(f.restore, 'foreign'); fs.chmodSync(f.restore, 0o400); }
      if (mutation === 'pending-phase') f.events.splice(6, 0, { ...(f.events[7] as any), toolUseId: 'parallel' });
      f.reorder(); if (mutation === 'ambiguous-order') f.events[5]!.order = f.events[4]!.order;
      expect(f.evaluate().allow).toBe(false);
    });
  }

  test('split successful close ranges through EOF are sufficient', () => {
    const f = fixture(); f.events.splice(4, 2); f.read('part1', f.packet.closePacketPath, 1, 10);
    f.read('part2', f.packet.closePacketPath, 11); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
  });
  test('a later incomplete close supersedes the earlier complete close and publication', () => {
    const f = fixture(); f.message();
    const newer = preparePhaseClose('ceo', f.active, f.checkpoint, f.restore, f.method);
    f.read('new-close', newer.closePacketPath, 1, 1); f.current(); expect(f.evaluate().allow).toBe(false);
  });
  test('an ordinary foreign close-packet filename cannot supersede the owned phase close', () => {
    const f = fixture(), foreign = path.join(f.cwd, 'project', 'close-packet.md');
    fs.mkdirSync(path.dirname(foreign)); fs.writeFileSync(foreign, 'Ordinary project data.\n');
    f.read('unrelated', foreign); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    f.events.splice(4, 2); f.reorder();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Finish the existing Phase 1 close procedure') });
  });
  test('a malformed later packet inside the owned phase still invalidates old publication', () => {
    const f = fixture(); f.message();
    const dir = fs.mkdtempSync(path.join(f.cwd, 'autoplan-ceo-')), packet = path.join(dir, 'close-packet.md');
    fs.writeFileSync(packet, 'Malformed current packet.\n', { mode: 0o444 });
    f.read('malformed-owned', packet); f.current(); expect(f.evaluate().allow).toBe(false);
  });
  for (const outcome of ['success', 'pending', 'failed'] as const) test(`active plan mutation after close: ${outcome}`, () => {
    const f = fixture(); f.message(); f.use('late-edit', 'Edit', { file_path: f.active, old_string: 'current', new_string: 'changed' });
    if (outcome !== 'pending') f.result('late-edit', { isError: outcome === 'failed', content: outcome });
    f.current(); expect(f.evaluate().allow).toBe(outcome === 'failed');
  });
  test('a new initialization excludes earlier phase publications', () => {
    const f = fixture(); f.message();
    // Same initialized plan can be a new source, but a new external restore
    // identity is required by the actual init API. No old completion carries.
    const active = path.join(f.cwd, 'new-active.md'), restore = path.join(f.cwd, 'new-restore.md');
    const init = initializePlan(f.source, active, restore);
    f.use('new-init', 'Bash', { command: `bun "${ROOT}/bin/gstack-autoplan-snapshot.ts" init "${f.source}" "${active}" "${restore}"` });
    f.result('new-init', { content: JSON.stringify(init) });
    f.read('new-entry', path.join(ROOT, 'autoplan/sections/ceo-phase.md')); f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Finish the existing Phase 1 close procedure') });
  });
  test('cached native Read reenters the current invocation without carrying its prior publication', () => {
    const f = fixture(); f.message();
    const active = path.join(f.cwd, 'fresh-active.md'), restore = path.join(f.cwd, 'fresh-restore.md');
    const fresh = initializePlan(f.source, active, restore);
    f.add({ kind: 'end_turn' }); f.add({ kind: 'user_turn', autoplan: true });
    f.use('fresh-init', 'Bash', { command: `bun "${ROOT}/bin/gstack-autoplan-snapshot.ts" init "${f.source}" "${active}" "${restore}"` });
    f.result('fresh-init', { content: JSON.stringify(fresh) });
    const file = path.join(ROOT, 'autoplan/sections/ceo-phase.md');
    f.use('cached-entry', 'Read', { file_path: file });
    f.result('cached-entry', { content: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.', file: { filePath: file } });
    f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Finish the existing Phase 1 close procedure') });
  });

  for (const [phase, next] of [['ceo', 'design'], ['design', 'dx'], ['dx', 'eng'], ['eng', 'tasks']] as const) {
    test(`cached ${phase} entry retains that phase's publication barrier`, () => {
      const f = fixture(phase, next), priorUse: any = structuredClone(f.events[2]), priorResult: any = structuredClone(f.events[3]);
      priorUse.toolUseId = priorResult.toolUseId = 'prior-entry';
      const result: any = f.events[3];
      result.content = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';
      result.file = { filePath: priorResult.file.filePath };
      f.events.unshift(priorUse, priorResult); f.reorder(); f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining(`Publish the filled Phase ${phaseNumber[phase]}`) });
      f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    });
    test(`cached ${phase} close still needs publication after its new ACK`, () => {
      const f = fixture(phase, next); f.message();
      f.use('cache-close', 'Read', { ...(f.events[4] as any).input });
      f.result('cache-close', { content: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.', file: { filePath: f.packet.closePacketPath } });
      f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining(`Publish the filled Phase ${phaseNumber[phase]}`) });
      f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    });
  }

  test('cached incomplete close ranges never turn into a complete close', () => {
    const f = fixture(), prior: any = f.events[5], request: any = f.events[4];
    request.input.limit = 1; prior.file.content = prior.file.content.split('\n')[0]; prior.file.numLines = 1;
    f.use('cache-close', 'Read', { ...request.input });
    f.result('cache-close', { content: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.', file: { filePath: f.packet.closePacketPath } });
    f.message(); f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Read every line') });
  });

  for (const mutation of ['none', 'cache-chain', 'same-range', 'duplicate-prior-use', 'duplicate-prior-result', 'conflicting-prior-use', 'missing-prior', 'stale-body', 'missing-body', 'wrong-total', 'foreign-path', 'foreign-session', 'pending-prior', 'failed-prior', 'ambiguous-prior', 'late-prior-ACK', 'changed-offset', 'changed-limit', 'failed-cache', 'unknown-cache', 'quoted-cache', 'seeded-cache', 'extra-cache-metadata'] as const) {
    test(`native cached Read range authentication: ${mutation}`, () => {
      const f = fixture(), use: any = structuredClone(f.events[2]), result: any = structuredClone(f.events[3]);
      const content = fs.readFileSync(use.input.file_path, 'utf8');
      let prior: any[] = [use, result];
      const current: any = { ...structuredClone(use), toolUseId: 'cache', order: 10 };
      const ack: any = { kind: 'result', sessionId: f.sessionId, toolUseId: 'cache', isError: false, order: 11,
        content: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.', file: { filePath: use.input.file_path } };
      if (mutation === 'cache-chain') prior.push({ ...structuredClone(current), toolUseId: 'prior-cache', order: 5 }, { ...structuredClone(ack), toolUseId: 'prior-cache', order: 6 });
      if (mutation === 'same-range') { use.input.offset = current.input.offset = 2; use.input.limit = current.input.limit = 1; result.file.startLine = 2; result.file.numLines = 1; result.file.content = content.split('\n')[1]; }
      if (mutation === 'duplicate-prior-use') prior.push({ ...structuredClone(use), order: 4 });
      if (mutation === 'duplicate-prior-result') prior.push({ ...structuredClone(result), order: 4 });
      if (mutation === 'conflicting-prior-use') prior.push({ ...structuredClone(use), input: { file_path: use.input.file_path + '.foreign' }, order: 4 });
      if (mutation === 'missing-prior') prior = [];
      if (mutation === 'stale-body') result.file.content += 'changed';
      if (mutation === 'missing-body') delete result.file.content;
      if (mutation === 'wrong-total') result.file.totalLines++;
      if (mutation === 'foreign-path') use.input.file_path += '.foreign';
      if (mutation === 'foreign-session') use.sessionId = result.sessionId = 'foreign';
      if (mutation === 'pending-prior') prior.pop();
      if (mutation === 'failed-prior') result.isError = true;
      if (mutation === 'ambiguous-prior') prior.push({ ...result, isError: true, order: 4 });
      if (mutation === 'late-prior-ACK') result.order = 12;
      if (mutation === 'changed-offset') current.input.offset = 2;
      if (mutation === 'changed-limit') current.input.limit = 1;
      if (mutation === 'failed-cache') ack.isError = true;
      if (mutation === 'unknown-cache') delete ack.isError;
      if (mutation === 'quoted-cache') ack.content = `"${ack.content}"`;
      if (mutation === 'seeded-cache') ack.content = '<system-reminder>This file is already in your context (see "Contents" above) and has not changed on disk. Use that content instead of re-reading.</system-reminder>';
      if (mutation === 'extra-cache-metadata') ack.file.content = 'unverified';
      const range = autoplanReadRange(current, ack, content, prior);
      if (['none', 'cache-chain', 'same-range', 'duplicate-prior-use', 'duplicate-prior-result'].includes(mutation)) expect(range).toEqual(mutation === 'same-range' ? { start: 2, end: 2 } : { start: 1, end: content.split('\n').length });
      else expect(range).toBeUndefined();
    });
  }

  for (const mutation of ['missing-prior', 'stale-body', 'foreign-body', 'failed-cache', 'seeded-cache'] as const) test(`unverified cached initial entry cannot bypass the next phase: ${mutation}`, () => {
    const f = fixture(), oldUse: any = structuredClone(f.events[2]), oldResult: any = structuredClone(f.events[3]);
    oldUse.toolUseId = oldResult.toolUseId = 'old-read';
    f.events.splice(4); (f.events[3] as any).file = { filePath: oldUse.input.file_path };
    (f.events[3] as any).content = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';
    if (mutation === 'stale-body') oldResult.file.content += 'different';
    if (mutation === 'foreign-body') oldUse.input.file_path += '.foreign';
    if (mutation === 'failed-cache') (f.events[3] as any).isError = true;
    if (mutation === 'seeded-cache') (f.events[3] as any).content = '<system-reminder>This file is already in your context</system-reminder>';
    if (mutation !== 'missing-prior') f.events.unshift(oldUse, oldResult);
    f.reorder(); f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Phase 1') });
    f.input.tool_input.file_path = path.join(ROOT, 'autoplan/sections/ceo-phase.md');
    (f.events.at(-1) as any).input = f.input.tool_input;
    expect(f.evaluate()).toEqual({ allow: true });
  });

  test('an invocation with no observed phase cannot skip its initial CEO entry', () => {
    const f = fixture(); f.events.splice(2); f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Phase 1') });
  });

  for (const field of ['methodology', 'checkpoint', 'packet-phase'] as const) test(`a ${field} identity from another invocation cannot grant entry`, () => {
    const f = fixture(); f.message(); f.current();
    if (field === 'methodology') {
      const file = path.join(path.dirname(f.method), 'methodology.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.restorePath = f.source; fs.chmodSync(file, 0o644); fs.writeFileSync(file, JSON.stringify(manifest) + '\n'); fs.chmodSync(file, 0o444);
    } else if (field === 'checkpoint') {
      fs.chmodSync(f.checkpoint, 0o644); fs.writeFileSync(f.checkpoint, 'different baseline'); fs.chmodSync(f.checkpoint, 0o444);
    } else {
      const file = f.packet.closePacketPath; fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"phase":"ceo"', '"phase":"design"')); fs.chmodSync(file, 0o444);
    }
    expect(f.evaluate().allow).toBe(false);
  });
  test('same-phase and ordinary methodology reads do not require a close', () => {
    const f = fixture(); f.events.splice(4, 2); f.input.tool_input.file_path = path.join(ROOT, 'autoplan/sections/ceo-phase.md');
    f.current(); expect(f.evaluate()).toEqual({ allow: true });
    f.input.tool_input.file_path = f.method; expect(f.evaluate()).toEqual({ allow: true });
  });
  test('installed symlink identity is accepted, a different installation is denied', () => {
    const f = fixture(); f.message();
    const registry = path.join(f.cwd, 'registry'); fs.mkdirSync(registry); fs.symlinkSync(path.join(ROOT, 'autoplan'), path.join(registry, 'autoplan'));
    f.input.tool_input.file_path = path.join(registry, 'autoplan/sections/design-phase.md'); f.current(); expect(f.evaluate().allow).toBe(true);
    fs.unlinkSync(path.join(registry, 'autoplan')); fs.mkdirSync(path.join(registry, 'autoplan/sections'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'autoplan/sections/design-phase.md'), f.input.tool_input.file_path as string);
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('different or unavailable installation') });
  });
  test('an explicit child is outside parent publication authority', () => {
    const f = fixture(); f.current(); f.input.agent_id = 'reviewer-child'; expect(f.evaluate()).toEqual({ allow: true });
  });
  test('same native timestamp still uses append order for report then Read', () => {
    const f = fixture(); f.message(); f.current(); f.events.forEach(e => { e.timestamp = new Date(clock).toISOString(); });
    expect(f.evaluate()).toEqual({ allow: true });
  });
  test('a terminal turn followed by an authenticated new human request releases the old invocation', () => {
    const f = fixture(); f.add({ kind: 'end_turn' }); f.add({ kind: 'user_turn', autoplan: false }); f.current();
    expect(f.evaluate()).toEqual({ allow: true });
    (f.events[7] as any).autoplan = true; expect(f.evaluate().allow).toBe(false);
  });
  test('end_turn alone and metadata-free tool results cannot release the invocation', () => {
    const f = fixture(); f.add({ kind: 'end_turn' }); f.result('other', { content: 'continue' }); f.current();
    expect(f.evaluate().allow).toBe(false);
  });
  test('a real same-restore init re-arms without erasing an outstanding publication', () => {
    const f = fixture(); f.add({ kind: 'end_turn' }); f.add({ kind: 'user_turn', autoplan: false });
    f.use('re-init', 'Bash', (f.events[0] as any).input); f.result('re-init', { content: JSON.stringify({ ...f.init, reused: true }) });
    f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled') });
  });

  test.serial('unavailable journal polls every 50ms for the full 2000ms budget', async () => {
    const f = fixture();
    await withNativeProjectDirectory(f.cwd, () => withPublicationClock(async () => {
      const started = performance.now(), timer = jest.spyOn(globalThis, 'setTimeout');
      try {
        const output: any = await runPublicationHook(f.input, ROOT);
        expect(performance.now() - started).toBe(2_000);
        expect(timer.mock.calls.map(([, delay]) => delay)).toEqual(Array(40).fill(50));
        expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('no missing-publication conclusion');
      } finally { timer.mockRestore(); }
    }));
  });
  test.serial('the publication clock restores native timers after success and failure', async () => {
    const timeout = globalThis.setTimeout, immediate = globalThis.setImmediate, now = performance.now;
    const failure = new Error('fixture failure');
    const project = process.env.CLAUDE_PROJECT_DIR;
    for (const outcome of ['success', 'throw', 'over-budget']) {
      const pending = withNativeProjectDirectory(undefined, () => withPublicationClock(async () => {
        await new Promise(resolve => setTimeout(resolve, outcome === 'over-budget' ? 2_050 : 50));
        if (outcome === 'throw') throw failure;
        return 'settled';
      }));
      const result = await pending.then(value => value, error => error);
      if (outcome === 'throw') expect(result).toBe(failure);
      else if (outcome === 'over-budget') {
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain('did not settle within its 2000ms polling budget');
      } else expect(result).toBe('settled');
      expect(jest.isFakeTimers()).toBe(false);
      expect(globalThis.setTimeout).toBe(timeout);
      expect(globalThis.setImmediate).toBe(immediate);
      expect(performance.now).toBe(now);
      expect(process.env.CLAUDE_PROJECT_DIR).toBe(project);
    }
  });
  test.serial('the owned journal can arrive asynchronously on the last poll before the deadline', async () => {
    const f = fixture(); f.message(); f.current();
    await withNativeProjectDirectory(f.cwd, () => withPublicationClock(async () => {
      const started = performance.now();
      setTimeout(() => f.journal(), 1_950);
      expect(await runPublicationHook(f.input, ROOT)).toEqual({});
      expect(performance.now() - started).toBe(1_950);
      const decoded = readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId);
      expect(decoded.transcript.status).toBe('ready');
      expect(decoded.events.some(e => e.kind === 'use' && e.toolUseId === 'next')).toBe(true);
    }));
  });
  test('the actual owned native reader and asynchronous hook admit a flushed same-response report', async () => {
    const f = fixture(); f.message(); f.current();
    setTimeout(() => f.journal(), 100);
    expect(await runPublicationHook(f.input, ROOT)).toEqual({});
    const decoded = readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId);
    expect(decoded.transcript.status).toBe('ready');
    const report = decoded.events.find(e => e.kind === 'message')!, current = decoded.events.find(e => e.kind === 'use' && e.toolUseId === 'next')!;
    expect(report.order).toBeLessThan(current.order);
  });
  test('a native in-flight range Read uses the established phase without inventing a journal record', async () => {
    const f = fixture();
    const skill = path.join(f.cwd, 'streamed-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill));
    fs.writeFileSync(skill, '---\nname: plan-ceo-review\n---\n## Review Sections\n' +
      Array.from({ length: 1_200 }, (_, i) => `Review criterion ${i + 1}`).join('\n') + '\n');
    const method = prepareMethodology('ceo', skill, f.restore).methodologyPath;
    f.input.tool_input = { file_path: method, offset: 601, limit: 600 };
    f.journal();
    const before = readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId);
    expect(before.transcript.status).toBe('ready');
    expect(before.events.some(e => e.kind === 'use' && e.toolUseId === f.input.tool_use_id)).toBe(false);
    // Pinned Claude dispatches the native hook after the complete tool block,
    // before message_stop makes that current use available in the journal.
    expect(await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT))).toEqual({});
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId)).toEqual(before);
  });
  test('an in-flight Read can revisit an earlier established phase', async () => {
    const f = fixture('design', 'ceo'); f.journal();
    expect(await withNativeProjectDirectory(f.cwd, () => runPublicationHook(f.input, ROOT))).toEqual({});
  });
  for (const kind of ['initial-entry', 'new-phase', 'agent', 'foreign-methodology', 'duplicate',
    'foreign-session', 'orphan-current-result', 'pending-prior-entry', 'unpublished-predecessor', 'rearmed-human',
    'forged-prior-range', 'malformed-journal', 'symlinked-journal'] as const)
    test.serial(`an in-flight native Read does not bypass ${kind}`, async () => {
      const f = fixture(); f.input.tool_input = { file_path: f.method, offset: 1, limit: 1 };
      if (kind === 'initial-entry') f.events.splice(2);
      if (kind === 'new-phase') { f.message(); f.input.tool_input = { file_path: path.join(ROOT, 'autoplan/sections/design-phase.md') }; }
      if (kind === 'agent') { f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: 'You are the independent CEO reviewer for this phase.\n' }; }
      if (kind === 'foreign-methodology') f.input.tool_input = { file_path: fixture().method };
      if (kind === 'duplicate') f.events.push({ ...f.events[2]!, order: f.events.length });
      if (kind === 'orphan-current-result') f.result(f.input.tool_use_id, { content: 'Forged current acknowledgment.' });
      if (kind === 'pending-prior-entry') f.use('prior-pending', 'Read', { file_path: f.method });
      if (kind === 'forged-prior-range') for (const event of f.events)
        if (event.kind === 'result' && event.file) (event.file as { content: string }).content += '\nForged native range.';
      if (kind === 'unpublished-predecessor') {
        const later = path.join(ROOT, 'autoplan/sections/design-phase.md');
        f.read('unguarded-later-entry', later); f.input.tool_input = { file_path: later };
      }
      const { rows, record } = f.journal();
      if (kind === 'rearmed-human') {
        rows.push(record('assistant', [], { message: { role: 'assistant', content: [], stop_reason: 'end_turn' } }),
          record('user', '<command-message>autoplan</command-message>\n<command-name>/autoplan</command-name>',
            { origin: { kind: 'human' }, promptId: randomUUID() }));
        fs.writeFileSync(f.input.transcript_path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      }
      if (kind === 'malformed-journal') fs.appendFileSync(f.input.transcript_path, 'not a native JSON record\n');
      if (kind === 'symlinked-journal') {
        const target = path.join(path.dirname(f.input.transcript_path), 'aliased.jsonl');
        fs.renameSync(f.input.transcript_path, target); fs.symlinkSync(target, f.input.transcript_path);
      }
      if (kind === 'foreign-session') f.input.session_id = randomUUID();
      const output: any = await withNativeProjectDirectory(f.cwd, () => withPublicationClock(() => runPublicationHook(f.input, ROOT)));
      expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).events
        .filter(e => e.kind === 'use' && e.toolUseId === f.input.tool_use_id)).toHaveLength(0);
    });
  test('owned reader refuses a symlink and incomplete current record', async () => {
    const f = fixture(); f.message(); f.current(); f.journal();
    const bytes = fs.readFileSync(f.input.transcript_path, 'utf8'); fs.writeFileSync(f.input.transcript_path, bytes.slice(0, -1));
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).events.some(e => e.kind === 'use' && e.toolUseId === 'next')).toBe(false);
    const other = path.join(f.cwd, 'other.jsonl'); fs.renameSync(f.input.transcript_path, other); fs.symlinkSync(other, f.input.transcript_path);
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).transcript.status).toBe('error');
  });

  for (const kind of ['human', 'missing-origin', 'meta', 'tool-result', 'no-end-turn', 'compact-summary'] as const)
    test(`native lifecycle projection: ${kind}`, async () => {
      const f = fixture(), { rows, record } = f.journal();
      if (kind !== 'no-end-turn') rows.push(record('assistant', [{ type: 'text', text: 'Work ended.' }], {
        message: { role: 'assistant', id: 'msg_terminal', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Work ended.' }] },
      }));
      rows.push(record('system', undefined, { type: 'system', subtype: 'turn_duration', message: undefined }));
      const user = record('user', 'Read the driver for a new unrelated task.', {
        origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID(),
      }) as any;
      if (kind === 'missing-origin') delete user.origin;
      if (kind === 'meta') user.isMeta = true;
      if (kind === 'tool-result') { delete user.origin; user.message.content = [{ type: 'tool_result', tool_use_id: 'answer', content: 'Continue' }]; }
      if (kind === 'compact-summary') { delete user.origin; user.isMeta = true; user.message.content = 'Phase 1 complete.'; }
      rows.push(user, record('assistant', [{ type: 'tool_use', id: 'next', name: 'Read', input: f.input.tool_input }]));
      fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
      const decoded = readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId);
      expect(decoded.events.filter(e => e.kind === 'user_turn')).toHaveLength(kind === 'human' || kind === 'no-end-turn' ? 2 : 1);
      const result: any = await runPublicationHook(f.input, ROOT);
      if (kind === 'human') expect(result).toEqual({});
      else expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

  test('compaction keeps real parent ancestry; its summary supplies no publication', async () => {
    const f = fixture(), { rows, record } = f.journal();
    const prior = rows.at(-1)!;
    const boundary: any = record('system', undefined, { type: 'system', subtype: 'compact_boundary', parentUuid: null,
      logicalParentUuid: prior.uuid, message: undefined });
    rows.push(boundary, record('user', 'Phase 1 complete.', { isMeta: true }));
    const current: any = record('assistant', [{ type: 'tool_use', id: 'next', name: 'Read', input: f.input.tool_input }]);
    rows.push(current); fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    const before: any = await runPublicationHook(f.input, ROOT); expect(before.hookSpecificOutput?.permissionDecision).toBe('deny');
    // A real publication follows the retained close ACK, even with compaction.
    const message: any = { ...current, uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'Phase 1 complete.' }] } };
    current.parentUuid = message.uuid; rows.splice(-1, 0, message);
    fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(await runPublicationHook(f.input, ROOT)).toEqual({});
    boundary.logicalParentUuid = randomUUID();
    fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).events.some(e => e.kind === 'use' && e.toolUseId === 'next')).toBe(false);
  });
});


describe('Autoplan authenticated phase consumption', () => {
  function nextSnapshot(f: ReturnType<typeof fixture>) {
    const dir = path.join(f.cwd, 'next-skill'); fs.mkdirSync(dir);
    const skill = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skill, '---\nname: plan-eng-review\n---\n## Review Sections\nApply every engineering criterion.\n');
    const method = prepareMethodology('eng', skill, f.restore).methodologyPath;
    return { method, snapshot: createSnapshot('eng', f.active, f.restore, method) };
  }
  test('captured complete Bash driver delivery preserves the original earliest DX omission', () => {
    const request = consumption.events.find(e => e.kind === 'use' && e.name === 'Bash')!;
    const pair = consumption.events.filter(e => e.toolUseId === request.toolUseId);
    const transcript = { status: 'ready' as const, calls: [], assistantMessages: consumption.messages };
    expect(prematureAutoplanPhaseEntry(pair as any, transcript, [{ phase: 'eng', requiredPhase: 2.5,
      paths: [path.join(ROOT, 'autoplan/sections/eng-phase.md')], content: consumption.driverContent }], 0))
      .toMatchObject({ readToolUseId: request.toolUseId, requiredPhase: 2.5 });
  });
  test('an owned next methodology Read cannot bypass the missing current parent publication', () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    f.input.tool_input = { file_path: next.method }; f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
  });
  test('an exact next native Agent dispatch cannot bypass the missing current parent publication', () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: next.snapshot.nativeDispatchPrompt };
    f.use('next', 'Agent', f.input.tool_input);
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
  });
  const nextInput = (f: ReturnType<typeof fixture>, file: string) => { f.input.tool_input = { file_path: file }; f.current(); };
  function target(f: ReturnType<typeof fixture>, kind: string) {
    const n = nextSnapshot(f);
    return kind === 'methodology' ? n.method : kind === 'methodology.json' ? path.join(path.dirname(n.method), kind) :
      path.join(path.dirname(n.snapshot.snapshotPath), kind === 'implementation' ? 'eng-implementation.md' : kind);
  }
  for (const kind of ['methodology', 'methodology.json', 'native-prompt.md', 'snapshot.json', 'source-implementation.md', 'implementation']) {
    test(`owned ${kind} consumption needs close and publication, then permits recovery`, () => {
      const f = fixture('dx', 'eng'), file = target(f, kind);
      const close = f.events.splice(4, 2); f.reorder(); nextInput(f, file);
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Finish the existing Phase 2.5 close') });
      f.events.pop(); f.events.push(...close); f.reorder(); f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
      f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    });
  }
  test('actual captured parent wording does not publish DX or become tool-output credit', () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    for (const message of consumption.messages) f.message(message.text);
    f.use('print-report', 'Bash', { command: 'print-report' }); f.result('print-report', { content: 'Phase 2.5 complete.' });
    nextInput(f, next.method);
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
  });
  for (const by of ['methodology', 'snapshot', 'close', 'Agent'] as const) test(`an owned ${by} delivery infers the actual phase without a driver Read`, () => {
    const f = fixture('dx', 'eng'); f.events.splice(2, 2); f.reorder();
    if (by !== 'close') {
      const prior = f.events.splice(2);
      if (by === 'Agent') {
        const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(f.checkpoint), 'snapshot.json'), 'utf8'));
        f.use('native-dx', 'Agent', { prompt: manifest.nativeDispatchPrompt }); f.result('native-dx', { content: 'Native reviewer launched.' });
      } else f.read('owned-entry', by === 'methodology' ? f.method : path.join(path.dirname(f.checkpoint), 'snapshot.json'));
      f.events.push(...prior); f.reorder();
    }
    f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
    f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
  });
  test('an already delivered unguarded future methodology does not erase the unpublished predecessor', () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f); f.read('unguarded-future', next.method);
    f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: next.snapshot.nativeDispatchPrompt }; f.use('next', 'Agent', f.input.tool_input);
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
    f.events.pop(); f.message(); f.use('next', 'Agent', f.input.tool_input); expect(f.evaluate()).toEqual({ allow: true });
  });
  for (const kind of ['pending', 'error', 'foreign-session', 'incomplete'] as const) test(`${kind} future delivery cannot advance phase state`, () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f); f.read('future', next.method);
    const ack = f.events.at(-1)! as any;
    if (kind === 'pending') f.events.pop();
    if (kind === 'error') ack.isError = true;
    if (kind === 'foreign-session') ack.sessionId = 'foreign';
    if (kind === 'incomplete') ack.file.content += 'not-delivered';
    f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: next.snapshot.nativeDispatchPrompt }; f.use('next', 'Agent', f.input.tool_input);
    expect(f.evaluate().allow).toBe(false);
  });
  for (const invalid of ['denied-Agent', 'failed-Read', 'malformed-close'] as const) test(`${invalid} cannot poison same-phase repair`, () => {
    const f = fixture('dx', 'eng');
    if (invalid === 'denied-Agent') { f.use('bad', 'Agent', { prompt: 'You are the independent ENG reviewer for this phase.\nRead file: "/foreign/native-prompt.md"' }); f.result('bad', { isError: true }); }
    if (invalid === 'failed-Read') { f.use('bad', 'Read', { file_path: path.join(f.cwd, 'autoplan-eng-foreign', 'methodology.md') }); f.result('bad', { isError: true }); }
    if (invalid === 'malformed-close') {
      const d = fs.mkdtempSync(path.join(f.cwd, 'autoplan-dx-')), file = path.join(d, 'close-packet.md');
      fs.writeFileSync(file, 'Malformed owned close.\n', { mode: 0o444 }); f.read('bad', file);
    }
    nextInput(f, f.method); expect(f.evaluate()).toEqual({ allow: true });
    f.events.pop(); f.input.tool_input = { file_path: path.join(ROOT, 'autoplan/sections/eng-phase.md') }; f.current();
    expect(f.evaluate().allow).toBe(false);
    f.events.pop(); const repaired = preparePhaseClose('dx', f.active, f.checkpoint, f.restore, f.method);
    f.read('repaired-close', repaired.closePacketPath); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
  });
  for (const invalid of ['foreign-root', 'foreign-restore', 'foreign-active', 'mutable', 'aliased', 'wrong-native', 'partial-prompt'] as const) test(`${invalid} current phase consumption remains denied`, () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f); f.message();
    if (invalid === 'foreign-root') { nextInput(f, path.join(f.cwd, 'foreign', 'autoplan-eng-methodology-data', 'methodology.md')); }
    else if (invalid === 'partial-prompt' || invalid === 'wrong-native') {
      f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: next.snapshot.nativeDispatchPrompt + (invalid === 'partial-prompt' ? '\nChanged' : '') };
      if (invalid === 'wrong-native') { fs.chmodSync(next.snapshot.nativePromptPath, 0o644); fs.appendFileSync(next.snapshot.nativePromptPath, 'Changed'); fs.chmodSync(next.snapshot.nativePromptPath, 0o444); }
      f.use('next', 'Agent', f.input.tool_input);
    } else {
      const manifest = path.join(path.dirname(next.method), 'methodology.json');
      if (invalid === 'foreign-restore') { const x = JSON.parse(fs.readFileSync(manifest, 'utf8')); x.restorePath = f.source; fs.chmodSync(manifest, 0o644); fs.writeFileSync(manifest, JSON.stringify(x)); fs.chmodSync(manifest, 0o444); }
      if (invalid === 'foreign-active') { const file = path.join(path.dirname(next.snapshot.snapshotPath), 'snapshot.json'); const x = JSON.parse(fs.readFileSync(file, 'utf8')); x.activePlan = f.source; fs.chmodSync(file, 0o644); fs.writeFileSync(file, JSON.stringify(x)); fs.chmodSync(file, 0o444); }
      if (invalid === 'mutable') {
        fs.chmodSync(next.method, 0o644);
        // The manifest hash remains mandatory on Windows, where mode bits do not.
        if (process.platform === 'win32') fs.appendFileSync(next.method, '\nChanged after methodology preparation.\n');
      }
      if (invalid === 'aliased') { const file = next.method + '.saved'; fs.renameSync(next.method, file); fs.symlinkSync(file, next.method); }
      nextInput(f, invalid === 'foreign-active' ? next.snapshot.nativePromptPath : next.method);
    }
    expect(f.evaluate().allow).toBe(false);
  });
  test('captured report-only Edit preserves implementation and accepted records, but still needs publication', () => {
    const f = fixture('dx', 'eng'), edit = consumption.events.find(e => e.kind === 'use' && e.name === 'Edit')!.input as any;
    fs.appendFileSync(f.active, edit.old_string + '\n');
    f.use('report-edit', 'Edit', { ...edit, file_path: f.active });
    fs.writeFileSync(f.active, fs.readFileSync(f.active, 'utf8').replace(edit.old_string, edit.new_string));
    f.result('report-edit', { content: 'File updated.' }); f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
    f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
  });
  for (const change of ['accepted-None', 'accepted-unapplied', 'implementation', 'ambiguous-new', 'replace-all', 'missing-input', 'Write', 'pending-Edit', 'unknown-result'] as const) test(`post-close ${change} requires a new verified close`, () => {
    const f = fixture(); f.message();
    let old = 'None: retain the current behavior.', next = 'None: silently changed decision.';
    if (change === 'implementation') { old = 'Keep documented behavior.'; next = 'Implement new behavior.'; }
    if (change === 'accepted-unapplied') next = '- Add a new capability.\n';
    if (change === 'ambiguous-new') next = 'Review record';
    const input: any = { file_path: f.active, old_string: old, new_string: next };
    if (change === 'replace-all') input.replace_all = true;
    if (change === 'missing-input') delete input.old_string;
    if (change === 'Write') { delete input.old_string; delete input.new_string; input.content = fs.readFileSync(f.active, 'utf8'); }
    f.use('mutation', change === 'Write' ? 'Write' : 'Edit', input);
    if (change !== 'Write' && change !== 'pending-Edit') fs.writeFileSync(f.active, fs.readFileSync(f.active, 'utf8').replace(old, next));
    if (change !== 'pending-Edit') f.result('mutation', { ...(change === 'unknown-result' ? { isError: undefined } : {}), content: 'Updated.' });
    f.current(); expect(f.evaluate().allow).toBe(false);
  });
  test('multiple exact report-only Edits replay in reverse native order', () => {
    const f = fixture(); fs.appendFileSync(f.active, 'Original report note.\n');
    for (const [i, old, next] of [[1, 'Original report note.', 'Revised report note.'], [2, 'Revised report note.', 'Final report note.']] as const) {
      f.use(`edit-${i}`, 'Edit', { file_path: f.active, old_string: old, new_string: next });
      fs.writeFileSync(f.active, fs.readFileSync(f.active, 'utf8').replace(old, next)); f.result(`edit-${i}`, { content: 'Updated.' });
    }
    f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
  });
  test('ordinary repair tools, same-phase artifacts and unrelated child Agents remain available', () => {
    const f = fixture('dx', 'eng'); fs.writeFileSync(f.active, fs.readFileSync(f.active, 'utf8').replace('Keep documented behavior.', 'Repair current behavior.'));
    nextInput(f, f.method); expect(f.evaluate()).toEqual({ allow: true });
    f.input.tool_name = 'Bash'; f.input.tool_input = { command: 'current-phase repair' }; expect(f.evaluate()).toEqual({ allow: true });
    f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: 'Investigate this current-phase prerequisite.' }; expect(f.evaluate()).toEqual({ allow: true });
  });
  test('rearm excludes disarmed future Reads and still requires the original outstanding publication', () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    f.add({ kind: 'end_turn' }); f.add({ kind: 'user_turn', autoplan: false });
    f.read('unrelated-future', next.method);
    f.use('re-init', 'Bash', (f.events[0] as any).input); f.result('re-init', { content: JSON.stringify({ ...f.init, reused: true }) });
    nextInput(f, next.method); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled Phase 2.5') });
  });
  test('bound future native dispatch reaches the actual asynchronous hook reader', async () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    f.input.tool_name = 'Agent'; f.input.tool_input = { prompt: next.snapshot.nativeDispatchPrompt }; f.use('next', 'Agent', f.input.tool_input); f.journal();
    expect(await runPublicationHook(f.input, ROOT)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    f.events.pop(); f.message(); f.use('next', 'Agent', f.input.tool_input); f.journal();
    expect(await runPublicationHook(f.input, ROOT)).toEqual({});
  });

  function audit(f: ReturnType<typeof fixture>) {
    return prematureAutoplanPhaseEntry(f.events.filter(e => e.kind === 'use' || e.kind === 'result') as any,
      { status: 'ready', calls: [], assistantMessages: f.events.filter(e => e.kind === 'message') as any },
      [{ phase: 'eng', requiredPhase: 2.5, paths: [path.join(ROOT, 'autoplan/sections/eng-phase.md')],
        content: fs.readFileSync(path.join(ROOT, 'autoplan/sections/eng-phase.md'), 'utf8') }], 0);
  }
  test('Bash terminal whitespace transport preserves complete driver delivery', () => {
    const f = fixture('dx', 'eng');
    const file = path.join(ROOT, 'autoplan/sections/eng-phase.md');
    f.use('native-cat', 'Bash', { command: `cat "${file}"` });
    f.result('native-cat', { content: fs.readFileSync(file, 'utf8').trimEnd() });
    expect(audit(f)).toMatchObject({ phase: 'eng', readToolUseId: 'native-cat' });
  });

  for (const ending of ['', '\n', '\r\n', ' \t\r\n', '\n\n\n']) test(`complete Bash driver accepts only terminal whitespace normalization: ${JSON.stringify(ending)}`, () => {
    const f = fixture('dx', 'eng'), content = fs.readFileSync(path.join(ROOT, 'autoplan/sections/eng-phase.md'), 'utf8');
    f.use('transport', 'Bash', { command: 'opaque-native-driver-loader' });
    f.result('transport', { content: content.trimEnd() + ending });
    expect(audit(f)).toMatchObject({ readToolUseId: 'transport' });
    f.message(); expect(audit(f)).toMatchObject({ readToolUseId: 'transport' });
  });
  for (const change of ['missing-first', 'missing-last', 'internal-space', 'leading-space', 'same-line-prefix', 'same-line-suffix'] as const) test(`meaningful Bash driver content remains strict: ${change}`, () => {
    const f = fixture('dx', 'eng'), original = fs.readFileSync(path.join(ROOT, 'autoplan/sections/eng-phase.md'), 'utf8').trimEnd();
    const text = change === 'missing-first' ? original.slice(1) : change === 'missing-last' ? original.slice(0, -1) :
      change === 'internal-space' ? original.replace('Read ', 'Read  ') : change === 'leading-space' ? ' ' + original :
      change === 'same-line-prefix' ? 'PREFIX' + original : original + 'SUFFIX';
    expect(text).not.toBe(original);
    f.use('invalid-transport', 'Bash', { command: 'opaque-loader' }); f.result('invalid-transport', { content: text });
    expect(audit(f)).toBeNull();
  });
  test('cached future driver delivery is visible to the detector at the current native request', () => {
    const f = fixture('dx', 'eng'), file = path.join(ROOT, 'autoplan/sections/eng-phase.md');
    f.read('earlier-body', file);
    const prior = f.events.splice(-2); f.events.unshift(...prior); f.reorder();
    // Earlier body predates this audit window. The new native cache ACK is the
    // current entry; an eventual report does not erase that earlier violation.
    prior.forEach(e => { e.timestamp = new Date(clock - 100).toISOString(); });
    f.use('cached-future', 'Read', { file_path: file, offset: 1 });
    f.result('cached-future', { content: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.', file: { filePath: file } });
    const detect = () => prematureAutoplanPhaseEntry(f.events.filter(e => e.kind === 'use' || e.kind === 'result') as any,
      { status: 'ready', calls: [], assistantMessages: f.events.filter(e => e.kind === 'message') as any },
      [{ phase: 'eng', requiredPhase: 2.5, paths: [file], content: fs.readFileSync(file, 'utf8') }], clock);
    expect(detect()).toMatchObject({ readToolUseId: 'cached-future' });
    f.message(); expect(detect()).toMatchObject({ readToolUseId: 'cached-future' });
  });

  for (const kind of ['Read', 'Agent'] as const) test(`the actual detector authenticates ${kind} phase consumption through the current snapshot APIs`, () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    if (kind === 'Read') f.read('eng-consumer', next.method, 2, 1);
    else { f.use('eng-consumer', 'Agent', { prompt: next.snapshot.nativeDispatchPrompt }); f.result('eng-consumer', { content: 'Native child launched.' }); }
    expect(audit(f)).toMatchObject({ phase: 'eng', requiredPhase: 2.5, readToolUseId: 'eng-consumer' });
    f.message();
    expect(audit(f)).toMatchObject({ readToolUseId: 'eng-consumer', reportAt: f.events.at(-1)!.timestamp });
    const message = f.events.pop()!; message.timestamp = new Date(clock - 1).toISOString(); f.events.unshift(message);
    expect(audit(f)).toBeNull();
  });
  for (const mutation of ['missing-result', 'error', 'foreign-session', 'bad-content', 'wrong-restore', 'wrong-active', 'wrong-prompt', 'conflicting-result'] as const) test(`detector ${mutation} supplies no authenticated consumption`, () => {
    const f = fixture('dx', 'eng'), next = nextSnapshot(f);
    const agent = ['wrong-active', 'wrong-prompt'].includes(mutation);
    if (agent) { f.use('consumer', 'Agent', { prompt: next.snapshot.nativeDispatchPrompt + (mutation === 'wrong-prompt' ? '\nForeign change.' : '') }); f.result('consumer', { content: 'Launched.' }); }
    else f.read('consumer', next.method);
    const result = f.events.at(-1)! as any;
    if (mutation === 'missing-result') f.events.pop();
    if (mutation === 'error') result.isError = true;
    if (mutation === 'foreign-session') result.sessionId = 'foreign';
    if (mutation === 'bad-content') result.file.content += 'Changed.';
    if (mutation === 'conflicting-result') f.add({ ...result, isError: true });
    if (mutation === 'wrong-restore' || mutation === 'wrong-active') {
      const file = mutation === 'wrong-restore' ? path.join(path.dirname(next.method), 'methodology.json') : path.join(path.dirname(next.snapshot.snapshotPath), 'snapshot.json');
      const m = JSON.parse(fs.readFileSync(file, 'utf8')); m[mutation === 'wrong-restore' ? 'restorePath' : 'activePlan'] = f.source;
      fs.chmodSync(file, 0o644); fs.writeFileSync(file, JSON.stringify(m)); fs.chmodSync(file, 0o444);
    }
    expect(audit(f)).toBeNull();
  });
  for (const mode of ['literal-command', 'opaque-command', 'text-block', 'late-report', 'partial', 'changed', 'error', 'foreign-session', 'backward-result', 'conflicting-result', 'quoted-report', 'earlier-report'] as const) test(`captured Bash driver delivery: ${mode}`, () => {
    const request = structuredClone(consumption.events.find(e => e.kind === 'use' && e.name === 'Bash')!) as any;
    const result = structuredClone(consumption.events.find(e => e.kind === 'result' && e.toolUseId === request.toolUseId)!) as any;
    const transcript: any = { status: 'ready', calls: [], assistantMessages: structuredClone(consumption.messages) };
    if (mode === 'opaque-command') request.input.command = 'run-current-script';
    if (mode === 'text-block') result.content = [{ type: 'text', text: result.content }];
    if (mode === 'partial') result.content = result.content.replace(consumption.driverContent, consumption.driverContent.slice(1));
    if (mode === 'changed') result.content = result.content.replace(consumption.driverContent, consumption.driverContent.replace('Phase 3', 'Phase 9'));
    if (mode === 'error') result.isError = true;
    if (mode === 'foreign-session') result.sessionId = 'foreign';
    if (mode === 'backward-result') result.timestamp = new Date(Date.parse(request.timestamp) - 1).toISOString();
    if (['late-report', 'quoted-report', 'earlier-report'].includes(mode)) transcript.assistantMessages.push({ sessionId: request.sessionId,
      timestamp: new Date(Date.parse(request.timestamp) + (mode === 'late-report' ? 1 : -1)).toISOString(),
      text: mode === 'quoted-report' ? '```\nPhase 2.5 complete.\n```' : 'Phase 2.5 complete.' });
    const events = [request, result]; if (mode === 'conflicting-result') events.push({ ...result, isError: true });
    const detected = prematureAutoplanPhaseEntry(events, transcript, [{ phase: 'eng', requiredPhase: 2.5,
      paths: [path.join(ROOT, 'autoplan/sections/eng-phase.md')], content: consumption.driverContent }], 0);
    const expected = ['literal-command', 'opaque-command', 'text-block', 'late-report', 'quoted-report'].includes(mode);
    expect(detected !== null).toBe(expected);
    if (expected) expect(detected!.readToolUseId).toBe(request.toolUseId);
  });

});
