const assert = require('node:assert');
const { handleRequest, resetForTests } = require('./app');

resetForTests();
assert.deepStrictEqual(handleRequest('GET', '/notes', null), { status: 200, body: [] });

const created = handleRequest('POST', '/notes', { text: 'buy trail mix' });
assert.strictEqual(created.status, 201);
assert.strictEqual(created.body.text, 'buy trail mix');

const listed = handleRequest('GET', '/notes', null);
assert.strictEqual(listed.body.length, 1);

assert.strictEqual(handleRequest('POST', '/notes', {}).status, 400);
assert.strictEqual(handleRequest('GET', '/nope', null).status, 404);

console.log('all notes tests passed');
