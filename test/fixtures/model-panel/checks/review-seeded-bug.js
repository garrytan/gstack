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

const review = read('REVIEW.md');
expect(review.trim().length > 0, 'REVIEW.md must exist');
expect(/users\.js/i.test(review), 'review names src/users.js');
expect(/inject|parameteri[sz]|placeholder|bind|concatenat/i.test(review), 'review flags the SQL injection through search');
expect(/off[- ]by[- ]one|page\s*-\s*1|\(page\s*-\s*1\)|first page|skips?\s+(the\s+)?first|pages? start at 1/i.test(review), 'review flags the page offset bug');
expect(unchanged('src'), 'source files must not change during review');
finish();
