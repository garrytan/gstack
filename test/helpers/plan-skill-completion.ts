import { readOwnedClaudeTranscript } from './owned-claude-transcript';

/** A report preview is not completion. Require the latest owned conversation
 * turn to finish without tools, then corroborate its own completion text.
 */
export function readPlanSkillCompletion(configDir: string | null, sessionId: string, visible: string): string | null {
  const transcript = readOwnedClaudeTranscript(configDir, sessionId);
  if (transcript.pendingBytes) return null;
  const queued = new Map<string | undefined, number>();
  let queuedCount = 0;
  let ambiguousDequeues = false;
  let latest: { id: string | null; text: string[]; stop: unknown; tools: boolean } | null = null;
  for (const row of transcript.rows) {
    if (row.type === 'queue-operation') {
      latest = null;
      const hasContent = Object.hasOwn(row, 'content');
      if (!['enqueue', 'dequeue', 'remove', 'popOne', 'popAll'].includes(row.operation)
        || hasContent && (typeof row.content !== 'string' || row.operation === 'dequeue')) {
        throw new Error('Unsupported queue operation in owned Claude transcript');
      }
      const count = queued.get(row.content) ?? 0;
      if (row.operation === 'enqueue') {
        if (ambiguousDequeues) throw new Error('Unsupported mixed queue history after anonymous dequeue in owned Claude transcript');
        queued.set(row.content, count + 1);
        queuedCount++;
      } else {
        // Claude 2.1.263 emits one removal per actual item, even for popAll.
        // Dequeue omits identity: payload counts remain upper bounds until
        // the logged queue drains. New enqueues during unresolved ambiguity
        // fail closed; this reader cannot reconstruct every producer stream.
        if (!queuedCount) throw new Error('Queue removal lacks its enqueue in owned Claude transcript');
        if (row.operation === 'dequeue') ambiguousDequeues = queued.size > 1;
        else {
          if (!count) throw new Error('Queue removal does not match a queued payload in owned Claude transcript');
          if (count > 1) queued.set(row.content, count - 1);
          else queued.delete(row.content);
        }
        if (--queuedCount === 0) { queued.clear(); ambiguousDequeues = false; }
        else if (queued.size === 1) {
          // The remaining payload is now unique, even if it had duplicates.
          queued.set(queued.keys().next().value, queuedCount);
          ambiguousDequeues = false;
        }
      }
      continue;
    }
    if (row.type === 'user' || (row.type === 'attachment' && typeof row.attachment?.prompt === 'string')) {
      latest = null;
      continue;
    }
    if (row.type !== 'assistant' || row.message?.role !== 'assistant') continue;
    const message = row.message;
    const id = typeof message.id === 'string' ? message.id : null;
    if (!latest || !id || latest.id !== id) latest = { id, text: [], stop: null, tools: false };
    latest.stop = message.stop_reason;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') latest.text.push(block.text);
      if (block?.type === 'tool_use') latest.tools = true;
    }
  }
  if (queuedCount || !latest || latest.stop !== 'end_turn' || latest.tools) return null;
  let fence: string | null = null;
  const compact = (value: string) => value.replace(/[\s*#]/g, '').toLowerCase();
  for (const line of latest.text.join('\n').split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}| {0,3}\t)|^\s*>/.test(line)) continue;
    const text = line.replace(/^ {0,3}(?:#{1,6}\s+)?/, '').replace(/\*\*/g, '').trim();
    const marker = /^(?:GSTACK REVIEW REPORT|Completion Summary)$/i.test(text)
      || /^VERDICT:\s*\S/.test(text)
      || /^Status:\s*(?:clean|issues_open)\b/i.test(text)
      || /^(?:STATUS:\s*)?DONE(?:_WITH_CONCERNS)?(?:\s|[—:.-]|$)/.test(text);
    if (marker && compact(visible).includes(compact(text))) return text;
  }
  return null;
}
