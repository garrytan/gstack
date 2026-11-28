/**
 * ship-run-live — whether a /ship or review run on this machine still holds gstack upgrades (GST-3546, bin/gstack-capy-session's
 * open_run, R75's workflow boundary). The candidates are the ones open_run always read: an unclosed ship-budget ledger written in
 * the last 6 hours and an unconsumed review start under 120 minutes old. A candidate no longer holds once its run provably ended:
 * its owner process is gone (ownerGone: the harness it ran under exited or the machine restarted; a shared harness such as
 * capy-server proves nothing), or the checkout's /ship run record says the run finished or was abandoned and the record is this
 * ledger's: the ledger is the one newest ledger for that checkout created at or before the record opened, so neither an earlier
 * run's record nor a later run started on the same checkout releases it (for a review start, the record naming the run its claim
 * stamped). A stopped run can still claim its fix-check grant and resume, so it keeps
 * the hold, and so does a record that is missing, open, legacy, unreadable, older than the ledger or another ledger's.
 * A ledger a later start superseded (superseded_by) no longer holds either.
 * The same ownership ends a finished run (endClosedRun, GST-4109): an open record whose own ledger closed (Step 22's close) is marked
 * finished, so it no longer blocks the next /ship on the checkout, while a record whose ledger is still open keeps blocking.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { changeRunRecord, ownerGone, readRunRecord, type RunRecord } from './ship-run-record';

export const LEDGER_HOLD_MS = 360 * 60_000;
export const REVIEW_START_HOLD_MS = 120 * 60_000;
const PREFLIGHT_AFTER_START_MS = 5 * 60_000;

const ENDED = new Set(['finished', 'abandoned']);
const recordEnded = (checkout: unknown, ours: (r: RunRecord) => boolean) => {
  if (typeof checkout !== 'string' || !checkout) return false;
  const read = readRunRecord(checkout);
  return read.kind === 'record' && ENDED.has(read.record.state) && ours(read.record);
};
const fresh = (file: string, within: number, now: number) => { try { return now - fs.statSync(file).mtimeMs < within; } catch { return false; } };
const json = (file: string): Record<string, any> | null => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const dirs = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)); } catch { return []; } };
const files = (dir: string, ext: string) => { try { return fs.readdirSync(dir).filter(n => n.endsWith(ext)).map(n => path.join(dir, n)); } catch { return []; } };

type Ledgers = Array<{ file: string; l: Record<string, any> }>;
const shipLedgers = (stateRoot: string): Ledgers => dirs(path.join(stateRoot, 'ship-runs')).map(d => ({ file: path.join(d, 'budget.json'), l: json(path.join(d, 'budget.json')) }))
  .filter((x): x is Ledgers[number] => x.l?.kind === 'gstack-ship-budget');
const created = (l: Record<string, any>) => Date.parse(String(l.created_at));
/** Whether a run record is this ledger's: the ledger is the one newest ledger for its checkout created at or before the record opened. */
const owns = (ledgers: Ledgers, l: Record<string, any>) => (r: RunRecord) => {
  const before = ledgers.filter(x => x.l.checkout === l.checkout && created(x.l) <= Date.parse(r.started_at)).map(x => created(x.l));
  const newest = Math.max(...before);
  return created(l) === newest && before.filter(t => t === newest).length === 1;
};

/**
 * End a finished run: when the checkout's record is open and its own ledger (owns) closed after the record opened and belongs to that
 * record's run (the record opened within PREFLIGHT_AFTER_START_MS of the ledger's start, as /ship's start-then-preflight does, or the
 * ledger noted or reserved after the record opened), mark it finished (ended_by gstack-ship-budget close) and return the RUN_ENDED
 * line; null when there is nothing to end. Any other ledger belongs to an earlier run (a later run that wrote no ledger of its own,
 * such as an unmetered start, sits behind it), so its late close never ends that record. `checkout` is the git toplevel a ledger records.
 */
export function endClosedRun(checkout: string, stateRoot: string): string | null {
  const read = readRunRecord(checkout);
  if (read.kind !== 'record' || read.record.state !== 'open') return null;
  const ledgers = shipLedgers(stateRoot).filter(x => x.l.checkout === checkout);
  const mine = ledgers.find(x => owns(ledgers, x.l)(read.record));
  const opened = Date.parse(read.record.started_at);
  const worked = mine && (opened - created(mine.l) <= PREFLIGHT_AFTER_START_MS
    || [...(mine.l.notes ?? []), ...(mine.l.reservations ?? [])].some((x: { at?: string }) => Date.parse(String(x.at)) >= opened));
  if (!mine?.l.closed_at || opened > Date.parse(mine.l.closed_at) || !worked) return null;
  const run = read.record.run;
  const done = changeRunRecord(checkout, 'close', run, { ended_by: 'gstack-ship-budget close' });
  return done.ok ? `RUN_ENDED: run=${run} state=finished ended_by=gstack-ship-budget close (its budget ledger ${path.basename(path.dirname(mine.file))} closed at ${mine.l.closed_at})` : null;
}

/** The first run that still holds upgrades, as "<kind> run <id> (<file>)", or undefined; ended lists what no longer holds and why. */
export function liveRun(stateRoot: string, now = Date.now()): { live?: string; ended: string[] } {
  const ended: string[] = [];
  const ledgers = shipLedgers(stateRoot);
  for (const { file, l } of ledgers) {
    if (!fresh(file, LEDGER_HOLD_MS, now)) continue;
    if (!l || l.closed_at || l.superseded_by) continue;
    const id = path.basename(path.dirname(file));
    if (ownerGone(l.owner)) { ended.push(`/ship run ${id}: its owner process ${l.owner.pid} is gone`); continue; }
    if (recordEnded(l.checkout, owns(ledgers, l))) { ended.push(`/ship run ${id}: the run record in ${l.checkout} has ended`); continue; }
    return { live: `/ship run ${id} (${file})`, ended };
  }
  for (const project of dirs(path.join(stateRoot, 'projects'))) {
    for (const file of files(path.join(project, '.review-starts'), '.json')) {
      if (!fresh(file, REVIEW_START_HOLD_MS, now)) continue;
      const s = json(file);
      const id = path.basename(file, '.json');
      if (ownerGone(s?.owner)) { ended.push(`review run ${id}: its owner process ${s!.owner.pid} is gone`); continue; }
      if (s?.fix_check && recordEnded(s.repo, r => r.run === s.fix_check.run)) { ended.push(`review run ${id}: the /ship run record in ${s.repo} has ended`); continue; }
      return { live: `review run ${id} (${file})`, ended };
    }
  }
  return { ended };
}
