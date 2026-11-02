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

try {
  const { formatPrice } = load('src/format-price.js');
  for (const [cents, want] of [[1005, '$10.05'], [1250, '$12.50'], [999, '$9.99'], [5, '$0.05'], [100000, '$1000.00']]) {
    expect(formatPrice(cents) === want, 'formatPrice(' + cents + ') should be ' + want);
  }
} catch (err) { expect(false, 'src/format-price.js failed to load: ' + err.message); }
expect(unchanged('run-tests.js'), 'run-tests.js must not change');
expect(runNode('run-tests.js').status === 0, 'node run-tests.js must pass');
finish();
