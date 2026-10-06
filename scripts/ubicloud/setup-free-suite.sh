#!/usr/bin/env bash
# Bootstrap a fresh ubuntu-noble Ubicloud VM to run the free suite exactly as
# the required CI lane does (.github/workflows/free-tests.yml, free-suite job).
# Runs as user `ubi` (passwordless sudo) from the synced checkout.
set -euo pipefail

BUN_VERSION=1.4.2
NODE_VERSION=22.20.0

export DEBIAN_FRONTEND=noninteractive
sudo -E apt-get update -qq
sudo -E apt-get install -y -qq --no-install-recommends \
  git curl unzip xz-utils ca-certificates build-essential clang python3-venv jq \
  xvfb x11-utils poppler-utils fonts-noto-color-emoji zsh >/dev/null

# Ubuntu 24.04 blocks unprivileged user namespaces, which Chromium's sandbox
# needs; GitHub-hosted runners ship with this relaxed.
sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0

if ! command -v node >/dev/null; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    | sudo tar -xJ -C /usr/local --strip-components=1
fi

if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
grep -q '.bun/bin' "$HOME/.profile" || echo 'export PATH="$HOME/.bun/bin:$PATH"' >>"$HOME/.profile"
export PATH="$HOME/.bun/bin:$PATH"

git config --global user.email "free-tests@gstack.test"
git config --global user.name "Free Tests"
git config --global init.defaultBranch main
git config --global --add safe.directory '*'

bun install --frozen-lockfile
bunx playwright install --with-deps chromium

chrome=$(bun -e 'import { chromium } from "playwright"; import { realpathSync } from "node:fs"; console.log(realpathSync(chromium.executablePath()))')
sudo install -T -o root -g root -m 4755 "${chrome%/*}/chrome_sandbox" "${chrome%/*}/chrome-sandbox"

{
  bun run gen:skill-docs --host all
  bun run vendor:xterm
  bash browse/scripts/build-node-server.sh
  bun run build:gates
  bun run build:cso
} >/dev/null
