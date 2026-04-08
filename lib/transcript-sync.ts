/**
 * Transcript sync — parse Claude Code session history, enrich with
 * tool usage and LLM summaries, push to Supabase.
 *
 * Data sources:
 *   ~/.claude/history.jsonl          — user prompts (always available)
 *   ~/.claude/projects/{hash}/{sid}.jsonl — full transcript (when available, ~19%)
 *
 * Degradation cascade:
 *   history.jsonl only                → user prompts, turn count, duration
 *   + session file                    → + tools_used, full turn count
 *   + ANTHROPIC_API_KEY               → + 1-sentence LLM summary
 *
 * All operations are non-fatal. If any step fails, we degrade gracefully.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readJSON, atomicWriteJSON, GSTACK_STATE_DIR } from './util';
import { resolveSyncConfig } from './sync-config';
import { pushTranscript } from './sync';
import { summarizeSession } from './llm-summarize';

const HISTORY_FILE = path.join(os.homedir(), '.claude', 'history.jsonl');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MARKER_FILE = path.join(GSTACK_STATE_DIR, 'transcript-sync-marker.json');
const MAX_HISTORY_SIZE = 50 * 1024 * 1024; // 50MB warn threshold
const MAX_SESSION_FILE_SIZE = 10 * 1024 * 1024; // 10MB skip threshold
const PUSH_CONCURRENCY = 10;
const SUMMARY_CONCURRENCY = 5;

// --- Types ---

export interface HistoryEntry {
  display: string;
  pastedContents: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface TranscriptSyncMarker {
  pushed_sessions: Record<string, { turns_pushed: number; last_push: string }>;
  last_file_size: number;
  updated_at: string;
}

export interface SessionFileData {
  tools_used: string[];
  totalTurns: number;
}

export interface TranscriptData {
  session_id: string;
  repo_slug: string;
  messages: Array<{ display: string; timestamp: number }>;
  total_turns: number;
  tools_used: string[] | null;
  summary: string | null;
  started_at: string;
  ended_at: string;
}

// --- History parsing ---

/**
 * Parse ~/.claude/history.jsonl into HistoryEntry[].
 * Returns [] on ENOENT, EBUSY, EACCES, or any error. Skips malformed lines.
 */
export function parseHistoryFile(historyPath: string = HISTORY_FILE): HistoryEntry[] {
  try {
    const stat = fs.statSync(historyPath);
    if (stat.size > MAX_HISTORY_SIZE) {
      console.error(`Warning: history.jsonl is ${(stat.size / 1024 / 1024).toFixed(1)}MB — parsing may be slow.`);
    }
    const content = fs.readFileSync(historyPath, 'utf-8');
    const entries: HistoryEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.sessionId && d.timestamp && d.project) {
          entries.push({
            display: typeof d.display === 'string' ? d.display : '',
            pastedContents: d.pastedContents || {},
            timestamp: d.timestamp,
            project: d.project,
            sessionId: d.sessionId,
          });
        }
      } catch { /* skip malformed line */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Group history entries by sessionId.
 */
export function groupBySession(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const map = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const group = map.get(entry.sessionId);
    if (group) {
      group.push(entry);
    } else {
      map.set(entry.sessionId, [entry]);
    }
  }
  return map;
}

// --- Session file enrichment ---

/**
 * Find the rich session file for a given sessionId and project path.
 * Returns the file path or null if not found.
 *
 * Claude Code stores session files at:
 *   ~/.claude/projects/-{project.replaceAll('/', '-')}/{sessionId}.jsonl
 */
export function findSessionFile(sessionId: string, projectPath: string): string | null {
  try {
    const projectHash = '-' + projectPath.replace(/\//g, '-');
    const sessionFile = path.join(CLAUDE_PROJECTS_DIR, projectHash, `${sessionId}.jsonl`);

    // Security: validate the resolved path stays within ~/.claude/projects/
    const resolved = path.resolve(sessionFile);
    if (!resolved.startsWith(path.resolve(CLAUDE_PROJECTS_DIR))) return null;

    if (!fs.existsSync(sessionFile)) return null;

    const stat = fs.statSync(sessionFile);
    if (stat.size > MAX_SESSION_FILE_SIZE) return null; // Skip large files
    if (stat.size === 0) return null;

    return sessionFile;
  } catch {
    return null;
  }
}

/**
 * Parse a session JSONL file to extract tool usage and turn counts.
 */
export function parseSessionFile(sessionFilePath: string): SessionFileData | null {
  try {
    const content = fs.readFileSync(sessionFilePath, 'utf-8');
    const toolSet = new Set<string>();
    let totalTurns = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const type = d.type;
        if (type === 'user' || type === 'assistant') {
          totalTurns++;
        }
        if (type === 'assistant') {
          const content = d.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'tool_use' && typeof block.name === 'string') {
                toolSet.add(block.name);
              }
            }
          }
        }
      } catch { /* skip malformed line */ }
    }

    return {
      tools_used: Array.from(toolSet).sort(),
      totalTurns,
    };
  } catch {
    return null;
  }
}

// --- Repo slug resolution ---

const slugCache = new Map<string, string>();

/**
 * Get the repo slug for a project path. Memoized.
 * Runs `git remote get-url origin` with cwd set to the project path.
 * Falls back to path.basename() if git fails.
 */
export function getRemoteSlugForPath(projectPath: string): string {
  const cached = slugCache.get(projectPath);
  if (cached) return cached;

  let slug = path.basename(projectPath);
  try {
    if (fs.existsSync(projectPath)) {
      const { spawnSync } = require('child_process');
      const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 3_000,
      });
      if (result.status === 0 && result.stdout) {
        const url = result.stdout.toString().trim();
        // Parse "git@github.com:org/repo.git" or "https://github.com/org/repo.git"
        const match = url.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        if (match) slug = match[1];
      }
    }
  } catch { /* fall back to basename */ }

  slugCache.set(projectPath, slug);
  return slug;
}

/** Clear the slug cache (for testing). */
export function clearSlugCache(): void {
  slugCache.clear();
}

// --- Transcript data assembly ---

/**
 * Convert a session's data into the shape expected by the session_transcripts table.
 */
export function sessionToTranscriptData(
  sessionId: string,
  historyEntries: HistoryEntry[],
  sessionFileData: SessionFileData | null,
  summary: string | null,
): TranscriptData {
  const messages = historyEntries.map(e => ({
    display: e.display.length > 2000 ? e.display.slice(0, 2000) : e.display,
    timestamp: e.timestamp,
  }));

  const timestamps = historyEntries.map(e => e.timestamp);
  const startedAt = new Date(Math.min(...timestamps)).toISOString();
  const endedAt = new Date(Math.max(...timestamps)).toISOString();

  return {
    session_id: sessionId,
    repo_slug: getRemoteSlugForPath(historyEntries[0].project),
    messages,
    total_turns: sessionFileData?.totalTurns || historyEntries.length,
    tools_used: sessionFileData?.tools_used || null,
    summary,
    started_at: startedAt,
    ended_at: endedAt,
  };
}

// --- Sync marker ---

export function readSyncMarker(): TranscriptSyncMarker | null {
  return readJSON<TranscriptSyncMarker>(MARKER_FILE);
}

export function writeSyncMarker(marker: TranscriptSyncMarker): void {
  try {
    fs.mkdirSync(GSTACK_STATE_DIR, { recursive: true });
    atomicWriteJSON(MARKER_FILE, marker);
  } catch { /* non-fatal */ }
}

// --- Orchestrator ---

/**
 * Main sync function. Parses history, enriches sessions, pushes to Supabase.
 * Returns stats. All operations are non-fatal.
 */
export async function syncTranscripts(): Promise<{ pushed: number; skipped: number; errors: number }> {
  const config = resolveSyncConfig();
  if (!config || !config.syncTranscripts) {
    return { pushed: 0, skipped: 0, errors: 0 };
  }

  // Quick check: file size unchanged = nothing new
  let fileSize = 0;
  try {
    fileSize = fs.statSync(HISTORY_FILE).size;
  } catch {
    return { pushed: 0, skipped: 0, errors: 0 };
  }

  const marker = readSyncMarker() || {
    pushed_sessions: {},
    last_file_size: 0,
    updated_at: '',
  };

  if (fileSize === marker.last_file_size) {
    return { pushed: 0, skipped: 0, errors: 0 };
  }

  // Parse and group
  const entries = parseHistoryFile();
  if (entries.length === 0) return { pushed: 0, skipped: 0, errors: 0 };

  const sessions = groupBySession(entries);

  // Filter to sessions that need pushing
  const toPush: Array<{ sessionId: string; entries: HistoryEntry[] }> = [];
  let skipped = 0;
  for (const [sessionId, sessionEntries] of sessions) {
    const prev = marker.pushed_sessions[sessionId];
    if (prev && prev.turns_pushed >= sessionEntries.length) {
      skipped++;
      continue;
    }
    toPush.push({ sessionId, entries: sessionEntries });
  }

  if (toPush.length === 0) {
    // Update file size even if nothing to push (prevents re-parsing)
    marker.last_file_size = fileSize;
    marker.updated_at = new Date().toISOString();
    writeSyncMarker(marker);
    return { pushed: 0, skipped, errors: 0 };
  }

  // Enrich with session files
  const enriched = toPush.map(({ sessionId, entries: sessionEntries }) => {
    const sessionFile = findSessionFile(sessionId, sessionEntries[0].project);
    const sessionFileData = sessionFile ? parseSessionFile(sessionFile) : null;
    return { sessionId, entries: sessionEntries, sessionFileData };
  });

  // Summarize in batches (5-concurrent)
  const withSummaries: Array<{
    sessionId: string;
    entries: HistoryEntry[];
    sessionFileData: SessionFileData | null;
    summary: string | null;
  }> = [];

  for (let i = 0; i < enriched.length; i += SUMMARY_CONCURRENCY) {
    const batch = enriched.slice(i, i + SUMMARY_CONCURRENCY);
    const summaries = await Promise.allSettled(
      batch.map(({ entries: sessionEntries, sessionFileData }) => {
        const messages = sessionEntries.map(e => ({
          display: e.display.length > 200 ? e.display.slice(0, 200) : e.display,
          timestamp: e.timestamp,
        }));
        return summarizeSession(messages, sessionFileData?.tools_used || null);
      }),
    );

    batch.forEach((item, idx) => {
      const result = summaries[idx];
      withSummaries.push({
        ...item,
        summary: result.status === 'fulfilled' ? result.value : null,
      });
    });
  }

  // Push in batches (10-concurrent)
  let pushed = 0;
  let errors = 0;

  for (let i = 0; i < withSummaries.length; i += PUSH_CONCURRENCY) {
    const batch = withSummaries.slice(i, i + PUSH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(({ sessionId, entries: sessionEntries, sessionFileData, summary }) => {
        const data = sessionToTranscriptData(sessionId, sessionEntries, sessionFileData, summary);
        return pushTranscript(data as Record<string, unknown>);
      }),
    );

    results.forEach((result, idx) => {
      const item = batch[idx];
      if (result.status === 'fulfilled' && result.value) {
        pushed++;
        marker.pushed_sessions[item.sessionId] = {
          turns_pushed: item.entries.length,
          last_push: new Date().toISOString(),
        };
      } else {
        errors++;
      }
    });
  }

  // Update marker
  marker.last_file_size = fileSize;
  marker.updated_at = new Date().toISOString();
  writeSyncMarker(marker);

  return { pushed, skipped, errors };
}
