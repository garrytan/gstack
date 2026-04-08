#!/usr/bin/env bash
# build.sh
# TASK-015: bams-widget 전체 빌드 스크립트
#
# 사용법:
#   bash scripts/build.sh              # 일반 빌드
#   bash scripts/build.sh --ci         # CI 환경 (진행 메시지 간략화)
#   bash scripts/build.sh --dmg-only   # .dmg 패키지만 생성 (sidecar 빌드 생략)
#
# 빌드 순서:
#   Step 1: bams-server sidecar 빌드 (bun compile → src-tauri/binaries/)
#   Step 2: 프론트엔드 빌드 (bun run build → Vite → dist/)
#   Step 3: Tauri 앱 빌드 (cargo tauri build → src-tauri/target/release/)
#
# 출력:
#   src-tauri/target/release/bundle/dmg/bams-widget_*.dmg
#   src-tauri/target/release/bundle/macos/bams-widget.app

set -euo pipefail

# ── 경로 설정 ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 플래그 파싱 ────────────────────────────────────────────────

CI_MODE=false
DMG_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --ci)       CI_MODE=true ;;
    --dmg-only) DMG_ONLY=true ;;
    --help|-h)
      echo "사용법: bash scripts/build.sh [--ci] [--dmg-only]"
      echo "  --ci        CI 환경 모드 (진행 메시지 간략화)"
      echo "  --dmg-only  sidecar 빌드 생략, Tauri 빌드만 실행"
      exit 0
      ;;
  esac
done

# ── 로그 헬퍼 ─────────────────────────────────────────────────

log() {
  if [[ "$CI_MODE" == "true" ]]; then
    echo "[build] $*"
  else
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $*"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  fi
}

warn() { echo "[WARN] $*" >&2; }

# ── 사전 조건 확인 ─────────────────────────────────────────────

log "사전 조건 확인..."

if ! command -v bun &>/dev/null; then
  echo "[ERROR] bun이 설치되어 있지 않습니다. https://bun.sh 에서 설치하세요." >&2
  exit 1
fi

if ! command -v cargo &>/dev/null; then
  echo "[ERROR] Rust/Cargo가 설치되어 있지 않습니다." >&2
  echo "  설치: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  exit 1
fi

if ! xcode-select -p &>/dev/null; then
  echo "[ERROR] Xcode Command Line Tools가 필요합니다." >&2
  echo "  설치: xcode-select --install" >&2
  exit 1
fi

echo "[build] bun: $(bun --version)"
echo "[build] cargo: $(cargo --version)"
echo "[build] 타겟 루트: $TAURI_ROOT"

# ── 아이콘 경로 경고 ───────────────────────────────────────────

ICON_MISSING=false
for icon in "icons/32x32.png" "icons/128x128.png" "icons/128x128@2x.png" "icons/icon.icns" "icons/icon.ico"; do
  if [[ ! -f "$TAURI_ROOT/src-tauri/$icon" ]]; then
    warn "번들 아이콘 없음: src-tauri/$icon"
    ICON_MISSING=true
  fi
done

if [[ "$ICON_MISSING" == "true" ]]; then
  warn "번들 아이콘 파일이 누락되어 있습니다."
  warn "tauri icon 명령으로 생성: bunx tauri icon <source-image.png>"
  warn "빌드는 계속 진행하지만 번들 아이콘이 기본값으로 설정될 수 있습니다."
fi

# ── Step 1: sidecar 빌드 ───────────────────────────────────────

if [[ "$DMG_ONLY" == "false" ]]; then
  log "Step 1/3: bams-server sidecar 빌드"
  bash "$SCRIPT_DIR/build-sidecar.sh"
  echo "[build] sidecar 빌드 완료"
else
  echo "[build] --dmg-only 플래그: sidecar 빌드 생략"
fi

# ── Step 2: 프론트엔드 빌드 ────────────────────────────────────

log "Step 2/3: 프론트엔드 빌드 (Vite)"
cd "$TAURI_ROOT"
bun run build
echo "[build] 프론트엔드 빌드 완료 → dist/"

# ── Step 3: Tauri 앱 빌드 ─────────────────────────────────────

log "Step 3/3: Tauri 앱 빌드"
cd "$TAURI_ROOT"
bunx tauri build

# ── 빌드 결과 요약 ─────────────────────────────────────────────

echo ""
log "빌드 완료"

DMG_PATH=$(find "$TAURI_ROOT/src-tauri/target/release/bundle/dmg" -name "*.dmg" 2>/dev/null | head -1)
APP_PATH="$TAURI_ROOT/src-tauri/target/release/bundle/macos/bams-widget.app"

if [[ -n "$DMG_PATH" ]]; then
  echo "[build] .dmg: $DMG_PATH"
  echo "[build] 크기: $(du -sh "$DMG_PATH" | cut -f1)"
fi

if [[ -d "$APP_PATH" ]]; then
  echo "[build] .app: $APP_PATH"
  # 메모리 사용량 검증 가이드
  echo ""
  echo "[build] 메모리 검증 방법:"
  echo "  1. 앱을 실행한 뒤 Activity Monitor에서 'bams-widget' 프로세스 확인"
  echo "  2. Real Memory 컬럼 값이 100MB 이하인지 확인"
  echo "  3. 명령줄 확인: ps aux | grep bams-widget | awk '{print \$6/1024 \" MB\"}'"
fi

echo ""
