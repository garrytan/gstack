#!/bin/bash
# Governance hook for gstack — checks scope and signs receipts
# Called by PreToolUse hook on every Bash command

set -euo pipefail

GOVERNANCE_DIR="$HOME/.gstack/governance"
SCOPE_FILE=".gstack-scope.json"
LEDGER=$(ls -t "$GOVERNANCE_DIR"/ledger-*.jsonl 2>/dev/null | head -1)
KEY_FILE="$GOVERNANCE_DIR/session-key.pem"

# Extract command from tool input (Claude Code passes JSON via stdin)
COMMAND=$(cat | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('command', data.get('input', '')))
except:
    print('')
" 2>/dev/null || echo "")

if [ -z "$COMMAND" ]; then
    exit 0  # No command to check
fi

# Classify action type
ACTION_TYPE="read"
DESTRUCTIVE=false

# Destructive patterns (same as /careful, extended)
if echo "$COMMAND" | grep -qiE 'rm\s+-r|drop\s+table|truncate|git\s+push.*(-f|--force)|git\s+reset\s+--hard|kubectl\s+delete|docker\s+rm|deploy|migrate'; then
    ACTION_TYPE="destructive"
    DESTRUCTIVE=true
elif echo "$COMMAND" | grep -qiE 'git\s+push|npm\s+publish|pip\s+upload|twine\s+upload'; then
    ACTION_TYPE="deploy"
    DESTRUCTIVE=true
elif echo "$COMMAND" | grep -qiE 'git\s+commit|git\s+add'; then
    ACTION_TYPE="write"
elif echo "$COMMAND" | grep -qiE 'curl.*-X\s*(POST|PUT|DELETE|PATCH)|fetch.*method'; then
    ACTION_TYPE="network_write"
    DESTRUCTIVE=true
fi

# Check scope if scope file exists
VERDICT="permit"
REASON=""

if [ -f "$SCOPE_FILE" ]; then
    BLOCKED=$(python3 -c "
import json, sys
with open('$SCOPE_FILE') as f:
    scope = json.load(f)
blocked = scope.get('blocked', [])
action = '$ACTION_TYPE'
if action in blocked or ('$COMMAND' and any(b in '$COMMAND' for b in blocked)):
    print('blocked')
else:
    allowed = scope.get('allowed', [])
    if allowed and action not in allowed and action != 'read':
        print('not_in_scope')
    else:
        print('ok')
" 2>/dev/null || echo "ok")

    if [ "$BLOCKED" = "blocked" ]; then
        VERDICT="deny"
        REASON="Action type '$ACTION_TYPE' is in blocked list"
    elif [ "$BLOCKED" = "not_in_scope" ]; then
        VERDICT="deny"
        REASON="Action type '$ACTION_TYPE' not in allowed scope"
    fi
fi

# Sign receipt for destructive actions
if [ "$DESTRUCTIVE" = true ] && [ -n "$LEDGER" ] && [ -f "$KEY_FILE" ]; then
    # Get previous receipt hash for chain
    PREV_HASH=$(tail -1 "$LEDGER" 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || echo "genesis")
    
    # Create receipt
    ACTION_HASH=$(echo -n "$COMMAND" | shasum -a 256 | cut -d' ' -f1)
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    
    RECEIPT="{\"event\":\"action\",\"action_type\":\"$ACTION_TYPE\",\"action_hash\":\"sha256:$ACTION_HASH\",\"verdict\":\"$VERDICT\",\"ts\":\"$TS\",\"previous_receipt_hash\":\"sha256:$PREV_HASH\"}"
    
    # Sign the receipt
    SIG=$(echo -n "$RECEIPT" | openssl pkeyutl -sign -inkey "$KEY_FILE" 2>/dev/null | xxd -p | tr -d '\n' || echo "unsigned")
    
    # Append signed receipt to ledger
    echo "$RECEIPT" | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
r['signature'] = 'ed25519:${SIG:0:128}'
print(json.dumps(r))
" >> "$LEDGER" 2>/dev/null || echo "$RECEIPT" >> "$LEDGER"
fi

# Return verdict to Claude Code hook system
if [ "$VERDICT" = "deny" ]; then
    echo "{\"permissionDecision\": \"ask\", \"message\": \"🛡️ Governance: $REASON. Action type: $ACTION_TYPE. Override requires explicit approval.\"}"
else
    if [ "$DESTRUCTIVE" = true ]; then
        echo "{\"permissionDecision\": \"allow\", \"message\": \"📋 Receipt signed for: $ACTION_TYPE\"}" >&2
    fi
fi
