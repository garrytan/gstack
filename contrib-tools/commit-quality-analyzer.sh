#!/usr/bin/env bash
# commit-quality-analyzer.sh — Analyze commit message quality and detect AI slop
# "A commit message is a love letter to your future self" — Unknown
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

LIMIT="${1:-50}"

echo -e "${BOLD}"
echo "┌─────────────────────────────────────────────────────┐"
echo "│   📝 COMMIT QUALITY ANALYZER v1.0.0 📝              │"
echo "│   Detecting AI slop since 2026                      │"
echo "└─────────────────────────────────────────────────────┘"
echo -e "${NC}"
echo "  Analyzing last $LIMIT commits..."
echo ""

# AI slop patterns
SLOP_PATTERNS=(
    "leverage"
    "streamline"
    "robust"
    "seamless"
    "cutting-edge"
    "best practices"
    "holistic"
    "synergy"
    "paradigm"
    "revolutionary"
    "game-changing"
    "world-class"
    "state-of-the-art"
    "elevate"
    "empower"
    "unlock"
    "harness"
    "supercharge"
    "turbocharge"
    "next-gen"
    "bleeding-edge"
    "mission-critical"
    "actionable insights"
    "deep dive"
    "circle back"
)

# Good commit message patterns
GOOD_PATTERNS=(
    "^fix:"
    "^feat:"
    "^refactor:"
    "^docs:"
    "^test:"
    "^chore:"
    "^perf:"
    "^style:"
    "^ci:"
    "^build:"
)

TOTAL_COMMITS=0
SLOP_COMMITS=0
GOOD_FORMAT=0
TOO_SHORT=0
TOO_LONG=0
NO_BODY=0

declare -A SLOP_WORD_COUNT

while IFS= read -r msg; do
    [ -z "$msg" ] && continue
    TOTAL_COMMITS=$((TOTAL_COMMITS + 1))
    
    # Check length
    SUBJECT=$(echo "$msg" | head -1)
    SUBJECT_LEN=${#SUBJECT}
    
    if [ "$SUBJECT_LEN" -lt 10 ]; then
        TOO_SHORT=$((TOO_SHORT + 1))
    elif [ "$SUBJECT_LEN" -gt 72 ]; then
        TOO_LONG=$((TOO_LONG + 1))
    fi
    
    # Check conventional commit format
    for pattern in "${GOOD_PATTERNS[@]}"; do
        if echo "$SUBJECT" | grep -qiE "$pattern"; then
            GOOD_FORMAT=$((GOOD_FORMAT + 1))
            break
        fi
    done
    
    # Check for AI slop
    IS_SLOP=0
    for slop in "${SLOP_PATTERNS[@]}"; do
        if echo "$msg" | grep -qi "$slop"; then
            IS_SLOP=1
            SLOP_WORD_COUNT["$slop"]=$(( ${SLOP_WORD_COUNT["$slop"]:-0} + 1 ))
        fi
    done
    
    if [ "$IS_SLOP" -eq 1 ]; then
        SLOP_COMMITS=$((SLOP_COMMITS + 1))
    fi
    
done < <(git log --format="%s" -"$LIMIT" 2>/dev/null)

# Results
echo -e "${BOLD}  ─── Commit Format Analysis ──────────────────────────${NC}"
echo -e "  Total analyzed:       $TOTAL_COMMITS"
echo -e "  Conventional format:  $GOOD_FORMAT ($((GOOD_FORMAT * 100 / TOTAL_COMMITS))%)"
echo -e "  Too short (<10 char): $TOO_SHORT"
echo -e "  Too long (>72 char):  $TOO_LONG"
echo ""

echo -e "${BOLD}  ─── AI Slop Detection ───────────────────────────────${NC}"
SLOP_PERCENT=$((SLOP_COMMITS * 100 / TOTAL_COMMITS))
if [ "$SLOP_PERCENT" -lt 5 ]; then
    echo -e "  Slop score: ${GREEN}$SLOP_PERCENT%${NC} — Clean! Minimal corporate buzzword usage."
elif [ "$SLOP_PERCENT" -lt 20 ]; then
    echo -e "  Slop score: ${YELLOW}$SLOP_PERCENT%${NC} — Moderate. Some AI influence detected."
else
    echo -e "  Slop score: ${RED}$SLOP_PERCENT%${NC} — HIGH. Commits may be AI-generated without review."
fi
echo -e "  Flagged commits: $SLOP_COMMITS/$TOTAL_COMMITS"
echo ""

if [ ${#SLOP_WORD_COUNT[@]} -gt 0 ]; then
    echo -e "${BOLD}  ─── Most Used Slop Words ────────────────────────────${NC}"
    for word in "${!SLOP_WORD_COUNT[@]}"; do
        echo "  $word: ${SLOP_WORD_COUNT[$word]}"
    done | sort -t: -k2 -rn | head -10
    echo ""
fi

# Quality grade
QUALITY=$((100 - SLOP_PERCENT - (TOO_SHORT * 2) - (TOO_LONG)))
QUALITY=$((QUALITY < 0 ? 0 : QUALITY))
QUALITY=$((QUALITY > 100 ? 100 : QUALITY))

echo -e "${BOLD}  ─── Overall Quality ─────────────────────────────────${NC}"
if [ "$QUALITY" -ge 90 ]; then
    echo -e "  Grade: ${GREEN}A+ ($QUALITY/100)${NC} — Commit messages are clear and human!"
elif [ "$QUALITY" -ge 75 ]; then
    echo -e "  Grade: ${GREEN}B+ ($QUALITY/100)${NC} — Good messages with minor issues."
elif [ "$QUALITY" -ge 60 ]; then
    echo -e "  Grade: ${YELLOW}C ($QUALITY/100)${NC} — Average. Consider more descriptive messages."
else
    echo -e "  Grade: ${RED}D ($QUALITY/100)${NC} — Poor. AI slop or lazy messages detected."
fi
echo ""
echo -e "  ${BLUE}\"Write commit messages as if the person reading them is${NC}"
echo -e "  ${BLUE} a violent psychopath who knows where you live.\" — Unknown${NC}"
echo ""
