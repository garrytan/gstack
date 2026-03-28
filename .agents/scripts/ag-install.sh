#!/usr/bin/env bash
set -e

# Accepts GitHub username as the first positional argument.
GITHUB_USER="${1}"

if [ -z "$GITHUB_USER" ]; then
    echo "ERROR: Please provide your GitHub username as an argument."
    echo "Usage: curl -fsSL <url> | bash -s <YOUR-GITHUB-USERNAME>"
    exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/$GITHUB_USER/gstack.git}"
INSTALL_DIR="$HOME/.gstack-fork"

echo "Installing Antigravity gstack fork..."
if [ -d "$INSTALL_DIR" ]; then
    echo "Directory $INSTALL_DIR already exists. Pulling latest updates..."
    cd "$INSTALL_DIR"
    git fetch origin
    git pull
else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Ensure our local branch has the Antigravity setup script executable
chmod +x .agents/scripts/ag-setup.sh || true
./.agents/scripts/ag-setup.sh

# Complete the gstack bootstrap process
bun install
bun run build
./setup

echo "Antigravity gstack installed successfully at $INSTALL_DIR!"
