#!/usr/bin/env bash
# setup-scc.sh — install scc (github.com/boyter/scc), used by
# scripts/garry-output-comparison.ts for logical-line classification of added lines.
#
# Why standalone (not a package.json dependency): 95% of gstack users never run
# the throughput script. Making scc a required install step for every `bun install`
# would bloat onboarding for no reason. This script is invoked only when you
# actually want to run garry-output-comparison.ts.
#
# Usage: bash scripts/setup-scc.sh
set -euo pipefail

if command -v scc >/dev/null 2>&1; then
  echo "scc is already installed: $(command -v scc)"
  echo "Version: $(scc --version 2>/dev/null || echo 'unknown')"
  exit 0
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    if command -v brew >/dev/null 2>&1; then
      echo "Installing scc via Homebrew..."
      brew install scc
    else
      echo "Homebrew not found. Install from https://brew.sh or download scc manually:"
      echo "  https://github.com/boyter/scc/releases"
      exit 1
    fi
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      echo "Attempting apt-get install scc..."
      if sudo apt-get install -y scc 2>/dev/null; then
        echo "Installed via apt."
      else
        echo "scc not in apt repos. Download the Linux binary manually:"
        echo "  https://github.com/boyter/scc/releases"
        echo "  After download: chmod +x scc && sudo mv scc /usr/local/bin/"
        exit 1
      fi
    elif command -v pacman >/dev/null 2>&1; then
      echo "Installing scc via pacman..."
      sudo pacman -S --noconfirm scc
    else
      echo "Unknown Linux package manager. Download the binary manually:"
      echo "  https://github.com/boyter/scc/releases"
      exit 1
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected. Download the scc Windows binary from:"
    echo "  https://github.com/boyter/scc/releases"
    echo "Add it to your PATH."
    exit 1
    ;;
  *)
    echo "Unknown OS: $OS. Download scc manually:"
    echo "  https://github.com/boyter/scc/releases"
    exit 1
    ;;
esac

# Verify install
if command -v scc >/dev/null 2>&1; then
  echo "scc installed: $(command -v scc)"
  scc --version
else
  echo "Install appears to have failed. scc not found in PATH after install."
  exit 1
fi
