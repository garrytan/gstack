import * as fs from 'node:fs';
import * as path from 'node:path';
import { streamedUsageCostUsd } from '../../../lib/pricing';

/** The session ledger's cost field for a PTY session: present only when its transcript prices. */
export function pricedTranscript(session: { transcriptCostUsd?(): number | undefined } | undefined): { streamed_cost_usd?: number } {
  const cost = session?.transcriptCostUsd?.();
  return cost === undefined ? {} : { streamed_cost_usd: cost };
}

/** Top-level session transcripts (`projects/<dir>/<id>.jsonl`) under a config dir; empty when unreadable. */
export function transcriptFiles(configDir: string | undefined): Set<string> {
  if (!configDir) return new Set();
  try {
    const projects = path.join(configDir, 'projects');
    return new Set(fs.readdirSync(projects, { withFileTypes: true }).filter(dir => dir.isDirectory())
      .flatMap(dir => fs.readdirSync(path.join(projects, dir.name)).filter(f => f.endsWith('.jsonl')).map(f => path.join(projects, dir.name, f))));
  } catch {
    return new Set();
  }
}

/**
 * The session id of the one transcript that appeared since `before` and was written for `cwd`. Concurrent PTY tests in
 * one process share a hermetic config dir, so a launch claims only a new transcript for its own cwd; none or several
 * (two sessions in one cwd) is undefined, which leaves the cost unknown.
 */
export function newTranscriptSessionId(configDir: string | undefined, before: ReadonlySet<string>, cwd: string): string | undefined {
  try {
    const cwds = new Set([cwd, fs.realpathSync(cwd)]);
    const mine = [...transcriptFiles(configDir)].filter(file => !before.has(file) && fs.readFileSync(file, 'utf8').split('\n').some(line => {
      try {
        return cwds.has(JSON.parse(line)?.cwd);
      } catch {
        return false;
      }
    }));
    return mine.length === 1 ? path.basename(mine[0], '.jsonl') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Price one PTY session from the transcripts Claude Code wrote under its owned config dir:
 * `projects/<dir>/<sessionId>.jsonl` (inline sidechains included) and `projects/<dir>/<sessionId>/subagents/*.jsonl`,
 * rows deduplicated by message id. Undefined (cost-unknown, never $0) without a config dir, session id, transcript or
 * usage, when a message's model has no price row, or when any read fails: it runs in ledger writers before close and
 * cleanup, so it never throws.
 */
export function ptyTranscriptCostUsd(configDir: string | null | undefined, sessionId: string | undefined): number | undefined {
  if (!configDir || !sessionId) return undefined;
  try {
    const projects = path.join(configDir, 'projects');
    const files: string[] = [];
    for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const main = path.join(projects, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(main)) files.push(main);
      const subagents = path.join(projects, dir.name, sessionId, 'subagents');
      if (fs.existsSync(subagents)) files.push(...fs.readdirSync(subagents).filter(f => f.endsWith('.jsonl')).map(f => path.join(subagents, f)));
    }
    const rows = files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    }));
    return streamedUsageCostUsd(rows);
  } catch {
    return undefined;
  }
}
