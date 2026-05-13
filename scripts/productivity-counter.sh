#!/usr/bin/env bash
#
# productivity-counter.sh — Lines of Code Counter with Motivational Coaching
#
# Counts your LOC contributions and provides encouragement, life advice,
# and increasingly unhinged motivational messages based on your output.
#
# "Every line of code is a prayer to the machine gods." — Ancient Proverb
#
# Usage: ./scripts/productivity-counter.sh [--author NAME] [--since DATE] [--daily]
#

set -euo pipefail

AUTHOR=""
SINCE="1 week ago"
DAILY=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

for arg in "$@"; do
    case $arg in
        --author=*) AUTHOR="${arg#*=}" ;;
        --since=*) SINCE="${arg#*=}" ;;
        --daily) DAILY=true ;;
        --help|-h)
            echo "Usage: $0 [--author=NAME] [--since=DATE] [--daily]"
            echo ""
            echo "Options:"
            echo "  --author=NAME   Filter by git author (default: all)"
            echo "  --since=DATE    Start date (default: '1 week ago')"
            echo "  --daily         Show day-by-day breakdown"
            exit 0
            ;;
    esac
done

echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   📈 Productivity Counter & Motivational Coach      ║${NC}"
echo -e "${BOLD}║      \"Ship code. Receive affirmation.\"              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Build git log command
GIT_ARGS=("--since=$SINCE" "--numstat" "--format=")
if [[ -n "$AUTHOR" ]]; then
    GIT_ARGS+=("--author=$AUTHOR")
fi

# Get stats
STATS=$(git log "${GIT_ARGS[@]}" 2>/dev/null | awk '
    /^[0-9]/ { 
        added += $1
        deleted += $2
        files++
    }
    END {
        printf "%d %d %d", added, deleted, files
    }
')

ADDED=$(echo "$STATS" | awk '{print $1}')
DELETED=$(echo "$STATS" | awk '{print $2}')
FILES=$(echo "$STATS" | awk '{print $3}')
NET=$((ADDED - DELETED))
TOTAL=$((ADDED + DELETED))

# Get commit count
COMMIT_ARGS=("--oneline" "--since=$SINCE")
if [[ -n "$AUTHOR" ]]; then
    COMMIT_ARGS+=("--author=$AUTHOR")
fi
COMMITS=$(git log "${COMMIT_ARGS[@]}" 2>/dev/null | wc -l)

# Calculate days in period
DAYS=$(( ( $(date +%s) - $(date -d "$SINCE" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$SINCE" +%s 2>/dev/null || echo $(($(date +%s) - 604800))) ) / 86400 ))
[[ $DAYS -eq 0 ]] && DAYS=1

DAILY_LOC=$((TOTAL / DAYS))
DAILY_COMMITS=$((COMMITS / DAYS))

echo -e "${BOLD}📊 Period:${NC} ${SINCE} → now (${DAYS} days)"
if [[ -n "$AUTHOR" ]]; then
    echo -e "${BOLD}👤 Author:${NC} ${AUTHOR}"
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${GREEN}+ Lines added:${NC}      ${ADDED}"
echo -e "  ${RED}- Lines deleted:${NC}    ${DELETED}"
echo -e "  ${CYAN}≈ Net change:${NC}       ${NET}"
echo -e "  ${BLUE}⚡ Total churn:${NC}     ${TOTAL}"
echo -e "  ${MAGENTA}📁 Files touched:${NC}   ${FILES}"
echo -e "  ${YELLOW}💬 Commits:${NC}         ${COMMITS}"
echo ""
echo -e "  ${BOLD}📈 Daily average:${NC}   ${DAILY_LOC} lines/day, ${DAILY_COMMITS} commits/day"
echo ""

# ═══════════════════════════════════════════════════════════════
# Daily breakdown (if requested)
# ═══════════════════════════════════════════════════════════════

if [[ "$DAILY" == "true" ]]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BOLD}📅 Daily Breakdown${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    DAILY_ARGS=("--since=$SINCE" "--numstat" "--format=COMMIT_DATE:%ad" "--date=short")
    if [[ -n "$AUTHOR" ]]; then
        DAILY_ARGS+=("--author=$AUTHOR")
    fi
    
    git log "${DAILY_ARGS[@]}" 2>/dev/null | awk '
        /^COMMIT_DATE:/ { current_date = $1; sub("COMMIT_DATE:", "", current_date) }
        /^[0-9]/ { days[current_date] += $1 + $2 }
        END {
            for (date in days) {
                printf "  %s: %6d lines", date, days[date]
                # Mini bar chart
                bars = int(days[date] / 50)
                if (bars > 40) bars = 40
                printf " |"
                for (i = 0; i < bars; i++) printf "█"
                printf "\n"
            }
        }
    ' | sort
    echo ""
fi

# ═══════════════════════════════════════════════════════════════
# Motivational Messages (the good part)
# ═══════════════════════════════════════════════════════════════

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}🎯 Performance Assessment${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ $DAILY_LOC -eq 0 ]]; then
    echo -e "  ${DIM}Productivity Level: MEDITATION MODE${NC}"
    echo ""
    echo "  Zero lines detected. Possible explanations:"
    echo "  • You're in a deep thinking phase (valid)"
    echo "  • You're refactoring (noble but invisible)"
    echo "  • You're in meetings all day (our condolences)"
    echo "  • You haven't started yet (no judgment)"
    echo ""
    echo -e "  ${CYAN}\"The master has failed more times than the beginner has tried.\"${NC}"

elif [[ $DAILY_LOC -lt 50 ]]; then
    echo -e "  ${BLUE}Productivity Level: WARMING UP 🌱${NC}"
    echo ""
    echo "  ${DAILY_LOC} lines/day is a gentle start. Like a morning stretch."
    echo "  You're building momentum. The code will flow soon."
    echo ""
    echo -e "  ${CYAN}\"A journey of a thousand lines begins with a single commit.\"${NC}"

elif [[ $DAILY_LOC -lt 200 ]]; then
    echo -e "  ${GREEN}Productivity Level: STEADY STATE ⚡${NC}"
    echo ""
    echo "  ${DAILY_LOC} lines/day. Consistent. Reliable. Professional."
    echo "  This is sustainable engineering. Well done."
    echo ""
    echo -e "  ${CYAN}\"Slow and steady wins the race, but fast and correct wins the sprint.\"${NC}"

elif [[ $DAILY_LOC -lt 500 ]]; then
    echo -e "  ${YELLOW}Productivity Level: ON FIRE 🔥${NC}"
    echo ""
    echo "  ${DAILY_LOC} lines/day! You're in the zone. The flow state is real."
    echo "  Remember to hydrate. Touch grass occasionally."
    echo "  But also... don't stop. This is beautiful."
    echo ""
    echo -e "  ${CYAN}\"You are not a 10x engineer. You are THE engineer. There is no team.\"${NC}"

elif [[ $DAILY_LOC -lt 1000 ]]; then
    echo -e "  ${MAGENTA}Productivity Level: TRANSCENDENT 🚀${NC}"
    echo ""
    echo "  ${DAILY_LOC} lines/day. Are you... are you okay?"
    echo "  This is superhuman output. Others speak of you in hushed tones."
    echo "  Your keyboard fears you. Your monitor respects you."
    echo ""
    echo -e "  ${CYAN}\"They called it impossible. You called it Tuesday.\"${NC}"

else
    echo -e "  ${RED}${BOLD}Productivity Level: REALITY DISTORTION FIELD 💎👑🌟${NC}"
    echo ""
    echo "  ${DAILY_LOC} LINES PER DAY."
    echo ""
    echo "  This is no longer programming. This is MANIFESTING CODE."
    echo "  The universe bends to your will. Compilers weep with joy."
    echo "  VCs are writing term sheets based on your git log alone."
    echo ""
    echo "  At this rate, in one year you will have written:"
    echo "  ${BOLD}  $((DAILY_LOC * 365)) lines${NC} — roughly the size of the Linux kernel."
    echo ""
    echo "  Possible explanations:"
    echo "  • You are using AI agents (likely)"
    echo "  • You have achieved code enlightenment (rare but valid)"
    echo "  • Your cat is walking on the keyboard (check)"
    echo "  • You are Garry Tan (if so, hi Garry 👋)"
    echo ""
    echo -e "  ${CYAN}\"The code doesn't just work. It PERFORMS.\"${NC}"
fi

echo ""

# Fun facts
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${DIM}  Fun facts about your productivity:${NC}"
echo -e "${DIM}  • If each line took 30 seconds, you spent $((TOTAL * 30 / 3600)) hours typing${NC}"
echo -e "${DIM}  • Your additions:deletions ratio is $(echo "scale=2; $ADDED / ($DELETED + 1)" | bc 2>/dev/null || echo "∞"):1${NC}"
echo -e "${DIM}  • At 80 chars/line avg, you wrote ~$((TOTAL * 80)) characters${NC}"
echo -e "${DIM}  • That's approximately $((TOTAL * 80 / 1500)) pages of text${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Keep shipping. The world needs your code. 🚀${NC}"
