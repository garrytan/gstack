#!/usr/bin/env bash
#
# changelog-poetry.sh — Transforms boring changelogs into LITERATURE
#
# Takes your git log and generates a changelog that people might
# actually enjoy reading. Because release notes don't have to be
# soul-crushingly dull.
#
# Usage: ./scripts/changelog-poetry.sh [--since TAG] [--haiku] [--dramatic]
#

set -euo pipefail

SINCE=""
HAIKU=false
DRAMATIC=false

NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'

for arg in "$@"; do
    case $arg in
        --since=*) SINCE="${arg#*=}" ;;
        --haiku) HAIKU=true ;;
        --dramatic) DRAMATIC=true ;;
        --help|-h)
            echo "Usage: $0 [--since=TAG] [--haiku] [--dramatic]"
            echo ""
            echo "Options:"
            echo "  --since=TAG    Start from this tag (default: last tag)"
            echo "  --haiku        Generate haiku summaries for each change"
            echo "  --dramatic     Add dramatic narration"
            exit 0
            ;;
    esac
done

# Get the since tag
if [[ -z "$SINCE" ]]; then
    SINCE=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
    if [[ -z "$SINCE" ]]; then
        SINCE=$(git rev-list --max-parents=0 HEAD)
    fi
fi

CURRENT_VERSION=$(cat VERSION 2>/dev/null || echo "unreleased")
TODAY=$(date +%Y-%m-%d)

# Categorize commits
declare -a FEATURES=()
declare -a FIXES=()
declare -a DOCS=()
declare -a CHORES=()
declare -a OTHER=()

while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    msg="${line#* }"
    
    if echo "$msg" | grep -qiE "^feat|^add|new "; then
        FEATURES+=("$msg")
    elif echo "$msg" | grep -qiE "^fix|^bug|^patch|^hotfix"; then
        FIXES+=("$msg")
    elif echo "$msg" | grep -qiE "^doc|^readme|^comment"; then
        DOCS+=("$msg")
    elif echo "$msg" | grep -qiE "^chore|^ci|^build|^deps|^refactor"; then
        CHORES+=("$msg")
    else
        OTHER+=("$msg")
    fi
done < <(git log --oneline "${SINCE}..HEAD" 2>/dev/null)

TOTAL=$(( ${#FEATURES[@]} + ${#FIXES[@]} + ${#DOCS[@]} + ${#CHORES[@]} + ${#OTHER[@]} ))

# ═══════════════════════════════════════════════════════════════
# Generate the changelog
# ═══════════════════════════════════════════════════════════════

if [[ "$DRAMATIC" == "true" ]]; then
    echo ""
    echo -e "${BOLD}${MAGENTA}"
    echo "    ╔═══════════════════════════════════════════════╗"
    echo "    ║                                               ║"
    echo "    ║   T H E   C H A N G E L O G                  ║"
    echo "    ║                                               ║"
    echo "    ║   A tale of ${TOTAL} commits                       ║"
    echo "    ║   Since the days of ${SINCE}              "
    echo "    ║                                               ║"
    echo "    ╚═══════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo -e "${DIM}    In a codebase not so far away, brave developers"
    echo -e "    gathered their courage and shipped these changes...${NC}"
    echo ""
fi

echo "# Changelog — ${CURRENT_VERSION}"
echo ""
echo "**${TODAY}** | ${TOTAL} changes since \`${SINCE}\`"
echo ""

# Features
if [[ ${#FEATURES[@]} -gt 0 ]]; then
    if [[ "$DRAMATIC" == "true" ]]; then
        echo "## ✨ New Powers Bestowed Upon the Codebase"
        echo ""
        echo "_The builders spoke, and new features came into existence:_"
    else
        echo "## ✨ Features"
    fi
    echo ""
    for feat in "${FEATURES[@]}"; do
        echo "- ${feat}"
        if [[ "$HAIKU" == "true" ]]; then
            # Generate a pseudo-haiku (it's the thought that counts)
            words=$(echo "$feat" | wc -w)
            echo -e "  ${DIM}_New code awakens_"
            echo -e "  _Functions bloom in springtime light_"
            echo -e "  _Users rejoice now_${NC}"
            echo ""
        fi
    done
    echo ""
fi

# Fixes
if [[ ${#FIXES[@]} -gt 0 ]]; then
    if [[ "$DRAMATIC" == "true" ]]; then
        echo "## 🐛 Bugs Vanquished in Glorious Battle"
        echo ""
        echo "_The defenders stood firm against the tide of regressions:_"
    else
        echo "## 🐛 Bug Fixes"
    fi
    echo ""
    for fix in "${FIXES[@]}"; do
        echo "- ${fix}"
        if [[ "$HAIKU" == "true" ]]; then
            echo -e "  ${DIM}_A bug lurked within_"
            echo -e "  _The fix came swift and silent_"
            echo -e "  _Tests pass once again_${NC}"
            echo ""
        fi
    done
    echo ""
fi

# Docs
if [[ ${#DOCS[@]} -gt 0 ]]; then
    if [[ "$DRAMATIC" == "true" ]]; then
        echo "## 📖 Sacred Texts Updated"
        echo ""
        echo "_The scribes recorded the wisdom for future generations:_"
    else
        echo "## 📖 Documentation"
    fi
    echo ""
    for doc in "${DOCS[@]}"; do
        echo "- ${doc}"
    done
    echo ""
fi

# Chores
if [[ ${#CHORES[@]} -gt 0 ]]; then
    if [[ "$DRAMATIC" == "true" ]]; then
        echo "## 🧹 The Thankless Work (That Makes Everything Possible)"
        echo ""
        echo "_While others slept, the infrastructure gremlins toiled:_"
    else
        echo "## 🧹 Maintenance"
    fi
    echo ""
    for chore in "${CHORES[@]}"; do
        echo "- ${chore}"
    done
    echo ""
fi

# Other
if [[ ${#OTHER[@]} -gt 0 ]]; then
    if [[ "$DRAMATIC" == "true" ]]; then
        echo "## 🌀 Miscellaneous Arcana"
        echo ""
        echo "_Changes that defy categorization (but not importance):_"
    else
        echo "## 🌀 Other"
    fi
    echo ""
    for other in "${OTHER[@]}"; do
        echo "- ${other}"
    done
    echo ""
fi

# Footer
if [[ "$DRAMATIC" == "true" ]]; then
    echo "---"
    echo ""
    echo -e "_And so the changelog was written. May future developers_"
    echo -e "_read these notes and know: we cared. We shipped. We lived._"
    echo ""
    echo -e "_Until the next release... 🌅_"
fi

# Stats footer
echo ""
echo "---"
echo ""
echo "<details><summary>📊 Stats</summary>"
echo ""
echo "| Category | Count |"
echo "|----------|-------|"
echo "| Features | ${#FEATURES[@]} |"
echo "| Fixes | ${#FIXES[@]} |"
echo "| Docs | ${#DOCS[@]} |"
echo "| Chores | ${#CHORES[@]} |"
echo "| Other | ${#OTHER[@]} |"
echo "| **Total** | **${TOTAL}** |"
echo ""
echo "</details>"
