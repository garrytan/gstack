#!/usr/bin/env node
// gstack preview fixtures: serve a frontend on loopback with canned API
// answers, one scenario per state, so /design-review --build can lint and
// screenshot the states a spec names. docs/howto-preview-a-frontend.md is the
// contract. Two ways to run it:
//
//   start --root <app dir> --fixtures <dir> [--port 5300] [--api /api/] [--state <dir>] [--static]
//     Without --static: the repo's own Vite (resolved from --root, never
//     installed by gstack) with its own config plus this file's plugin.
//     With --static: a plain file server over --root (a built or hand-written
//     page) with the same shim and fixture API.
//   stop --state <dir>   (or --port <n>, which finds the default state dir)
//
// A request under the API prefix is answered only from
// <fixtures>/<scenario>.json; anything else under the prefix is a 501 problem
// document naming the route and the file to edit, recorded in
// <state>/unhandled.jsonl, never passed to a live backend; so is a path the
// app's own server.proxy would forward. Loopback only, a
// port this process owns (strict), a private redacted log, a clean stop.
//
// Plugin use inside a repo's vite.config: import { gstackPreviewFixtures }
// from this file and add gstackPreviewFixtures({ fixtures: '<dir>' }).

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DOC = 'https://github.com/garrytan/gstack/blob/main/docs/howto-preview-a-frontend.md';
const HOST = '127.0.0.1';
const SCENARIO = /^[A-Za-z0-9._-]{1,64}$/;
const SECRET_PARAM = /token|key|secret|auth|session|sig|signature|password|pass|code|jwt|bearer/i;

export const FIXES = {
  PREVIEW_NO_VITE: 'install vite in the app (npm i -D vite), or pass --static to serve built files',
  PREVIEW_CONFIG: "fix the app's vite config so 'vite' starts on its own, then rerun",
  PREVIEW_PORT: 'stop whatever holds the port, or pass another --port',
  PREVIEW_HOST: 'the preview listens on 127.0.0.1 only; drop --host',
  PREVIEW_USAGE: 'see ' + DOC,
  PREVIEW_NO_SCENARIO: 'open the page with ?as=<scenario>; the shim carries it to API calls',
  PREVIEW_UNKNOWN_SCENARIO: 'add <fixtures>/<scenario>.json with {"version":1,"routes":{}}',
  PREVIEW_UNHANDLED: 'add the route to the scenario file',
  PREVIEW_LIVE_PROXY: 'serve the route under the API prefix from a fixture',
  PREVIEW_STATE: 'pass --state <a private directory this user owns>',
};

/** Userinfo dropped and secret-looking parameter values replaced, up to the next &, # or whitespace. */
export function redact(s) {
  return String(s)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1')
    .replace(/([?&#;])([^=&#?;\s]+)=([^&#\s]*)/g, (all, sep, key) => (SECRET_PARAM.test(key) ? `${sep}${key}=REDACTED` : all));
}

/** The script every HTML page gets first: ?as= persists for the tab and rides every same-origin fetch and XHR as x-gstack-scenario. */
export const SHIM = `(function(){var K='gstack-scenario',q=null;try{q=new URLSearchParams(location.search).get('as');if(q!==null)sessionStorage.setItem(K,q);else q=sessionStorage.getItem(K);}catch(e){}
if(!q)return;window.__gstackScenario=q;
function same(u){try{return new URL(u,location.href).origin===location.origin}catch(e){return false}}
var f=window.fetch;if(f){window.fetch=function(input,init){var u=typeof input==='string'?input:(input&&input.url)||String(input);if(!same(u))return f.call(this,input,init);init=Object.assign({},init||{});var h=new Headers(init.headers||(typeof Request!=='undefined'&&input instanceof Request?input.headers:undefined));h.set('x-gstack-scenario',q);init.headers=h;return f.call(this,input,init)}}
var X=window.XMLHttpRequest&&XMLHttpRequest.prototype;if(X){var o=X.open,s=X.send;X.open=function(m,u){this.__gstackSame=same(u);return o.apply(this,arguments)};X.send=function(){if(this.__gstackSame)this.setRequestHeader('x-gstack-scenario',q);return s.apply(this,arguments)}}})();`;

export function injectShim(html) {
  const tag = `<script data-gstack-preview>${SHIM}</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + tag) : tag + html;
}

function scenarioOf(req, url) {
  const header = req.headers['x-gstack-scenario'];
  if (typeof header === 'string' && header) return header;
  const q = url.searchParams.get('as');
  if (q) return q;
  try { return new URL(req.headers.referer ?? '').searchParams.get('as') ?? ''; } catch { return ''; }
}

function matchRoute(routes, method, pathname) {
  if (routes[`${method} ${pathname}`]) return routes[`${method} ${pathname}`];
  const parts = pathname.split('/');
  for (const [key, value] of Object.entries(routes)) {
    const [m, p] = key.split(' ');
    if (m !== method || !p) continue;
    const want = p.split('/');
    if (want.length === parts.length && want.every((w, i) => w.startsWith(':') || w === parts[i])) return value;
  }
  return null;
}

/** Connect-style middleware answering the API prefix from fixtures; everything else goes to next(). */
export function createFixtureMiddleware({ fixtures, api = '/api/', stateDir, log = () => {}, proxied = [] }) {
  const record = (hit) => { if (stateDir) fs.appendFileSync(path.join(stateDir, 'unhandled.jsonl'), JSON.stringify(hit) + '\n', { mode: 0o600 }); };
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://' + HOST);
    const method = (req.method ?? 'GET').toUpperCase();
    const scenario = scenarioOf(req, url);
    const fail = (code, detail, fixLine) => {
      record({ scenario, method, path: redact(url.pathname), code });
      log(`${method} ${redact(url.pathname + url.search)} 501 ${code} scenario=${scenario || '-'}`);
      res.writeHead(501, { 'content-type': 'application/problem+json', 'x-gstack-preview': code, 'cache-control': 'no-store' });
      res.end(JSON.stringify({ type: `${DOC}#${code.toLowerCase().replace(/_/g, '-')}`, title: 'No fixture answers this request', status: 501, code, detail, fix: fixLine }));
    };
    const live = url.pathname.startsWith(api) ? undefined : proxied.find((k) => (k.startsWith('^') ? new RegExp(k).test(req.url ?? '/') : (req.url ?? '/').startsWith(k)));
    if (live !== undefined) return fail('PREVIEW_LIVE_PROXY', `${method} ${url.pathname} matches the app's dev proxy "${live}", a live backend`, `serve it under ${api} from a fixture`);
    if (!url.pathname.startsWith(api)) return next();
    if (url.pathname === api + '__gstack-preview') { res.writeHead(204, { 'x-gstack-preview': 'ready', 'x-gstack-preview-state': stateDir ? encodeURIComponent(stateDir) : '', 'cache-control': 'no-store' }); return res.end(); }
    if (!scenario) return fail('PREVIEW_NO_SCENARIO', `${method} ${url.pathname} arrived with no scenario (no x-gstack-scenario header, ?as= or Referer ?as=)`, FIXES.PREVIEW_NO_SCENARIO);
    const file = path.join(fixtures, `${scenario}.json`);
    if (!SCENARIO.test(scenario) || !fs.existsSync(file)) return fail('PREVIEW_UNKNOWN_SCENARIO', `scenario "${redact(scenario)}" has no fixture file`, `add ${path.join(fixtures, '<scenario>.json')} with {"version":1,"routes":{}}`);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fail('PREVIEW_UNKNOWN_SCENARIO', `${file} is not JSON (${e.message})`, 'fix the JSON in ' + file); }
    const route = matchRoute(doc.routes ?? {}, method, url.pathname);
    if (!route) return fail('PREVIEW_UNHANDLED', `scenario "${scenario}" has no route "${method} ${url.pathname}"`, `add "${method} ${url.pathname}": {"status":200,"json":…} to ${file}`);
    const status = Number(route.status ?? 200);
    const finish = () => {
      try { res.writeHead(status, { 'content-type': 'json' in route ? 'application/json' : 'text/plain', 'cache-control': 'no-store', ...(route.headers ?? {}) }); }
      catch (e) { return fail('PREVIEW_UNKNOWN_SCENARIO', `route "${method} ${url.pathname}" in ${file} has a bad status or header (${e.message})`, 'fix that route in ' + file); }
      log(`${method} ${redact(url.pathname + url.search)} ${status} scenario=${scenario}`);
      res.end('json' in route ? JSON.stringify(route.json) : String(route.body ?? ''));
    };
    req.resume();
    if (route.delay_ms) setTimeout(finish, Number(route.delay_ms)); else finish();
  };
}

/** The Vite plugin: the shim in every HTML page, the fixture API ahead of the app's own middleware. */
export function gstackPreviewFixtures({ fixtures, api = '/api/', stateDir, log } = {}) {
  return {
    name: 'gstack-preview-fixtures',
    apply: 'serve',
    transformIndexHtml: () => [{ tag: 'script', attrs: { 'data-gstack-preview': '' }, children: SHIM, injectTo: 'head-prepend' }],
    configureServer(server) { server.middlewares.use(createFixtureMiddleware({ fixtures: path.resolve(fixtures), api, stateDir, log, proxied: Object.keys(server.config?.server?.proxy ?? {}) })); },
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function staticHandler(root, api) {
  const base = path.resolve(root);
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + HOST);
    let file;
    try { file = path.join(base, decodeURIComponent(url.pathname)); } catch { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad escape in the path'); }
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); return res.end('outside the preview root'); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && !path.extname(url.pathname) && !url.pathname.startsWith(api)) file = path.join(base, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(file);
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(ext === '.html' ? injectShim(body.toString('utf8')) : body);
  };
}

class PreviewError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--static') out.static = true;
    else if (a.startsWith('--')) {
      if (argv[i + 1] === undefined) throw new PreviewError('PREVIEW_USAGE', `${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/** The app's own Vite: a node_modules/vite at or above the root. A runtime's global cache (Bun's auto-install) does not count. */
function hasLocalVite(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'vite', 'package.json'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

const defaultState = (port) => path.join(os.tmpdir(), `gstack-preview-${port}`);
const ownState = (dir) => {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new PreviewError('PREVIEW_STATE', `${dir} is a link or not a directory this user owns`);
};

async function start(o) {
  if (o.host && o.host !== HOST && o.host !== 'localhost') throw new PreviewError('PREVIEW_HOST', `--host ${o.host} is not loopback`);
  if (!o.root || !o.fixtures) throw new PreviewError('PREVIEW_USAGE', 'start needs --root <app dir> and --fixtures <dir>');
  const port = Number(o.port ?? 5300);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PreviewError('PREVIEW_USAGE', `--port ${o.port} is not a port number`);
  const api = o.api ?? '/api/';
  const root = path.resolve(o.root);
  const fixtures = path.resolve(o.fixtures);
  const stateDir = path.resolve(o.state ?? defaultState(port || 'auto'));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  ownState(stateDir);
  fs.chmodSync(stateDir, 0o700);
  const logFile = path.join(stateDir, 'preview.log');
  fs.writeFileSync(logFile, '', { mode: 0o600 });
  fs.chmodSync(logFile, 0o600);
  fs.rmSync(path.join(stateDir, 'unhandled.jsonl'), { force: true });
  const log = (line) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${redact(line)}\n`);
  const fixtureMw = createFixtureMiddleware({ fixtures, api, stateDir, log });

  let close;
  let actualPort;
  if (o.static) {
    const serve = staticHandler(root, api);
    const server = http.createServer((req, res) => fixtureMw(req, res, () => { log(`${req.method} ${redact(req.url)}`); serve(req, res); }));
    await new Promise((resolve, reject) => {
      server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new PreviewError('PREVIEW_PORT', `port ${port} on ${HOST} is taken`) : e));
      server.listen(port, HOST, resolve);
    });
    actualPort = server.address().port;
    close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  } else {
    let vitePath;
    try {
      if (!hasLocalVite(root)) throw new Error('no node_modules/vite');
      vitePath = createRequire(path.join(root, 'package.json')).resolve('vite');
    } catch { throw new PreviewError('PREVIEW_NO_VITE', `no vite package resolves from ${root}`); }
    const vite = await import(pathToFileURL(vitePath).href);
    let server;
    try {
      server = await vite.createServer({ root, logLevel: 'silent', server: { host: HOST, port, strictPort: true }, plugins: [gstackPreviewFixtures({ fixtures, api, stateDir, log })] });
    } catch (e) { throw new PreviewError('PREVIEW_CONFIG', `vite could not load the app's config: ${redact(e.message)}`); }
    try { await server.listen(); } catch (e) {
      await server.close();
      throw /EADDRINUSE|in use/.test(e.message) ? new PreviewError('PREVIEW_PORT', `port ${port} on ${HOST} is taken`) : new PreviewError('PREVIEW_CONFIG', redact(e.message));
    }
    actualPort = server.httpServer.address().port;
    close = () => server.close();
  }
  const url = `http://${HOST}:${actualPort}/`;
  fs.writeFileSync(path.join(stateDir, 'preview.json'), JSON.stringify({ pid: process.pid, port: actualPort, url, log: logFile }) + '\n', { mode: 0o600 });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await close();
    fs.rmSync(path.join(stateDir, 'preview.json'), { force: true });
    log('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`PREVIEW: ready url=${url} mode=${o.static ? 'static' : 'vite'} state=${stateDir} log=${logFile}`);
}

async function stopCmd(o) {
  const stateDir = path.resolve(o.state ?? defaultState(o.port ?? 5300));
  const file = path.join(stateDir, 'preview.json');
  if (!fs.existsSync(file)) { console.log(`PREVIEW: stopped (nothing running for ${stateDir})`); return; }
  ownState(stateDir);
  const { pid, port } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (alive()) process.kill(pid, 'SIGTERM');
  const running = () => fs.existsSync(file) && alive();
  for (let i = 0; i < 50 && running(); i++) await new Promise((r) => setTimeout(r, 100));
  if (running()) throw new PreviewError('PREVIEW_STOP', `process ${pid} did not stop within 5 s`);
  fs.rmSync(file, { force: true });
  console.log(`PREVIEW: stopped port=${port}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  if (cmd === 'start') return start(o);
  if (cmd === 'stop') return stopCmd(o);
  throw new PreviewError('PREVIEW_USAGE', 'usage: preview-fixtures.mjs start --root <dir> --fixtures <dir> [--port 5300] [--api /api/] [--state <dir>] [--static] | stop --state <dir>');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  main(process.argv.slice(2)).catch((e) => {
    const code = e.code && FIXES[e.code] !== undefined ? e.code : e.code === 'PREVIEW_STOP' ? e.code : 'PREVIEW_CONFIG';
    console.error(`PREVIEW: fail code=${code} ${redact(e.message)} | fix: ${FIXES[code] ?? 'kill the process named, then rerun'}`);
    process.exit(code === 'PREVIEW_USAGE' || code === 'PREVIEW_HOST' ? 3 : 4);
  });
}
