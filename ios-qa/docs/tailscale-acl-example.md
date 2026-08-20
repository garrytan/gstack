# Tailscale ACL example for the iOS QA daemon

The Mac-side daemon binds the Tailscale interface only when you pass
`--tailnet`. By default the daemon is local-USB-only. This doc walks through
the steps to expose your iPhone to remote agents safely so they can run iOS QA over the tailnet.

## Threat model recap

- **iOS app StateServer:** loopback-only always. Reachable from the Mac via
  the CoreDevice IPv6 tunnel. Never directly bound to tailnet.
- **Mac daemon:** owns the tailnet interface. Binds two listeners — loopback
  (full surface, never forwarded) and tailnet (locked allowlist with
  capability tiers).
- **Auth:** Tailscale identity validation via the local `tailscaled` socket
  (`/var/run/tailscale.sock` LocalAPI WhoIs). Allowlist file at
  `~/.gstack/ios-qa-allowlist.json` is the single source of truth for who can
  do what.

## Step 1: Install and run Tailscale

```bash
brew install --cask tailscale
# Login + start tailscaled, then verify:
tailscale status
```

Confirm the daemon can read the LocalAPI socket:

```bash
test -S /var/run/tailscale.sock && echo "socket present" || echo "MISSING"
```

If missing, the daemon will refuse to open the tailnet listener (fail-closed).

## Step 2: Set up the daemon's ACL

The daemon needs to know which Tailscale identities are allowed to control
which devices at which capability tier. The allowlist file is JSON:

```json
{
  "version": 1,
  "entries": [
    {
      "identity": "you@example.com",
      "capabilities": ["restore"],
      "expires_at": null,
      "note": "Owner — full access"
    },
    {
      "identity": "ci@example.com",
      "capabilities": ["mutate"],
      "expires_at": "2026-12-31T00:00:00Z",
      "note": "CI runner — can write state but not full restore"
    },
    {
      "identity": "tag:claude-readonly",
      "capabilities": ["observe"],
      "expires_at": null,
      "note": "Agents that should only read"
    }
  ]
}
```

Identities are canonicalized via WhoIs:

- **User OAuth:** `user@example.com` (no `acct:`, no domain rewriting).
- **Tagged nodes:** `tag:<tagname>` (lowercased).
- **Node keys:** `node:<nodekey-hex>` (rare; use tags instead).

Capability tiers are ordered: `observe` < `interact` < `mutate` < `restore`.
Granting `restore` implies all lower tiers.

## Step 3: Mint a session token for a remote agent

You can let agents self-mint (if their identity is allowlisted) or you can
mint server-side for them:

```bash
# Server-side mint (owner-only, runs locally on the Mac with the device):
gstack-ios-qa-mint --remote ci@example.com --capability mutate --ttl 1h

# Self-service mint (agent over tailnet):
curl -X POST http://<mac-tailnet-ip>:9999/auth/mint \
  -H "Content-Type: application/json" \
  -d '{"capability": "interact"}'
# → {"session_token": "...", "expires_at": "...", "capability": "interact"}
```

## Step 4: Tighten the Tailscale ACL (defense in depth)

The daemon's allowlist is the primary access control. Belt-and-suspenders:
restrict the tailnet ACL to limit who can even *reach* the daemon port.

```jsonc
// In your tailscale admin console:
{
  "acls": [
    // Allow CI runner to reach the iOS QA Mac on port 9999 only.
    {
      "action": "accept",
      "src": ["ci@example.com"],
      "dst": ["ios-qa-mac:9999"]
    },
    // Tagged Claude agents — observe tier only (enforced by daemon, not ACL).
    {
      "action": "accept",
      "src": ["tag:claude-readonly"],
      "dst": ["ios-qa-mac:9999"]
    },
    // Default deny.
    {
      "action": "drop",
      "src": ["*"],
      "dst": ["ios-qa-mac:9999"]
    }
  ]
}
```

## Step 5: Audit trail

Every authenticated mutating request through the tailnet listener writes a
row to `~/.gstack/security/ios-qa-audit.jsonl`:

```jsonl
{"ts":"2026-05-18T14:23:00Z","identity":"ci@example.com","device_udid":"00008101-XXXX","endpoint":"/tap","session_id":"abc...","capability":"interact","request_id":"req_001","status":200}
```

Rejections (no token, expired token, capability-insufficient, identity not
allowlisted, rate limit hit) write to `~/.gstack/security/attempts.jsonl`.

## Rate limits

- `/auth/mint`: 10 mints / 60s per identity. 11th returns 429.
- Per-tailnet-request body: 1MB hard cap (413 above).
- Screenshot response: 10MB hard cap (500 above with sanitized error).

## Token lifetime

- Daemon-minted session tokens: default 1h TTL, max 24h via
  `--tailnet-session-ttl`.
- Refreshable via `POST /session/heartbeat` (extends by `ttl_seconds`, capped
  at the original max).
- Boot token (between iOS app launch and daemon rotation): ~5s lifetime —
  daemon rotates immediately on first scrape.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| Daemon refuses to open tailnet listener | `/var/run/tailscale.sock` missing or permission-denied | Install Tailscale; verify `tailscale status` works as the user running daemon |
| `403 identity_not_allowed` | identity missing from allowlist | Owner mint: `gstack-ios-qa-mint --remote <identity>` |
| `403 capability_insufficient` | token tier below endpoint requirement | Owner mint with higher `--capability` tier |
| `429 rate_limited` | >10 mints/min from one identity | Wait 60s; investigate why the agent is re-minting so often |
| `409 schema_mismatch` on `/state/restore` | snapshot from older app build | Discard the snapshot; re-capture from current app build |
