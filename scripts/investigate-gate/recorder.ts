#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * investigate-gate recorder — observation-only worktree-delta recorder for the
 * GST-938 eval (plan v3, gate rev 4 d3/d7). The harness registers it as a
 * settings-level hook in EVERY arm (N, S and H alike) on PreToolUse,
 * PostToolUse and PostToolUseFailure with matcher "*", from a settings file
 * outside the model's home, so the scorer reads the same evidence in every arm.
 *
 * It prints nothing and always exits 0, so the model never sees it. It writes
 * one JSONL line per tool event to $GSTACK_INVESTIGATE_RECORDER_DIR/<session>.jsonl
 * (no-op when the variable is unset): the tool, the Bash command, exit status and
 * a redacted tail, and the tracked non-test source delta against the baseline
 * captured at the session's first event (PreToolUse, before any tool ran).
 */
import * as fs from 'fs';
import * as path from 'path';
import { exitFromPayload, fingerprintDelta, isBackground, outputTail, repoTop, sourceFingerprint, type Fingerprint } from '../../lib/investigate-gate';

export interface RecorderLine {
  i: number;
  ts: string;
  event: string;
  tool: string;
  tool_use_id: string | null;
  command?: string;
  exit?: number | null;
  background?: boolean;
  tail?: string;
  delta: string[];
}

function readAll(): string {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

export function record(payload: Record<string, unknown>, dir: string): void {
  const session = String(payload.session_id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  const event = String(payload.hook_event_name ?? '');
  if (!session || !event) return;
  const top = repoTop(String(payload.cwd || process.cwd()));
  if (!top) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const basePath = path.join(dir, `${session}.baseline.json`);
  const logPath = path.join(dir, `${session}.jsonl`);
  let baseline: Fingerprint;
  try {
    baseline = JSON.parse(fs.readFileSync(basePath, 'utf8')) as Fingerprint;
  } catch {
    baseline = sourceFingerprint(top);
    fs.writeFileSync(basePath, JSON.stringify(baseline), { mode: 0o600 });
  }
  if (event === 'PreToolUse') return;
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  const tool = String(payload.tool_name ?? '');
  let i = 0;
  try { i = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length; } catch { /* first line */ }
  const line: RecorderLine = { i, ts: new Date().toISOString(), event, tool, tool_use_id: (payload.tool_use_id as string) ?? null, delta: fingerprintDelta(baseline, sourceFingerprint(top)) };
  if (tool === 'Bash') {
    const command = String(input.command ?? '');
    Object.assign(line, { command, exit: exitFromPayload(event, payload), background: isBackground(command, input.run_in_background === true), tail: outputTail(event, payload) });
  }
  fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

if (import.meta.main) {
  try {
    const dir = process.env.GSTACK_INVESTIGATE_RECORDER_DIR;
    const raw = readAll();
    if (dir && raw.trim()) record(JSON.parse(raw) as Record<string, unknown>, dir);
  } catch { /* observation only: never affect the session */ }
  process.exit(0);
}
