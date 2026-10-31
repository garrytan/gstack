process.env.TZ = 'America/Los_Angeles';
const assert = require('node:assert');
const { dayOfMonth } = require('./src/dates');
const { summary } = require('./src/report');

assert.strictEqual(dayOfMonth('2026-03-08'), 8);
assert.strictEqual(dayOfMonth('2026-12-31'), 31);
assert.strictEqual(summary({ name: 'Mission Peak', date: '2026-07-04' }), 'Mission Peak on day 4');

console.log('all report tests passed');
