# Pipeline Naming Convention

## 1. Slug 형식

```
{command}_{한글요약}
```

- `command`: 영문 소문자
- `한글요약`: 10자 이내 한글

## 2. 불변성 원칙

slug는 파이프라인 생성 시 확정되며 이후 변경 불가합니다. 파이프라인 상태는 slug가 아닌 이벤트로 판별합니다.

- `pipeline_end` 이벤트 없음 → 진행 중
- `pipeline_end` 이벤트 있음 → 상태 필드(`completed` | `failed` | `paused` | `rolled_back`)로 판단

## 3. 허용 command 목록

- `feature`
- `hotfix`
- `dev`
- `debug`
- `retro`
- `review`
- `deep-review`

## 4. 예시

- `feature_결제플로우구현`
- `hotfix_빌드에러수정`
- `dev_vizDB재설계`
- `debug_태스크기록누락`
- `retro_전체회고_1`

## 5. 안티패턴

- `fix_build-error` — `fix`는 허용 command 목록에 없으며, 요약이 영문입니다.
- `feature_결제플로우구현_v2` — 버전/suffix 추가 금지. 재시도는 신규 파이프라인으로 생성합니다.
- `hotfix_Thu Apr  9 13:33:23 KST 2026` — 타임스탬프 등 동적값 사용 금지. slug는 사람이 읽을 수 있는 요약이어야 합니다.
