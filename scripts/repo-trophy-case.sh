#!/usr/bin/env bash
#
# repo-trophy-case.sh — Achievement System for Repository Milestones
#
# Scans the repository and awards trophies/achievements based on
# various milestones. Because gamification makes everything better.
#
# Usage: ./scripts/repo-trophy-case.sh [--all] [--unlocked-only]
#

set -euo pipefail

GOLD='\033[1;33m'
SILVER='\033[0;37m'
BRONZE='\033[0;33m'
LOCKED='\033[2m'
GREEN='\033[0;32m'
NC='\033[0m'
BOLD='\033[1m'

ALL=false
UNLOCKED_ONLY=false

for arg in "$@"; do
    case $arg in
        --all) ALL=true ;;
        --unlocked-only) UNLOCKED_ONLY=true ;;
    esac
done

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║            🏆 Repository Trophy Case 🏆             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

UNLOCKED=0
TOTAL=0

trophy() {
    local name="$1"
    local description="$2"
    local condition="$3"  # true or false
    local tier="$4"       # gold, silver, bronze
    
    ((TOTAL++))
    
    case $tier in
        gold) color=$GOLD; icon="🥇" ;;
        silver) color=$SILVER; icon="🥈" ;;
        bronze) color=$BRONZE; icon="🥉" ;;
        *) color=$NC; icon="🏆" ;;
    esac
    
    if [[ "$condition" == "true" ]]; then
        ((UNLOCKED++))
        if [[ "$UNLOCKED_ONLY" == "true" ]] || [[ "$ALL" == "true" ]] || true; then
            echo -e "  ${color}${icon} ${BOLD}${name}${NC}"
            echo -e "     ${description}"
            echo ""
        fi
    else
        if [[ "$ALL" == "true" ]]; then
            echo -e "  ${LOCKED}🔒 ${name}${NC}"
            echo -e "  ${LOCKED}   ${description}${NC}"
            echo ""
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════
# Gather data
# ═══════════════════════════════════════════════════════════════

TOTAL_COMMITS=$(git rev-list --all --count 2>/dev/null || echo 0)
TOTAL_AUTHORS=$(git log --format='%aN' --all 2>/dev/null | sort -u | wc -l)
TOTAL_TAGS=$(git tag -l 2>/dev/null | wc -l)
TOTAL_BRANCHES=$(git branch -a 2>/dev/null | wc -l)
TOTAL_FILES=$(find . -type f -not -path './.git/*' -not -path './node_modules/*' | wc -l)
TOTAL_MD=$(find . -name "*.md" -not -path './.git/*' -not -path './node_modules/*' | wc -l)
TOTAL_SH=$(find . -name "*.sh" -not -path './.git/*' -not -path './node_modules/*' | wc -l)
TOTAL_SKILLS=$(find . -name "SKILL.md" -not -path './.git/*' | wc -l)
HAS_CI=$([[ -d ".github/workflows" ]] && echo "true" || echo "false")
HAS_TESTS=$([[ -d "test" ]] && echo "true" || echo "false")
HAS_LICENSE=$([[ -f "LICENSE" ]] && echo "true" || echo "false")
HAS_COC=$([[ -f "CODE_OF_CONDUCT.md" ]] && echo "true" || echo "false")
HAS_SECURITY=$([[ -f "SECURITY.md" ]] && echo "true" || echo "false")
HAS_EDITORCONFIG=$([[ -f ".editorconfig" ]] && echo "true" || echo "false")
HAS_CHANGELOG=$([[ -f "CHANGELOG.md" ]] && echo "true" || echo "false")
REPO_AGE_DAYS=$(( ($(date +%s) - $(git log --reverse --format=%at | head -1)) / 86400 ))

# ═══════════════════════════════════════════════════════════════
# Award trophies!
# ═══════════════════════════════════════════════════════════════

echo -e "${BOLD}─── Commit Milestones ───${NC}"
echo ""

trophy "First Steps" \
    "Made the first commit" \
    "$([[ $TOTAL_COMMITS -ge 1 ]] && echo true || echo false)" \
    "bronze"

trophy "Century Club" \
    "Reached 100 commits" \
    "$([[ $TOTAL_COMMITS -ge 100 ]] && echo true || echo false)" \
    "bronze"

trophy "Thousand Strong" \
    "Reached 1,000 commits" \
    "$([[ $TOTAL_COMMITS -ge 1000 ]] && echo true || echo false)" \
    "silver"

trophy "Commit Olympian" \
    "Reached 5,000 commits" \
    "$([[ $TOTAL_COMMITS -ge 5000 ]] && echo true || echo false)" \
    "gold"

echo -e "${BOLD}─── Community ───${NC}"
echo ""

trophy "Not Alone" \
    "Second contributor joined" \
    "$([[ $TOTAL_AUTHORS -ge 2 ]] && echo true || echo false)" \
    "bronze"

trophy "Squad Goals" \
    "5+ contributors" \
    "$([[ $TOTAL_AUTHORS -ge 5 ]] && echo true || echo false)" \
    "silver"

trophy "It Takes a Village" \
    "20+ contributors" \
    "$([[ $TOTAL_AUTHORS -ge 20 ]] && echo true || echo false)" \
    "gold"

trophy "Open Source Citizen" \
    "Has CODE_OF_CONDUCT.md" \
    "$HAS_COC" \
    "bronze"

echo -e "${BOLD}─── Documentation ───${NC}"
echo ""

trophy "Literate Codebase" \
    "More than 10 markdown files" \
    "$([[ $TOTAL_MD -gt 10 ]] && echo true || echo false)" \
    "bronze"

trophy "Documentation Fortress" \
    "50+ markdown files" \
    "$([[ $TOTAL_MD -ge 50 ]] && echo true || echo false)" \
    "silver"

trophy "The Library of Alexandria" \
    "100+ markdown files" \
    "$([[ $TOTAL_MD -ge 100 ]] && echo true || echo false)" \
    "gold"

echo -e "${BOLD}─── Engineering Practices ───${NC}"
echo ""

trophy "Guard Rails" \
    "Has CI/CD pipeline" \
    "$HAS_CI" \
    "bronze"

trophy "Safety Net" \
    "Has test directory" \
    "$HAS_TESTS" \
    "bronze"

trophy "Legal Eagle" \
    "Has LICENSE file" \
    "$HAS_LICENSE" \
    "bronze"

trophy "Security Conscious" \
    "Has SECURITY.md" \
    "$HAS_SECURITY" \
    "silver"

trophy "Editor Harmony" \
    "Has .editorconfig" \
    "$HAS_EDITORCONFIG" \
    "bronze"

trophy "Memory Lane" \
    "Maintains a CHANGELOG" \
    "$HAS_CHANGELOG" \
    "silver"

echo -e "${BOLD}─── Scale ───${NC}"
echo ""

trophy "Skill Collector" \
    "10+ skills defined" \
    "$([[ $TOTAL_SKILLS -ge 10 ]] && echo true || echo false)" \
    "bronze"

trophy "Skill Hoarder" \
    "20+ skills defined" \
    "$([[ $TOTAL_SKILLS -ge 20 ]] && echo true || echo false)" \
    "silver"

trophy "Skill Maximalist" \
    "30+ skills — you might have a problem" \
    "$([[ $TOTAL_SKILLS -ge 30 ]] && echo true || echo false)" \
    "gold"

trophy "Release Veteran" \
    "20+ version tags" \
    "$([[ $TOTAL_TAGS -ge 20 ]] && echo true || echo false)" \
    "silver"

trophy "Ancient Repository" \
    "Repository is over 1 year old" \
    "$([[ $REPO_AGE_DAYS -ge 365 ]] && echo true || echo false)" \
    "silver"

trophy "Prolific Scripter" \
    "10+ shell scripts" \
    "$([[ $TOTAL_SH -ge 10 ]] && echo true || echo false)" \
    "bronze"

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${BOLD}Trophies unlocked: ${UNLOCKED}/${TOTAL}${NC}"
echo ""

PERCENT=$((UNLOCKED * 100 / TOTAL))
BAR_FULL=$((PERCENT / 5))
BAR_EMPTY=$((20 - BAR_FULL))
BAR=$(printf '█%.0s' $(seq 1 $BAR_FULL 2>/dev/null || true))$(printf '░%.0s' $(seq 1 $BAR_EMPTY 2>/dev/null || true))
echo -e "  [${BAR}] ${PERCENT}%"
echo ""

if [[ $PERCENT -eq 100 ]]; then
    echo -e "  ${GOLD}${BOLD}🌟 COMPLETIONIST — All trophies unlocked! You are legendary. 🌟${NC}"
elif [[ $PERCENT -ge 80 ]]; then
    echo -e "  ${GREEN}Almost there! Just a few more achievements to go...${NC}"
elif [[ $PERCENT -ge 50 ]]; then
    echo -e "  Solid progress! Keep building and the trophies will come.${NC}"
else
    echo -e "  Many trophies await! Use ${BOLD}--all${NC} to see what's locked."
fi
echo ""
