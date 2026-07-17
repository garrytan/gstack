#!/usr/bin/env bash
set -euo pipefail
umask 077

SOURCE="$(cd "${1:-$PWD}" && pwd -P)"
ROOT="$(mktemp -d /tmp/gstack2-devcontainer-gate.XXXXXX)"
ROOT="$(cd "$ROOT" && pwd -P)"
REPO="$ROOT/source"

cleanup() {
  rm -rf -- "$ROOT"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$REPO"
tar -C "$SOURCE" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  -cf - . \
  | tar -C "$REPO" -xf -

# The parity and generated-file checks need the checkout's Git history. Point
# the disposable worktree at the read-only source metadata, while leaving all
# Git commands free to discover fixture repositories normally.
REAL_GIT="${GSTACK_GATE_BASE_GIT:-$(command -v git)}"
if SOURCE_GIT_DIR="$("$REAL_GIT" -c safe.directory="$SOURCE" -C "$SOURCE" rev-parse --absolute-git-dir 2>/dev/null)"; then
  printf 'gitdir: %s\n' "$SOURCE_GIT_DIR" > "$REPO/.git"
  GIT_WRAPPER_DIR="$ROOT/bin"
  mkdir -p "$GIT_WRAPPER_DIR"
  export GSTACK_GATE_BASE_GIT="$REAL_GIT"
  export GSTACK_GATE_SOURCE="$SOURCE"
  export GSTACK_GATE_WORK_TREE="$REPO"
  export GIT_OPTIONAL_LOCKS=0
  export PATH="$GIT_WRAPPER_DIR:$PATH"
  cat > "$GIT_WRAPPER_DIR/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "$GSTACK_GATE_BASE_GIT" \
  -c safe.directory="$GSTACK_GATE_SOURCE" \
  -c safe.directory="$GSTACK_GATE_WORK_TREE" \
  "$@"
EOF
  chmod 700 "$GIT_WRAPPER_DIR/git"
fi

cd "$REPO"
bun install --frozen-lockfile
bun run test:gstack2
