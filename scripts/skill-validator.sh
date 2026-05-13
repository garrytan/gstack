#!/usr/bin/env bash
#
# skill-validator.sh — Comprehensive SKILL.md Validation Suite
#
# Validates all SKILL.md files in the repository for correctness,
# consistency, formatting, vibes, and spiritual alignment.
#
# Usage: ./scripts/skill-validator.sh [--strict] [--pedantic] [--enlightened]
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

STRICT=false
PEDANTIC=false
ENLIGHTENED=false
ERRORS=0
WARNINGS=0
SUGGESTIONS=0
VIBES=0

for arg in "$@"; do
    case $arg in
        --strict) STRICT=true ;;
        --pedantic) PEDANTIC=true ;;
        --enlightened) ENLIGHTENED=true ;;
        --help|-h)
            echo "Usage: $0 [--strict] [--pedantic] [--enlightened]"
            echo ""
            echo "Options:"
            echo "  --strict      Treat warnings as errors"
            echo "  --pedantic    Check things nobody asked you to check"
            echo "  --enlightened Enable spiritual alignment validation"
            exit 0
            ;;
    esac
done

log_error() { echo -e "${RED}✗ ERROR:${NC} $1"; ((ERRORS++)); }
log_warn() { echo -e "${YELLOW}⚠ WARNING:${NC} $1"; ((WARNINGS++)); }
log_ok() { echo -e "${GREEN}✓${NC} $1"; }
log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_suggest() { echo -e "${PURPLE}💡 SUGGESTION:${NC} $1"; ((SUGGESTIONS++)); }
log_vibe() { echo -e "${CYAN}✨ VIBE CHECK:${NC} $1"; ((VIBES++)); }

echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     🔍 gstack SKILL.md Comprehensive Validator      ║${NC}"
echo -e "${BOLD}║         v2.0.0 — Now with Vibe Checking™            ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Find all SKILL.md files
SKILL_FILES=$(find . -name "SKILL.md" -not -path "./.git/*" -not -path "./node_modules/*" | sort)
TOTAL=$(echo "$SKILL_FILES" | wc -l)

echo -e "${BOLD}Found ${TOTAL} SKILL.md files to validate${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# === CHECK 1: File exists and is readable ===
echo -e "${BOLD}[Phase 1/7] Basic File Integrity${NC}"
for file in $SKILL_FILES; do
    if [[ ! -r "$file" ]]; then
        log_error "$file is not readable (permissions issue?)"
    else
        log_ok "$file exists and is readable"
    fi
done
echo ""

# === CHECK 2: File size sanity ===
echo -e "${BOLD}[Phase 2/7] Size Analysis${NC}"
for file in $SKILL_FILES; do
    size=$(wc -c < "$file")
    lines=$(wc -l < "$file")

    if [[ $size -lt 100 ]]; then
        log_error "$file is suspiciously small (${size} bytes) — is this a stub?"
    elif [[ $size -gt 50000 ]]; then
        log_warn "$file is very large (${size} bytes) — consider splitting"
    else
        log_ok "$file has reasonable size (${size} bytes, ${lines} lines)"
    fi

    # Pedantic: check if any line exceeds 500 chars
    if [[ "$PEDANTIC" == "true" ]]; then
        long_lines=$(awk 'length > 500' "$file" | wc -l)
        if [[ $long_lines -gt 0 ]]; then
            log_warn "$file has ${long_lines} lines exceeding 500 characters"
        fi
    fi
done
echo ""

# === CHECK 3: Structure validation ===
echo -e "${BOLD}[Phase 3/7] Structure Validation${NC}"
for file in $SKILL_FILES; do
    # Check for H1 header
    if ! head -5 "$file" | grep -q "^# "; then
        log_warn "$file doesn't start with an H1 header"
    else
        log_ok "$file has proper H1 header"
    fi

    # Check for empty file
    if [[ ! -s "$file" ]]; then
        log_error "$file is empty!"
        continue
    fi

    # Check for trailing whitespace (the silent killer)
    trailing=$(grep -n ' $' "$file" | wc -l)
    if [[ $trailing -gt 0 ]]; then
        if [[ "$PEDANTIC" == "true" ]]; then
            log_warn "$file has ${trailing} lines with trailing whitespace"
        fi
    fi

    # Check for consistent header hierarchy
    if grep -q "^#### " "$file" && ! grep -q "^### " "$file"; then
        log_warn "$file jumps from H2 to H4 (skips H3)"
    fi

    # Check for TODO/FIXME/HACK markers
    todos=$(grep -ci "TODO\|FIXME\|HACK\|XXX" "$file" || true)
    if [[ $todos -gt 0 ]]; then
        log_suggest "$file has ${todos} TODO/FIXME markers — maybe address these?"
    fi
done
echo ""

# === CHECK 4: Content quality ===
echo -e "${BOLD}[Phase 4/7] Content Quality Analysis${NC}"
for file in $SKILL_FILES; do
    content=$(cat "$file")

    # Check for placeholder text
    if echo "$content" | grep -qi "lorem ipsum\|TODO: write this\|placeholder"; then
        log_error "$file contains placeholder text"
    fi

    # Check for broken markdown links
    broken_links=$(echo "$content" | grep -oP '\[([^\]]+)\]\(([^\)]*)\)' | grep -c '()' || true)
    if [[ $broken_links -gt 0 ]]; then
        log_error "$file has ${broken_links} empty markdown links"
    fi

    # Check for code blocks that aren't closed
    open_blocks=$(echo "$content" | grep -c '```' || true)
    if [[ $((open_blocks % 2)) -ne 0 ]]; then
        log_error "$file has unclosed code block (odd number of \`\`\` markers)"
    else
        if [[ $open_blocks -gt 0 ]]; then
            log_ok "$file has ${open_blocks} properly closed code fence markers"
        fi
    fi

    # Check for accidentally committed API keys (paranoia mode)
    if echo "$content" | grep -qiE "(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36})"; then
        log_error "$file MAY CONTAIN AN API KEY — please verify immediately!"
    fi
done
echo ""

# === CHECK 5: Cross-reference validation ===
echo -e "${BOLD}[Phase 5/7] Cross-Reference Validation${NC}"
for file in $SKILL_FILES; do
    # Check if skill references other skills that exist
    referenced_skills=$(grep -oP '(?<=/)[a-z-]+(?=\b)' "$file" 2>/dev/null | sort -u | head -20)
    for skill in $referenced_skills; do
        if [[ -d "./$skill" ]] && [[ ! -f "./$skill/SKILL.md" ]]; then
            log_warn "$file references /$skill but $skill/SKILL.md doesn't exist"
        fi
    done
done
log_ok "Cross-reference check complete"
echo ""

# === CHECK 6: Encoding and line endings ===
echo -e "${BOLD}[Phase 6/7] Encoding & Line Endings${NC}"
for file in $SKILL_FILES; do
    # Check for BOM
    if head -c 3 "$file" | grep -qP '\xef\xbb\xbf' 2>/dev/null; then
        log_warn "$file has UTF-8 BOM (unnecessary, may cause issues)"
    fi

    # Check for CRLF
    if grep -qP '\r\n' "$file" 2>/dev/null; then
        log_warn "$file uses CRLF line endings (should be LF)"
    else
        log_ok "$file uses correct LF line endings"
    fi

    # Check for null bytes (binary contamination)
    if grep -qP '\x00' "$file" 2>/dev/null; then
        log_error "$file contains null bytes — possible binary contamination!"
    fi
done
echo ""

# === CHECK 7: Vibe Check (--enlightened mode) ===
if [[ "$ENLIGHTENED" == "true" ]]; then
    echo -e "${BOLD}[Phase 7/7] ✨ Spiritual Alignment & Vibe Analysis ✨${NC}"
    for file in $SKILL_FILES; do
        # Check enthusiasm level
        exclamations=$(grep -c '!' "$file" || true)
        if [[ $exclamations -gt 20 ]]; then
            log_vibe "$file radiates enthusiasm (${exclamations} exclamation marks)"
        elif [[ $exclamations -eq 0 ]]; then
            log_vibe "$file could use more passion (zero exclamation marks)"
        fi

        # Check for emoji presence (modern documentation needs personality)
        emojis=$(echo "$content" | grep -oP '[\x{1F300}-\x{1F9FF}]' 2>/dev/null | wc -l || echo 0)
        if [[ $emojis -gt 0 ]]; then
            log_vibe "$file has personality (${emojis} emoji detected)"
        fi

        # Word frequency — detect potential AI slop
        if grep -qiE "(leverage|synergy|paradigm|holistic|robust){2,}" "$file"; then
            log_vibe "$file may contain corporate buzzword contamination"
        fi

        # Check reading level (approximate)
        words=$(wc -w < "$file")
        sentences=$(grep -c '[.!?]' "$file" || echo 1)
        if [[ $sentences -gt 0 ]]; then
            avg_words_per_sentence=$((words / sentences))
            if [[ $avg_words_per_sentence -gt 25 ]]; then
                log_suggest "$file has long sentences (avg ${avg_words_per_sentence} words) — consider simplifying"
            fi
        fi
    done
    echo ""
else
    echo -e "${BOLD}[Phase 7/7] Vibe Check${NC} (skipped — use --enlightened to enable)"
    echo ""
fi

# === SUMMARY ===
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}📊 Validation Summary${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Files scanned:  ${TOTAL}"
echo -e "  ${RED}Errors:         ${ERRORS}${NC}"
echo -e "  ${YELLOW}Warnings:       ${WARNINGS}${NC}"
echo -e "  ${PURPLE}Suggestions:    ${SUGGESTIONS}${NC}"
if [[ "$ENLIGHTENED" == "true" ]]; then
    echo -e "  ${CYAN}Vibes checked:  ${VIBES}${NC}"
fi
echo ""

if [[ $ERRORS -gt 0 ]]; then
    echo -e "${RED}${BOLD}❌ VALIDATION FAILED${NC} — ${ERRORS} error(s) found"
    if [[ "$STRICT" == "true" ]]; then
        echo -e "${RED}   (strict mode: ${WARNINGS} warnings also count as failures)${NC}"
        exit 1
    fi
    exit 1
elif [[ $WARNINGS -gt 0 ]] && [[ "$STRICT" == "true" ]]; then
    echo -e "${YELLOW}${BOLD}⚠️  VALIDATION FAILED (strict mode)${NC} — ${WARNINGS} warning(s)"
    exit 1
else
    echo -e "${GREEN}${BOLD}✅ ALL CHECKS PASSED${NC}"
    if [[ $WARNINGS -gt 0 ]]; then
        echo -e "${YELLOW}   (${WARNINGS} non-blocking warnings)${NC}"
    fi
    echo ""
    echo -e "${CYAN}Your skills are valid and spiritually aligned. Ship with confidence. 🚀${NC}"
fi
