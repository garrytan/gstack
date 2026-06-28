---
name: gpu-ops
preamble-tier: 0
version: 1.0.0
description: Deploy LLMs, track GPU cost per AI agent, enforce budgets and model policies via VibOps MCP
triggers:
  - "deploy a model on my GPU cluster"
  - "what's my GPU cost per agent"
  - "set a budget on an agent"
  - "which agent costs the most"
  - "scale GPU replicas"
  - "check GPU anomalies"
allowed-tools:
  - Bash
  - Read
---

# /gpu-ops — GPU Infrastructure + Agent FinOps

> Deploy LLMs, track GPU cost per AI agent, enforce budgets and model policies — all in natural language via VibOps MCP.

## When to invoke this skill

- "Deploy Mistral-7B on my GPU cluster"
- "Which agent costs the most in GPU this month?"
- "Set a $1,500/month budget on the pricing agent"
- "Only allow RH agents to use Mistral models"
- "Show me GPU anomalies"
- "Scale inference to 4 replicas"
- "Verify the audit chain"
- "What's the impact if I migrate Llama-70B?"

## Prerequisites

Install the VibOps MCP server:

```bash
# Add to Claude Code
claude mcp add vibops -- vibops-mcp \
  -e VIBOPS_URL=https://your-vibops-instance \
  -e VIBOPS_TOKEN=your-api-token

# Or install standalone
pip install git+https://github.com/VibOpsai/vibops-mcp.git
```

## What it provides

### GPU Infrastructure (37 tools)
- **Deploy**: `deploy_model`, `helm_upgrade`, `helm_uninstall`
- **Scale**: `scale_deployment` with dry-run confirmation
- **Monitor**: `get_gpu_metrics`, `list_alerts`, `get_open_anomalies`
- **Multi-vendor**: NVIDIA, AMD, Intel, AWS Trainium, Google TPU, Groq
- **SLURM**: `slurm_submit_job`, `slurm_list_jobs`, `slurm_cancel_job`

### Agent Infrastructure Control Plane (12 tools)
- **FinOps per agent**: `get_agent_usage` — which agent costs how much in GPU
- **Budget enforcement**: `set_agent_budget` — block agents that exceed spend limits (HTTP 429)
- **Model policy**: `update_agent_model_rule` — control which agent uses which LLM (HTTP 403)
- **Identity lifecycle**: `create_agent_identity`, `rotate`, `revoke`
- **Dependency graph**: `get_agent_dependency_graph` — impact analysis before migration

### Governance & Compliance (21 tools)
- **AI Act**: `get_ai_act_score`, `list_ai_act_controls`
- **SOC 2/GDPR/HIPAA**: `generate_compliance_report`
- **Audit**: `list_audit_logs`, `verify_audit_chain` (HMAC-SHA256)
- **Policy engine**: `get_policy`, `update_policy` (default-deny)

### GPU FinOps (4 tools)
- **Budget**: `get_budget` — org-level GPU spend tracking
- **Chargeback**: `get_chargeback` — inter-department GPU cost allocation
- **Waste detection**: `get_waste_analysis` — idle GPUs burning budget
- **Trends**: `get_spend_trend` — 30/60/90 day projections

## Example workflow

```
You: "I just deployed 5 AI agents. Show me the GPU cost per agent this month."

Claude calls: get_agent_usage(period="30d")

Response:
  supply-chain-optimizer  $4,559  (53% of total — Llama-70B only)
  pricing-agent-v2        $2,368  (Llama-70B + Mistral-7B mix)
  marketing-content       $1,145
  rh-screening-bot          $271  (Mistral-7B — most efficient)
  rh-onboarding             $118

You: "Set a $1,500 budget on marketing and restrict RH agents to Mistral only."

Claude calls: set_agent_budget("marketing-content", 1500)
              update_agent_model_rule("rh-*", allowed=["mistral-*"])
```

## Links

- **GitHub**: https://github.com/VibOpsai/vibops-mcp (MIT, 74 tools)
- **Website**: https://vibops.ai
- **Install**: `pip install git+https://github.com/VibOpsai/vibops-mcp.git`
