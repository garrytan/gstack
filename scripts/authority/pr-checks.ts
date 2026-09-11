import { classifyRequiredChecks, snapshotRequiredChecks } from '../../lib/provider-access';

function usage(): never { console.error('usage: snapshot|poll --pr N'); process.exit(2); }
const args = process.argv.slice(2);
const command = args.shift();
let pr = 0, deadlineMs = 15 * 60_000, intervalMs = 2_000;
while (args.length) {
  const flag = args.shift(), value = args.shift();
  if (flag === '--pr' && value && /^[1-9][0-9]*$/.test(value)) pr = Number(value);
  else if (process.env.ECPE_TESTING === '1' && flag === '--deadline-ms' && value && /^\d+$/.test(value)) deadlineMs = Number(value);
  else if (process.env.ECPE_TESTING === '1' && flag === '--interval-ms' && value && /^\d+$/.test(value)) intervalMs = Number(value);
  else usage();
}
if (!['snapshot', 'poll'].includes(command ?? '') || !pr) usage();
try {
  let snapshot = await snapshotRequiredChecks(process.cwd(), pr);
  if (command === 'poll') {
    const deadline = Bun.nanoseconds() + deadlineMs * 1_000_000;
    while (snapshot.summary.status === 'pending' && Bun.nanoseconds() < deadline) { await Bun.sleep(intervalMs); snapshot = await snapshotRequiredChecks(process.cwd(), pr); }
    if (snapshot.summary.status === 'pending') snapshot.summary = classifyRequiredChecks(snapshot.checks, { timedOut: true });
  }
  console.log(JSON.stringify(snapshot));
  if (command === 'poll' && snapshot.summary.status !== 'ready') process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'provider_error' })); process.exitCode = 1; }
