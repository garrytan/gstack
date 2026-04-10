# Parent Pipeline WU 자동 상속

> 이 파일은 hotfix, deep-review 등 parent pipeline을 선택하는 커맨드에서 WU를 자동 상속하는 공통 로직을 정의합니다.
> 각 커맨드의 Step 0.6(또는 0.5)에서 이 파일을 Read하여 지시를 따릅니다.

## 전제 조건

- `PARENT_PIPELINE_SLUG` 변수가 이전 단계(AskUserQuestion)에서 설정되어 있어야 합니다.
- "없음" 선택 시 `PARENT_PIPELINE_SLUG=""`로 설정합니다 (빈 문자열).

## WU 상속 로직

Parent Pipeline이 선택된 경우("없음" 제외), 해당 파이프라인의 WU를 자동 상속하여 `_shared_common.md` &sect;WU 선택 단계를 스킵한다.

```bash
# Parent pipeline의 WU 자동 상속
# slug sanitize — SQL injection 방지 (작은따옴표 이스케이프)
_SAFE_SLUG=$(echo "${PARENT_PIPELINE_SLUG}" | sed "s/'/''/g")

if [ -n "${PARENT_PIPELINE_SLUG}" ] && [ "${PARENT_PIPELINE_SLUG}" != "없음" ]; then
  _PARENT_WU=""
  # API 우선 조회 — 단건 조회로 효율화
  _P_JSON=$(curl -sf "http://localhost:3099/api/pipelines/${PARENT_PIPELINE_SLUG}" 2>/dev/null)
  if [ -n "$_P_JSON" ]; then
    _PARENT_WU=$(echo "$_P_JSON" | jq -r '.pipeline.work_unit_slug // empty' 2>/dev/null)
  fi
  # API 실패 시 DB fallback (sanitized slug 사용)
  if [ -z "$_PARENT_WU" ] && [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
    _PARENT_WU=$(sqlite3 "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" "SELECT wu.slug FROM pipelines p JOIN work_units wu ON p.work_unit_id = wu.id WHERE p.slug = '${_SAFE_SLUG}'" 2>/dev/null)
  fi
  if [ -n "$_PARENT_WU" ]; then
    SELECTED_WU_SLUG="$_PARENT_WU"
    echo "Parent pipeline '${PARENT_PIPELINE_SLUG}'의 WU 자동 상속: ${SELECTED_WU_SLUG}"
  fi
fi
```

**`SELECTED_WU_SLUG`가 설정되면 `_shared_common.md` &sect;WU 선택 단계를 스킵한다.**

## 주의사항

- API 단건 조회(`/api/pipelines/${slug}`)를 우선 사용하여 전체 목록 조회를 피합니다.
- DB fallback에서는 `_SAFE_SLUG`(작은따옴표 이스케이프 처리)를 사용합니다.
- 한글 slug(`hotfix_빌드에러수정` 등)도 정상 동작합니다.
