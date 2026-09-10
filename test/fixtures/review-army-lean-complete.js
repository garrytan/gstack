// Lean-and-complete fixture: the false-flag precision case for the
// simplification specialist. This is an ETHOS "choose A" diff — small,
// covers the error path and edge cases, carries its own check. There is
// nothing here to cut; a correct simplification pass returns NO FINDINGS.

function parsePort(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`parsePort: missing value`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`parsePort: expected integer in 1-65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

// Self-check: the smallest thing that fails if the logic breaks.
function testParsePort() {
  const assert = require('node:assert');
  assert.strictEqual(parsePort('8080'), 8080);
  assert.strictEqual(parsePort(443), 443);
  assert.throws(() => parsePort(''), /missing value/);
  assert.throws(() => parsePort('0'), /1-65535/);
  assert.throws(() => parsePort('65536'), /1-65535/);
  assert.throws(() => parsePort('abc'), /1-65535/);
}

module.exports = { parsePort, testParsePort };
