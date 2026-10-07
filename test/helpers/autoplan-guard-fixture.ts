/**
 * Replay fixtures for the /autoplan publication guard: one real invocation's
 * artifacts plus a Claude-shaped journal whose records carry messageIds, so a
 * test can cut the journal where Claude Code had flushed it at hook time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializePlan, prepareMethodology, createSnapshot, preparePhaseClose } from '../../bin/gstack-autoplan-snapshot';
import { runPublicationHook, type PublicationHookInput } from '../../autoplan/bin/phase-publication-hook.ts';

export const ROOT = fs.realpathSync(path.join(import.meta.dir, '..', '..'));
export const PHASE_NUMBER = { ceo: 1, design: 2, dx: 2.5, eng: 3 } as const;
export type Phase = keyof typeof PHASE_NUMBER;
export const section = (name: string) => path.join(ROOT, 'autoplan', 'sections', name);

type Record_ = Record<string, any>;
export interface Step {
  kind: 'use' | 'result' | 'message' | 'end_turn' | 'typed' | 'notification';
  id?: string; name?: string; input?: Record<string, unknown>; text?: string; content?: unknown;
  file?: unknown; isError?: boolean; async?: boolean; messageId?: string;
}

/** A completed Phase `phase` (init, entry, close packet Read) with a reviewer snapshot for `phase`. */
/** `opening: 'skill'` starts the run from a typed request and a Skill tool call instead of the /autoplan slash turn. */
export function guardFixture(phase: Phase = 'ceo', opts: { methodologyLines?: number; version?: string; opening?: 'slash' | 'skill' } = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'autoplan-guard-replay-')));
  const source = path.join(cwd, 'source.md'), active = path.join(cwd, 'active.md'), restore = path.join(cwd, 'restore.md');
  fs.writeFileSync(source, '# Current plan\nKeep documented behavior.\n');
  const init = initializePlan(source, active, restore);
  const skill = path.join(cwd, 'SKILL.md');
  fs.writeFileSync(skill, `---\nname: plan-${phase === 'dx' ? 'devex' : phase}-review\n---\n## Review Sections\n` +
    Array.from({ length: opts.methodologyLines ?? 1 }, (_, i) => `Apply review criterion ${i + 1}.`).join('\n') + '\n');
  const method = prepareMethodology(phase, skill, restore).methodologyPath;
  const snapshot = createSnapshot(phase, active, restore, method);
  fs.appendFileSync(active, `<!-- autoplan-accepted:${phase} -->\nNone: retain the current behavior.\n<!-- /autoplan-accepted:${phase} -->\n`);
  const packet = preparePhaseClose(phase, active, snapshot.snapshotPath, restore, method);
  const sessionId = randomUUID(), steps: Step[] = [];
  const transcript = path.join(cwd, 'config', 'projects', 'fixture', `${sessionId}.jsonl`);
  const stateRoot = path.join(cwd, 'state');
  let message = 0;
  const nextMessage = () => `msg_fixture${++message}`;
  const add = (step: Step) => { steps.push(step); return step; };
  const use = (id: string, name: string, input: Record<string, unknown>, messageId = nextMessage()) =>
    add({ kind: 'use', id, name, input, messageId });
  const result = (id: string, extra: Partial<Step> = {}) => add({ kind: 'result', id, isError: false, ...extra });
  const readResult = (id: string, file: string, offset = 1, limit?: number) => {
    const lines = fs.readFileSync(fs.realpathSync(file), 'utf8').split('\n');
    const count = Math.min(limit ?? lines.length, lines.length - offset + 1);
    return result(id, { file: { filePath: file, content: lines.slice(offset - 1, offset - 1 + count).join('\n'),
      startLine: offset, numLines: count, totalLines: lines.length } });
  };
  const readInput = (file: string, offset = 1, limit?: number) => ({ file_path: file, offset, ...(limit === undefined ? {} : { limit }) });
  const read = (id: string, file: string, offset = 1, limit?: number, messageId?: string) => {
    use(id, 'Read', readInput(file, offset, limit), messageId); readResult(id, file, offset, limit);
  };
  const say = (text: string, messageId = nextMessage()) => add({ kind: 'message', text, messageId });
  const report = (messageId?: string) => say(`**Phase ${PHASE_NUMBER[phase]} complete.**`, messageId);
  /** Phase-close step 6: the report and the no-op in their own message, then the no-op's result. */
  const publish = () => {
    const messageId = nextMessage();
    report(messageId); use(`noop-${messageId}`, 'Bash', { command: `true autoplan-published ${phase}` }, messageId);
    result(`noop-${messageId}`, { content: '' });
  };

  use('init', 'Bash', { command: `cd '${cwd}'\nbun "${ROOT}/bin/gstack-autoplan-snapshot.ts" init \\\n "${source}" "${active}" "${restore}"` });
  result('init', { content: JSON.stringify(init) });
  read('entry', section(`${phase}-phase.md`));
  read('close', packet.closePacketPath);

  const input = (id: string, name: string, toolInput: Record<string, unknown>): PublicationHookInput => ({
    hook_event_name: 'PreToolUse', session_id: sessionId, cwd, transcript_path: transcript,
    tool_name: name, tool_use_id: id, tool_input: toolInput });

  /**
   * Write the journal for steps[0, upto), streaming rows to the file. `pad(at)`
   * adds Claude-shaped records before the /autoplan turn (`at` -1) and after
   * step `at`, for bound tests and the journal-read benchmark.
   */
  function journal(upto = steps.length, pad?: (at: number) => Array<{ type: string; message?: Record_; extra?: Record_ }>) {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    let parent: string | null = null, clock = Date.parse('2026-10-07T09:04:00Z');
    const record = (type: string, message: Record_, extra: Record_ = {}) => {
      const uuid = randomUUID(); const r = { uuid, parentUuid: parent, cwd, sessionId, isSidechain: false,
        version: opts.version ?? '2.1.292', timestamp: new Date(clock += 100).toISOString(), type, message, ...extra };
      parent = uuid; return r;
    };
    const assistant = (messageId: string | undefined, content: unknown[], extra: Record_ = {}) =>
      record('assistant', { role: 'assistant', ...(messageId ? { id: messageId } : {}), content, ...extra });
    const fd = fs.openSync(transcript, 'w');
    const rows = { push: (...items: Record_[]) => { fs.writeSync(fd, items.map(r => JSON.stringify(r) + '\n').join('')); } };
    const padding = (at: number) => { for (const r of pad?.(at) ?? []) rows.push(record(r.type, r.message as Record_, r.extra)); };
    padding(-1);
    if (opts.opening === 'skill') {
      rows.push(record('user', { role: 'user', content: 'Run autoplan on the current plan.' }, { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() }));
      rows.push(assistant(nextMessage(), [{ type: 'tool_use', id: 'skill-autoplan', name: 'Skill', input: { skill: 'autoplan' } }]));
      rows.push(record('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'skill-autoplan', content: 'Launching skill: autoplan' }] }));
    } else rows.push(record('user', { role: 'user', content: '<command-message>autoplan</command-message>\n<command-name>/autoplan</command-name>' },
      { origin: { kind: 'human' }, promptId: randomUUID() }));
    for (const [at, s] of steps.slice(0, upto).entries()) {
      if (s.kind === 'use') rows.push(assistant(s.messageId, [{ type: 'tool_use', id: s.id, name: s.name, input: s.input }]));
      else if (s.kind === 'message') rows.push(assistant(s.messageId, [{ type: 'text', text: s.text }]));
      else if (s.kind === 'end_turn') rows.push(assistant(s.messageId, [], { stop_reason: 'end_turn' }));
      else if (s.kind === 'result') rows.push(record('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: s.id,
        content: s.content ?? 'Read complete.', is_error: s.isError }] }, { toolUseResult: { ...(s.file ? { file: s.file } : {}),
        ...(s.async ? { isAsync: true, status: 'async_launched' } : {}) } }));
      else if (s.kind === 'typed') rows.push(record('user', { role: 'user', content: s.text }, { origin: { kind: 'human' },
        promptSource: 'typed', promptId: randomUUID() }));
      else if (s.kind === 'notification') rows.push(record('user', { role: 'user', content:
        `<task-notification>\n<tool-use-id>${s.id}</tool-use-id>\n<status>completed</status>\n<result>Review done.</result>\n</task-notification>` },
        { origin: { kind: 'task-notification' }, promptSource: 'system', promptId: randomUUID() }));
      padding(at);
    }
    fs.closeSync(fd);
  }

  /** Run the hook in-process against the journal as written, with an owned state root for the guard log. */
  async function hook(value: PublicationHookInput): Promise<any> {
    const prior = { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, GSTACK_STATE_ROOT: process.env.GSTACK_STATE_ROOT };
    process.env.CLAUDE_PROJECT_DIR = cwd; process.env.GSTACK_STATE_ROOT = stateRoot;
    try { return await runPublicationHook(value, ROOT); }
    finally { for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const log = (): Record_[] => {
    const file = path.join(stateRoot, 'analytics', 'autoplan-guard.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return { cwd, active, restore, method, snapshot, packet, sessionId, steps, transcript, stateRoot, add, use, result, read,
    readInput, readResult, say, report, publish, nextMessage, input, journal, hook, log, cleanup };
}

export type GuardFixture = ReturnType<typeof guardFixture>;
export const denial = (output: any): string | undefined => output?.hookSpecificOutput?.permissionDecision === 'deny'
  ? output.hookSpecificOutput.permissionDecisionReason : undefined;
export const codeOf = (output: any): string | undefined =>
  /\(code ([a-z_:A-Z0-9-]+),/.exec(denial(output) ?? output?.systemMessage ?? '')?.[1];
