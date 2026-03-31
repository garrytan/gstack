---
description: Designer's eye plan review — rates each design dimension 0-10, explains what makes a 10, fixes to get there.
argument-hint: [plan file]
---

# plan-design-review

gstack 스킬을 실행합니다. 아래 순서를 따르세요:

## 1. 스킬 파일 찾기

```bash
_GSTACK_SKILL=$(find ~/.claude/plugins/cache -path "*/gstack-plugin/*/skills/plan-design-review/SKILL.md" 2>/dev/null | head -1)
echo "SKILL: $_GSTACK_SKILL"
```

## 2. 스킬 실행

Read 도구로 `$_GSTACK_SKILL` 파일을 읽고, 그 안의 모든 지시사항을 따르세요.
Preamble bash 블록이 있으면 먼저 실행하세요.
