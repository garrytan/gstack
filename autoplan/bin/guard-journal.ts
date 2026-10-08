/**
 * What the publication guard reads of its parent journal (CEO-2, ENG-4, ENG-5).
 * The bounded reader's index keeps every owned record's events without content.
 * This policy reloads in full only what the evaluation reads: every literal
 * init and its result, the current call, and inside the invocation window
 * (from the latest human turn at or before the bound invocation chain's first
 * init) the results of guarded and close-packet Reads, structured Bash results,
 * error results, assistant text after the first close-packet Read and
 * mutations of the active plan; plus the earlier Read a dedup reply cites,
 * even before the window.
 */
import { readOwnedClaudePublicTranscript, type IndexedRecord, type JournalPrefix, type OwnedRead,
  type OwnedReadMeasure } from '../../lib/claude-owned-journal';
import { object, sameNativePath, type ClaudeParentPublicEvent, type NativePublicToolEvent } from '../../lib/claude-journal-records';

type Event = ClaudeParentPublicEvent;
type Use = NativePublicToolEvent & { order: number };
/** Claude Code's reply to a Read of an unchanged file it already returned in full. */
export const DEDUP_REPLY = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';
/** The longest Read input or Bash command the index keeps; a literal init is far shorter. */
const INDEX_INPUT_MAX = 4096;

export function textResult(event: Event): string | undefined {
  if (event.kind !== 'result' || event.isError !== false) return;
  if (typeof event.content === 'string') return event.content;
  if (Array.isArray(event.content) && event.content.length === 1 && event.content[0]?.type === 'text' &&
      typeof event.content[0].text === 'string') return event.content[0].text;
}

/** The hook's own classifiers, passed in so this policy and the evaluation cannot disagree. */
export interface GuardJournalTests {
  /** A literal snapshot init's [source, active, restore], or undefined. */
  init(command: unknown): string[] | undefined;
  /** A phase driver or artifact Read ('phase'), a close-packet Read ('close'), or neither. */
  read(file: unknown): 'phase' | 'close' | undefined;
  reviewer(input: Record<string, unknown>): boolean;
}

function indexInput(tests: GuardJournalTests) {
  return (name: string, input: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (name === 'Read') return JSON.stringify(input).length <= INDEX_INPUT_MAX ? input : undefined;
    if (name === 'Bash') return typeof input.command === 'string' && input.command.length <= INDEX_INPUT_MAX ? { command: input.command } : undefined;
    if (name === 'Agent') return tests.reviewer(input) ? input : undefined;
    if (name === 'Write' || name === 'Edit')
      return typeof input.file_path === 'string' && input.file_path.length <= INDEX_INPUT_MAX ? { file_path: input.file_path } : undefined;
  };
}

function select(tests: GuardJournalTests, currentToolUseId: string) {
  return (records: readonly IndexedRecord[], load: (records: readonly IndexedRecord[]) => void) => {
    const useOf = new Map<string, { use: Use; record: IndexedRecord }>(), resultsOf = new Map<string, IndexedRecord[]>();
    const reads: Array<{ use: Use; record: IndexedRecord }> = [], inits: Array<{ use: Use; record: number; args: string[] }> = [];
    records.forEach((record, at) => {
      for (const e of record.events) {
        if (e.kind === 'use') {
          const use = e as Use;
          if (!useOf.has(use.toolUseId)) useOf.set(use.toolUseId, { use, record });
          if (use.name === 'Read') reads.push({ use, record });
          const args = use.name === 'Bash' ? tests.init(use.input?.command) : undefined;
          if (args) inits.push({ use, record: at, args });
        } else if (e.kind === 'result') { const list = resultsOf.get(e.toolUseId) ?? []; list.push(record); resultsOf.set(e.toolUseId, list); }
      }
    });
    const withResults = (id: string) => [...(useOf.has(id) ? [useOf.get(id)!.record] : []), ...resultsOf.get(id) ?? []];
    // invocation() binds and checks every literal init, so all of them load, window or not.
    load(inits.flatMap(init => resultsOf.get(init.use.toolUseId) ?? []));
    let bound: Record<string, any> | undefined, chainStart: number | undefined;
    for (const init of inits) {
      const replies = (resultsOf.get(init.use.toolUseId) ?? []).flatMap(r => r.events)
        .filter(e => e.kind === 'result' && e.toolUseId === init.use.toolUseId && e.order > init.use.order);
      let reply: unknown;
      try { reply = replies.length === 1 ? JSON.parse(textResult(replies[0]!) ?? 'null') : undefined; } catch { reply = undefined; }
      // A reused:true init keeps the earlier binding, as invocation() does.
      if (object(reply) && reply.reused === true && bound && bound.activePlan === reply.activePlan &&
          bound.restorePath === reply.restorePath) continue;
      chainStart = init.record; bound = object(reply) ? reply : undefined;
    }
    let start = 0;
    for (let i = chainStart ?? records.length - 1; i >= 0; i--)
      if (records[i]!.events.some(e => e.kind === 'user_turn')) { start = i; break; }
    const activePlans = inits.filter(init => init.record >= start).map(init => init.args[1]);
    const wanted = new Set<IndexedRecord>(withResults(currentToolUseId));
    let afterClose = false;
    for (const record of records.slice(start)) for (const e of record.events) {
      if (e.kind === 'use' && e.name === 'Read' && tests.read(e.input?.file_path) === 'close') afterClose = true;
      if (e.kind === 'message' && afterClose) wanted.add(record);
      if (e.kind === 'use' && (e.name === 'Write' || e.name === 'Edit') && activePlans.some(plan => sameNativePath(plan, e.input?.file_path)))
        wanted.add(record);
      if (e.kind !== 'result') continue;
      const use = useOf.get(e.toolUseId)?.use;
      if (e.isError || (use?.name === 'Read' && tests.read(use.input?.file_path)) ||
          (use?.name === 'Bash' && record.jsonResults?.includes(e.toolUseId))) wanted.add(record);
    }
    load([...wanted]);
    // ENG-4: a dedup reply's cited earlier Read (and its own reply) loads even before the window.
    for (let pending = [...wanted]; pending.length;) {
      const next: IndexedRecord[] = [];
      for (const record of pending) for (const e of record.events) {
        const use = e.kind === 'result' ? useOf.get(e.toolUseId)?.use : undefined;
        if (!use || use.name !== 'Read' || textResult(e) !== DEDUP_REPLY) continue;
        const prior = reads.findLast(r => r.use.order < use.order && sameNativePath(r.use.input?.file_path, use.input?.file_path));
        if (prior) next.push(...withResults(prior.use.toolUseId).filter(r => !r.full));
      }
      load(next);
      pending = next;
    }
  };
}

/** The guard's owned read: the bounded reader under this policy, keeping the prefix witness across reads. */
export function readGuardJournal(file: string, owners: readonly string[], sessionId: string, currentToolUseId: string,
  tests: GuardJournalTests, prior?: JournalPrefix, measure?: OwnedReadMeasure): OwnedRead {
  return readOwnedClaudePublicTranscript(file, owners, sessionId,
    { prior, measure, policy: { indexInput: indexInput(tests), select: select(tests, currentToolUseId) } });
}
