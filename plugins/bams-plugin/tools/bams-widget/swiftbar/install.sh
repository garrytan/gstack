#!/usr/bin/env bash
# BAMS SwiftBar 플러그인 설치 헬퍼
# 사용법: ./install.sh [플러그인 디렉토리 경로]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SCRIPT="${SCRIPT_DIR}/bams-status.5s.sh"

# ─────────────────────────────────────────────────────────────
# 색상 출력 유틸
# ─────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }

# ─────────────────────────────────────────────────────────────
# SwiftBar 설치 확인
# ─────────────────────────────────────────────────────────────

check_swiftbar() {
  if ! ls /Applications/SwiftBar.app > /dev/null 2>&1 && \
     ! ls "$HOME/Applications/SwiftBar.app" > /dev/null 2>&1; then
    warn "SwiftBar.app을 찾을 수 없습니다."
    warn "설치: https://github.com/swiftbar/SwiftBar/releases"
    warn "또는: brew install --cask swiftbar"
    echo ""
    read -r -p "SwiftBar 없이 계속 진행하시겠습니까? [y/N] " answer
    if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
      error "설치를 취소했습니다."
      exit 1
    fi
  else
    success "SwiftBar 설치 확인"
  fi
}

# ─────────────────────────────────────────────────────────────
# 플러그인 디렉토리 감지
# ─────────────────────────────────────────────────────────────

detect_plugin_dir() {
  # 1. 인자로 전달된 경로 우선
  if [ -n "${1:-}" ]; then
    echo "$1"
    return
  fi

  # 2. SwiftBar 기본 경로
  local default_dir="$HOME/Library/Application Support/SwiftBar/Plugins"
  if [ -d "$default_dir" ]; then
    echo "$default_dir"
    return
  fi

  # 3. 사용자 입력 요청
  warn "SwiftBar 플러그인 디렉토리를 자동으로 감지하지 못했습니다."
  warn "SwiftBar > Preferences > Plugin Folder 에서 확인하세요."
  echo ""
  read -r -p "플러그인 디렉토리 경로를 입력하세요: " user_dir
  if [ -z "$user_dir" ]; then
    error "플러그인 디렉토리 경로가 필요합니다."
    exit 1
  fi
  echo "$user_dir"
}

# ─────────────────────────────────────────────────────────────
# 설치 실행
# ─────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "BAMS SwiftBar 플러그인 설치"
  echo "================================"
  echo ""

  # SwiftBar 확인
  check_swiftbar

  # 플러그인 디렉토리 감지
  PLUGIN_DIR=$(detect_plugin_dir "${1:-}")
  info "플러그인 디렉토리: ${PLUGIN_DIR}"

  # 디렉토리 생성 (없으면)
  if [ ! -d "$PLUGIN_DIR" ]; then
    mkdir -p "$PLUGIN_DIR"
    success "플러그인 디렉토리 생성: ${PLUGIN_DIR}"
  fi

  # 플러그인 스크립트 확인
  if [ ! -f "$PLUGIN_SCRIPT" ]; then
    error "플러그인 스크립트를 찾을 수 없습니다: ${PLUGIN_SCRIPT}"
    exit 1
  fi

  # 실행 권한 부여
  chmod +x "$PLUGIN_SCRIPT"
  success "실행 권한 부여: bams-status.5s.sh"

  # 기존 심볼릭 링크 제거
  LINK_PATH="${PLUGIN_DIR}/bams-status.5s.sh"
  if [ -L "$LINK_PATH" ]; then
    rm "$LINK_PATH"
    info "기존 심볼릭 링크 제거"
  elif [ -f "$LINK_PATH" ]; then
    warn "기존 파일 발견: ${LINK_PATH}"
    read -r -p "덮어쓰시겠습니까? [y/N] " answer
    if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
      error "설치를 취소했습니다."
      exit 1
    fi
    rm "$LINK_PATH"
  fi

  # 심볼릭 링크 생성
  ln -sf "$PLUGIN_SCRIPT" "$LINK_PATH"
  success "심볼릭 링크 생성: ${LINK_PATH} -> ${PLUGIN_SCRIPT}"

  # jq 확인
  if ! which jq > /dev/null 2>&1; then
    warn "jq가 설치되어 있지 않습니다."
    warn "설치: brew install jq"
  else
    success "jq 설치 확인: $(which jq)"
  fi

  echo ""
  echo "================================"
  success "설치 완료!"
  echo ""
  info "다음 단계:"
  echo "  1. SwiftBar를 실행하거나 재시작하세요"
  echo "  2. bams-server를 실행하세요:"
  echo "     cd plugins/bams-plugin/server && bun run dev"
  echo "  3. 메뉴바에 '⚪ BAMS' 또는 '🟢 BAMS (N)'이 표시되면 성공입니다"
  echo ""
  info "환경 변수 (선택사항):"
  echo "  BAMS_SERVER_URL  bams-server URL (기본값: http://localhost:3099)"
  echo "  BAMS_VIZ_URL     bams-viz URL (기본값: http://localhost:3333)"
  echo ""
  info "설정 방법: ~/.zshrc 또는 ~/.bash_profile에 추가"
  echo "  export BAMS_SERVER_URL=http://localhost:3099"
  echo "  export BAMS_VIZ_URL=http://localhost:3333"
  echo ""
}

main "$@"
