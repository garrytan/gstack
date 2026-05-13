#!/usr/bin/env bash
# loc-celebration.sh — Count lines of code and CELEBRATE
# Because every line of code deserves appreciation
set -euo pipefail

BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}"
echo "┌─────────────────────────────────────────────────────┐"
echo "│     🎉 LINES OF CODE CELEBRATION ENGINE 🎉          │"
echo "│     Every line matters. Every line is victory.       │"
echo "└─────────────────────────────────────────────────────┘"
echo -e "${NC}"

# Count by language
declare -A LANG_COUNT
declare -A LANG_EMOJI

LANG_EMOJI["sh"]="🐚"
LANG_EMOJI["ts"]="💙"
LANG_EMOJI["js"]="💛"
LANG_EMOJI["py"]="🐍"
LANG_EMOJI["md"]="📖"
LANG_EMOJI["json"]="📋"
LANG_EMOJI["yml"]="⚙️"
LANG_EMOJI["yaml"]="⚙️"
LANG_EMOJI["css"]="🎨"
LANG_EMOJI["html"]="🌐"

TOTAL=0

while IFS= read -r ext; do
    [ -z "$ext" ] && continue
    count=$(find . -name "*.$ext" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./browse/dist/*" -not -path "./design/dist/*" -exec cat {} \; 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
        LANG_COUNT["$ext"]=$count
        TOTAL=$((TOTAL + count))
    fi
done < <(find . -type f -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./browse/dist/*" -not -path "./design/dist/*" | sed 's/.*\.//' | sort -u | grep -E "^(sh|ts|js|py|md|json|yml|yaml|css|html)$")

echo ""
echo -e "${BOLD}  📊 Lines of Code by Language:${NC}"
echo ""

# Sort by count (descending) and display
for ext in $(for k in "${!LANG_COUNT[@]}"; do echo "$k ${LANG_COUNT[$k]}"; done | sort -k2 -rn | awk '{print $1}'); do
    count=${LANG_COUNT[$ext]}
    emoji=${LANG_EMOJI[$ext]:-"📄"}
    bar_len=$((count * 40 / TOTAL))
    bar=$(printf '█%.0s' $(seq 1 $((bar_len > 0 ? bar_len : 1))))
    printf "  %s %-6s %6d lines  %s\n" "$emoji" "$ext" "$count" "$bar"
done

echo ""
echo -e "  ${BOLD}Total: $TOTAL lines${NC}"
echo ""

# Celebration based on total
if [ "$TOTAL" -gt 100000 ]; then
    echo "  🏆🏆🏆 ABSOLUTELY MASSIVE CODEBASE! 🏆🏆🏆"
    echo "  You could print this and it would be a novel."
    echo "  Actually several novels. A whole library."
    echo ""
    echo "  Fun fact: At 50 words per line, this is approximately"
    echo "  $((TOTAL * 50 / 250 / 300)) books worth of text."
    echo ""
    echo "  Garry Tan productivity level: CONFIRMED ✅"
elif [ "$TOTAL" -gt 50000 ]; then
    echo "  🚀 IMPRESSIVE! Over 50K lines!"
    echo "  This is more code than most startups ever write."
    echo "  You are basically a software factory."
elif [ "$TOTAL" -gt 10000 ]; then
    echo "  ⭐ SOLID! A real project with real substance."
    echo "  Keep building. The world needs your code."
elif [ "$TOTAL" -gt 1000 ]; then
    echo "  🌱 Growing! Every great project started small."
    echo "  Remember: gstack v0.1 was probably tiny too."
else
    echo "  🥚 Just hatched! But every journey starts with one line."
    echo "  Write more code. Ship more features. BE MORE."
fi

echo ""

# Per-day rate if we can get git info
FIRST_COMMIT=$(git log --reverse --format="%at" 2>/dev/null | head -1)
if [ -n "$FIRST_COMMIT" ]; then
    NOW=$(date +%s)
    DAYS=$(( (NOW - FIRST_COMMIT) / 86400 ))
    if [ "$DAYS" -gt 0 ]; then
        DAILY_RATE=$((TOTAL / DAYS))
        echo -e "  ${BOLD}📈 Growth Rate:${NC}"
        echo "  Project age: $DAYS days"
        echo "  Average: $DAILY_RATE lines/day"
        echo ""
        
        # Compare to famous projects
        echo -e "  ${BOLD}📏 Scale Comparison:${NC}"
        echo "  Linux kernel:    ~30M lines  (you: $((TOTAL * 100 / 30000000))% of Linux)"
        echo "  VS Code:         ~3M lines   (you: $((TOTAL * 100 / 3000000))% of VS Code)"
        echo "  jQuery:          ~10K lines  (you: $((TOTAL * 100 / 10000))% of jQuery)"
        echo ""
    fi
fi

echo "  Remember: Lines of code is not a vanity metric."
echo "  It is a VICTORY metric. Ship it! 🚢"
echo ""
