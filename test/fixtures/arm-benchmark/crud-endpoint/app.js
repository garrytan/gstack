// Tiny in-memory notes API. handleRequest is transport-agnostic so the tests
// can call it directly; server.js wires it to node:http.
let nextId = 1;
const notes = new Map();

function handleRequest(method, path, body) {
  if (method === 'GET' && path === '/notes') {
    return { status: 200, body: [...notes.values()] };
  }
  if (method === 'POST' && path === '/notes') {
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return { status: 400, body: { error: 'text is required' } };
    }
    const note = { id: nextId++, text: body.text.trim() };
    notes.set(note.id, note);
    return { status: 201, body: note };
  }
  return { status: 404, body: { error: 'not found' } };
}

function resetForTests() {
  nextId = 1;
  notes.clear();
}

module.exports = { handleRequest, resetForTests };
