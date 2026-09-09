#!/usr/bin/env bun
/** Autoplan's blind reviewer inputs contain only the current implementation plan. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const PHASES = ['ceo', 'design', 'dx', 'eng'];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function extractImplementationPlan(plan: string): string {
  const boundaries: Array<{ name: string; start: number; end: number }> = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const raw of plan.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (fence) {
        if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      } else if (run[0] !== '`' || !delimiter[2]!.includes('`')) {
        fence = { char: run[0]!, length: run.length };
      }
    } else if (!fence) {
      const heading = /^ {0,3}##[ \t]+(Implementation plan|Review record)[ \t]*(?:#+[ \t]*)?$/.exec(line);
      if (heading) boundaries.push({ name: heading[1]!, start: offset, end: offset + raw.length });
    }
    offset += raw.length;
  }
  if (boundaries.length !== 2 || boundaries[0]!.name !== 'Implementation plan' || boundaries[1]!.name !== 'Review record') {
    throw new Error('Expected one Implementation plan section followed by one Review record section outside Markdown code/quotes');
  }
  const body = plan.slice(boundaries[0]!.end, boundaries[1]!.start);
  if (!body.trim()) throw new Error('Implementation plan is empty');
  return body;
}

function phaseName(phase: string): string {
  if (!PHASES.includes(phase)) throw new Error('Phase must be ceo, design, dx or eng');
  return phase;
}

export function createSnapshot(phase: string, activePlan: string, restorePath: string) {
  phaseName(phase);
  const source = realpathSync(activePlan);
  const restore = realpathSync(restorePath);
  if (source === restore || !statSync(restore).isFile()) throw new Error('Expected a separate restore-point file');
  const content = extractImplementationPlan(readFileSync(source, 'utf8'));
  // Unique path on every invocation, including a repeated/zero-change phase.
  // No prior snapshot is overwritten, and no review text enters this file.
  const directory = mkdtempSync(join(dirname(restore), `autoplan-${phase}-`));
  try {
    const snapshotPath = join(directory, `${phase}-implementation.md`);
    const manifest = { schemaVersion: 1, phase, activePlan: source, snapshotPath, sha256: sha256(content) };
    writeFileSync(snapshotPath, content, { flag: 'wx', mode: 0o444 });
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o444 });
    return manifest;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function checkImplementation(phase: string, activePlan: string, snapshotPath: string, expected: string) {
  phaseName(phase);
  if (expected !== 'changed' && expected !== 'unchanged') throw new Error('Expected changed or unchanged');
  const source = realpathSync(activePlan);
  const snapshot = realpathSync(snapshotPath);
  const manifest = JSON.parse(readFileSync(join(dirname(snapshot), 'snapshot.json'), 'utf8'));
  const original = readFileSync(snapshot, 'utf8');
  if (manifest.schemaVersion !== 1 || manifest.phase !== phase || manifest.activePlan !== source ||
      manifest.snapshotPath !== snapshot || manifest.sha256 !== sha256(original) || basename(snapshot) !== `${phase}-implementation.md`) {
    throw new Error('Snapshot identity/content does not match this phase and active plan');
  }
  const implementation = extractImplementationPlan(readFileSync(source, 'utf8'));
  const changed = implementation !== original;
  if (changed !== (expected === 'changed')) {
    throw new Error(`Implementation plan is ${changed ? 'changed' : 'unchanged'}; review-record/task edits are not implementation amendments`);
  }
  // This is a byte-level readback, NOT proof that any decision was approved or
  // implemented correctly. The reviewer must check the actual text vs decisions.
  return { phase, activePlan: source, snapshotPath: snapshot, changed, sha256: sha256(implementation), implementation };
}

if (import.meta.main) {
  try {
    const [command, phase, active, location, expected, ...extra] = process.argv.slice(2);
    if (!phase || !active || !location || extra.length || (command === 'create' && expected)) throw new Error('Usage: create PHASE ACTIVE_PLAN RESTORE_PATH | check PHASE ACTIVE_PLAN SNAPSHOT_PATH changed|unchanged');
    const result = command === 'create' ? createSnapshot(phase, active, location)
      : command === 'check' && expected ? checkImplementation(phase, active, location, expected)
      : (() => { throw new Error('Expected create or check command'); })();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    console.error(`gstack-autoplan-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
