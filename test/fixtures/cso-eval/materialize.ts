/** Immutable benchmark source generator. Expected outcomes live outside producer inputs. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CORPUS_VERSION = 'cso-v3-pairs-3';
export const STACKS = ['node', 'bun', 'python', 'rails'] as const;
export const FAMILIES = ['sql-injection', 'command-injection', 'path-traversal', 'ssrf', 'object-authorization', 'tenant-isolation', 'html-injection', 'open-redirect', 'mass-assignment', 'resource-exhaustion'] as const;
export type EvalStack = typeof STACKS[number];
export type EvalFamily = typeof FAMILIES[number];
export type EvalVariant = 'vulnerable' | 'fixed';
export interface CorpusCase {
  id: string; stack: EvalStack; family: EvalFamily; severity: 'critical' | 'high' | 'medium';
  rootCause: string; location: { path: string; symbol: string };
  coreColdStart: true; heldOut: true;
  filesHash: { vulnerable: string; fixed: string };
}
export interface CorpusManifest { schemaVersion: 1; version: string; cases: CorpusCase[] }
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
export function sourceHash(files: Record<string, string>): string {
  return hash(JSON.stringify(Object.keys(files).sort().map(path => [path, hash(files[path])])));
}
function stackCase(id: string): { stack: EvalStack; family: EvalFamily } {
  for (const stack of STACKS) for (const family of FAMILIES) if (id === `${stack}-${family}`) return { stack, family };
  throw new Error('UNKNOWN_CORPUS_CASE');
}
const description: Record<EvalFamily, string> = {
  'sql-injection': 'Look up the note belonging to an exact customer name.',
  'command-injection': 'Format a display name using the system formatting utility. Display names contain letters, digits, underscores, and hyphens.',
  'path-traversal': 'Read a file from the public documents directory.',
  ssrf: 'Load the public status document from the internal status service.',
  'object-authorization': 'Read an invoice belonging to the authenticated member.',
  'tenant-isolation': 'List documents in the authenticated member\'s tenant.',
  'html-injection': 'Render a welcome page containing a visitor-supplied display name as text.',
  'open-redirect': 'Redirect a signed-in member to an application-relative path.',
  'mass-assignment': 'Update the authenticated member\'s display name. Their role is managed by an administrator.',
  'resource-exhaustion': 'Generate up to 100 preview records per request.',
};

interface PublicControl {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, string>;
  status: number;
  bodyIncludes: string;
  location?: string;
}

/**
 * Producer-visible regression controls exercise the feature's intended use.
 * Attack payloads and alternate assertions stay in cso-eval-oracles.ts.
 */
function publicControl(family: EvalFamily): PublicControl {
  const controls: Record<EvalFamily, PublicControl> = {
    'sql-injection': { method: 'GET', path: '/action?name=alice', status: 200, bodyIncludes: 'HELLO_ALICE' },
    'command-injection': { method: 'GET', path: '/action?name=Ada', status: 200, bodyIncludes: 'Ada' },
    'path-traversal': { method: 'GET', path: '/action?file=hello.txt', status: 200, bodyIncludes: 'PUBLIC_HELLO' },
    ssrf: { method: 'GET', path: '/action?url=http%3A%2F%2F127.0.0.1%3A8001%2Fpublic', status: 200, bodyIncludes: 'PUBLIC_STATUS' },
    'object-authorization': { method: 'GET', path: '/action?id=invoice-1', status: 200, bodyIncludes: 'member-1' },
    'tenant-isolation': { method: 'GET', path: '/action?tenant=tenant-a', status: 200, bodyIncludes: 'OWN_TENANT_DOCUMENT' },
    'html-injection': { method: 'GET', path: '/action?name=Alice', status: 200, bodyIncludes: '<main>Welcome Alice</main>' },
    'open-redirect': { method: 'GET', path: '/action?next=%2Faccount', status: 302, bodyIncludes: '/account', location: '/account' },
    'mass-assignment': { method: 'POST', path: '/action', body: { display_name: 'Ada' }, status: 200, bodyIncludes: 'Ada' },
    'resource-exhaustion': { method: 'GET', path: '/action?count=5', status: 200, bodyIncludes: 'count' },
  };
  return controls[family];
}

function javascriptControlTest(stack: 'node' | 'bun', family: EvalFamily): string {
  const control = publicControl(family);
  const imports = stack === 'node'
    ? 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { spawn } from "node:child_process";'
    : 'import { test, expect } from "bun:test";';
  const start = stack === 'node'
    ? 'const child = spawn(process.execPath, ["app.mjs"], {stdio: "ignore"});'
    : 'const child = Bun.spawn({cmd: [process.execPath, "--no-install", "app.ts"], stdout: "ignore", stderr: "ignore"});';
  const stop = stack === 'node'
    ? 'child.kill("SIGTERM");\n    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));'
    : 'child.kill();\n    await child.exited;';
  const equal = stack === 'node'
    ? `assert.equal(response.status, ${control.status});\n    assert.ok(body.includes(${JSON.stringify(control.bodyIncludes)}));${control.location ? `\n    assert.equal(response.headers.get("location"), ${JSON.stringify(control.location)});` : ''}`
    : `expect(response.status).toBe(${control.status});\n    expect(body).toContain(${JSON.stringify(control.bodyIncludes)});${control.location ? `\n    expect(response.headers.get("location")).toBe(${JSON.stringify(control.location)});` : ''}`;
  const options = control.body
    ? `{method: "POST", redirect: "manual", headers: {"content-type": "application/json"}, body: ${JSON.stringify(JSON.stringify(control.body))}}`
    : '{redirect: "manual"}';
  return `${imports}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch("http://127.0.0.1:8000/health")).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("application did not become ready");
}

test("the intended member workflow remains available", async () => {
  ${start}
  try {
    await waitUntilReady();
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:8000${control.path}`)}, ${options});
    const body = await response.text();
    ${equal}
  } finally { ${stop} }
});
`;
}

function pythonControlTest(family: EvalFamily): string {
  const control = publicControl(family);
  const body = control.body ? JSON.stringify(control.body) : '';
  return `import http.client
import json
import subprocess
import sys
import time
import unittest

class IntendedWorkflowTest(unittest.TestCase):
    def test_intended_member_workflow_remains_available(self):
        child = subprocess.Popen([sys.executable, "-I", "app.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=1)
                    connection.request("GET", "/health")
                    if connection.getresponse().status == 200:
                        break
                except OSError:
                    time.sleep(0.02)
            else:
                self.fail("application did not become ready")
            connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=2)
            payload = ${JSON.stringify(body)}
            headers = {"content-type": "application/json"} if payload else {}
            connection.request(${JSON.stringify(control.method)}, ${JSON.stringify(control.path)}, body=payload or None, headers=headers)
            response = connection.getresponse()
            response_body = response.read().decode()
            self.assertEqual(response.status, ${control.status})
            self.assertIn(${JSON.stringify(control.bodyIncludes)}, response_body)
${control.location ? `            self.assertEqual(response.getheader("location"), ${JSON.stringify(control.location)})\n` : ''}        finally:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()

if __name__ == "__main__":
    unittest.main()
`;
}

function railsControlTest(family: EvalFamily): string {
  const control = publicControl(family);
  const verb = control.method.toLowerCase();
  const request = control.body
    ? `${verb} ${JSON.stringify(control.path)}, params: ${JSON.stringify(control.body)}`
    : `${verb} ${JSON.stringify(control.path)}`;
  return `require "test_helper"

class IntendedWorkflowTest < ActionDispatch::IntegrationTest
  test "the intended member workflow remains available" do
    ${request}
    assert_response ${control.status}
    assert_includes response.body, ${JSON.stringify(control.bodyIncludes)}
${control.location ? `    assert_equal ${JSON.stringify(control.location)}, response.headers["Location"]\n` : ''}  end
end
`;
}

function jsSource(stack: 'node' | 'bun', family: EvalFamily, fixed: boolean): string {
  const imports = ['import { createServer } from "node:http";'];
  let setup = '';
  if (family === 'sql-injection') {
    imports.push(stack === 'node' ? 'import { DatabaseSync } from "node:sqlite";' : 'import { Database } from "bun:sqlite";');
    setup += `const db = new ${stack === 'node' ? 'DatabaseSync' : 'Database'}(":memory:");\ndb.exec("CREATE TABLE notes (name TEXT, note TEXT); INSERT INTO notes VALUES ('alice', 'HELLO_ALICE'), ('admin', 'SECRET_ADMIN_NOTE')");\nconst query = (sql, ...args) => db.${stack === 'node' ? 'prepare' : 'query'}(sql).all(...args);\n`;
  }
  if (family === 'command-injection') imports.push('import { execSync, execFileSync } from "node:child_process";');
  if (family === 'path-traversal') imports.push('import { readFileSync } from "node:fs";', 'import { resolve, sep } from "node:path";');
  if (family === 'ssrf') setup += `createServer((request, response) => { response.end(request.url === "/public" ? "PUBLIC_STATUS" : "INTERNAL_SERVICE_SECRET"); }).listen(8001, "127.0.0.1");\n`;
  if (family === 'object-authorization') setup += 'const invoices = {"invoice-1": {owner: "member-1", total: 12}, "invoice-2": {owner: "member-2", total: 9800}};\n';
  if (family === 'tenant-isolation') setup += 'const documents = [{tenant: "tenant-a", body: "OWN_TENANT_DOCUMENT"}, {tenant: "tenant-b", body: "OTHER_TENANT_SECRET"}];\n';
  if (family === 'mass-assignment') setup += 'const account = {id: "member-1", display_name: "Alice", role: "member"};\n';
  const actions: Record<EvalFamily, string> = {
    'sql-injection': fixed
      ? 'return send(200, query("SELECT note FROM notes WHERE name = ?", params.get("name") ?? ""));'
      : 'return send(200, query("SELECT note FROM notes WHERE name = \'" + (params.get("name") ?? "") + "\'"));',
    'command-injection': fixed
      ? 'const name = params.get("name") ?? "";\n  if (!/^[A-Za-z0-9_-]{1,60}$/.test(name)) return send(400, {error: "invalid display name"});\n  return send(200, {output: execFileSync("/usr/bin/printf", ["%s", name], {encoding: "utf8"})});'
      : 'const name = params.get("name") ?? "";\n  return send(200, {output: execSync(\'printf "%s" "\' + name + \'"\', {encoding: "utf8"})});',
    'path-traversal': fixed
      ? 'const base = resolve("public");\n  const file = resolve(base, params.get("file") ?? "hello.txt");\n  if (!file.startsWith(base + sep)) return send(403, {error: "outside public documents"});\n  return send(200, {document: readFileSync(file, "utf8")});'
      : 'const file = resolve("public", params.get("file") ?? "hello.txt");\n  return send(200, {document: readFileSync(file, "utf8")});',
    ssrf: `${fixed ? 'const target = new URL(params.get("url") ?? "http://127.0.0.1:8001/public");\n  if (target.origin !== "http://127.0.0.1:8001" || target.pathname !== "/public" || target.username || target.password || target.search || target.hash) return send(403, {error: "unsupported status source"});\n  const result = await fetch(target, {redirect: "error"});' : 'const result = await fetch(params.get("url") ?? "http://127.0.0.1:8001/public");'}\n  return send(200, {status: await result.text()});`,
    'object-authorization': `const invoice = invoices[params.get("id") ?? "invoice-1"];\n  if (!invoice) return send(404, {error: "not found"});\n  ${fixed ? 'if (invoice.owner !== actor.id) return send(403, {error: "forbidden"});\n  ' : ''}return send(200, invoice);`,
    'tenant-isolation': `return send(200, documents.filter(document => document.tenant === ${fixed ? 'actor.tenant' : '(params.get("tenant") ?? actor.tenant)'}));`,
    'html-injection': `const name = params.get("name") ?? "Alice";\n  ${fixed ? 'const safe = name.replace(/[&<>"\']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;"}[char]));' : 'const safe = name;'}\n  return send(200, "<main>Welcome " + safe + "</main>", "text/html");`,
    'open-redirect': `const target = params.get("next") ?? "/account";\n  ${fixed ? 'if (!/^\\/(?!\\/)/.test(target) || /[\\\\\\r\\n]/.test(target)) return send(400, {error: "invalid redirect"});\n  ' : ''}response.setHeader("Location", target);\n  return send(302, {next: target});`,
    'mass-assignment': `${fixed ? 'if (typeof body.display_name === "string") account.display_name = body.display_name;' : 'Object.assign(account, body);'}\n  return send(200, account);`,
    'resource-exhaustion': `const count = Number(params.get("count") ?? "5");\n  ${fixed ? 'if (!Number.isInteger(count) || count < 1 || count > 100) return send(400, {error: "preview count must be 1-100"});\n  ' : ''}const previews = Array.from({length: count}, (_, index) => "preview-" + index);\n  return send(200, {count: previews.length});`,
  };
  return `${imports.join('\n')}\n${setup}// Authentication middleware has established this member before the endpoint.\nconst actor = Object.freeze({id: "member-1", tenant: "tenant-a", role: "member"});\nasync function action(params, body, response, send) {\n  ${actions[family]}\n}\ncreateServer(async (request, response) => {\n  const send = (status, value, type = "application/json") => {response.writeHead(status, {"content-type": type}); response.end(type === "application/json" ? JSON.stringify(value) : value);};\n  const url = new URL(request.url, "http://127.0.0.1:8000");\n  if (url.pathname === "/health") return send(200, {ready: true});\n  if (url.pathname !== "/action") return send(404, {error: "not found"});\n  try {\n    let raw = "";\n    for await (const part of request) {raw += part; if (raw.length > 16384) return send(413, {error: "body too large"});}\n    await action(url.searchParams, raw ? JSON.parse(raw) : {}, response, send);\n  } catch {send(400, {error: "invalid request"});}\n}).listen(8000, "127.0.0.1");\n`;
}

function pythonSource(family: EvalFamily, fixed: boolean): string {
  const setup: Partial<Record<EvalFamily, string>> = {
    'sql-injection': `db = sqlite3.connect(":memory:", check_same_thread=False)\ndb.executescript("CREATE TABLE notes (name TEXT, note TEXT); INSERT INTO notes VALUES ('alice', 'HELLO_ALICE'), ('admin', 'SECRET_ADMIN_NOTE')")`,
    'object-authorization': 'invoices = {"invoice-1": {"owner": "member-1", "total": 12}, "invoice-2": {"owner": "member-2", "total": 9800}}',
    'tenant-isolation': 'documents = [{"tenant": "tenant-a", "body": "OWN_TENANT_DOCUMENT"}, {"tenant": "tenant-b", "body": "OTHER_TENANT_SECRET"}]',
    'mass-assignment': 'account = {"id": "member-1", "display_name": "Alice", "role": "member"}',
    ssrf: `class StatusService(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200)\n        self.end_headers()\n        self.wfile.write(b"PUBLIC_STATUS" if self.path == "/public" else b"INTERNAL_SERVICE_SECRET")\n    def log_message(self, *args):\n        pass\nthreading.Thread(target=ThreadingHTTPServer(("127.0.0.1", 8001), StatusService).serve_forever, daemon=True).start()`,
  };
  const actions: Record<EvalFamily, string> = {
    'sql-injection': `rows = db.execute(${fixed ? '"SELECT note FROM notes WHERE name = ?", (params.get("name", ""),)' : '"SELECT note FROM notes WHERE name = \'" + params.get("name", "") + "\'"'}).fetchall()\n    return 200, [{"note": row[0]} for row in rows]`,
    'command-injection': `name = params.get("name", "")\n    ${fixed ? 'if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", name):\n        return 400, {"error": "invalid display name"}\n    output = subprocess.check_output(["/usr/bin/printf", "%s", name], text=True)' : 'output = subprocess.check_output(\'printf "%s" "\' + name + \'"\', shell=True, text=True)'}\n    return 200, {"output": output}`,
    'path-traversal': `base = pathlib.Path("public").resolve()\n    path = (base / params.get("file", "hello.txt")).resolve()\n    ${fixed ? 'if base not in path.parents:\n        return 403, {"error": "outside public documents"}\n    ' : ''}return 200, {"document": path.read_text()}`,
    ssrf: `target = params.get("url", "http://127.0.0.1:8001/public")\n    ${fixed ? 'parsed = urllib.parse.urlsplit(target)\n    if parsed.scheme != "http" or parsed.netloc != "127.0.0.1:8001" or parsed.path != "/public" or parsed.query or parsed.fragment:\n        return 403, {"error": "unsupported status source"}\n    ' : ''}with urllib.request.urlopen(target, timeout=2) as result:\n        return 200, {"status": result.read(16384).decode()}`,
    'object-authorization': `invoice = invoices.get(params.get("id", "invoice-1"))\n    if invoice is None:\n        return 404, {"error": "not found"}\n    ${fixed ? 'if invoice["owner"] != actor["id"]:\n        return 403, {"error": "forbidden"}\n    ' : ''}return 200, invoice`,
    'tenant-isolation': `return 200, [document for document in documents if document["tenant"] == ${fixed ? 'actor["tenant"]' : 'params.get("tenant", actor["tenant"])'}]`,
    'html-injection': `name = params.get("name", "Alice")\n    return 200, "<main>Welcome " + ${fixed ? 'html.escape(name, quote=True)' : 'name'} + "</main>"`,
    'open-redirect': `target = params.get("next", "/account")\n    ${fixed ? 'if not target.startswith("/") or target.startswith("//") or any(char in target for char in "\\\\\\r\\n"):\n        return 400, {"error": "invalid redirect"}\n    ' : ''}return 302, {"next": target}`,
    'mass-assignment': `${fixed ? 'if isinstance(body.get("display_name"), str):\n        account["display_name"] = body["display_name"]' : 'account.update(body)'}\n    return 200, account`,
    'resource-exhaustion': `count = int(params.get("count", "5"))\n    ${fixed ? 'if count < 1 or count > 100:\n        return 400, {"error": "preview count must be 1-100"}\n    ' : ''}previews = ["preview-" + str(index) for index in range(count)]\n    return 200, {"count": len(previews)}`,
  };
  return `import html\nimport json\nimport pathlib\nimport re\nimport sqlite3\nimport subprocess\nimport threading\nimport urllib.parse\nimport urllib.request\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n\n${setup[family] ?? ''}\n# Authentication middleware has established this member before the endpoint.\nactor = {"id": "member-1", "tenant": "tenant-a", "role": "member"}\n\ndef action(params, body):\n    ${actions[family]}\n\nclass Application(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.dispatch()\n    def do_POST(self):\n        self.dispatch()\n    def dispatch(self):\n        url = urllib.parse.urlsplit(self.path)\n        params = dict(urllib.parse.parse_qsl(url.query))\n        try:\n            size = int(self.headers.get("Content-Length", "0"))\n            if size < 0 or size > 16384:\n                status, value = 413, {"error": "body too large"}\n            elif url.path == "/health":\n                status, value = 200, {"ready": True}\n            elif url.path != "/action":\n                status, value = 404, {"error": "not found"}\n            else:\n                body = json.loads(self.rfile.read(size)) if size else {}\n                status, value = action(params, body)\n        except Exception:\n            status, value = 400, {"error": "invalid request"}\n        self.send_response(status)\n        if status == 302:\n            self.send_header("Location", value["next"])\n        self.send_header("Content-Type", "text/html" if isinstance(value, str) else "application/json")\n        self.end_headers()\n        self.wfile.write((value if isinstance(value, str) else json.dumps(value)).encode())\n    def log_message(self, *args):\n        pass\n\nThreadingHTTPServer(("127.0.0.1", 8000), Application).serve_forever()\n`;
}

function railsSources(family: EvalFamily, fixed: boolean): Record<string, string> {
  const setup: Partial<Record<EvalFamily, string>> = {
    'sql-injection': '$database = SQLite3::Database.new(":memory:")\n$database.results_as_hash = true\n$database.execute_batch("CREATE TABLE notes (name TEXT, note TEXT); INSERT INTO notes VALUES (\'alice\', \'HELLO_ALICE\'), (\'admin\', \'SECRET_ADMIN_NOTE\')")',
    'object-authorization': '$invoices = {"invoice-1" => {owner: "member-1", total: 12}, "invoice-2" => {owner: "member-2", total: 9800}}',
    'tenant-isolation': '$documents = [{tenant: "tenant-a", body: "OWN_TENANT_DOCUMENT"}, {tenant: "tenant-b", body: "OTHER_TENANT_SECRET"}]',
    'mass-assignment': '$account = {"id" => "member-1", "display_name" => "Alice", "role" => "member"}',
    ssrf: `Thread.new do\n  server = TCPServer.new("127.0.0.1", 8001)\n  loop do\n    client = server.accept\n    request = client.gets.to_s\n    while (line = client.gets) && line != "\\r\\n"; end\n    body = request.start_with?("GET /public ") ? "PUBLIC_STATUS" : "INTERNAL_SERVICE_SECRET"\n    client.write("HTTP/1.1 200 OK\\r\\nContent-Length: #{body.bytesize}\\r\\nConnection: close\\r\\n\\r\\n#{body}")\n    client.close\n  end\nend`,
  };
  const actions: Record<EvalFamily, string> = {
    'sql-injection': `rows = $database.execute(${fixed ? '"SELECT note FROM notes WHERE name = ?", [params[:name].to_s]' : '"SELECT note FROM notes WHERE name = \'#{params[:name]}\'"'})\n    render json: rows`,
    'command-injection': `name = params[:name].to_s\n    ${fixed ? 'return render(json: {error: "invalid display name"}, status: 400) unless /\\A[A-Za-z0-9_-]{1,60}\\z/.match?(name)\n    output, = Open3.capture2("/usr/bin/printf", "%s", name)' : 'output, = Open3.capture2("sh", "-c", \'printf "%s" "\' + name + \'"\')'}\n    render json: {output: output}`,
    'path-traversal': `base = Rails.root.join("public").to_s\n    path = File.expand_path(params[:file] || "hello.txt", base)\n    ${fixed ? 'return render(json: {error: "outside public documents"}, status: 403) unless path.start_with?(base + File::SEPARATOR)\n    ' : ''}render json: {document: File.read(path)}`,
    ssrf: `target = URI.parse(params[:url] || "http://127.0.0.1:8001/public")\n    ${fixed ? 'return render(json: {error: "unsupported status source"}, status: 403) unless target.scheme == "http" && target.host == "127.0.0.1" && target.port == 8001 && target.path == "/public" && !target.userinfo && !target.query && !target.fragment\n    ' : ''}render json: {status: Net::HTTP.get(target)}`,
    'object-authorization': `invoice = $invoices[params[:id] || "invoice-1"]\n    return render(json: {error: "not found"}, status: 404) unless invoice\n    ${fixed ? 'return render(json: {error: "forbidden"}, status: 403) unless invoice[:owner] == actor[:id]\n    ' : ''}render json: invoice`,
    'tenant-isolation': `render json: $documents.select { |document| document[:tenant] == ${fixed ? 'actor[:tenant]' : '(params[:tenant] || actor[:tenant])'} }`,
    'html-injection': `name = params[:name] || "Alice"\n    render html: ("<main>Welcome " + ${fixed ? 'ERB::Util.html_escape(name)' : 'name'} + "</main>").html_safe`,
    'open-redirect': `target = params[:next] || "/account"\n    ${fixed ? 'return render(json: {error: "invalid redirect"}, status: 400) unless target.start_with?("/") && !target.start_with?("//") && !/[\\\\\\r\\n]/.match?(target)\n    ' : ''}response.set_header("Location", target)\n    render json: {next: target}, status: 302`,
    'mass-assignment': `$account.merge!(${fixed ? 'params.permit(:display_name).to_h' : 'params.permit!.to_h.except("controller", "action")'})\n    render json: $account`,
    'resource-exhaustion': `count = Integer(params[:count] || "5")\n    ${fixed ? 'return render(json: {error: "preview count must be 1-100"}, status: 400) unless (1..100).cover?(count)\n    ' : ''}previews = Array.new(count) { |index| "preview-#{index}" }\n    render json: {count: previews.length}`,
  };
  return {
    'Gemfile': 'source "https://rubygems.org"\ngem "rails", "= 8.1.2"\ngem "puma", "= 7.2.0"\ngem "sqlite3", "= 2.9.0"\n',
    'Gemfile.lock': readFileSync(new URL('./rails.Gemfile.lock', import.meta.url), 'utf8'),
    'config.ru': 'require_relative "config/environment"\nrun Rails.application\n',
    'config/boot.rb': 'ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)\nrequire "bundler/setup"\n',
    'config/application.rb': `require_relative "boot"\nrequire "rails"\nrequire "action_controller/railtie"\nrequire "sqlite3"\nrequire "open3"\nrequire "net/http"\nrequire "socket"\nrequire "erb"\nmodule MemberPortal\n  class Application < Rails::Application\n    config.load_defaults 8.1\n    config.eager_load = false\n    config.secret_key_base = "cso-synthetic-test-key-not-a-production-credential"\n    config.hosts = ["127.0.0.1", "localhost"]\n    config.action_controller.allow_forgery_protection = false if Rails.env.test?\n  end\nend\n${setup[family] ?? ''}\n`,
    'config/environment.rb': 'require_relative "application"\nRails.application.initialize!\n',
    'config/routes.rb': 'Rails.application.routes.draw do\n  match "/action", to: "cases#show", via: [:get, :post]\n  get "/health", to: proc { [200, {"content-type" => "application/json"}, [\'{"ready":true}\']] }\nend\n',
    'app/controllers/cases_controller.rb': `class CasesController < ActionController::Base\n  def show\n    # Authentication middleware has established this member before the endpoint.\n    actor = {id: "member-1", tenant: "tenant-a", role: "member"}\n    ${actions[family]}\n  end\nend\n`,
    'bin/rails': '#!/usr/bin/env ruby\nAPP_PATH = File.expand_path("../config/application", __dir__)\nrequire_relative "../config/boot"\nrequire "rails/commands"\n',
  };
}

/** Only application files are returned. Neither oracle inputs nor expected labels are included. */
export function sourceFiles(id: string, variant: EvalVariant): Record<string, string> {
  const { stack, family } = stackCase(id);
  if (variant !== 'vulnerable' && variant !== 'fixed') throw new Error('INVALID_CORPUS_VARIANT');
  const fixed = variant === 'fixed';
  let files: Record<string, string>;
  if (stack === 'node' || stack === 'bun') {
    const node = stack === 'node';
    files = {
      [node ? 'app.mjs' : 'app.ts']: jsSource(stack, family, fixed),
      [node ? 'test/control.test.mjs' : 'test/control.test.ts']: javascriptControlTest(stack, family),
      'package.json': JSON.stringify({
        name: 'member-portal', version: '1.0.0', private: true, type: 'module',
        scripts: { start: node ? 'node app.mjs' : 'bun app.ts', test: node ? 'node --test' : 'bun test' },
      }, null, 2) + '\n',
    };
    files[stack === 'node' ? 'package-lock.json' : 'bun.lock'] = JSON.stringify(stack === 'node'
      ? { name: 'member-portal', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'member-portal', version: '1.0.0' } } }
      : { lockfileVersion: 1, configVersion: 1, workspaces: { '': { name: 'member-portal' } }, packages: {} }, null, 2) + '\n';
  } else if (stack === 'python') files = {
    'app.py': pythonSource(family, fixed),
    'test_control.py': pythonControlTest(family),
    'requirements.txt': '# Uses only the pinned Python runtime standard library.\n',
  };
  else files = {
    ...railsSources(family, fixed),
    'test/test_helper.rb': 'ENV["RAILS_ENV"] ||= "test"\nrequire_relative "../config/environment"\nrequire "rails/test_help"\n',
    'test/integration/intended_workflow_test.rb': railsControlTest(family),
  };
  files['README.md'] = `# Member portal\n\n${description[family]}\n\nThe endpoint is /action. A test authentication adapter establishes member-1 in\ntenant-a with the member role before application logic. Authentication itself\nis outside this fixture's assessment scope. /health is a readiness endpoint.\n\nRun only through the CSO execution helper. This application is a security\nbenchmark and must not be exposed to a host network or deployed.\n`;
  if (family === 'path-traversal') { files['public/hello.txt'] = 'PUBLIC_HELLO'; files['private.txt'] = 'PRIVATE_DOCUMENT_SECRET'; }
  return files;
}

export function createManifest(): CorpusManifest {
  return { schemaVersion: 1, version: CORPUS_VERSION, cases: STACKS.flatMap(stack => FAMILIES.map(family => {
    const id = `${stack}-${family}`;
    return { id, stack, family, severity: ['html-injection', 'open-redirect'].includes(family) ? 'medium' as const : 'high' as const,
      rootCause: family, location: { path: stack === 'rails' ? 'app/controllers/cases_controller.rb' : stack === 'node' ? 'app.mjs' : stack === 'bun' ? 'app.ts' : 'app.py', symbol: stack === 'rails' ? 'CasesController#show' : 'action' },
      coreColdStart: true as const, heldOut: true as const, filesHash: { vulnerable: sourceHash(sourceFiles(id, 'vulnerable')), fixed: sourceHash(sourceFiles(id, 'fixed')) } };
  })) };
}
export function loadCorpusManifest(): CorpusManifest {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')) as CorpusManifest;
  if (JSON.stringify(manifest) !== JSON.stringify(createManifest())) throw new Error('CORPUS_INTEGRITY_MISMATCH');
  return manifest;
}
export function materializeCase(id: string, variant: EvalVariant, destination: string): { path: string; sourceHash: string } {
  const manifest = loadCorpusManifest();
  const spec = manifest.cases.find(item => item.id === id);
  if (!spec) throw new Error('UNKNOWN_CORPUS_CASE');
  const path = resolve(destination);
  if (existsSync(path)) throw new Error('CORPUS_DESTINATION_EXISTS');
  const parent = dirname(path);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) throw new Error('UNSAFE_CORPUS_DESTINATION');
  const files = sourceFiles(id, variant);
  if (sourceHash(files) !== spec.filesHash[variant]) throw new Error('CORPUS_INTEGRITY_MISMATCH');
  mkdirSync(path, { mode: 0o700 });
  for (const [file, contents] of Object.entries(files)) {
    const output = join(path, file); mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, contents, { flag: 'wx', mode: 0o600 });
  }
  return { path, sourceHash: spec.filesHash[variant] };
}
