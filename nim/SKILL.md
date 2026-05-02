# @nim

> Route current task through NVIDIA NIM instead of Anthropic

Use this when you want to use your own NIM models instead of Claude Code's default Anthropic models.

## When

- **Cost savings**: Your GPU / API (not per-token)
- **Privacy**: Data stays local, not sent to Anthropic  
- **Specific models**: Use NIM-exclusive models (GLM, Llama, Vision)
- **Testing**: Compare NIM vs Claude outputs
- **Custom models**: Fine-tuned or private models

## Setup (One-Time)

```bash
# Clone OpenClaude
git clone https://github.com/Hanishchow/OpenClaude.git ~/OpenClaude
cd ~/OpenClaude

# Add your NVIDIA API key
cp config/env.example config/.env
# Edit .env and add: NVIDIA_NIM_API_KEY=your-key

# Start the proxy
./scripts/start.sh

# Test
~/OpenClaude/cli/nim-chat.sh "hello"
```

Get your free NVIDIA API key at: https://build.nvidia.com/settings/api-keys

## Architecture

```
Claude Code → OpenClaude Proxy (localhost:8082) → NVIDIA NIM → Your Models
```

## Models Available

| Model | Best For |
|-------|----------|
| `z-ai/glm-4.7` | General chat (default) |
| `meta/llama-3.1-70b-instruct` | Fast responses |
| `deepseek-ai/deepseek-coder-v2` | Code, debugging |
| `nvidia/vision` | Image understanding |

## Usage

```bash
# Chat with NIM
~/OpenClaude/cli/nim-chat.sh "Your prompt"

# Auto-route to best model
~/OpenClaude/cli/nim-route.sh "description"

# List available models
~/OpenClaude/cli/nim-models.sh

# Or use the skill in Claude Code:
@nim Explain quantum computing
```

## Comparison

| Feature | Claude (Anthropic) | NIM (This) |
|---------|-------------------|-------------|
| Cost | Per-token | Your GPU/API |
| Privacy | Sends to cloud | Local option |
| Models | Claude only | Any NIM model |
| Tools | Full support | Limited |
| Speed | Fast | Depends on GPU |

## Troubleshooting

**Proxy not running:**
```bash
~/OpenClaude/scripts/start.sh
```

**API key issues:**
- Get key from https://build.nvidia.com/settings/api-keys
- Add to ~/OpenClaude/config/.env

**Model not found:**
- Some models require acceptance on NVIDIA build
- Check available models: ~/OpenClaude/cli/nim-models.sh