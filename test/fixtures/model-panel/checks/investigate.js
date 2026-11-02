const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || '.');
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };
const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 15_000 });
const seed = () => git('rev-list', '--max-parents=0', 'HEAD').stdout.trim().split('\n').pop();
const unchanged = (file) => git('diff', '--quiet', seed(), '--', file).status === 0;
const runNode = (file) => spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
const read = (file) => { try { return fs.readFileSync(path.join(dir, file), 'utf-8'); } catch { return ''; } };
const load = (file) => { const p = path.join(dir, file); delete require.cache[require.resolve(p)]; return require(p); };
const finish = () => {
  if (failures.length) { console.error('FAIL: ' + failures.join('; ')); process.exit(1); }
  console.log('PASS');
};

expect(runNode('run-tests.js').status === 0, 'node run-tests.js must pass');
expect(unchanged('run-tests.js'), 'run-tests.js must not change');
expect(unchanged('src/retry.js'), 'the retry decoy must not change');
try {
  process.env.TZ = 'Pacific/Kiritimati';
  const { dayOfMonth } = load('src/dates.js');
  expect(dayOfMonth('2026-03-08') === 8 && dayOfMonth('2026-01-01') === 1, 'dayOfMonth is right in a UTC+14 zone too');
} catch (err) { expect(false, 'src/dates.js failed: ' + err.message); }
finish();
