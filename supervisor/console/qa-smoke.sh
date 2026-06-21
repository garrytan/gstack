#!/usr/bin/env bash
# supervisor/console/qa-smoke.sh
# Smoke-tests the Fleet Console web UI for key DOM elements and captures a screenshot.
# Usage: bash supervisor/console/qa-smoke.sh
# Env: QA_BASE_URL (default: http://localhost:7842), BROWSE_BIN (default: gstack)

BROWSE_BIN="${BROWSE_BIN:-gstack}"
QA_BASE_URL="${QA_BASE_URL:-http://localhost:7842}"
SCREENSHOT="/tmp/console-qa-$(date +%s).png"

pass=0
fail=0

_ok()   { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
_fail() { printf '  FAIL  %s\n' "$1" >&2; fail=$((fail + 1)); }

# AC5: verify the browse binary is available before doing anything else
if ! command -v "$BROWSE_BIN" >/dev/null 2>&1; then
  echo "gstack browse not found — install gstack or set BROWSE_BIN" >&2
  exit 1
fi

echo "=== Fleet Console smoke test ==="
echo "  URL:     $QA_BASE_URL"
echo "  Browser: $BROWSE_BIN"
echo ""

# AC1a: navigate to the console
"$BROWSE_BIN" goto "$QA_BASE_URL"

# AC1b: page title contains "Fleet Console"
TITLE=$("$BROWSE_BIN" js "document.title")
if echo "$TITLE" | grep -q "Fleet Console"; then
  _ok "page title contains 'Fleet Console' (got: $TITLE)"
else
  _fail "page title should contain 'Fleet Console' (got: $TITLE)"
fi

# AC1c: nav[role=tablist] is visible
VIS=$("$BROWSE_BIN" is visible "nav[role=tablist]")
if [ "$VIS" = "true" ]; then
  _ok "nav[role=tablist] is visible"
else
  _fail "nav[role=tablist] is not visible (got: $VIS)"
fi

# AC1d: Fleet tab button is present (checked via JS for text content)
FLEET_TAB=$("$BROWSE_BIN" js "Array.from(document.querySelectorAll('button[role=\"tab\"]')).some(function(b){return b.textContent.trim()==='Fleet';}) ? 'true' : 'false'")
if [ "$FLEET_TAB" = "true" ]; then
  _ok "Fleet tab button is present"
else
  _fail "Fleet tab button is not present"
fi

# T10 AC1/AC7: body font-size is 16px
FONT_SIZE=$("$BROWSE_BIN" js "getComputedStyle(document.body).fontSize")
if [ "$FONT_SIZE" = "16px" ]; then
  _ok "body font-size is 16px (got: $FONT_SIZE)"
else
  _fail "body font-size should be 16px (got: $FONT_SIZE)"
fi

# T10 AC4: card border-radius is 6px (checked on .empty-section which is always present)
RADIUS=$("$BROWSE_BIN" js "getComputedStyle(document.querySelector('.empty-section')).borderRadius")
if [ "$RADIUS" = "6px" ]; then
  _ok "card border-radius is 6px (got: $RADIUS)"
else
  _fail "card border-radius should be 6px (got: $RADIUS)"
fi

# T6 AC1: fleet avatar img src contains dicebear.com
"$BROWSE_BIN" js "renderFleet([{name:'agent-fe',state:'working',task:'T6',sessionStart:Date.now()-120000,lastTool:'Read',lastSummary:'testing'}])"
AVATAR_SRC=$("$BROWSE_BIN" js "const img=document.querySelector('.fleet-avatar img');img?img.getAttribute('src'):'none'")
if echo "$AVATAR_SRC" | grep -q "dicebear.com"; then
  _ok "fleet avatar img src contains dicebear.com"
else
  _fail "fleet avatar img src should contain dicebear.com (got: $AVATAR_SRC)"
fi

# T6 AC2: elapsed time cell contains 'm' or 'h'
ELAPSED=$("$BROWSE_BIN" js "const el=document.querySelector('.fleet-elapsed');el?el.textContent.trim():'none'")
if echo "$ELAPSED" | grep -qE "[0-9]+[mh]"; then
  _ok "fleet elapsed time shows time value (got: $ELAPSED)"
else
  _fail "fleet elapsed time should show Xm/Xh value (got: $ELAPSED)"
fi

# T6 AC4: approval card renders with HIGH risk badge — switch to Queue tab first
"$BROWSE_BIN" js "document.getElementById('tab-queue').click()"
"$BROWSE_BIN" js "const c=buildApprovalCard({id:'test-a1',agent:'agent-fe',risk:'high',command:'rm -rf /',description:'test action',action_type:'SHELL',files:[]});document.getElementById('approval-cards').prepend(c)"
HIGH_BADGE=$("$BROWSE_BIN" js "const b=document.querySelector('.approval-risk-label.risk-high');b?b.textContent.trim():'none'")
if echo "$HIGH_BADGE" | grep -qi "HIGH"; then
  _ok "approval card renders with HIGH risk badge (got: $HIGH_BADGE)"
else
  _fail "approval card should render with HIGH badge (got: $HIGH_BADGE)"
fi

# T6 AC5: attention card renders with Unblock button
"$BROWSE_BIN" js "const c=buildAttentionCard({id:'test-b1',agent:'agent-fe',task_id:'T6',title:'Test blocked task',agent_note:'This is a test note for the unblock test'});document.getElementById('attention-cards').prepend(c)"
UNBLOCK_BTN=$("$BROWSE_BIN" js "document.querySelector('.btn-unblock')?'present':'none'")
if [ "$UNBLOCK_BTN" = "present" ]; then
  _ok "attention card has Unblock button"
else
  _fail "attention card should have Unblock button"
fi

# AC1e / AC2: take screenshot and print path so QA can attach it as evidence
"$BROWSE_BIN" screenshot "$SCREENSHOT"
echo "Screenshot: $SCREENSHOT"
echo ""

printf '=== Results: %d passed, %d failed ===\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
