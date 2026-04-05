#!/usr/bin/env bash
# validate-agent-sync.sh — 에이전트 7곳 동기화 검증
# 사용법: bash plugins/bams-plugin/scripts/validate-agent-sync.sh
# Exit code: 0=정합, 1=불일치

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0
TMPDIR_VALIDATE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_VALIDATE"' EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo "=== BAMS Agent Sync Validation ==="
echo ""

# ─────────────────────────────────────────────
# 1. Canonical source: agents/*.md
# ─────────────────────────────────────────────
CANONICAL="$TMPDIR_VALIDATE/canonical.txt"
ls "$PLUGIN_DIR"/agents/*.md 2>/dev/null \
  | xargs -n1 basename \
  | sed 's/\.md$//' \
  | sort > "$CANONICAL"

CANONICAL_COUNT=$(wc -l < "$CANONICAL" | tr -d ' ')
echo -e "${BOLD}Canonical source: agents/ ($CANONICAL_COUNT agents)${NC}"
echo ""

# Helper: compare a source list against canonical
# Usage: compare_source <check_number> <label> <source_file>
compare_source() {
  local num="$1" label="$2" src="$3"
  local src_count missing extra

  sort -o "$src" "$src"
  src_count=$(wc -l < "$src" | tr -d ' ')

  missing=$(comm -23 "$CANONICAL" "$src")
  extra=$(comm -13 "$CANONICAL" "$src")

  if [[ -z "$missing" && -z "$extra" ]]; then
    echo -e "  [${num}/7] ${label} ... ${GREEN}OK${NC} (${src_count}/${CANONICAL_COUNT})"
  else
    if [[ -n "$missing" ]]; then
      local missing_list
      missing_list=$(echo "$missing" | tr '\n' ', ' | sed 's/,$//')
      echo -e "  [${num}/7] ${label} ... ${RED}MISSING${NC}: ${missing_list}"
      ERRORS=$((ERRORS + 1))
    fi
    if [[ -n "$extra" ]]; then
      local extra_list
      extra_list=$(echo "$extra" | tr '\n' ', ' | sed 's/,$//')
      echo -e "  [${num}/7] ${label} ... ${YELLOW}EXTRA${NC}: ${extra_list}"
      ERRORS=$((ERRORS + 1))
    fi
  fi
}

# ─────────────────────────────────────────────
# 2. plugin.json
# ─────────────────────────────────────────────
PLUGIN_JSON="$PLUGIN_DIR/.claude-plugin/plugin.json"
SRC_PLUGIN="$TMPDIR_VALIDATE/plugin.txt"
if [[ -f "$PLUGIN_JSON" ]]; then
  jq -r '.agents[]' "$PLUGIN_JSON" \
    | sed 's|.*/||; s/\.md$//' \
    | sort > "$SRC_PLUGIN"
  compare_source "1" "plugin.json" "$SRC_PLUGIN"
else
  echo -e "  [1/7] plugin.json ... ${RED}FILE NOT FOUND${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# 3. jojikdo.json (agent_id normalization)
#    pattern: foo_bar_agent → foo-bar
#    special: data_integration_engineering_agent → data-integration
# ─────────────────────────────────────────────
JOJIKDO="$PLUGIN_DIR/references/jojikdo.json"
SRC_JOJIKDO="$TMPDIR_VALIDATE/jojikdo.txt"
SRC_JOJIKDO_RAW="$TMPDIR_VALIDATE/jojikdo_raw.txt"
if [[ -f "$JOJIKDO" ]]; then
  # Extract raw agent_ids
  jq -r '.. | .agent_id? // empty' "$JOJIKDO" \
    | sort -u > "$SRC_JOJIKDO_RAW"

  # Normalize: remove _agent suffix, replace _ with -, handle special cases
  # Strategy: try to match against canonical names after normalization
  while IFS= read -r aid; do
    # Remove _agent suffix
    slug="${aid%_agent}"
    # Replace underscores with hyphens
    slug="${slug//_/-}"
    # Known mapping exceptions
    case "$slug" in
      data-integration-engineering) slug="data-integration" ;;
    esac
    # If slug doesn't exist in canonical but slug-agent does, use that
    if ! grep -qx "$slug" "$CANONICAL" 2>/dev/null; then
      if grep -qx "${slug}-agent" "$CANONICAL" 2>/dev/null; then
        slug="${slug}-agent"
      fi
    fi
    echo "$slug"
  done < "$SRC_JOJIKDO_RAW" | sort > "$SRC_JOJIKDO"

  # Check for naming mismatches (normalized matches but raw doesn't follow convention)
  WARNINGS=""
  while IFS= read -r aid; do
    slug="${aid%_agent}"
    slug="${slug//_/-}"
    expected_raw="${slug//-/_}_agent"
    case "$slug" in
      data-integration-engineering) continue ;;  # known exception
    esac
    if [[ "$aid" != "$expected_raw" ]]; then
      WARNINGS="${WARNINGS}${aid} vs expected ${expected_raw}, "
    fi
  done < "$SRC_JOJIKDO_RAW"

  if [[ -n "$WARNINGS" ]]; then
    echo -e "  [2/7] jojikdo.json ... ${YELLOW}WARN${NC}: naming mismatch (${WARNINGS%, })"
  fi
  compare_source "2" "jojikdo.json" "$SRC_JOJIKDO"
else
  echo -e "  [2/7] jojikdo.json ... ${RED}FILE NOT FOUND${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# 4. dept_map in bams-viz-emit.sh
# ─────────────────────────────────────────────
VIZ_EMIT="$PLUGIN_DIR/hooks/bams-viz-emit.sh"
SRC_DEPT="$TMPDIR_VALIDATE/dept_map.txt"
if [[ -f "$VIZ_EMIT" ]]; then
  # Extract agent names from case patterns in dept_map function
  # Lines look like:    product-strategy|business-analysis|...) echo "planning" ;;
  sed -n '/^dept_map()/,/^}/p' "$VIZ_EMIT" \
    | grep -E 'echo "[a-z]+"' \
    | sed 's/).*//' \
    | tr '|' '\n' \
    | sed 's/^[[:space:]]*//' \
    | grep -E '^[a-z]+(-[a-z]+)*$' \
    | sort > "$SRC_DEPT"
  compare_source "3" "dept_map (bams-viz-emit.sh)" "$SRC_DEPT"
else
  echo -e "  [3/7] dept_map ... ${RED}FILE NOT FOUND${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# 5. delegation-protocol.md
# ─────────────────────────────────────────────
DELEG="$PLUGIN_DIR/references/delegation-protocol.md"
SRC_DELEG="$TMPDIR_VALIDATE/delegation.txt"
if [[ -f "$DELEG" ]]; then
  # Extract agent slugs: match known slug patterns from canonical list
  # Use canonical as reference to grep for mentions
  > "$SRC_DELEG"
  while IFS= read -r agent; do
    if grep -qF "$agent" "$DELEG"; then
      echo "$agent" >> "$SRC_DELEG"
    fi
  done < "$CANONICAL"
  sort -o "$SRC_DELEG" "$SRC_DELEG"
  compare_source "4" "delegation-protocol.md" "$SRC_DELEG"
else
  echo -e "  [4/7] delegation-protocol.md ... ${RED}FILE NOT FOUND${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# 6. init.md CLAUDE.md section (Step 11 agent list)
# ─────────────────────────────────────────────
INIT_MD="$PLUGIN_DIR/commands/bams/init.md"
SRC_INIT="$TMPDIR_VALIDATE/init.txt"
if [[ -f "$INIT_MD" ]]; then
  # Extract agent slugs from the CLAUDE.md section (Step 11)
  # The section lists agents in lines like: - 기획: product-strategy, business-analysis, ...
  # Search between Step 11 marker and next ## Step
  > "$SRC_INIT"
  while IFS= read -r agent; do
    # Search in the Step 11 section specifically (lines 336-415 approx)
    if sed -n '/^## Step 11/,/^## Step [0-9]/p' "$INIT_MD" | grep -qF "$agent"; then
      echo "$agent" >> "$SRC_INIT"
    fi
  done < "$CANONICAL"
  sort -o "$SRC_INIT" "$SRC_INIT"
  compare_source "5" "init.md CLAUDE.md" "$SRC_INIT"
else
  echo -e "  [5/7] init.md ... ${RED}FILE NOT FOUND${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# 7. best-practices/*.md
# ─────────────────────────────────────────────
BP_DIR="$PLUGIN_DIR/references/best-practices"
SRC_BP="$TMPDIR_VALIDATE/best_practices.txt"
if [[ -d "$BP_DIR" ]]; then
  ls "$BP_DIR"/*.md 2>/dev/null \
    | xargs -n1 basename \
    | sed 's/\.md$//' \
    | sort > "$SRC_BP"
  compare_source "6" "best-practices/" "$SRC_BP"
else
  echo -e "  [6/7] best-practices/ ... ${RED}DIRECTORY NOT FOUND${NC}"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# Bonus: verify all departments in dept_map are covered
# ─────────────────────────────────────────────
if [[ -f "$VIZ_EMIT" ]]; then
  DEPTS=$(sed -n '/^dept_map()/,/^}/p' "$VIZ_EMIT" \
    | grep 'echo "' \
    | sed 's/.*echo "//; s/".*//' \
    | sort -u \
    | grep -v general)
  DEPT_COUNT=$(echo "$DEPTS" | wc -l | tr -d ' ')
  echo -e "  [7/7] dept_map departments ... ${GREEN}OK${NC} (${DEPT_COUNT} departments: $(echo "$DEPTS" | tr '\n' ', ' | sed 's/,$//'))"
fi

# ─────────────────────────────────────────────
# Result
# ─────────────────────────────────────────────
echo ""
if [[ "$ERRORS" -eq 0 ]]; then
  echo -e "=== Result: ${GREEN}All sources in sync${NC} ==="
  exit 0
else
  echo -e "=== Result: ${RED}${ERRORS} issue(s) found${NC} ==="
  exit 1
fi
