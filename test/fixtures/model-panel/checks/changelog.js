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

const original13 = '## 1.3.0\n\n- You can now attach photos to a trail note.\n- Fixed: the map no longer jumps back to your location while you scroll.\n';
const log = read('CHANGELOG.md');
const first = log.indexOf('## ');
const second = log.indexOf('## ', first + 3);
const entry = first >= 0 && second > first ? log.slice(first, second) : '';
expect(/^## \[?1\.4\.0\]?/.test(entry), 'the first section is 1.4.0, above 1.3.0');
expect(/dark mode/i.test(entry), '1.4.0 mentions dark mode');
expect(/csv/i.test(entry), '1.4.0 mentions CSV export');
expect(/sign(s|ed)? (you )?out|log(s|ged)? (you )?out|time(s|d)?[ -]?out/i.test(entry), '1.4.0 mentions the sign-out fix');
expect(!/eslint|test helpers?|node_modules|\bci\b|workflow/i.test(entry), '1.4.0 leaves out internal-only commits');
expect(log.includes(original13), 'the 1.3.0 section is unchanged');
finish();
