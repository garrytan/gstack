#!/usr/bin/env bash
set -euo pipefail
umask 077

SOURCE="${1:-$PWD}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gstack2-runtime-smoke.XXXXXX")"
FIXTURE_PID=""
HOME_DIR=""
cleanup() {
  if [[ -n "$HOME_DIR" && -x "$HOME_DIR/bin/browse" ]]; then
    BROWSE_STATE_FILE="$ROOT/browser-state/browse.json" "$HOME_DIR/bin/browse" stop >/dev/null 2>&1 || true
  fi
  if [[ -n "$FIXTURE_PID" ]]; then
    kill "$FIXTURE_PID" >/dev/null 2>&1 || true
    wait "$FIXTURE_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT INT TERM

REPO="$ROOT/source tree"
HOME_DIR="$ROOT/runtime home"
mkdir -p "$REPO"
# Do not preserve the bind mount's numeric ownership. Git correctly rejects a
# copied repository whose .git directory still belongs to the host runner,
# even though the destination itself was created inside the container.
cp -R "$SOURCE/." "$REPO/"
rm -rf "$REPO/node_modules"
rm -f \
  "$REPO/browse/dist/browse" "$REPO/browse/dist/browse.exe" \
  "$REPO/design/dist/design" "$REPO/design/dist/design.exe" \
  "$REPO/make-pdf/dist/pdf" "$REPO/make-pdf/dist/pdf.exe"

(
  cd "$REPO"
  ./setup --home "$HOME_DIR" --browser managed --install-now --yes --json
)

# The optional runtime setup installs only its production/build closure. The
# paid E2E harness SDK and disabled local-model runtime remain development-only
# and must not enter user setup.
test -e "$REPO/node_modules/@anthropic-ai/sdk/package.json"
test ! -e "$REPO/node_modules/@anthropic-ai/claude-agent-sdk"
test ! -e "$REPO/node_modules/@huggingface/transformers"
test ! -e "$REPO/node_modules/onnxruntime-node"

(
  cd "$HOME_DIR/versions/$(jq -r .current "$HOME_DIR/versions/current.json")"
  node --input-type=module --eval 'await import("@anthropic-ai/sdk"); await import("sharp"); await import("@ngrok/ngrok");'
)

(
  # Exercise project identity against the disposable, container-owned copy.
  # The workflow checkout is a read-only host bind mount whose ownership is
  # intentionally not trusted by Git inside the container.
  cd "$REPO"
  "$HOME_DIR/bin/gstack" setup
  "$HOME_DIR/bin/gstack" doctor --json
  "$HOME_DIR/bin/gstack" --version
)
ACTIVE_VERSION="$(jq -r .current "$HOME_DIR/versions/current.json")"
test -x "$HOME_DIR/versions/$ACTIVE_VERSION/browse/dist/browse"
test -x "$HOME_DIR/bin/browse"

# Prove the installed local-browser capability can launch Chromium, navigate a
# loopback page, interact with DOM controls, and execute page JavaScript. This
# is deliberately offline and never uses a cloud/remote browser provider.
PORT_FILE="$ROOT/fixture-port"
node - "$PORT_FILE" <<'NODE' &
const http = require("node:http");
const fs = require("node:fs");
const portFile = process.argv[2];
const page = `<!doctype html>
<html><head><title>GStack runtime browser smoke</title></head>
<body>
  <main><h1>Local browser ready</h1>
    <label for="name">Name</label><input id="name">
    <button id="verify">Verify</button><output id="result"></output>
  </main>
  <script>
    document.querySelector('#verify').addEventListener('click', () => {
      document.querySelector('#result').textContent = 'verified:' + document.querySelector('#name').value;
    });
  </script>
</body></html>`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
NODE
FIXTURE_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.05
done
test -s "$PORT_FILE"
FIXTURE_URL="http://127.0.0.1:$(cat "$PORT_FILE")/"
export BROWSE_STATE_FILE="$ROOT/browser-state/browse.json"
"$HOME_DIR/bin/browse" goto "$FIXTURE_URL"
"$HOME_DIR/bin/browse" fill "#name" "GStack 2"
"$HOME_DIR/bin/browse" click "#verify"
"$HOME_DIR/bin/browse" text | grep -F "verified:GStack 2"
"$HOME_DIR/bin/browse" snapshot | grep -F "Local browser ready"
"$HOME_DIR/bin/browse" screenshot "$ROOT/runtime-full.png" | grep -F "Screenshot saved"
test -s "$ROOT/runtime-full.png"
"$HOME_DIR/bin/browse" stop

"$HOME_DIR/bin/gstack-design" daemon status
"$HOME_DIR/bin/make-pdf" version
"$HOME_DIR/bin/gstack" uninstall --json

test ! -e "$HOME_DIR/versions"
test ! -e "$HOME_DIR/runtime-install.json"
test -e "$HOME_DIR/config.json"

echo "GStack 2 runtime install smoke passed on $(uname -s) $(uname -m)."
