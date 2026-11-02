import { spawnSync } from 'node:child_process';

// A Windows runner pays a one-time cost the first time it executes a binary, and
// all of it lands on whichever test spawns that binary first. On 12 fresh
// windows-latest VMs (probe run 41205346554) the first launch cost jq +60-250 ms,
// awk +190-290 ms and powershell.exe +1.7-3.1 s over a warm launch; under shard
// load the same first jq or awk launch passed a 5 s per-call kill (Windows Free
// Tests 41195098239, 41174352235) while every later call took about 0.3 s. Pay it
// once here, unasserted, so a per-call kill times the code under test.
export function warmFirstExec(command: string, args: string[]): void {
  spawnSync(command, args, { stdio: 'ignore', timeout: 25_000 });
}
