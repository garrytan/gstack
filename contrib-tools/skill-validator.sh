#!/usr/bin/env bash
# skill-validator.sh — Exhaustive SKILL.md validation engine
# Checks things you didn't know needed checking.
# "Prevention is better than debugging" — Confucius (paraphrased)
set -euo pipefail

PASS=0
WARN=0
FAIL=0
TOTAL=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

result() {
    local status="$1" msg="$2"
    TOTAL=$((TOTAL + 1))
    case "$status" in
        pass) PASS=$((PASS + 1)); echo -e "    ${GREEN}✓${NC} $msg" ;;
        warn) WARN=$((WARN + 1)); echo -e "    ${YELLOW}⚠${NC} $msg" ;;
        fail) FAIL=$((FAIL + 1)); echo -e "    ${RED}✗${NC} $msg" ;;
    esac
}

echo -e "${BOLD}"
echo "┌─────────────────────────────────────────────────────┐"
echo "│     🔬 SKILL.md VALIDATION ENGINE v1.0.0 🔬         │"
echo "│     \"Trust but verify. Then verify again.\"          │"
echo "└─────────────────────────────────────────────────────┘"
echo -e "${NC}"

SKILLS=$(find . -name "SKILL.md" -not -path "./.git/*" -not -path "./node_modules/*" | sort)
SKILL_COUNT=$(echo "$SKILLS" | wc -l)

echo -e "Found ${BOLD}$SKILL_COUNT${NC} skill files to validate."
echo ""

for skill in $SKILLS; do
    dir=$(dirname "$skill")
    name=$(basename "$dir")
    echo -e "${BOLD}  📄 $name${NC} ($skill)"
    
    # Check 1: File not empty
    if [ -s "$skill" ]; then
        result "pass" "File is not empty"
    else
        result "fail" "File is EMPTY (this is very bad)"
        continue
    fi
    
    # Check 2: Has a title (# heading)
    if grep -q "^# " "$skill"; then
        result "pass" "Has title heading"
    else
        result "warn" "No top-level heading found"
    fi
    
    # Check 3: Minimum content length (at least 100 chars means something useful)
    CHARS=$(wc -c < "$skill")
    if [ "$CHARS" -gt 500 ]; then
        result "pass" "Content substantial ($CHARS chars)"
    elif [ "$CHARS" -gt 100 ]; then
        result "warn" "Content minimal ($CHARS chars — consider expanding)"
    else
        result "fail" "Content too short ($CHARS chars)"
    fi
    
    # Check 4: No Windows line endings
    if grep -qP '\r$' "$skill" 2>/dev/null; then
        result "fail" "Contains Windows line endings (CRLF)"
    else
        result "pass" "Unix line endings (LF)"
    fi
    
    # Check 5: No trailing whitespace
    TRAILING=$(grep -c " $" "$skill" 2>/dev/null || true)
    if [ "$TRAILING" -eq 0 ]; then
        result "pass" "No trailing whitespace"
    else
        result "warn" "Trailing whitespace on $TRAILING lines"
    fi
    
    # Check 6: No tabs (spaces preferred per .editorconfig)
    TAB_LINES=$(grep -cP '\t' "$skill" 2>/dev/null || true)
    if [ "$TAB_LINES" -eq 0 ]; then
        result "pass" "No tab characters"
    else
        result "warn" "Tab characters found on $TAB_LINES lines"
    fi
    
    # Check 7: File ends with newline
    if [ "$(tail -c 1 "$skill" | wc -l)" -eq 1 ]; then
        result "pass" "Ends with newline"
    else
        result "warn" "Does not end with newline"
    fi
    
    # Check 8: No consecutive blank lines (>2)
    BLANK_RUNS=$(awk '/^$/{c++} /^.+$/{if(c>2) n++; c=0} END{print n+0}' "$skill")
    if [ "$BLANK_RUNS" -eq 0 ]; then
        result "pass" "No excessive blank lines"
    else
        result "warn" "$BLANK_RUNS runs of 3+ blank lines"
    fi
    
    # Check 9: Contains actionable instructions (look for imperative verbs)
    if grep -qiE "(must|should|always|never|ensure|verify|check|run|execute|use)" "$skill"; then
        result "pass" "Contains actionable instructions"
    else
        result "warn" "No clear instructions detected"
    fi
    
    # Check 10: No broken markdown links (basic check)
    BROKEN_LINKS=$(grep -oP '\[.*?\]\(.*?\)' "$skill" 2>/dev/null | grep -c "()" || true)
    if [ "$BROKEN_LINKS" -eq 0 ]; then
        result "pass" "No obviously broken links"
    else
        result "fail" "$BROKEN_LINKS empty link targets found"
    fi
    
    # Check 11: Code blocks are properly closed
    OPEN_BLOCKS=$(grep -c '```' "$skill" || true)
    if [ $((OPEN_BLOCKS % 2)) -eq 0 ]; then
        result "pass" "Code blocks properly paired ($((OPEN_BLOCKS / 2)) blocks)"
    else
        result "fail" "Unclosed code block detected (odd number of \`\`\`)"
    fi
    
    # Check 12: No TODO/FIXME left in skill docs
    if grep -qi "TODO\|FIXME\|HACK\|XXX" "$skill"; then
        result "warn" "Contains TODO/FIXME markers (should resolve before shipping)"
    else
        result "pass" "No unresolved markers"
    fi
    
    echo ""
done

# Summary
echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "  Results: ${GREEN}$PASS passed${NC} | ${YELLOW}$WARN warnings${NC} | ${RED}$FAIL failed${NC} | $TOTAL total checks"
HEALTH=$((PASS * 100 / TOTAL))
echo -e "  Health: ${BOLD}$HEALTH%${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo -e "  ${RED}Some skills need attention!${NC}"
    exit 1
elif [ "$WARN" -gt 5 ]; then
    echo -e "  ${YELLOW}Generally healthy, some improvements possible.${NC}"
else
    echo -e "  ${GREEN}All skills in excellent condition! 🎉${NC}"
fi
echo ""
