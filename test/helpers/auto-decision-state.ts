import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AutoDecisionState {
  questionId: string;
  preference: 'never-ask';
  records: Record<string, unknown>[];
}

/** Bind before launch to the same explicit state root as the child. Read the
 * actual append, not a shell command whose failure may have been masked. */
export function bindAutoDecisionState(
  binding: { stateRoot: string; projectSlug: string },
  env: Record<string, string> | undefined,
  skillName: string,
): () => AutoDecisionState | undefined {
  const root = path.resolve(binding.stateRoot);
  if (!env?.GSTACK_STATE_ROOT || path.resolve(env.GSTACK_STATE_ROOT) !== root ||
      !/^[a-zA-Z0-9_-]+$/.test(binding.projectSlug)) throw new Error('Auto-decision state must match the child state root and project');
  const project = path.join(root, 'projects', binding.projectSlug);
  const preference = path.join(project, 'question-preferences.json');
  const log = path.join(project, 'question-log.jsonl');
  const questionId = `${skillName}-mode`;
  const owned = (file: string) => fs.realpathSync(file) === file && !fs.lstatSync(file).isSymbolicLink();
  if (!owned(root) || !owned(project) || !owned(preference)) throw new Error('Auto-decision state cannot follow links');
  const before = fs.readFileSync(preference, 'utf8');
  if (JSON.parse(before)[questionId] !== 'never-ask') throw new Error('Auto-decision state requires the explicit mode preference');
  // Each attempt starts without a decision log. Existing records cannot prove
  // that this invocation acted, even if they happen to share a session id.
  if (fs.existsSync(log)) throw new Error('Auto-decision state requires a fresh attempt log');
  return () => {
    try {
      if (!owned(root) || !owned(project) || !owned(preference) || !owned(log) ||
          fs.readFileSync(preference, 'utf8') !== before || fs.statSync(log).size > 1024 * 1024) return undefined;
      const records = fs.readFileSync(log, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      if (records.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return undefined;
      return { questionId, preference: 'never-ask', records };
    } catch { return undefined; } // Missing/partial writes are not completed decisions.
  };
}
