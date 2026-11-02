#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * investigate-gate scorer — the prospective follow scorer for the GST-938 eval
 * (plan v3, gate rev 4 d2-d7). Hashed into the prereg; the historical Step B
 * scorer (score-final.py, sha256 b0a7da1a…) is kept unchanged beside it.
 *
 *   bun scripts/investigate-gate/score.ts <recorder.jsonl>... [--gate-state <file>]... [--json]
 *
 * Per session, from the recorder's worktree deltas (never from tool names):
 *   first_edit   first event whose tracked non-test source delta is non-empty
 *   repro        the last qualifying failing Bash run before first_edit that ran on
 *                unchanged source (lib/investigate-gate.ts qualifiesAsFailingRun)
 *   paired       a later passing run (qualifiesAsPassingRun) of the same command or
 *                one naming the repro's test target, after the last source change
 *   follow       repro && paired; a session with no source edit is not a follow
 *   unscorable   the recorder file is empty or has no event
 * With --gate-state (H arm), it adds escapes, bypasses, denials and repro_valid
 * (the bound run itself qualifies and pairs with a later passing run).
 */
import * as fs from 'fs';
import * as path from 'path';
import { pairsWithRepro, qualifiesAsFailingRun, qualifiesAsPassingRun, type SessionState } from '../../lib/investigate-gate';
import type { RecorderLine } from './recorder';

export interface SessionScore {
  session: string;
  events: number;
  unscorable: boolean;
  edited: boolean;
  repro: string | null;
  paired: boolean;
  follow: boolean;
  test_after: boolean;
  gate?: { escapes: number; bypasses: number; denials: number; bound: boolean; repro_valid: boolean };
}

type Bash = RecorderLine & { command: string };

export function scoreLines(session: string, lines: RecorderLine[]): SessionScore {
  const base: SessionScore = { session, events: lines.length, unscorable: lines.length === 0, edited: false, repro: null, paired: false, follow: false, test_after: false };
  if (base.unscorable) return base;
  const firstEdit = lines.findIndex((l) => l.delta.length > 0);
  base.edited = firstEdit >= 0;
  if (!base.edited) return base;
  const isBash = (l: RecorderLine): l is Bash => l.tool === 'Bash' && typeof l.command === 'string';
  const asRun = (l: Bash) => ({ command: l.command, exit: l.exit ?? null, background: l.background === true, tail: l.tail ?? '' });
  const before = lines.slice(0, firstEdit).filter(isBash).filter((l) => l.delta.length === 0 && qualifiesAsFailingRun(asRun(l)));
  const repro = before.length ? before[before.length - 1] : null;
  let lastChange = firstEdit;
  for (let i = firstEdit + 1; i < lines.length; i++) if (lines[i].delta.join('\0') !== lines[i - 1].delta.join('\0')) lastChange = i;
  const after = lines.slice(lastChange + 1).filter(isBash).filter((l) => qualifiesAsPassingRun(asRun(l)));
  base.test_after = after.length > 0;
  base.repro = repro?.command ?? null;
  base.paired = !!repro && after.some((l) => pairsWithRepro(repro.command, l.command));
  base.follow = base.paired;
  return base;
}

export function gateFields(state: SessionState, recorder: RecorderLine[]): NonNullable<SessionScore['gate']> {
  const invs = state.investigations;
  const escapes = invs.filter((v) => v.hypothesis?.no_repro).length;
  const bypasses = invs.reduce((n, v) => n + v.bypasses.length, 0);
  const denials = invs.reduce((n, v) => n + v.denials, 0);
  const boundRuns = invs.flatMap((v) => (v.hypothesis?.bound_run !== undefined ? [v.runs[v.hypothesis.bound_run]] : []));
  const passing = recorder.filter((l) => l.tool === 'Bash' && typeof l.command === 'string').filter((l) => qualifiesAsPassingRun({ command: l.command!, exit: l.exit ?? null, background: l.background === true, tail: l.tail ?? '' }));
  const valid = boundRuns.length > 0 && boundRuns.every((r) => qualifiesAsFailingRun(r) && passing.some((l) => pairsWithRepro(r.command, l.command!)));
  return { escapes, bypasses, denials, bound: boundRuns.length > 0, repro_valid: valid };
}

function readJsonl(file: string): RecorderLine[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecorderLine);
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const states = new Map<string, SessionState>();
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--gate-state') {
      const st = JSON.parse(fs.readFileSync(args[++i], 'utf8')) as SessionState;
      states.set(st.session.replace(/[^A-Za-z0-9._-]/g, '_'), st);
      continue;
    }
    files.push(args[i]);
  }
  if (files.length === 0) {
    process.stderr.write('usage: score.ts <recorder.jsonl>... [--gate-state <file>]... [--json]\n');
    process.exit(2);
  }
  const rows = files.map((f) => {
    const session = path.basename(f).replace(/\.jsonl$/, '');
    const lines = readJsonl(f);
    const row = scoreLines(session, lines);
    const st = states.get(session);
    if (st) row.gate = gateFields(st, lines);
    return row;
  });
  if (json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else {
    for (const r of rows) process.stdout.write(`${r.session} follow=${r.follow} edited=${r.edited} repro=${r.repro ? 'yes' : 'no'} paired=${r.paired} test_after=${r.test_after}${r.unscorable ? ' UNSCORABLE' : ''}${r.gate ? ` escapes=${r.gate.escapes} bypasses=${r.gate.bypasses} denials=${r.gate.denials} repro_valid=${r.gate.repro_valid}` : ''}\n`);
    const scorable = rows.filter((r) => !r.unscorable);
    process.stdout.write(`FOLLOW: ${scorable.filter((r) => r.follow).length}/${scorable.length} scorable (${rows.length - scorable.length} unscorable)\n`);
  }
}
