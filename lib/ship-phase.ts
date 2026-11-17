/**
 * ship-phase — one ship/DRIVER.md phase as one command (G2, handoffs/ship-conductor-cost-2026-11-16): measured
 * conductors made 121-308 calls where the driver plans 9 to 12, so a phase's bins now run from one command.
 * `run` executes the phase's commands in order, each in the background with its output in <dir>/phases/<phase>/,
 * and prints only their result lines. A command still running when --wait-s ends (200 s) keeps running and the run
 * prints `NEXT: rerun`: the same command resumes the wait. The journal keeps each finished command by the sha256 of
 * its text, so a rerun after a failure or a restart starts at the first command that has not passed, and a command
 * a restart killed runs again. With --record, a stopped run, or one past 100 minutes (lib/ship-clock.ts), refuses to
 * start the phase and prints the STOP block.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ledgerFileFor, mutateLedger, parseRecordBlock } from './ship-budget';
import { bashCommandInvocation } from './script-invocation';
import { timeStop } from './ship-clock';

export interface PhaseEntry { sha: string; cmd: string; state: 'running' | 'done' | 'failed'; pid?: number; started: string; ended?: string; exit?: number; log: string; lines?: string[] }
export interface Journal { schema_version: 1; phase: string; entries: PhaseEntry[] }
export interface PhaseOut { stdout: string[]; exit: number }

export const WAIT_S_DEFAULT = 200;
const MAX_LINES = 60;
const RESULT_RE = /^(?:[A-Z][A-Z0-9_]*(?:\([^)]*\))?|gstack-[a-z0-9-]+(?: [a-z0-9-]+)?): /;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The lines of a command's output that a parent acts on: `CODE: …` result lines and `gstack-<bin>: …` refusals. */
export function resultLines(text: string): string[] {
  const hits = text.split('\n').map(l => l.trimEnd()).filter(l => RESULT_RE.test(l)).map(l => (l.length > 2000 ? l.slice(0, 2000) + ' …' : l));
  return hits.length > MAX_LINES ? [...hits.slice(0, MAX_LINES - 1), `(${hits.length - MAX_LINES + 1} more result lines in the log)`, hits[hits.length - 1]!] : hits;
}

const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

function readJournal(file: string, phase: string): Journal {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.schema_version === 1 && Array.isArray(j.entries)) return j; } catch { /* a new or unreadable journal starts over */ }
  return { schema_version: 1, phase, entries: [] };
}
function writeJournal(file: string, j: Journal): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Start one command detached: its output goes to the log and its exit status to <log>.exit when it ends, even after this process returns. */
function start(cmd: string, log: string, cwd: string, env: NodeJS.ProcessEnv): number | undefined {
  try { fs.rmSync(`${log}.exit`, { force: true }); } catch { /* absent */ }
  const inv = bashCommandInvocation('( eval "$GSTACK_SHIP_PHASE_CMD" ) >"$GSTACK_SHIP_PHASE_LOG" 2>&1 </dev/null; echo $? >"$GSTACK_SHIP_PHASE_LOG.exit.tmp"; mv "$GSTACK_SHIP_PHASE_LOG.exit.tmp" "$GSTACK_SHIP_PHASE_LOG.exit"');
  if (!inv.ok) { fs.writeFileSync(log, `gstack-ship-phase: ${inv.error}\n`); fs.writeFileSync(`${log}.exit`, '127\n'); return undefined; }
  const child = spawn(inv.cmd, inv.argv, { cwd, env: { ...env, GSTACK_SHIP_PHASE_CMD: cmd, GSTACK_SHIP_PHASE_LOG: log }, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/** The run's stop check before a phase starts: a stopped run, or one past 100 minutes; null to go on (no record, or no ledger yet). */
function preflight(record: string | undefined, phase: string, cwd: string, env: NodeJS.ProcessEnv): string[] | null {
  if (!record || !parseRecordBlock(record)?.ledger) return null;
  return mutateLedger(ledgerFileFor({ record }, env), env, l => {
    if (l.stopped) return [`STOP: run ${l.run} stopped (${l.stopped.reason}) at Step ${l.stopped.step}; nothing ran; resume first: gstack-ship-budget resume --record ${l.record}`, `GSTACK_RESULT: skill=ship status=incomplete run=${l.dir}`];
    return timeStop(l, cwd, `Phase ${phase}`, env, Date.now(), `resume, then rerun Phase ${phase}`);
  });
}

export interface RunOpts { dir: string; phase: string; commands: string[]; record?: string; waitS?: number; cwd: string; env: NodeJS.ProcessEnv; pollMs?: number }

/** run: the phase's commands in order, resumable from the journal; see the header. */
export async function runPhase(o: RunOpts): Promise<PhaseOut> {
  const t0 = Date.now();
  const deadline = t0 + (o.waitS ?? WAIT_S_DEFAULT) * 1000;
  const stopped = preflight(o.record, o.phase, o.cwd, o.env);
  if (stopped) return { stdout: stopped, exit: 3 };
  const dir = path.join(path.resolve(o.dir), 'phases', o.phase);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'journal.json');
  const j = readJournal(file, o.phase);
  const out: string[] = [];
  const n = o.commands.length;
  const firstChanged = j.entries.findIndex((e, i) => i >= n || e.sha !== sha256(o.commands[i]!));
  if (firstChanged >= 0) {
    const live = j.entries.slice(firstChanged).filter(e => e.state === 'running' && alive(e.pid));
    for (const e of live) {
      out.push(`REPLACED: ${j.entries.indexOf(e) + 1}/${n} pid=${e.pid} ran a command this list no longer names; stopping it (log=${e.log})`);
      try { process.kill(-e.pid!, 'SIGTERM'); } catch { /* already gone */ }
    }
    for (let t = 0; t < 50 && live.some(e => alive(e.pid)); t++) await Bun.sleep(100);
    const stuck = live.filter(e => alive(e.pid));
    if (stuck.length) return { stdout: [...out, `STOP: phase ${o.phase}: replaced command pid ${stuck.map(e => e.pid).join(',')} is still running and shares its log and exit file with the new list; stop it (kill -- -<pid>), then rerun the same command`], exit: 3 };
    j.entries.length = firstChanged;
  }
  for (let i = 0; i < n; i++) {
    const cmd = o.commands[i]!;
    const k = `${i + 1}/${n}`;
    let e = j.entries[i];
    if (e?.state === 'done') { out.push(`RAN: ${k} exit=0 (done earlier)`, ...(e.lines ?? [])); continue; }
    if (!e || e.state === 'failed' || (e.state === 'running' && !alive(e.pid) && !fs.existsSync(`${e.log}.exit`))) {
      const log = path.join(dir, `${i + 1}.log`);
      e = j.entries[i] = { sha: sha256(cmd), cmd, state: 'running', started: new Date().toISOString(), log };
      e.pid = start(cmd, log, o.cwd, o.env);
      writeJournal(file, j);
    }
    while (!fs.existsSync(`${e.log}.exit`)) {
      if (Date.now() >= deadline) {
        const ran = Math.round((Date.now() - Date.parse(e.started)) / 1000);
        out.push(`WAITING: ${k} pid=${e.pid ?? 'unknown'} running=${ran}s log=${e.log}`, `NEXT: rerun (the same gstack-ship-phase command resumes the wait; commands before ${i + 1} stay done)`);
        return { stdout: out, exit: 0 };
      }
      if (!alive(e.pid) && !fs.existsSync(`${e.log}.exit`)) { await Bun.sleep(200); if (!fs.existsSync(`${e.log}.exit`)) break; }
      await Bun.sleep(o.pollMs ?? 500);
    }
    const raw = fs.existsSync(`${e.log}.exit`) ? fs.readFileSync(`${e.log}.exit`, 'utf8').trim() : '';
    const code = /^\d+$/.test(raw) ? Number(raw) : -1;
    const text = fs.existsSync(e.log) ? fs.readFileSync(e.log, 'utf8') : '';
    e.exit = code; e.ended = new Date().toISOString(); e.lines = resultLines(text); e.state = code === 0 ? 'done' : 'failed';
    writeJournal(file, j);
    out.push(`RAN: ${k} exit=${code < 0 ? 'lost' : code}${code === 0 ? '' : ` log=${e.log}`}`, ...e.lines);
    if (code === 0) continue;
    if (!e.lines.length) out.push(...text.trimEnd().split('\n').slice(-5).map(l => `  | ${l.slice(0, 500)}`));
    out.push(`STOP: phase ${o.phase} command ${k} exited ${code < 0 ? 'without a status (killed?)' : code}; fix the cause, then rerun the same command (commands before ${i + 1} stay done)`);
    return { stdout: out, exit: 3 };
  }
  out.push(`PHASE: ${o.phase} done commands=${n} elapsed_s=${Math.round((Date.now() - t0) / 1000)} journal=${file}`);
  return { stdout: out, exit: 0 };
}
