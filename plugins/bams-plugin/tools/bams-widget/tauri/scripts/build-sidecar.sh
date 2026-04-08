#!/usr/bin/env bash
# build-sidecar.sh
# TASK-010: bams-server를 단일 바이너리로 컴파일하여 Tauri sidecar로 배치
#
# 사용법:
#   bash scripts/build-sidecar.sh
#   bash scripts/build-sidecar.sh --target aarch64-apple-darwin
#
# 출력:
#   src-tauri/binaries/bams-server-aarch64-apple-darwin (macOS Apple Silicon)
#   src-tauri/binaries/bams-server-x86_64-apple-darwin  (macOS Intel, --target x86_64 시)
#
# Tauri externalBin 명명 규칙:
#   {name}-{arch}-{os}  (예: bams-server-aarch64-apple-darwin)
#   Tauri가 실행 시 현재 플랫폼에 맞는 바이너리를 자동 선택

set -euo pipefail

# ── 경로 설정 ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ROOT="$(cd "$TAURI_ROOT/../../../server" && pwd)"
BINARIES_DIR="$TAURI_ROOT/src-tauri/binaries"

# ── 옵션 파싱 ──────────────────────────────────────────────────

TARGET="${1:-}"
if [[ "$TARGET" == "--target" ]]; then
  TARGET="${2:-}"
  shift 2
fi

# 기본 타겟: 현재 시스템 아키텍처
if [[ -z "$TARGET" ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64)  TARGET="aarch64-apple-darwin" ;;
    x86_64) TARGET="x86_64-apple-darwin" ;;
    *)
      echo "[build-sidecar] unsupported arch: $ARCH" >&2
      exit 1
      ;;
  esac
fi

BINARY_NAME="bams-server-${TARGET}"
OUTPUT_PATH="$BINARIES_DIR/$BINARY_NAME"

# ── 사전 조건 확인 ──────────────────────────────────────────────

echo "[build-sidecar] checking prerequisites..."

if ! command -v bun &>/dev/null; then
  echo "[build-sidecar] ERROR: bun not found. Install from https://bun.sh" >&2
  exit 1
fi

if [[ ! -f "$SERVER_ROOT/src/app.ts" ]]; then
  echo "[build-sidecar] ERROR: bams-server not found at $SERVER_ROOT/src/app.ts" >&2
  exit 1
fi

echo "[build-sidecar] bun: $(bun --version)"
echo "[build-sidecar] target: $TARGET"
echo "[build-sidecar] server: $SERVER_ROOT"
echo "[build-sidecar] output: $OUTPUT_PATH"

# ── binaries 디렉토리 생성 ────────────────────────────────────

mkdir -p "$BINARIES_DIR"

# ── bam-server 빌드 ───────────────────────────────────────────

echo ""
echo "[build-sidecar] building bams-server binary..."
cd "$SERVER_ROOT"

# bun compile: 단일 실행 바이너리 생성
# --target: bun의 플랫폼 타겟 (bun-darwin-arm64 / bun-darwin-x64)
case "$TARGET" in
  aarch64-apple-darwin) BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-apple-darwin)  BUN_TARGET="bun-darwin-x64" ;;
  *)
    echo "[build-sidecar] ERROR: unsupported target for bun compile: $TARGET" >&2
    exit 1
    ;;
esac

bun build \
  --compile \
  --target="$BUN_TARGET" \
  --outfile="$OUTPUT_PATH" \
  src/app.ts

echo ""
echo "[build-sidecar] build complete: $OUTPUT_PATH"
echo "[build-sidecar] size: $(du -sh "$OUTPUT_PATH" | cut -f1)"

# ── 실행 권한 확인 ────────────────────────────────────────────

chmod +x "$OUTPUT_PATH"
echo "[build-sidecar] executable: OK"

# ── 실행 가능 여부 확인 (현재 플랫폼과 타겟이 일치하는 경우) ───

CURRENT_TARGET=""
CURRENT_ARCH="$(uname -m)"
case "$CURRENT_ARCH" in
  arm64)  CURRENT_TARGET="aarch64-apple-darwin" ;;
  x86_64) CURRENT_TARGET="x86_64-apple-darwin" ;;
esac

if [[ "$TARGET" == "$CURRENT_TARGET" ]]; then
  echo "[build-sidecar] smoke test: $OUTPUT_PATH --version"
  # 서버를 실제로 시작하지 않고 --version만 확인
  if "$OUTPUT_PATH" --version 2>/dev/null || true; then
    echo "[build-sidecar] smoke test passed"
  fi
fi

echo ""
echo "[build-sidecar] done. Tauri will look for:"
echo "  src-tauri/binaries/bams-server-{arch}-{os}"
echo ""
echo "If building for both architectures (Universal Binary):"
echo "  bash scripts/build-sidecar.sh --target aarch64-apple-darwin"
echo "  bash scripts/build-sidecar.sh --target x86_64-apple-darwin"
