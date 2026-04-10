# Hotfix: Pre-flight + 타입 검증 + Parent 연결

> 이 파일은 `/bams:hotfix`의 Pre-flight 단계를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- arguments: $ARGUMENTS (버그 설명 또는 에러 메시지)

---

## Pre-flight

**`references/preflight-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

차이점:
- config.md 없어도 계속 진행 가능.
- 인자 비어있으면 AskUserQuestion으로 버그 설명 받기.
- Gotchas에서 버그 영역과 관련된 항목을 디버거 힌트로 전달.

진행 추적 파일: `templates/hotfix-tracking.md` 기반으로 생성.

### Viz 이벤트: pipeline_start

진행 추적 파일 및 lock 파일 생성 직후, Bash로 다음을 실행합니다.
**주의:** Step 0.6에서 parent_pipeline_slug가 결정된 후 아래 수정 라인으로 대체하여 emit한다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "hotfix" "/bams:hotfix" "{arguments}" "{parent_pipeline_slug}"
```

---

## Step 0.5: 파이프라인 타입 검증

Pre-flight 완료 직후, 입력 내용이 hotfix에 적합한지 확인합니다.

**타입 판별 기준:**

| 입력 특성 | 적합한 파이프라인 |
|-----------|-----------------|
| 재현 가능한 버그, 에러 메시지, 기존 기능 오작동 | hotfix (계속 진행) |
| 새로운 기능 추가, "~를 만들어줘", 신규 화면 | feature |
| 기존 피처 개선, 리팩토링, 성능 최적화 | dev |
| 보안 취약점, OWASP 관련 | security |

$ARGUMENTS를 분석하여:
1. **hotfix에 적합**: 바로 Step 1로 진행
2. **다른 파이프라인이 적합**: AskUserQuestion으로 사용자에게 안내

Question: "입력 내용이 버그 픽스보다 {적합한 파이프라인} 작업에 가까워 보입니다."
Header: "파이프라인 타입 불일치"
Options:
- **hotfix로 계속** — "현재 파이프라인으로 진행"
- **/{적합한 파이프라인} 사용** — "올바른 파이프라인으로 재시작 (현재 파이프라인 중단)"

---

## Step 0.6: Parent Pipeline 연결

이 핫픽스가 수정하는 원본 파이프라인을 연결합니다.

Bash로 최근 파이프라인 목록을 조회합니다:

```bash
echo "=== 최근 파이프라인 목록 ==="
ls -t ~/.bams/artifacts/pipeline/*-events.jsonl 2>/dev/null | head -10 | while read f; do
  slug=$(basename "$f" -events.jsonl)
  type=$(grep '"pipeline_start"' "$f" 2>/dev/null | head -1 | jq -r '.pipeline_type // "unknown"' 2>/dev/null)
  echo "  $slug ($type)"
done
```

AskUserQuestion — "이 핫픽스가 수정하는 파이프라인을 선택하세요"
Header: "Parent"
Options:
- 조회된 파이프라인 목록에서 최근 5개를 옵션으로 제시
- **없음** — "새로운 독립 핫픽스 (특정 파이프라인과 무관)"

선택된 parent_pipeline_slug를 이후 pipeline_start emit 시 6번째 인자로 전달합니다.

기존 pipeline_start emit 라인을 수정:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "hotfix" "/bams:hotfix" "{arguments}" "{parent_pipeline_slug}"
```

### Parent Pipeline의 WU 자동 상속

**`references/parent-wu-inheritance.md`를 Read하여 지시를 따른다.** 해당 파일의 bash 스크립트를 실행하여 WU를 상속한다.

AskUserQuestion에서 "없음" 선택 시: `PARENT_PIPELINE_SLUG=""`로 설정하여 상속 로직을 스킵한다.

---

## Pre-flight 완료 게이트 조건

- [ ] 추적 파일 생성 완료
- [ ] pipeline_start emit 완료
- [ ] 타입 검증 완료 (hotfix 적합 또는 사용자 확인)
- [ ] parent_pipeline_slug 결정 완료 (없음 포함)

Pre-flight 완료 → 엔트리포인트가 Step 1을 라우팅합니다.
