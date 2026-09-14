import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface PlanFloorTargetDelivery {
  status: 'missing' | 'ready' | 'error';
  reason?: string;
  sessionId: string;
  command: string;
  targetPath: string;
  targetSha256: string;
  acknowledgedAt?: string;
}

/** The first owned native user command must name the already-seeded plan. */
export function readPlanFloorTarget(configDir: string | null, cwd: string, opts: {
  seed: string; sessionId: string; slashCommand: string; startedAt: number; now: number;
}): PlanFloorTargetDelivery {
  const delivery: PlanFloorTargetDelivery = {
    status: 'missing', sessionId: opts.sessionId, command: `${opts.slashCommand} PLAN.md`,
    targetPath: path.join(cwd, 'PLAN.md'), targetSha256: createHash('sha256').update(opts.seed).digest('hex'),
  };
  try {
    if (!configDir || !/^[\da-f-]{36}$/i.test(opts.sessionId) || !/^\/[\w-]+$/.test(opts.slashCommand) ||
        !Number.isFinite(opts.startedAt) || !Number.isFinite(opts.now) || opts.now < opts.startedAt) return delivery;
    if (!fs.lstatSync(delivery.targetPath).isFile() || fs.readFileSync(delivery.targetPath, 'utf8') !== opts.seed) {
      return { ...delivery, status: 'error', reason: 'Owned seed plan is missing or changed' };
    }
    const projects = path.join(configDir, 'projects');
    if (!fs.existsSync(projects)) return delivery;
    if (!fs.lstatSync(projects).isDirectory()) throw Error('Native project root is not a directory');
    const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(dir => dir.isDirectory());
    if (dirs.length > 128) throw Error('Too many native project directories');
    const files = dirs.map(dir => path.join(projects, dir.name, `${opts.sessionId}.jsonl`)).filter(file => fs.existsSync(file));
    if (files.length === 0) return delivery;
    if (files.length !== 1 || !fs.lstatSync(files[0]!).isFile()) throw Error('Ambiguous or nonregular native session');
    if (fs.statSync(files[0]!).size > 32 * 1024 * 1024) throw Error('Native session exceeds 32 MiB');
    const raw = fs.readFileSync(files[0]!, 'utf8');
    const expected = `<command-message>${opts.slashCommand.slice(1)}</command-message>\n` +
      `<command-name>${opts.slashCommand}</command-name>\n<command-args>PLAN.md</command-args>`;
    for (const line of raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line), at = Date.parse(record.timestamp ?? '');
      if (record.type !== 'user' || record.isSidechain !== false || record.cwd !== cwd ||
          record.sessionId !== opts.sessionId || record.parent_tool_use_id || record.message?.role !== 'user' ||
          !Number.isFinite(at) || at < opts.startedAt || at > opts.now) continue;
      const content = record.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 &&
        content[0]?.type === 'text' && typeof content[0].text === 'string' ? content[0].text : undefined;
      if (text === undefined) {
        if (Array.isArray(content) && content.some(block => block?.type === 'text')) {
          return { ...delivery, status: 'error', reason: 'First owned native user text was not one target command' };
        }
        continue; // Tool-result-only user envelopes are not submitted commands.
      }
      // A later queued target cannot repair a skill that already started bare.
      return text === expected
        ? { ...delivery, status: 'ready', acknowledgedAt: record.timestamp }
        : { ...delivery, status: 'error', reason: 'First owned native user input did not name the seeded plan' };
    }
    return delivery;
  } catch (error) {
    return { ...delivery, status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}
