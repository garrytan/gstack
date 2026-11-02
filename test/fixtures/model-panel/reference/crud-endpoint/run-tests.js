const assert = require('node:assert');
const { handleRequest, resetForTests } = require('./app');

resetForTests();
const created = handleRequest('POST', '/notes', { text: 'buy trail mix' });
assert.strictEqual(created.status, 201);
assert.strictEqual(handleRequest('DELETE', '/notes/1', null).status, 204);
assert.strictEqual(handleRequest('DELETE', '/notes/1', null).status, 404);
console.log('all notes tests passed');
