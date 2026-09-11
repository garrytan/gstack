import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProjectEvalDir } from './eval-store';

interface PlanCountSnapshot {
  skillName: string;
  observation: object;
  raw: string;
  visible: string;
  viewport?: string;
  cwd: string;
  claudeConfigDir: string | null;
}

/** One owned directory per count attempt; periodic captures replace files atomically. */
export function createPlanCountSnapshotWriter(env: NodeJS.ProcessEnv = process.env):
  (input: PlanCountSnapshot) => { artifactDir?: string; artifactError?: string } {
  let artifactDir: string | undefined;
  return (input) => {
    if (!env.EVALS_RUN_ID) return {};
    try {
      if (!artifactDir) {
        const segment = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'run';
        const root = path.resolve(env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'pty-count', segment(env.EVALS_RUN_ID));
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        artifactDir = fs.mkdtempSync(path.join(root, `${segment(input.skillName)}-${Date.now()}-`));
      }
      const write = (name: string, content: string) => {
        const target = path.join(artifactDir!, name);
        fs.writeFileSync(`${target}.tmp`, content, { mode: 0o600 });
        fs.renameSync(`${target}.tmp`, target);
      };
      write('terminal.raw.log', input.raw);
      write('terminal.visible.log', input.visible);
      if (input.viewport !== undefined) write('terminal.screen.log', input.viewport);
      write('observation.json', JSON.stringify({
        ...input.observation, artifactDir,
        capture: { skill: input.skillName, runId: env.EVALS_RUN_ID, cwd: input.cwd,
          claudeConfigDir: input.claudeConfigDir, at: new Date().toISOString() },
      }, null, 2) + '\n');
      return { artifactDir };
    } catch (error) {
      // Preserve any partial evidence and the original test outcome; make the
      // write failure visible instead of claiming diagnostics were retained.
      return { artifactDir, artifactError: String(error) };
    }
  };
}

/** Keep a single snapshot outside the temporary fixture that setup later removes. */
export function persistPlanCountSnapshot(input: PlanCountSnapshot, env: NodeJS.ProcessEnv = process.env) {
  return createPlanCountSnapshotWriter(env)(input);
}
