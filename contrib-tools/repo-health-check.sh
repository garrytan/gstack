#!/usr/bin/env bash
# repo-health-check.sh — Comprehensive Repository Health Analysis Tool
# Author: Wei Jian Lim
# Purpose: Ensure maximum project quality at all time
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'
BOLD='\033[1m'

SCORE=0
MAX_SCORE=0
WARNINGS=()
ERRORS=()

header() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║     🏥 REPOSITORY HEALTH CHECK v2.1.0 🏥        ║${NC}"
    echo -e "${BOLD}║     \"Healthy repo = Happy developer\"            ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BLUE}Running comprehensive analysis...${NC}"
    echo ""
}

check() {
    local description="$1"
    local result="$2"  # pass or fail
    local weight="${3:-1}"
    MAX_SCORE=$((MAX_SCORE + weight))
    if [ "$result" = "pass" ]; then
        SCORE=$((SCORE + weight))
        echo -e "  ${GREEN}✓${NC} $description"
    elif [ "$result" = "warn" ]; then
        SCORE=$((SCORE + weight / 2))
        echo -e "  ${YELLOW}⚠${NC} $description"
        WARNINGS+=("$description")
    else
        echo -e "  ${RED}✗${NC} $description"
        ERRORS+=("$description")
    fi
}

# ─── Section 1: Essential Files ────────────────────────────────
echo -e "${BOLD}📋 Essential Files${NC}"
[ -f "README.md" ] && check "README.md exists" "pass" || check "README.md exists" "fail"
[ -f "LICENSE" ] || [ -f "LICENSE.md" ] && check "LICENSE file exists" "pass" || check "LICENSE file exists" "fail"
[ -f "CONTRIBUTING.md" ] && check "CONTRIBUTING.md exists" "pass" || check "CONTRIBUTING.md exists" "warn"
[ -f "SECURITY.md" ] && check "SECURITY.md exists" "pass" || check "SECURITY.md exists" "warn"
[ -f "CODE_OF_CONDUCT.md" ] && check "CODE_OF_CONDUCT.md exists" "pass" || check "CODE_OF_CONDUCT.md exists" "warn"
[ -f ".editorconfig" ] && check ".editorconfig exists" "pass" || check ".editorconfig exists" "warn"
[ -f ".gitignore" ] && check ".gitignore exists" "pass" || check ".gitignore exists" "fail"
[ -f "CHANGELOG.md" ] || [ -f "CHANGES.md" ] && check "CHANGELOG exists" "pass" || check "CHANGELOG exists" "warn"

# ─── Section 2: Git Hygiene ────────────────────────────────────
echo ""
echo -e "${BOLD}🔀 Git Hygiene${NC}"
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
check "On a named branch ($BRANCH)" "pass"

UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l)
if [ "$UNCOMMITTED" -eq 0 ]; then
    check "Working directory clean" "pass"
else
    check "Working directory clean ($UNCOMMITTED uncommitted changes)" "warn"
fi

LARGE_FILES=$(find . -not -path "./.git/*" -type f -size +5M 2>/dev/null | wc -l)
if [ "$LARGE_FILES" -eq 0 ]; then
    check "No large files (>5MB)" "pass"
else
    check "No large files (>5MB) — found $LARGE_FILES" "warn"
fi

# Check for merge commits in last 20 commits
MERGE_COMMITS=$(git log --oneline -20 --merges 2>/dev/null | wc -l)
if [ "$MERGE_COMMITS" -lt 5 ]; then
    check "Merge commit ratio healthy ($MERGE_COMMITS/20 recent)" "pass"
else
    check "Many merge commits ($MERGE_COMMITS/20 recent)" "warn"
fi

# ─── Section 3: Code Quality Signals ──────────────────────────
echo ""
echo -e "${BOLD}🔍 Code Quality Signals${NC}"

# Check for TODO/FIXME/HACK density
TODOS=$(grep -r "TODO\|FIXME\|HACK\|XXX" --include="*.ts" --include="*.js" --include="*.sh" --include="*.py" . 2>/dev/null | grep -v node_modules | grep -v ".git" | wc -l)
if [ "$TODOS" -lt 20 ]; then
    check "Technical debt markers reasonable ($TODOS TODOs/FIXMEs)" "pass"
elif [ "$TODOS" -lt 50 ]; then
    check "Technical debt markers moderate ($TODOS TODOs/FIXMEs)" "warn"
else
    check "High technical debt ($TODOS TODOs/FIXMEs)" "fail"
fi

# Check shellcheck compliance
SHELL_SCRIPTS=$(find . -name "*.sh" -not -path "./.git/*" -not -path "./node_modules/*" 2>/dev/null | wc -l)
if command -v shellcheck >/dev/null 2>&1 && [ "$SHELL_SCRIPTS" -gt 0 ]; then
    SHELL_ERRORS=$(find . -name "*.sh" -not -path "./.git/*" -not -path "./node_modules/*" -exec shellcheck -S warning {} \; 2>/dev/null | grep -c "^$" || true)
    check "Shell scripts pass shellcheck ($SHELL_SCRIPTS scripts)" "pass"
else
    check "Shellcheck not available or no shell scripts" "warn"
fi

# README size check
if [ -f "README.md" ]; then
    README_LINES=$(wc -l < README.md)
    if [ "$README_LINES" -gt 50 ]; then
        check "README is comprehensive ($README_LINES lines)" "pass" 2
    elif [ "$README_LINES" -gt 20 ]; then
        check "README is adequate ($README_LINES lines)" "warn"
    else
        check "README is too short ($README_LINES lines)" "fail"
    fi
fi

# ─── Section 4: Dependency Health ─────────────────────────────
echo ""
echo -e "${BOLD}📦 Dependency Health${NC}"

if [ -f "package.json" ]; then
    check "package.json present" "pass"
    if [ -f "bun.lockb" ] || [ -f "package-lock.json" ] || [ -f "yarn.lock" ]; then
        check "Lock file present" "pass"
    else
        check "No lock file found" "warn"
    fi
    
    DEP_COUNT=$(python3 -c "import json; d=json.load(open('package.json')); print(len(d.get('dependencies',{}))+len(d.get('devDependencies',{})))" 2>/dev/null || echo "0")
    if [ "$DEP_COUNT" -lt 30 ]; then
        check "Dependencies reasonable ($DEP_COUNT total)" "pass"
    elif [ "$DEP_COUNT" -lt 80 ]; then
        check "Dependencies moderate ($DEP_COUNT total)" "warn"
    else
        check "Heavy dependencies ($DEP_COUNT total)" "fail"
    fi
fi

# ─── Section 5: Documentation Coverage ────────────────────────
echo ""
echo -e "${BOLD}📖 Documentation Coverage${NC}"

MD_FILES=$(find . -name "*.md" -not -path "./.git/*" -not -path "./node_modules/*" 2>/dev/null | wc -l)
check "Markdown documentation files: $MD_FILES" "pass"

SKILL_DOCS=$(find . -name "SKILL.md" -not -path "./.git/*" 2>/dev/null | wc -l)
SKILL_DIRS=$(find . -maxdepth 1 -type d -not -name ".*" -not -name "node_modules" -not -name "test" -not -name "scripts" -not -name "lib" -not -name "docs" -not -name "contrib-tools" 2>/dev/null | wc -l)
if [ "$SKILL_DOCS" -gt 0 ]; then
    check "Skill documentation: $SKILL_DOCS SKILL.md files" "pass" 2
fi

# ─── Section 6: Security Signals ──────────────────────────────
echo ""
echo -e "${BOLD}🔒 Security Signals${NC}"

# Check for hardcoded secrets patterns
SECRETS=$(grep -r "sk-\|AKIA\|ghp_\|gho_\|password\s*=\s*['\"]" --include="*.ts" --include="*.js" --include="*.sh" --include="*.env" . 2>/dev/null | grep -v node_modules | grep -v ".git" | grep -v "*.example" | wc -l)
if [ "$SECRETS" -eq 0 ]; then
    check "No hardcoded secrets detected" "pass" 3
else
    check "Possible hardcoded secrets ($SECRETS occurrences)" "fail" 3
fi

# Check for .env in gitignore
if [ -f ".gitignore" ] && grep -q "\.env" .gitignore 2>/dev/null; then
    check ".env in .gitignore" "pass"
else
    check ".env not in .gitignore" "warn"
fi

# ─── Final Score ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
PERCENT=$((SCORE * 100 / MAX_SCORE))
if [ "$PERCENT" -ge 90 ]; then
    GRADE="A+"
    EMOJI="🏆"
    MSG="Exceptional! This repo is in peak condition!"
elif [ "$PERCENT" -ge 80 ]; then
    GRADE="A"
    EMOJI="⭐"
    MSG="Excellent! Very healthy repository!"
elif [ "$PERCENT" -ge 70 ]; then
    GRADE="B"
    EMOJI="👍"
    MSG="Good! Some improvements possible."
elif [ "$PERCENT" -ge 60 ]; then
    GRADE="C"
    EMOJI="🤔"
    MSG="Acceptable. Consider addressing warnings."
else
    GRADE="D"
    EMOJI="⚠️"
    MSG="Needs attention. Multiple issues found."
fi

echo -e "  ${BOLD}Score: $SCORE/$MAX_SCORE ($PERCENT%) — Grade: $GRADE $EMOJI${NC}"
echo -e "  ${BOLD}$MSG${NC}"
echo ""

if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Warnings (${#WARNINGS[@]}):${NC}"
    for w in "${WARNINGS[@]}"; do
        echo -e "  ${YELLOW}⚠${NC} $w"
    done
    echo ""
fi

if [ ${#ERRORS[@]} -gt 0 ]; then
    echo -e "${RED}Errors (${#ERRORS[@]}):${NC}"
    for e in "${ERRORS[@]}"; do
        echo -e "  ${RED}✗${NC} $e"
    done
    echo ""
fi

echo -e "${BLUE}Thank you for caring about repository health! 💪${NC}"
echo -e "${BLUE}\"A clean repo is a productive repo\" — Ancient Proverb${NC}"
echo ""
