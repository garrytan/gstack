#!/usr/bin/env bash
# pre-commit-guardian.sh — The Most Thorough Pre-Commit Hook Known to Mankind
# Install: cp contrib-tools/pre-commit-guardian.sh .git/hooks/pre-commit
# "An ounce of prevention is worth a pound of `git revert`" — Benjamin Franklin (approximately)
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

ERRORS=0
WARNINGS=0

warn() { echo -e "  ${YELLOW}⚠${NC} $1"; WARNINGS=$((WARNINGS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }
pass() { echo -e "  ${GREEN}✓${NC} $1"; }

echo -e "${BOLD}🛡️  Pre-Commit Guardian — Protecting You From Yourself${NC}"
echo ""

# Get staged files
STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$STAGED" ] && { echo "  No staged files. Nothing to guard."; exit 0; }

# ─── Check 1: No secrets ──────────────────────────────────────
echo -e "${BOLD}  🔒 Secret Detection${NC}"
SECRET_PATTERNS=(
    'AKIA[0-9A-Z]{16}'           # AWS Access Key
    'sk-[a-zA-Z0-9]{48}'         # OpenAI key
    'ghp_[a-zA-Z0-9]{36}'        # GitHub PAT
    'gho_[a-zA-Z0-9]{36}'        # GitHub OAuth
    'sk_live_[a-zA-Z0-9]+'       # Stripe live key
    'xox[baprs]-[a-zA-Z0-9-]+'   # Slack token
    'PRIVATE KEY'                  # Private keys
    'password\s*=\s*["\x27][^"\x27]+'  # Hardcoded passwords
)

SECRETS_FOUND=0
for file in $STAGED; do
    [ -f "$file" ] || continue
    for pattern in "${SECRET_PATTERNS[@]}"; do
        if grep -qE "$pattern" "$file" 2>/dev/null; then
            fail "Possible secret in $file (pattern: ${pattern:0:20}...)"
            SECRETS_FOUND=1
        fi
    done
done
[ "$SECRETS_FOUND" -eq 0 ] && pass "No secrets detected in staged files"

# ─── Check 2: No large files ──────────────────────────────────
echo ""
echo -e "${BOLD}  📦 File Size Check${NC}"
for file in $STAGED; do
    [ -f "$file" ] || continue
    SIZE=$(wc -c < "$file" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 5242880 ]; then
        fail "$file is $(( SIZE / 1048576 ))MB — too large for git!"
    elif [ "$SIZE" -gt 1048576 ]; then
        warn "$file is $(( SIZE / 1048576 ))MB — consider if this belongs in git"
    fi
done
pass "No oversized files detected"

# ─── Check 3: No conflict markers ─────────────────────────────
echo ""
echo -e "${BOLD}  ⚔️  Merge Conflict Check${NC}"
CONFLICTS=0
for file in $STAGED; do
    [ -f "$file" ] || continue
    if grep -qE "^(<<<<<<<|=======|>>>>>>>)" "$file" 2>/dev/null; then
        fail "Merge conflict markers in $file"
        CONFLICTS=1
    fi
done
[ "$CONFLICTS" -eq 0 ] && pass "No merge conflict markers"

# ─── Check 4: No debug statements ─────────────────────────────
echo ""
echo -e "${BOLD}  🐛 Debug Statement Check${NC}"
DEBUG_PATTERNS=(
    "console\.log"
    "debugger;"
    "binding\.pry"
    "import pdb"
    "breakpoint()"
    "print(f\"DEBUG"
)
DEBUG_FOUND=0
for file in $STAGED; do
    [ -f "$file" ] || continue
    [[ "$file" == *.test.* ]] && continue  # Allow in tests
    [[ "$file" == *spec* ]] && continue
    for pattern in "${DEBUG_PATTERNS[@]}"; do
        if grep -qE "$pattern" "$file" 2>/dev/null; then
            warn "Debug statement in $file: $pattern"
            DEBUG_FOUND=1
        fi
    done
done
[ "$DEBUG_FOUND" -eq 0 ] && pass "No debug statements in production code"

# ─── Check 5: Commit message preview ──────────────────────────
echo ""
echo -e "${BOLD}  💬 Commit Message Advisory${NC}"
echo "  (Reminder: Use conventional commits — feat:, fix:, docs:, etc.)"
echo "  (Reminder: Keep subject <72 chars)"
echo "  (Reminder: AI slop words to avoid: leverage, streamline, robust)"
pass "Advisory displayed"

# ─── Check 6: File permission check ───────────────────────────
echo ""
echo -e "${BOLD}  🔐 Permission Check${NC}"
for file in $STAGED; do
    [ -f "$file" ] || continue
    if [[ "$file" == *.sh ]] && [ ! -x "$file" ]; then
        warn "$file is a shell script but not executable"
    fi
done
pass "Permission check complete"

# ─── Check 7: Trailing whitespace ─────────────────────────────
echo ""
echo -e "${BOLD}  🧹 Whitespace Check${NC}"
WS_FILES=0
for file in $STAGED; do
    [ -f "$file" ] || continue
    [[ "$file" == *.md ]] && continue  # Markdown uses trailing spaces for <br>
    if grep -q " $" "$file" 2>/dev/null; then
        WS_FILES=$((WS_FILES + 1))
    fi
done
if [ "$WS_FILES" -eq 0 ]; then
    pass "No trailing whitespace"
else
    warn "$WS_FILES files have trailing whitespace"
fi

# ─── Check 8: TODO without ticket ─────────────────────────────
echo ""
echo -e "${BOLD}  📋 TODO Check${NC}"
NAKED_TODOS=0
for file in $STAGED; do
    [ -f "$file" ] || continue
    # Look for TODOs without a ticket/issue reference
    if grep -qE "TODO[^(]|TODO$" "$file" 2>/dev/null; then
        NAKED_TODOS=$((NAKED_TODOS + 1))
    fi
done
if [ "$NAKED_TODOS" -eq 0 ]; then
    pass "All TODOs have context"
else
    warn "$NAKED_TODOS files have TODOs without ticket reference"
fi

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
if [ "$ERRORS" -gt 0 ]; then
    echo -e "  ${RED}BLOCKED: $ERRORS error(s) found. Fix before committing.${NC}"
    echo ""
    echo "  To bypass (emergency only): git commit --no-verify"
    echo "  But please... don't. The guardian is here to help."
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    echo -e "  ${YELLOW}PASSED with $WARNINGS warning(s). Proceeding with commit.${NC}"
    echo "  Consider fixing warnings when you have time."
else
    echo -e "  ${GREEN}ALL CLEAR! ✨ Code is clean. You are a responsible developer.${NC}"
fi
echo ""
echo "  🛡️  The Guardian appreciates your cooperation."
echo ""
