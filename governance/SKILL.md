---
name: governance
version: 0.1.0
description: |
  Cryptographic accountability for agent sessions. Every destructive action gets an
  Ed25519-signed receipt. Scope enforcement prevents the agent from exceeding its
  declared authority. Tamper-evident audit trail survives session restarts.
  Use when asked to "govern this session", "accountability mode", "audit mode",
  or before any high-stakes workflow (deploy, data migration, production changes). (gstack)
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-governance.sh"
          statusMessage: "Checking governance scope..."
---

# /governance — Cryptographic Accountability for Agent Sessions

Governance mode is now **active**. This session has a cryptographic identity and
every significant action produces a signed, tamper-evident receipt.

```bash
mkdir -p ~/.gstack/governance
mkdir -p ~/.gstack/analytics

# Generate session identity (Ed25519 keypair) if not exists
if [ ! -f ~/.gstack/governance/session-key.pem ]; then
  openssl genpkey -algorithm ed25519 -out ~/.gstack/governance/session-key.pem 2>/dev/null
  openssl pkey -in ~/.gstack/governance/session-key.pem -pubout -out ~/.gstack/governance/session-key.pub 2>/dev/null
  echo "Generated session Ed25519 keypair"
fi

# Extract public key fingerprint
SESSION_PUB=$(openssl pkey -in ~/.gstack/governance/session-key.pub -pubin -text -noout 2>/dev/null | grep -A2 'pub:' | tail -1 | tr -d ' :')
echo "Session identity: ${SESSION_PUB:0:16}..."

# Initialize audit ledger for this session
LEDGER=~/.gstack/governance/ledger-$(date -u +%Y%m%d-%H%M%S).jsonl
echo "{\"event\":\"session_start\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"pubkey\":\"$SESSION_PUB\",\"pid\":\"$$\"}" >> "$LEDGER"
echo "Audit ledger: $LEDGER"

# Load scope (if declared)
if [ -f .gstack-scope.json ]; then
  SCOPE=$(cat .gstack-scope.json)
  echo "Scope loaded: $(echo $SCOPE | python3 -c 'import sys,json; d=json.load(sys.stdin); print(", ".join(d.get("allowed",[])))'  2>/dev/null || echo 'custom')"
else
  echo "No scope file found (.gstack-scope.json). Running in audit-only mode."
  echo "Create .gstack-scope.json to enforce scope boundaries."
fi

echo '{"skill":"governance","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## What this does

| Feature | Description |
|---------|-------------|
| **Session identity** | Ed25519 keypair generated at first use. Persists across sessions. |
| **Signed receipts** | Every destructive action (deploy, push, delete, db mutation) gets a receipt signed with the session key. |
| **Scope enforcement** | If `.gstack-scope.json` exists, actions outside the declared scope are blocked. |
| **Audit ledger** | Append-only JSONL file. Every action logged with timestamp, command hash, and signature. |
| **Tamper detection** | Each receipt includes the hash of the previous receipt. Break the chain = evidence of tampering. |

## Scope file format


Create `.gstack-scope.json` in your project root:

```json
{
  "allowed": ["read", "write", "test", "review"],
  "blocked": ["deploy", "db_migrate", "force_push"],
  "spend_limit": null,
  "expires_at": null,
  "principal": "your-name"
}
```

- **allowed**: Actions the agent can perform. If empty, all actions are allowed (audit-only).
- **blocked**: Actions that are always denied, even if in `allowed`.
- **spend_limit**: Optional. Maximum dollar amount for purchase/deploy operations.
- **principal**: Who authorized this session. Logged in every receipt.

Without a scope file, `/governance` runs in **audit-only mode** — everything is logged and signed, nothing is blocked. Add a scope file to enable enforcement.

## How receipts work

Every destructive command produces a receipt:

```json
{
  "action": "git push origin main",
  "action_hash": "sha256:a1b2c3...",
  "timestamp": "2026-04-04T12:00:00Z",
  "scope_check": "permit",
  "previous_receipt_hash": "sha256:9f8e7d...",
  "signature": "ed25519:..."
}
```

The `previous_receipt_hash` creates a hash chain — if any receipt is deleted or modified,
the chain breaks and the tampering is detectable. This is the same pattern used in
blockchain and certificate transparency logs.

## Composing with other gstack skills

`/governance` composes naturally with existing gstack skills:

- **`/governance` + `/ship`**: Every deploy gets a signed receipt. If something breaks in prod, you can prove exactly what was deployed, when, and with what authorization.
- **`/governance` + `/careful`**: `/careful` warns before destructive commands. `/governance` signs a receipt if you proceed. Defense in depth.
- **`/governance` + `/review`**: Code review findings are logged in the audit ledger. A reviewer can prove they flagged an issue before it shipped.
- **`/governance` + `/guard`**: Maximum safety. Scope enforcement + destructive command warnings + signed audit trail.

## Viewing the audit trail

```bash
# View recent receipts
cat ~/.gstack/governance/ledger-*.jsonl | tail -20 | python3 -m json.tool

# Verify chain integrity
cat ~/.gstack/governance/ledger-*.jsonl | python3 -c "
import sys, json, hashlib
prev = None
for line in sys.stdin:
    r = json.loads(line)
    if prev and r.get('previous_receipt_hash') != prev:
        print(f'CHAIN BREAK at {r[\"ts\"]}')
    prev = hashlib.sha256(line.encode()).hexdigest()
print(f'Chain intact. {sum(1 for _ in open(sys.argv[1]) if True)} receipts verified.' if prev else 'Empty ledger.')
" 2>/dev/null || echo "Use: cat ledger-*.jsonl | python3 verify_chain.py"
```

## External verification (optional)

For teams that want external accountability, receipts can be verified against the
[Agent Passport System](https://github.com/aeoess/agent-passport-system) gateway:

```bash
npm install agent-passport-system  # optional — governance works without this
```

With APS, the session identity becomes a verifiable agent passport with delegation
chains, reputation scoring, and cascade revocation. The receipts produced by
`/governance` are compatible with APS receipt format.

This is optional. `/governance` works standalone with zero dependencies.
