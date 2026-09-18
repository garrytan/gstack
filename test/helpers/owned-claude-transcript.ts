import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OwnedClaudeTranscript {
  file: string | null;
  rows: any[];
  completedLines: number;
  pendingBytes: number;
}

/** Shared exact-session scanner. Read direct project directories only, retain
 * complete JSONL records, and exclude foreign sessions and sidechain events.
 * Callers interpret assistant text; raw records never enter error messages.
 */
export function readOwnedClaudeTranscript(configDir: string | null, sessionId: string): OwnedClaudeTranscript {
  if (!configDir) throw new Error('Claude observation requires an owned hermetic transcript directory');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Claude transcript session ID must be a UUID');
  }
  const pending = { file: null, rows: [], completedLines: 0, pendingBytes: 0 };
  const projects = path.join(configDir, 'projects');
  let directories: fs.Dirent[];
  try {
    directories = fs.readdirSync(projects, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pending;
    throw error;
  }
  const files: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue; // Never follow project symlinks.
    const file = path.join(projects, directory.name, `${sessionId}.jsonl`);
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error(`Claude transcript is not a regular file: ${file}`);
      files.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (files.length === 0) return pending;
  if (files.length !== 1) throw new Error(`Ambiguous Claude transcript for session ${sessionId}`);
  const file = files[0];
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pending;
    throw error;
  }
  const boundary = source.lastIndexOf('\n') + 1;
  const lines = source.slice(0, boundary).split('\n').slice(0, -1);
  const rows: any[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected a JSON object');
    } catch {
      // Do not include the raw record: it may contain tool output or secrets.
      throw new Error(`Malformed Claude transcript JSON at ${file}:${index + 1}`);
    }
    if (row.sessionId !== sessionId || row.isSidechain === true || row.parent_tool_use_id != null) continue;
    rows.push(row);
  }
  return { file, rows, completedLines: lines.length, pendingBytes: Buffer.byteLength(source.slice(boundary)) };
}
