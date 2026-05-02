# @nim

> Route current task through NVIDIA NIM instead of Anthropic

Use this when you want to use your own NIM models (via OpenClaude proxy) instead of Claude Code's default Anthropic models.

## When

- **Cost savings**: You're running on your own GPU/API
- **Privacy**: Don't want to send data to Anthropic  
- **Specific models**: Use NIM-only models (GLM, Llama, Vision)
- **Testing**: Compare NIM vs Claude outputs

## Setup Required

```bash
# One-time setup
git clone https://github.com/Hanishchow/OpenClaude.git ~/OpenClaude
cd ~/OpenClaude
./scripts/start.sh

# Test it works
~/OpenClaude/cli/nim-chat.sh "test"
```

## How It Works

1. Routes through local proxy at `localhost:8082`
2. Proxy forwards to NVIDIA NIM (`integrate.api.nvidia.com`)
3. Response streaming returned in SSE format

## Models Available

| Model | Best For |
|-------|----------|
| `z-ai/glm-4.7` | General chat |
| `meta/llama-3.1-70b-instruct` | Fast responses |
| `deepseek-ai/deepseek-coder-v2` | Code/debug tasks |
| `nvidia/vision` | Image understanding |

## Workflow

1. Activate this skill: `@nim`
2. Your task will be routed through NIM instead of Anthropic
3. See the response in your terminal

## Requirements

- NVIDIA API key (https://build.nvidia.com/settings/api-keys)
- OpenClaude proxy running (`./scripts/start.sh`)
- Or use existing CLI: `~/OpenClaude/cli/nim-chat.sh "prompt"`

## Notes

- **Slow first start**: Proxy cold-starts ~5s
- **Response quality**: May differ from Claude
- **Tool support**: Limited vs Claude (no computer use, etc.)
- **Streaming**: Responses stream in real-time

## Examples

```
@nim Explain quantum computing simply
@nim Write a Python function for Fibonacci
@nim Compare this code to NIM vs Claude output
```