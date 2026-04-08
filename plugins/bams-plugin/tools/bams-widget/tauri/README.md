# bams-widget (Tauri v2)

macOS 메뉴바 위젯 — BAMS 파이프라인 상태를 실시간으로 표시합니다.

## Prerequisites (사전 요구사항)

| 도구 | 버전 | 설치 방법 |
|------|------|-----------|
| Rust (stable) | 최신 stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Bun | >= 1.0.0 | `curl -fsSL https://bun.sh/install \| bash` |
| Xcode CLI Tools | — | `xcode-select --install` |
| macOS | >= 10.15 (Catalina) | — |

Tauri CLI는 `devDependencies`에 포함되어 있으므로 별도 전역 설치 불필요합니다.

```bash
# Rust 설치 후 타겟 추가 (Apple Silicon)
rustup target add aarch64-apple-darwin

# Intel Mac 지원 시 추가
rustup target add x86_64-apple-darwin
```

---

## Development (개발 실행)

```bash
# 1. 의존성 설치
bun install

# 2. bams-server sidecar 빌드 (최초 1회 또는 서버 코드 변경 시)
bash scripts/build-sidecar.sh

# 3. Tauri 개발 서버 (React HMR + Rust 자동 재빌드)
bun run tauri dev
```

개발 서버 실행 시 다음이 자동으로 시작됩니다:
- Vite 개발 서버 (`http://localhost:5173`)
- Tauri Rust 백엔드
- macOS 메뉴바 트레이 아이콘

bams-server는 별도로 실행해야 합니다 (`http://localhost:3099`).

---

## Build (프로덕션 빌드)

### 전체 빌드 (권장)

```bash
# sidecar → 프론트엔드 → Tauri 앱 순서로 빌드
bash scripts/build.sh
```

빌드 결과:
- `.dmg` 인스톨러: `src-tauri/target/release/bundle/dmg/bams-widget_*.dmg`
- `.app` 번들: `src-tauri/target/release/bundle/macos/bams-widget.app`

### npm 스크립트

```bash
bun run build:full    # bash scripts/build.sh (전체 빌드)
bun run build:dmg     # tauri build --bundles dmg (.dmg만 생성)
bun run build:ci      # bash scripts/build.sh --ci (CI 환경용)
```

### CI 빌드

```bash
bash scripts/build.sh --ci
```

### 옵션

| 플래그 | 설명 |
|--------|------|
| (없음) | 전체 빌드 (sidecar + frontend + tauri) |
| `--ci` | CI 환경 — 진행 메시지 간략화 |
| `--dmg-only` | sidecar 빌드 생략, Tauri 빌드만 실행 |

---

## Sidecar (bams-server 번들링)

위젯은 `bams-server`를 sidecar 바이너리로 번들링합니다.
Tauri의 `externalBin` 기능을 사용하며, 앱 시작 시 서버가 자동으로 실행됩니다.

```bash
# 현재 플랫폼 (기본값)
bash scripts/build-sidecar.sh

# Apple Silicon 명시적 지정
bash scripts/build-sidecar.sh --target aarch64-apple-darwin

# Intel Mac
bash scripts/build-sidecar.sh --target x86_64-apple-darwin
```

출력 경로: `src-tauri/binaries/bams-server-{arch}-apple-darwin`

Tauri가 실행 시 현재 플랫폼에 맞는 바이너리를 자동으로 선택합니다.

---

## Memory (메모리 사용량 검증)

목표: **100MB 이하**

```bash
# 앱 실행 후 확인
ps aux | grep bams-widget | awk '{print $6/1024 " MB"}'

# Activity Monitor에서 확인
# 프로세스 이름: bams-widget
# 컬럼: Real Memory
```

빌드 최적화 (`Cargo.toml` `[profile.release]`):
- `lto = true` — Link Time Optimization (바이너리 크기 최소화)
- `strip = true` — 디버그 심볼 제거
- `opt-level = "s"` — 사이즈 우선 최적화
- `codegen-units = 1` — 최대 LTO 효과
- `panic = "abort"` — 패닉 언와인딩 코드 제거

---

## 구조

```
tauri/
├── scripts/
│   ├── build.sh           # 전체 빌드 스크립트
│   └── build-sidecar.sh   # bams-server sidecar 빌드
├── src/                   # React 19 + TypeScript 프론트엔드
│   ├── lib/               # API 클라이언트, 타입 정의
│   ├── styles/            # Tailwind CSS v4
│   ├── components/        # 재사용 컴포넌트
│   ├── views/             # SmallView, MediumView
│   └── hooks/             # SWR, SSE, 알림 훅
└── src-tauri/             # Rust 백엔드
    ├── binaries/          # sidecar 바이너리 (빌드 후 생성)
    ├── icons/             # 트레이 아이콘 (tray-icon.png 등)
    ├── src/
    │   ├── main.rs        # 진입점
    │   ├── lib.rs         # 앱 초기화
    │   └── tray.rs        # 시스템 트레이
    └── tauri.conf.json    # Tauri 설정
```

---

## bams-server 연결

위젯은 `http://localhost:3099`의 bams-server에 연결합니다.
서버가 실행 중이지 않으면 "Server Offline" 상태를 표시합니다.

bams-viz 대시보드: `http://localhost:3333`
