const fs = require('node:fs');
const path = require('node:path');
let stage = 'input';
let root;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
try {
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  root = input.root;
  if (typeof root !== 'string' || typeof input.realpath !== 'string' || typeof input.dev !== 'string' || typeof input.ino !== 'string') throw new Error('invalid_input');
  stage = 'identity';
  const state = fs.lstatSync(root, { bigint: true });
  const identity = {
    directory: state.isDirectory() && !state.isSymbolicLink(),
    pathMatches: samePath(fs.realpathSync(root), input.realpath),
    deviceMatches: state.dev.toString() === input.dev,
    inodeMatches: state.ino.toString() === input.ino,
  };
  if (Object.values(identity).some(value => !value)) {
    console.log(JSON.stringify({ removed: false, reason: 'identity_mismatch', identity }));
    process.exitCode = 1;
  } else {
    stage = 'remove';
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 0 });
    console.log(JSON.stringify({ removed: !fs.existsSync(root), identity, retries: 0 }));
  }
} catch (error) {
  const code = ['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EINVAL', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code) ? error.code : 'filesystem_error';
  let failingPath = null;
  let metadata = null;
  if (typeof root === 'string' && typeof error.path === 'string') {
    const relative = path.relative(root, error.path);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      failingPath = relative || '.';
      try {
        const state = fs.lstatSync(error.path);
        metadata = { mode: state.mode, directory: state.isDirectory(), link: state.isSymbolicLink() };
      } catch {}
    }
  }
  console.log(JSON.stringify({ removed: false, stage, code, failingPath, metadata }));
  process.exitCode = 1;
}
