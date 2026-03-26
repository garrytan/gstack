#!/usr/bin/env bash
set -euo pipefail

EVAL_DIR="$HOME/.gstack"
EVAL_LOG="$EVAL_DIR/eval-log.txt"

TIER1=(review ship investigate qa browse)
TIER2=(autoplan retro document-release land-and-deploy canary)
TIER3=(careful freeze guard unfreeze setup-deploy)
TIER4=(benchmark codex cso design-review design-consultation office-hours plan-ceo-review plan-design-review plan-eng-review qa-only setup-browser-cookies gstack-upgrade)

ALL_SKILLS=("${TIER1[@]}" "${TIER2[@]}" "${TIER3[@]}" "${TIER4[@]}")

mkdir -p "$EVAL_DIR"
touch "$EVAL_LOG"

is_evaluated() {
  local skill="$1"
  grep -q "^${skill} " "$EVAL_LOG" 2>/dev/null
}

cmd_mark() {
  local skill="$1"
  local today
  today="$(date +%Y-%m-%d)"
  # Remove existing entry if present, then add fresh
  grep -v "^${skill} " "$EVAL_LOG" > "$EVAL_LOG.tmp" || true
  mv "$EVAL_LOG.tmp" "$EVAL_LOG"
  echo "${skill} ${today} evaluated" >> "$EVAL_LOG"
  echo "Marked '${skill}' as evaluated (${today})"
}

cmd_reset() {
  local skill="$1"
  grep -v "^${skill} " "$EVAL_LOG" > "$EVAL_LOG.tmp" || true
  mv "$EVAL_LOG.tmp" "$EVAL_LOG"
  echo "Reset '${skill}' from eval log"
}

cmd_reset_all() {
  > "$EVAL_LOG"
  echo "Eval log cleared"
}

print_tier() {
  local tier_name="$1"
  shift
  local skills=("$@")

  echo ""
  echo "## ${tier_name}"
  for skill in "${skills[@]}"; do
    if is_evaluated "$skill"; then
      echo "  [x] ${skill}"
    else
      echo "  [ ] ${skill}"
      echo "      To evaluate: /skill-creator review ${skill}/SKILL.md"
    fi
  done
}

cmd_show() {
  local evaluated=0
  local total=${#ALL_SKILLS[@]}

  for skill in "${ALL_SKILLS[@]}"; do
    if is_evaluated "$skill"; then
      evaluated=$((evaluated + 1))
    fi
  done

  echo "=== gstack skill evaluation checklist ==="
  echo "Progress: ${evaluated}/${total} skills evaluated"

  print_tier "Tier 1 (critical path)" "${TIER1[@]}"
  print_tier "Tier 2 (automation)" "${TIER2[@]}"
  print_tier "Tier 3 (safety)" "${TIER3[@]}"
  print_tier "Tier 4 (specialty)" "${TIER4[@]}"

  echo ""
}

# --- Main ---

case "${1:-}" in
  mark)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: evaluate-skills.sh mark <skill>" >&2
      exit 1
    fi
    cmd_mark "$2"
    ;;
  reset)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: evaluate-skills.sh reset <skill>" >&2
      exit 1
    fi
    cmd_reset "$2"
    ;;
  reset-all)
    cmd_reset_all
    ;;
  "")
    cmd_show
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "Usage: evaluate-skills.sh [mark <skill> | reset <skill> | reset-all]" >&2
    exit 1
    ;;
esac
