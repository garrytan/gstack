import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BROWSE_BIN = path.join(ROOT, 'browse', 'dist', 'browse');

describe('browse CLI daemon lifecycle', () => {
  test('reuses the same daemon across separate invocations', () => {
    const script = `
      set -euo pipefail
      TMP=$(mktemp -d)
      STATE="$TMP/browse.json"
      PORTFILE="$TMP/port"
      cleanup() {
        if [ -f "$STATE" ]; then
          PID=$(python3 - <<'PY' "$STATE"
import json, sys
print(json.load(open(sys.argv[1]))["pid"])
PY
)
          kill "$PID" 2>/dev/null || true
        fi
        if [ -f "$TMP/http.pid" ]; then
          kill "$(cat "$TMP/http.pid")" 2>/dev/null || true
        fi
        rm -rf "$TMP"
      }
      trap cleanup EXIT

      python3 - <<'PY' "$PORTFILE" >/tmp/gstack-http-test.log 2>&1 &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'<!doctype html><title>daemon test</title><h1>daemon test</h1>')
    def log_message(self, *args):
        pass
with socketserver.TCPServer(('127.0.0.1', 0), H) as s:
    open(sys.argv[1], 'w').write(str(s.server_address[1]))
    s.serve_forever()
PY
      echo $! > "$TMP/http.pid"

      while [ ! -f "$PORTFILE" ]; do sleep 0.1; done
      PORT=$(cat "$PORTFILE")

      cd "$TMP"
      CI=1 BROWSE_STATE_FILE="$STATE" BROWSE_PORT=0 "${BROWSE_BIN}" goto "http://127.0.0.1:$PORT" >"$TMP/out1" 2>"$TMP/err1"
      PID1=$(python3 - <<'PY' "$STATE"
import json, sys
print(json.load(open(sys.argv[1]))["pid"])
PY
)
      CI=1 BROWSE_STATE_FILE="$STATE" BROWSE_PORT=0 "${BROWSE_BIN}" url >"$TMP/out2" 2>"$TMP/err2"
      PID2=$(python3 - <<'PY' "$STATE"
import json, sys
print(json.load(open(sys.argv[1]))["pid"])
PY
)

      printf 'PID1=%s\\n' "$PID1"
      printf 'PID2=%s\\n' "$PID2"
      printf 'ERR1=%s\\n' "$(cat "$TMP/err1")"
      printf 'ERR2=%s\\n' "$(cat "$TMP/err2")"
      printf 'OUT2=%s\\n' "$(cat "$TMP/out2")"
    `;

    const result = spawnSync('bash', ['-lc', script], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000,
    });

    if (result.error) throw result.error;
    expect(result.status).toBe(0);

    const stdout = result.stdout;
    expect(stdout).toContain('ERR1=[browse] Starting server...');
    expect(stdout).toContain('ERR2=');
    expect(stdout).not.toContain('ERR2=[browse] Starting server...');
    expect(stdout).toMatch(/PID1=(\d+)/);
    expect(stdout).toMatch(/PID2=(\d+)/);
    expect(stdout).toContain('OUT2=http://127.0.0.1:');

    const pid1 = stdout.match(/PID1=(\d+)/)?.[1];
    const pid2 = stdout.match(/PID2=(\d+)/)?.[1];
    expect(pid1).toBe(pid2);
  }, 45_000);
});
