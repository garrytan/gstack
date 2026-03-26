#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/preflight.sh [--fix] [--root <path>] [--help]

Checks that AGENTS.md and pointer files exist and are non-empty.
When repairing, creates symlinks from CLAUDE.md to AGENTS.md.
Outputs JSON to stdout and diagnostics to stderr.

Options:
  --fix          Create missing files and fill empty files with defaults
  --root <path>  Repository root to check (default: current directory)
  --help         Show this help text

Exit codes:
  0  all checks passed, or issues fixed successfully
  2  validation failed (missing or empty files) and --fix was not used
  64 invalid CLI usage
USAGE
}

fix=false
root="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix)
      fix=true
      shift
      ;;
    --root)
      if [[ $# -lt 2 ]]; then
        echo "Error: --root requires a path argument" >&2
        usage >&2
        exit 64
      fi
      root="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

required=("AGENTS.md" "CLAUDE.md")
missing=()
empty=()
fixed=()

if $fix; then
  mkdir -p "$root"
fi

create_pointer_symlink() {
  local path="$1"
  ln -sfn "AGENTS.md" "$path"
}

create_agents_if_needed() {
  local path="$1"
  cat > "$path" <<'EOF_AGENTS'
# AGENTS.md

- Add project-specific coding standards here.
- Add architecture and workflow guidance here.
- Keep this file concise and durable.
EOF_AGENTS
}

for file in "${required[@]}"; do
  path="$root/$file"
  if [[ ! -f "$path" ]]; then
    missing+=("$file")
  elif [[ ! -s "$path" ]]; then
    empty+=("$file")
  fi
done

if $fix; then
  for file in "${missing[@]}"; do
    path="$root/$file"
    echo "Creating missing file: $file" >&2
    if [[ "$file" == "AGENTS.md" ]]; then
      create_agents_if_needed "$path"
    else
      create_pointer_symlink "$path"
    fi
    fixed+=("$file")
  done

  for file in "${empty[@]}"; do
    path="$root/$file"
    echo "Filling empty file: $file" >&2
    if [[ "$file" == "AGENTS.md" ]]; then
      create_agents_if_needed "$path"
    else
      create_pointer_symlink "$path"
    fi
    fixed+=("$file")
  done
fi

join_json_array() {
  local first=true
  printf "["
  for item in "$@"; do
    if $first; then
      first=false
    else
      printf ","
    fi
    printf '"%s"' "$item"
  done
  printf "]"
}

printf '{'
if [[ ${#missing[@]} -eq 0 && ${#empty[@]} -eq 0 ]]; then
  ok=true
elif $fix; then
  ok=true
else
  ok=false
fi
printf '"ok":%s,' "$ok"
printf '"root":"%s",' "$root"
printf '"missing":'
join_json_array "${missing[@]}"
printf ','
printf '"empty":'
join_json_array "${empty[@]}"
printf ','
printf '"fixed":'
join_json_array "${fixed[@]}"
printf '}\n'

if [[ ${#missing[@]} -gt 0 || ${#empty[@]} -gt 0 ]]; then
  if ! $fix; then
    echo "Preflight failed: missing or empty files detected." >&2
    exit 2
  fi
fi

echo "Preflight checks complete." >&2
