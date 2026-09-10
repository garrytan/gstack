const assert = require('node:assert');
const { formatPrice } = require('./src/format-price');

assert.strictEqual(formatPrice(1250), '$12.50');
assert.strictEqual(formatPrice(1005), '$10.05');
assert.strictEqual(formatPrice(999), '$9.99');

console.log('all price tests passed');
