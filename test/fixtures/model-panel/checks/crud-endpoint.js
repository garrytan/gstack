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
  const { handleRequest, resetForTests } = load('app.js');
  resetForTests();
  const created = handleRequest('POST', '/notes', { text: 'pack water' });
  expect(created.status === 201, 'POST /notes still returns 201');
  expect(handleRequest('DELETE', '/notes/' + created.body.id, null).status === 204, 'DELETE of an existing note returns 204');
  expect(handleRequest('DELETE', '/notes/' + created.body.id, null).status === 404, 'second DELETE returns 404');
  expect(handleRequest('DELETE', '/notes/999', null).status === 404, 'DELETE of an unknown id returns 404');
  const listed = handleRequest('GET', '/notes', null);
  expect(Array.isArray(listed.body) && listed.body.length === 0, 'deleted note is gone from GET /notes');
} catch (err) { expect(false, 'app.js failed: ' + err.message); }
expect(/DELETE/.test(read('run-tests.js')), 'run-tests.js covers DELETE');
expect(runNode('run-tests.js').status === 0, 'node run-tests.js must pass');
finish();
