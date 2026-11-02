#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * investigate-gate settings — the Claude Code hooks block for one arm of the
 * GST-938 eval (plan v3). Every arm gets the observation-only recorder; only H
 * adds the reproduce-first gate. S and H therefore run the same /investigate
 * skill bytes and differ only in these hooks. The harness passes the output to
 * `claude -p --settings <file>` from a path outside the model's home.
 *
 *   bun scripts/investigate-gate/settings.ts --arm N|S|H --recorder "<cmd>" [--gate "<cmd>"]
 */
type Hook = { type: 'command'; command: string };
type Entry = { matcher: string; hooks: Hook[] };

export function armSettings(arm: string, recorder: string, gate?: string): { hooks: Record<string, Entry[]> } {
  if (!['N', 'S', 'H'].includes(arm)) throw new Error(`unknown arm ${arm}`);
  if (arm === 'H' && !gate) throw new Error('arm H needs --gate');
  const rec: Entry = { matcher: '*', hooks: [{ type: 'command', command: recorder }] };
  const hooks: Record<string, Entry[]> = { PreToolUse: [rec], PostToolUse: [rec], PostToolUseFailure: [rec] };
  if (arm === 'H') {
    const g: Hook = { type: 'command', command: `GSTACK_INVESTIGATE_GATES=1 ${gate}` };
    hooks.PreToolUse = [...hooks.PreToolUse, { matcher: 'Edit|Write|NotebookEdit|Bash', hooks: [g] }];
    hooks.PostToolUse = [...hooks.PostToolUse, { matcher: 'Bash', hooks: [g] }];
    hooks.PostToolUseFailure = [...hooks.PostToolUseFailure, { matcher: 'Bash', hooks: [g] }];
  }
  return { hooks };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const arm = get('--arm') ?? '';
    const recorder = get('--recorder');
    if (!recorder) throw new Error('--recorder is required');
    process.stdout.write(`${JSON.stringify(armSettings(arm, recorder, get('--gate')), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\nusage: settings.ts --arm N|S|H --recorder "<cmd>" [--gate "<cmd>"]\n`);
    process.exit(2);
  }
}
