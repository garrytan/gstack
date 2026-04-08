#!/usr/bin/env bash
# <swiftbar.title>BAMS Status</swiftbar.title>
# <swiftbar.version>1.0.0</swiftbar.version>
# <swiftbar.author>bams-widget</swiftbar.author>
# <swiftbar.desc>bams-server 파이프라인 상태 모니터</swiftbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>false</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>

# ─────────────────────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────────────────────

BAMS_URL="${BAMS_SERVER_URL:-http://localhost:3099}"
BAMS_VIZ_URL="${BAMS_VIZ_URL:-http://localhost:3333}"
CACHE_FILE="/tmp/bams-widget-cache.json"
CACHE_TTL=30
JQ=$(which jq 2>/dev/null)

# ─────────────────────────────────────────────────────────────
# jq 의존성 확인
# ─────────────────────────────────────────────────────────────

if [ -z "$JQ" ]; then
  echo "⚠ BAMS | color=#eab308"
  echo "---"
  echo "jq required: brew install jq | color=#ef4444"
  echo "---"
  echo "🔗 Open Dashboard | href=${BAMS_VIZ_URL} color=#3b82f6"
  exit 0
fi

# ─────────────────────────────────────────────────────────────
# 캐시 유틸리티
# ─────────────────────────────────────────────────────────────

cache_is_valid() {
  if [ ! -f "$CACHE_FILE" ]; then
    return 1
  fi
  local now
  now=$(date +%s)
  local mtime
  # macOS: stat -f %m / Linux: stat -c %Y
  if stat -f %m "$CACHE_FILE" > /dev/null 2>&1; then
    mtime=$(stat -f %m "$CACHE_FILE")
  else
    mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
  fi
  local age=$(( now - mtime ))
  [ "$age" -lt "$CACHE_TTL" ]
}

read_cache() {
  cat "$CACHE_FILE" 2>/dev/null
}

write_cache() {
  echo "$1" > "$CACHE_FILE"
}

# ─────────────────────────────────────────────────────────────
# 파이프라인 상태 아이콘 / 색상 매핑
# ─────────────────────────────────────────────────────────────

get_pipeline_icon() {
  local status="$1"
  case "$status" in
    running|active)    echo "🟢" ;;
    completed|done|success) echo "✅" ;;
    failed|error)      echo "🔴" ;;
    paused)            echo "⏸" ;;
    *)                echo "⬜" ;;
  esac
}

get_pipeline_color() {
  local status="$1"
  case "$status" in
    running|active)    echo "#22c55e" ;;
    completed|done|success) echo "#22c55e" ;;
    failed|error)      echo "#ef4444" ;;
    paused)            echo "#eab308" ;;
    *)                echo "#8e8ea0" ;;
  esac
}

# ─────────────────────────────────────────────────────────────
# API 호출
# ─────────────────────────────────────────────────────────────

# Step 1: Health check (타임아웃 2초)
health_response=$(curl -s --max-time 2 "${BAMS_URL}/health" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$health_response" ]; then
  # OFFLINE
  echo "⚫ BAMS | color=#666666"
  echo "---"
  echo "Server Offline | color=#666666 size=12"
  echo "bams-server is not running | color=#8e8ea0 size=10"
  echo "---"
  echo "⚙️ ${BAMS_URL} | color=#585870 size=10"
  echo "🔗 Open Dashboard | href=${BAMS_VIZ_URL} color=#3b82f6"
  exit 0
fi

# Step 2: 활성 Work Units 가져오기 (캐시 우선)
wu_data=""
if cache_is_valid; then
  wu_data=$(read_cache)
else
  wu_data=$(curl -s --max-time 3 "${BAMS_URL}/api/workunits/active" 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$wu_data" ]; then
    write_cache "$wu_data"
  else
    # 캐시 fallback
    wu_data=$(read_cache)
  fi
fi

# 파싱 실패 시 빈 배열
if [ -z "$wu_data" ]; then
  wu_data='{"workunits":[]}'
fi

# workunits 배열 추출
wu_count=$(echo "$wu_data" | $JQ -r '.workunits | length' 2>/dev/null || echo "0")
wu_count=${wu_count:-0}

# ─────────────────────────────────────────────────────────────
# 메뉴바 첫 줄 출력
# ─────────────────────────────────────────────────────────────

if [ "$wu_count" -eq 0 ]; then
  echo "⚪ BAMS | color=#8e8ea0"
else
  echo "🟢 BAMS (${wu_count}) | color=#22c55e"
fi

echo "---"

# ─────────────────────────────────────────────────────────────
# 드롭다운: Work Units 섹션
# ─────────────────────────────────────────────────────────────

echo "📋 Work Units | size=12 color=#8e8ea0"

if [ "$wu_count" -eq 0 ]; then
  echo "-- No active work units | color=#585870 size=10"
else
  # 상위 3개 WU만 처리
  max_wu=3
  idx=0

  while IFS= read -r wu_slug; do
    [ -z "$wu_slug" ] && continue
    [ "$idx" -ge "$max_wu" ] && break

    wu_name=$(echo "$wu_data" | $JQ -r --arg slug "$wu_slug" '.workunits[] | select(.slug == $slug) | .name // .slug' 2>/dev/null)
    wu_name=${wu_name:-$wu_slug}
    pipeline_count=$(echo "$wu_data" | $JQ -r --arg slug "$wu_slug" '.workunits[] | select(.slug == $slug) | .pipelineCount // 0' 2>/dev/null)
    pipeline_count=${pipeline_count:-0}

    echo "-- 🔵 ${wu_name} | color=#3b82f6 font=Menlo size=11"

    # Step 3: 각 WU의 파이프라인 상세 조회 (타임아웃 3초)
    if [ "$pipeline_count" -gt 0 ]; then
      wu_detail=$(curl -s --max-time 3 "${BAMS_URL}/api/workunits/${wu_slug}" 2>/dev/null)
      if [ $? -eq 0 ] && [ -n "$wu_detail" ]; then
        # pipelines 배열에서 최근 5개 파이프라인 표시
        pipelines_json=$(echo "$wu_detail" | $JQ -r '.pipelines // []' 2>/dev/null)
        pipeline_count_detail=$(echo "$pipelines_json" | $JQ 'length' 2>/dev/null || echo 0)

        if [ "$pipeline_count_detail" -gt 0 ]; then
          # 최근 5개만
          echo "$pipelines_json" | $JQ -r '.[-5:][] | "\(.slug // "unknown")|\(.status // "unknown")"' 2>/dev/null | while IFS='|' read -r p_slug p_status; do
            icon=$(get_pipeline_icon "$p_status")
            color=$(get_pipeline_color "$p_status")
            echo "---- ${icon} ${p_slug} (${p_status}) | color=${color} size=10 font=Menlo"
          done
        else
          echo "---- No pipelines yet | color=#585870 size=10"
        fi
      else
        echo "---- Failed to load pipelines | color=#ef4444 size=10"
      fi
    else
      echo "---- No pipelines | color=#585870 size=10"
    fi

    idx=$(( idx + 1 ))
  done < <(echo "$wu_data" | $JQ -r '.workunits[].slug' 2>/dev/null)

  # 3개 초과 시 추가 표시
  if [ "$wu_count" -gt "$max_wu" ]; then
    remaining=$(( wu_count - max_wu ))
    echo "-- ... and ${remaining} more | color=#8e8ea0 size=10"
  fi
fi

echo "---"

# ─────────────────────────────────────────────────────────────
# 드롭다운: 액션 섹션
# ─────────────────────────────────────────────────────────────

echo "🔗 Open Dashboard | href=${BAMS_VIZ_URL} color=#3b82f6"
echo "🔄 Refresh | refresh=true color=#8e8ea0"
echo "⚙️ bams-server: ${BAMS_URL} | color=#585870 size=10"
