/**
 * GST-1613: a Linux test runner that is a child subreaper (prctl PR_SET_CHILD_SUBREAPER) adopts every orphan its
 * tests leave and never reaps it, so a detached process that exits stays a zombie that kill -0 and tail --pid count
 * as alive. lib/land-merged-checks.ts sets the flag on its caller, so tests run it in a child Bun.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import * as fs from 'node:fs';

const openLibc = () => dlopen('libc.so.6', { prctl: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } }).symbols;
let libc: ReturnType<typeof openLibc> | undefined;

/** PR_GET_CHILD_SUBREAPER for this process; false off Linux. */
export function isChildSubreaper(): boolean {
  if (process.platform !== 'linux') return false;
  libc ??= openLibc();
  const flag = new Int32Array(1);
  return libc.prctl(37, ptr(flag), 0, 0, 0) === 0 && flag[0] !== 0;
}

/** This process's zombie children as `<pid> <comm>`; [] off Linux. */
export function zombieChildren(): string[] {
  if (process.platform !== 'linux') return [];
  return fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).flatMap(d => {
    let stat = '';
    try { stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { return []; }
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return state === 'Z' && Number(ppid) === process.pid ? [`${d} ${stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))}`] : [];
  });
}
