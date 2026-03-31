---
description: Import cookies from your real browser into the headless browse session for authenticated testing.
argument-hint: 
---

# setup-browser-cookies

gstack 스킬을 실행합니다. 아래 순서를 따르세요:

## 1. 스킬 파일 찾기

```bash
_GSTACK_SKILL=$(find ~/.claude/plugins/cache -path "*/gstack-plugin/*/skills/setup-browser-cookies/SKILL.md" 2>/dev/null | head -1)
echo "SKILL: $_GSTACK_SKILL"
```

## 2. 스킬 실행

Read 도구로 `$_GSTACK_SKILL` 파일을 읽고, 그 안의 모든 지시사항을 따르세요.
Preamble bash 블록이 있으면 먼저 실행하세요.
