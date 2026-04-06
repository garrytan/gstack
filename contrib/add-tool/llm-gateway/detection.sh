# Multi-LLM orchestration (llm-cli-gateway)
# Reference fragment — inlined by preamble.ts resolver
_LLM_GW="unavailable"
_LLM_GW_CLAUDE="no"
_LLM_GW_CODEX="no"
_LLM_GW_GEMINI="no"
if command -v llm-cli-gateway >/dev/null 2>&1; then
  _LLM_GW="available"
  command -v claude >/dev/null 2>&1 && _LLM_GW_CLAUDE="yes"
  command -v codex >/dev/null 2>&1 && _LLM_GW_CODEX="yes"
  command -v gemini >/dev/null 2>&1 && _LLM_GW_GEMINI="yes"
fi
echo "LLM_GATEWAY: $_LLM_GW"
[ "$_LLM_GW" = "available" ] && echo "LLM_GW_CLAUDE: $_LLM_GW_CLAUDE"
[ "$_LLM_GW" = "available" ] && echo "LLM_GW_CODEX: $_LLM_GW_CODEX"
[ "$_LLM_GW" = "available" ] && echo "LLM_GW_GEMINI: $_LLM_GW_GEMINI"
