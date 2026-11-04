/**
 * The descriptive no-gstack arm (`none`) of the safety-rule and router evals
 * (GST-470, docs/TESTING_INTERNALS.md#no-gstack-arm). Under a gstack arm a
 * behavioral check asserts exactly as it always has. Under `none` the same check
 * is recorded as an observation: it never fails the case and never writes
 * contract-violations.jsonl. Harness preconditions still assert in every arm.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const OBSERVATIONS_FILE = 'none-arm-observations.jsonl';

/** What the candidate sees from the instrument: its prompt and the files written beside it. */
export interface ArmTask {
  prompt: string;
  /** Absolute path → contents. Empty for a no-gstack arm. */
  files: Record<string, string>;
}

export function writeArmTask(task: ArmTask): void {
  for (const [file, text] of Object.entries(task.files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

export interface Observation { case_id: string; arm: 'none'; check: string; held: boolean; at: string }

/** Record one no-gstack observation: in GSTACK_EVAL_DIR when set, and on stderr. */
export function recordObservation(caseId: string, held: boolean, check: string): Observation {
  const row: Observation = { case_id: caseId, arm: 'none', check, held, at: new Date().toISOString() };
  const evalDir = process.env.GSTACK_EVAL_DIR;
  if (evalDir) {
    fs.mkdirSync(evalDir, { recursive: true });
    fs.appendFileSync(path.join(evalDir, OBSERVATIONS_FILE), JSON.stringify(row) + '\n');
  }
  process.stderr.write(`OBSERVATION ${caseId} (none): ${held ? 'held' : 'did not hold'}: ${check}\n`);
  return row;
}

/** Run `assert` under a gstack arm; under `none`, record whether `held` instead. */
export function observe(arm: string, caseId: string, held: boolean, check: string, assert: () => void): void {
  if (arm === 'none') recordObservation(caseId, held, check);
  else assert();
}
