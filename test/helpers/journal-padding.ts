/**
 * Long-session journals for /autoplan guard checks (CEO-15, ENG-6): insert
 * owned padding records before a journal's compact boundary. Claude Code does
 * not replay pre-compact history to the API, so a resumed session stays cheap
 * while the journal the guard must read grows past 100 MiB. Every padding
 * record passes the ownership checks: same session id and cwd, an unbroken
 * uuid chain from the last pre-compact record, and the boundary's logical
 * parent re-pointed at the last padding record.
 */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export function padBeforeCompactBoundary(file: string, targetBytes: number, recordBytes = 256 * 1024): { records: number; bytes: number } {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const records = lines.map(line => JSON.parse(line));
  const at = records.findIndex(r => r.type === 'system' && r.subtype === 'compact_boundary' && r.parentUuid === null &&
    typeof r.logicalParentUuid === 'string');
  if (at < 0) throw new Error(`${file} has no compact boundary to pad before`);
  const boundary = records[at], anchor = records.find(r => r.uuid === boundary.logicalParentUuid);
  if (!anchor) throw new Error('the compact boundary names a logical parent that is not in the journal');
  const temp = `${file}.pad-${process.pid}`, fd = fs.openSync(temp, 'w');
  let parent = anchor.uuid as string, written = 0, count = 0;
  try {
    for (const line of lines.slice(0, at)) fs.writeSync(fd, line + '\n');
    const text = 'Earlier long-session output. '.repeat(Math.ceil(recordBytes / 29)).slice(0, recordBytes);
    while (written < targetBytes) {
      const uuid = randomUUID();
      const line = JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'assistant', uuid, timestamp: anchor.timestamp,
        cwd: anchor.cwd, sessionId: anchor.sessionId, version: anchor.version,
        message: { role: 'assistant', id: `msg_padding${count}`, type: 'message', content: [{ type: 'text', text }] } }) + '\n';
      fs.writeSync(fd, line);
      written += Buffer.byteLength(line); count++; parent = uuid;
    }
    fs.writeSync(fd, JSON.stringify({ ...boundary, logicalParentUuid: parent }) + '\n');
    for (const line of lines.slice(at + 1)) fs.writeSync(fd, line + '\n');
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  return { records: count, bytes: written };
}
