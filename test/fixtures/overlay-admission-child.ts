/** Synthetic scheduling child; executed in its own Bun process only. */
const fs = require('node:fs');
const [root, role, receipts] = process.argv.slice(2);
const lock = root + '/overlay-active', release = root + '/release-first';
const record = event => fs.appendFileSync(receipts, JSON.stringify({ role, event, sdk: process.env.GSTACK_SDK_MAX_CONCURRENCY }) + '\n');
const summary = () => console.log('Ran 1 test across 1 file. [1ms]');
const emergency = setTimeout(() => process.exit(88), 8000);
const finish = code => { clearTimeout(emergency); summary(); process.exit(code); };
if (role !== 'normal') {
  try { fs.mkdirSync(lock); } catch { process.exit(41); }
  record('start');
  if (role === 'first') fs.writeFileSync(root + '/first-started', 'ready');
  if (role === 'second') { fs.rmdirSync(lock); record('end'); finish(0); }
  const poll = setInterval(() => {
    if (!fs.existsSync(release)) return;
    clearInterval(poll); fs.rmdirSync(lock); record('end'); finish(3);
  }, 5);
} else {
  const poll = setInterval(() => {
    if (!fs.existsSync(root + '/first-started')) return;
    if (!fs.existsSync(lock)) process.exit(42);
    clearInterval(poll); record('ran-during-overlay'); fs.writeFileSync(release, 'go'); finish(0);
  }, 5);
}
