# BAMS SwiftBar Plugin

bams-server와 연동하여 macOS 메뉴바에 파이프라인 상태를 표시하는 SwiftBar 플러그인입니다.

## 기능

- 메뉴바에서 활성 Work Unit 수 실시간 확인
- 각 WU별 파이프라인 목록 및 상태 표시
- bams-viz 대시보드 빠른 열기
- bams-server 미실행 시 Offline 상태 graceful 처리
- 30초 캐싱으로 API 호출 최적화 (5초 갱신 주기 유지)

## 메뉴바 표시 형식

```
상태별 표시:
  ⚫ BAMS        — Offline (bams-server 미실행)
  ⚪ BAMS        — Idle (활성 WU 없음)
  🟢 BAMS (N)   — Active (N개의 활성 WU)

드롭다운:
  📋 Work Units
    🔵 my-work-unit
      🟢 feature_결제플로우 (running)
      ✅ hotfix_빌드에러 (completed)
  ---
  🔗 Open Dashboard
  🔄 Refresh
  ⚙️ bams-server: http://localhost:3099
```

## 요구사항

- macOS 12 이상
- [SwiftBar](https://github.com/swiftbar/SwiftBar) 1.4.0 이상
- [jq](https://jqlang.github.io/jq/) (`brew install jq`)
- bams-server (포트 3099)

## 설치

### 자동 설치 (권장)

```bash
cd plugins/bams-plugin/tools/bams-widget/swiftbar
./install.sh
```

### 수동 설치

1. SwiftBar를 설치합니다: https://github.com/swiftbar/SwiftBar/releases
2. SwiftBar > Preferences에서 Plugin Folder를 확인합니다
3. 실행 권한을 부여합니다:
   ```bash
   chmod +x bams-status.5s.sh
   ```
4. 심볼릭 링크를 생성합니다:
   ```bash
   ln -sf $(pwd)/bams-status.5s.sh ~/Library/Application\ Support/SwiftBar/Plugins/bams-status.5s.sh
   ```

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `BAMS_SERVER_URL` | `http://localhost:3099` | bams-server 주소 |
| `BAMS_VIZ_URL` | `http://localhost:3333` | bams-viz 대시보드 주소 |

### 설정 방법

`~/.zshrc` 또는 `~/.bash_profile`에 추가:

```bash
export BAMS_SERVER_URL=http://localhost:3099
export BAMS_VIZ_URL=http://localhost:3333
```

SwiftBar에서 환경 변수를 인식하게 하려면 SwiftBar를 터미널에서 실행하거나, `/etc/launchd.conf`에 설정합니다.

## bams-server 실행

```bash
# bams-plugin 루트에서
cd plugins/bams-plugin/server
bun run dev
```

## 파이프라인 상태 아이콘

| 아이콘 | 상태 | 색상 |
|--------|------|------|
| 🟢 | running / active | #22c55e |
| ✅ | completed / done | #22c55e |
| 🔴 | failed / error | #ef4444 |
| ⏸ | paused | #eab308 |
| ⬜ | unknown | #8e8ea0 |

## 트러블슈팅

### 메뉴바에 플러그인이 표시되지 않는 경우

1. SwiftBar > Preferences > Plugin Folder가 올바르게 설정되었는지 확인
2. 스크립트 실행 권한 확인: `ls -la ~/Library/Application\ Support/SwiftBar/Plugins/`
3. SwiftBar 재시작

### "⚫ BAMS" (Offline) 표시

- bams-server 실행 여부 확인: `curl http://localhost:3099/health`
- BAMS_SERVER_URL 환경 변수 확인

### "jq required" 표시

```bash
brew install jq
```

### 스크립트 디버깅

터미널에서 직접 실행:
```bash
bash -x ~/Library/Application\ Support/SwiftBar/Plugins/bams-status.5s.sh
```

### 캐시 초기화

```bash
rm /tmp/bams-widget-cache.json
```

## 동작 원리

1. SwiftBar가 5초마다 `bams-status.5s.sh`를 실행합니다
2. 스크립트는 `/tmp/bams-widget-cache.json`에 30초 TTL 캐시를 유지합니다
3. 캐시 만료 시에만 `GET /api/workunits/active` API를 호출합니다
4. 활성 WU가 있으면 각 WU의 파이프라인 상세를 조회합니다 (최대 3개 WU)
5. 결과를 SwiftBar 포맷으로 stdout에 출력합니다
