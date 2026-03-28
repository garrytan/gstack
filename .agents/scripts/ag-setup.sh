#!/usr/bin/env bash
set -e

echo "Setting up Antigravity constraints for gstack..."

# Verify the .agents directory structure is intact 
mkdir -p .agents/workflows
mkdir -p .agents/scripts

# Set upstream tracking appropriately
if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "Adding upstream remote to https://github.com/garrytan/gstack.git"
    git remote add upstream https://github.com/garrytan/gstack.git
else
    echo "Upstream is already configured."
fi

# Make sure this very script is executable
chmod +x .agents/scripts/ag-setup.sh || true

echo "Setup complete. Run bun install next."
