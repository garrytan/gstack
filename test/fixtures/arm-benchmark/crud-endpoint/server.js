const http = require('node:http');
const { handleRequest } = require('./app');

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = null; }
    }
    const result = handleRequest(req.method, req.url, body);
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(result.body === undefined ? '' : JSON.stringify(result.body));
  });
});

if (require.main === module) {
  server.listen(3000, () => console.log('notes api on :3000'));
}

module.exports = { server };
