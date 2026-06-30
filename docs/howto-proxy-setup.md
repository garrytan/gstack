# Using gstack Behind a Local Proxy

Running gstack skills through a local API proxy saves money, unlocks alternative models, and makes every gstack skill work with zero code changes.

## How it works

Claude Code natively reads the `ANTHROPIC_BASE_URL` environment variable at startup. When set, every API call — including every `/review`, `/qa`, `/investigate`, and `/ship` — routes through the proxy instead of Anthropic's direct endpoint.

No gstack code changes needed. Skills don't make their own API calls; they issue tool calls within Claude Code's session, and Claude Code handles the routing.

```
┌─────────────┐     tool calls      ┌──────────────────┐     proxied API     ┌──────────────┐
│  Claude Code │ ──────────────────→ │  Local Proxy     │ ─────────────────→ │  AI Provider  │
│  + gstack     │                    │  localhost:8082  │                    │  (DeepSeek,   │
│  skills       │ ←──────────────────│  (free-claude-   │ ←─────────────────│  OpenAI, etc) │
│               │     responses      │   code)          │     responses     │              │
└─────────────┘                     └──────────────────┘                    └──────────────┘
```

## Setup

```bash
# 1. Start your proxy (example: free-claude-code)
# See https://github.com/Alishahryar1/free-claude-code

# 2. Point Claude Code at it
export ANTHROPIC_BASE_URL=http://localhost:8082

# 3. Start Claude Code — gstack skills use the proxy automatically
claude
```

All 50+ gstack skills work transparently. Run `/health` to verify connectivity, then run any skill as usual.

## Real-world reference: free-claude-code

[free-claude-code](https://github.com/Alishahryar1/free-claude-code) is the reference proxy implementation. It runs as a Docker container, exposes an OpenAI-compatible API at `localhost:8082`, and supports multiple providers including DeepSeek V4 Flash.

### Cost comparison (Anthropic Direct vs Proxy)

| Metric | Anthropic Direct | DeepSeek V4 Flash (via proxy) | Savings |
|--------|-----------------|-------------------------------|---------|
| Input tokens per request | Same | Same | — |
| Output tokens per request | Same | Same | — |
| Cost per 1M input tokens | $3.00 (Sonnet) | $0.15 | **95%** |
| Cost per 1M output tokens | $15.00 (Sonnet) | $0.60 | **96%** |
| Effective rate per Claude Code session | ~$0.30-0.80 | ~$0.03-0.06 | **~90%** |

Pricing as of June 2026. DeepSeek V4 Flash is a proxy-level routing choice — swap providers via env vars, not code changes.

### Proxy features that matter for gstack

- **Transparent routing**: gstack skills make standard Claude API calls; the proxy intercepts and re-routes to the configured provider
- **Rate limiting**: built-in sliding window + reactive backoff for 429/5xx errors
- **Retry on transient failures**: HTTP 400 from upstream is retried with exponential backoff (DeepSeek occasionally returns 400 on internal hiccups)
- **Idempotent-safe**: `/messages` POSTs are safe to retry and upstream 400s aren't billed
- **Docker-based**: `docker compose up`, no system-level dependencies

## Verifying it works

```bash
# Check proxy health
curl -sf http://localhost:8082/health
# → {"status":"healthy"}

# Verify ANTHROPIC_BASE_URL is set in your Claude Code session
echo $ANTHROPIC_BASE_URL
# → http://localhost:8082

# Run a gstack skill — works transparently through the proxy
# /health in Claude Code will use proxy-routed requests
```

## Known patterns

### Running with a team

Set `ANTHROPIC_BASE_URL` in your shared environment config (direenv, `.envrc`, Railway vars, etc.) so every team member's Claude Code uses the proxy automatically.

### Multi-provider routing

Some proxies support provider selection via headers or URL paths. free-claude-code routes to DeepSeek by default but can be configured for OpenAI, Together, or Anthropic direct as fallback.

### CI/CD

For automated `/ship` and `/land-and-deploy` runs, set `ANTHROPIC_BASE_URL` in your CI environment. The proxy Docker container runs as a sidecar or service.

### Debugging

```bash
# Check proxy logs for errors
docker logs <proxy-container> 2>&1 | grep -E "ERROR|400|5xx"

# Verify the proxy is actually routing (not falling back to direct)
curl -sf http://localhost:8082/health
```

## Limitations

- **Latency**: Proxy adds ~5-20ms per request (Docker network hop). Negligible for LLM response times (seconds), but cumulative for rapid tool-use chains.
- **Provider availability**: If the upstream provider (DeepSeek, OpenAI) is down, the proxy cannot route. Configure a fallback provider in the proxy config.
- **Feature parity**: Some proxy implementations may not support every Anthropic API feature (thinking blocks, extended output, streaming). Verify your use case against the proxy's supported features.
