#!/usr/bin/env bash
#
# slop-detector.sh — AI Slop Pattern Detector for Commit Messages
#
# Scans git history for telltale signs of AI-generated commit messages
# that lack substance, personality, or human thought.
#
# "A commit message should tell a story. AI slop tells you nothing."
#
# Usage: ./scripts/slop-detector.sh [--last N] [--strict] [--shame]
#

set -euo pipefail

LAST=50
STRICT=false
SHAME=false
SLOP_COUNT=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
NC='\033[0m'
BOLD='\033[1m'

for arg in "$@"; do
    case $arg in
        --last=*) LAST="${arg#*=}" ;;
        --last) shift; LAST="${2:-50}" ;;
        --strict) STRICT=true ;;
        --shame) SHAME=true ;;
        --help|-h)
            echo "Usage: $0 [--last N] [--strict] [--shame]"
            echo ""
            echo "Scans commit messages for AI slop patterns."
            echo ""
            echo "Options:"
            echo "  --last=N    Check last N commits (default: 50)"
            echo "  --strict    Stricter detection (more false positives)"
            echo "  --shame     Print the Wall of Shame at the end"
            exit 0
            ;;
    esac
done

echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       🔍 AI Slop Detector for Commit Messages       ║${NC}"
echo -e "${BOLD}║     \"Say what you mean. Mean what you commit.\"       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Scanning last ${BOLD}${LAST}${NC} commits..."
echo ""

# ═══════════════════════════════════════════════════════════════
# Slop Patterns (ranked by severity)
# ═══════════════════════════════════════════════════════════════

declare -A PATTERNS
declare -A PATTERN_SEVERITY
declare -A PATTERN_DESCRIPTION

# Severity 3: Definite slop
PATTERNS[generic_update]="^(Update|Modify|Change|Edit|Tweak|Adjust) [a-zA-Z_.-]+$"
PATTERN_SEVERITY[generic_update]=3
PATTERN_DESCRIPTION[generic_update]="Generic 'Update file' with no context"

PATTERNS[single_word]="^[A-Za-z]+$"
PATTERN_SEVERITY[single_word]=3
PATTERN_DESCRIPTION[single_word]="Single-word commit message"

PATTERNS[wip_temp]="^(wip|temp|tmp|test|fix|asdf|aaa|xxx)$"
PATTERN_SEVERITY[wip_temp]=3
PATTERN_DESCRIPTION[wip_temp]="Throwaway commit message"

# Severity 2: Likely slop
PATTERNS[ai_opener]="^(This commit|This PR|This change|This patch|This update) (adds|removes|fixes|updates|modifies|implements|introduces)"
PATTERN_SEVERITY[ai_opener]=2
PATTERN_DESCRIPTION[ai_opener]="AI-style 'This commit does X' opener"

PATTERNS[corporate_buzzwords]="(leverage|synergize|paradigm shift|holistic approach|best practices|going forward|circle back|move the needle|align on)"
PATTERN_SEVERITY[corporate_buzzwords]=2
PATTERN_DESCRIPTION[corporate_buzzwords]="Corporate buzzword contamination"

PATTERNS[over_polite]="(please note|it should be noted|it's worth mentioning|as previously discussed)"
PATTERN_SEVERITY[over_polite]=2
PATTERN_DESCRIPTION[over_polite]="Over-polite filler phrases"

PATTERNS[redundant_prefix]="^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\(.+\): (add|update|fix|change|modify) "
PATTERN_SEVERITY[redundant_prefix]=1
PATTERN_DESCRIPTION[redundant_prefix]="Conventional commit with redundant verb"

# Severity 1: Mild concern
PATTERNS[too_long]="^.{150,}$"
PATTERN_SEVERITY[too_long]=1
PATTERN_DESCRIPTION[too_long]="First line exceeds 150 characters"

PATTERNS[no_verb]="^[A-Z][a-z]+ [a-z]+ [a-z]+$"
PATTERN_SEVERITY[no_verb]=1
PATTERN_DESCRIPTION[no_verb]="May lack an action verb"

PATTERNS[ellipsis_abuse]="\.\.\."
PATTERN_SEVERITY[ellipsis_abuse]=1
PATTERN_DESCRIPTION[ellipsis_abuse]="Ellipsis in commit message (uncertainty?)"

if [[ "$STRICT" == "true" ]]; then
    # Extra patterns for strict mode
    PATTERNS[emoji_spam]="([\x{1F300}-\x{1F9FF}].*){3,}"
    PATTERN_SEVERITY[emoji_spam]=1
    PATTERN_DESCRIPTION[emoji_spam]="Excessive emoji usage (3+)"

    PATTERNS[passive_voice]="(was|were|been|being|is|are) (added|removed|fixed|updated|changed|modified|implemented)"
    PATTERN_SEVERITY[passive_voice]=1
    PATTERN_DESCRIPTION[passive_voice]="Passive voice (who did this?)"
fi

# ═══════════════════════════════════════════════════════════════
# Analysis
# ═══════════════════════════════════════════════════════════════

declare -a SHAME_WALL=()
declare -A PATTERN_HITS

# Initialize hit counters
for pattern_name in "${!PATTERNS[@]}"; do
    PATTERN_HITS[$pattern_name]=0
done

while IFS= read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    
    hash="${line%% *}"
    message="${line#* }"
    ((TOTAL++))
    
    is_slop=false
    max_severity=0
    triggered_patterns=()
    
    for pattern_name in "${!PATTERNS[@]}"; do
        pattern="${PATTERNS[$pattern_name]}"
        if echo "$message" | grep -qiE "$pattern" 2>/dev/null; then
            is_slop=true
            severity=${PATTERN_SEVERITY[$pattern_name]}
            if [[ $severity -gt $max_severity ]]; then
                max_severity=$severity
            fi
            triggered_patterns+=("$pattern_name")
            PATTERN_HITS[$pattern_name]=$((${PATTERN_HITS[$pattern_name]} + 1))
        fi
    done
    
    if [[ "$is_slop" == "true" ]]; then
        ((SLOP_COUNT++))
        
        case $max_severity in
            3) severity_icon="🚨"; color=$RED ;;
            2) severity_icon="⚠️ "; color=$YELLOW ;;
            1) severity_icon="💭"; color=$BLUE ;;
            *) severity_icon="?"; color=$NC ;;
        esac
        
        echo -e "${severity_icon} ${color}${hash}${NC} ${DIM}${message}${NC}"
        for tp in "${triggered_patterns[@]}"; do
            echo -e "   ${DIM}└─ ${PATTERN_DESCRIPTION[$tp]}${NC}"
        done
        
        if [[ "$SHAME" == "true" ]] && [[ $max_severity -ge 2 ]]; then
            SHAME_WALL+=("$message")
        fi
    fi
    
done < <(git log --oneline -"$LAST" 2>/dev/null)

# ═══════════════════════════════════════════════════════════════
# Results
# ═══════════════════════════════════════════════════════════════

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}📊 Slop Analysis Results${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  Commits analyzed:  ${TOTAL}"
echo -e "  Slop detected:     ${SLOP_COUNT}"

if [[ $TOTAL -gt 0 ]]; then
    SLOP_PCT=$((SLOP_COUNT * 100 / TOTAL))
    echo -e "  Slop percentage:   ${SLOP_PCT}%"
    echo ""
    
    # Rating
    if [[ $SLOP_PCT -eq 0 ]]; then
        echo -e "  ${GREEN}${BOLD}🏆 PRISTINE${NC} — Zero slop detected. Your commit log is a work of art."
    elif [[ $SLOP_PCT -le 10 ]]; then
        echo -e "  ${GREEN}${BOLD}✅ CLEAN${NC} — Minimal slop. You clearly think before you commit."
    elif [[ $SLOP_PCT -le 25 ]]; then
        echo -e "  ${YELLOW}${BOLD}⚠️  MILD CONTAMINATION${NC} — Some slop present. Room for improvement."
    elif [[ $SLOP_PCT -le 50 ]]; then
        echo -e "  ${RED}${BOLD}🤖 MODERATE SLOP${NC} — Half your commits lack soul. Try harder."
    else
        echo -e "  ${RED}${BOLD}💀 CRITICAL SLOP LEVELS${NC} — Your git log reads like a ChatGPT transcript."
    fi
fi

# Pattern breakdown
echo ""
echo "  Most triggered patterns:"
for pattern_name in "${!PATTERN_HITS[@]}"; do
    hits=${PATTERN_HITS[$pattern_name]}
    if [[ $hits -gt 0 ]]; then
        echo -e "    ${hits}x ${PATTERN_DESCRIPTION[$pattern_name]}"
    fi
done | sort -rn | head -5

# Wall of Shame
if [[ "$SHAME" == "true" ]] && [[ ${#SHAME_WALL[@]} -gt 0 ]]; then
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}${BOLD}  🪦 THE WALL OF SHAME 🪦${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    for shame_msg in "${SHAME_WALL[@]}"; do
        echo -e "  ${DIM}\"${shame_msg}\"${NC}"
    done
fi

echo ""
echo -e "${DIM}Pro tip: Good commit messages explain WHY, not just WHAT.${NC}"
echo -e "${DIM}The diff already tells you what changed.${NC}"
echo ""

# Exit code
if [[ "$STRICT" == "true" ]] && [[ $SLOP_COUNT -gt 0 ]]; then
    exit 1
fi
exit 0
