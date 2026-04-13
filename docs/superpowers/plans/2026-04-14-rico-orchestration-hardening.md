# Rico Orchestration Hardening Plan

- 상태: 대부분 구현 완료
- 마지막 업데이트: 2026-04-14

> 목적: `2026-04-14` follow-up spec 세 개를 구현 가능한 작업 묶음으로 바꾼다.

- 기준 문서:
  - `2026-04-14-rico-workflow-state-machine-v2.md`
  - `2026-04-14-rico-governor-control-plane.md`
  - `2026-04-14-rico-specialist-contracts.md`

## 목표

현재 `rico`를 “작동하는 멀티 에이전트 런타임”에서 “운영 규칙이 잠긴 런타임”으로 올린다.

핵심 결과:

- Goal / Run / Task 상태머신 정교화
- `#total`의 Governor control plane 강화
- specialist visibility와 artifact contract 고정
- QA evidence enforcement 도입

## 작업 순서

### Track 1. Workflow State Machine V2

상태:

- 구현 완료

목표:

- `Goal`, `Run`, `Task`를 분리된 상태 전이 모델로 실제 사용

구현:

1. `schema.ts`
   - goal 상태 확장
   - task 상태 확장
   - task attempt / started_at / finished_at 필드 추가 검토
2. `repositories.ts`
   - task 상태 전이 helper 추가
   - run status 정규화 helper 추가
3. `dispatcher.ts`
   - `planned -> in_progress -> awaiting_qa -> approved|qa_failed`
   - deploy 승인 경유 시 `awaiting_human_approval`
4. stale state repair 로직 추가

검증:

- store / dispatcher / happy-path test 확장

### Track 2. Governor Control Plane

상태:

- 구현 완료

목표:

- `Governor`를 실제 운영 제어판으로 강화

구현:

1. `slack/intake.ts`
   - `상태`
   - `대기열`
   - `승인 대기`
   - `일시정지 project`
   - `재개 project`
   - `우선순위 project 3`
2. `governor.ts`
   - snapshot/list API 보강
   - paused/priority/queued visibility 확장
3. `message-style.ts`
   - 총괄 상태 메시지
   - 정책 변경 확인 메시지

검증:

- ingress / runtime-intake test 추가

### Track 3. Specialist Visibility Gate

상태:

- 구현 완료

목표:

- specialist가 필요한 순간에만 개별 메시지를 남기게 함

구현:

1. `dispatcher.ts`
   - `impact=blocking`
   - `impact=approval_needed`
   - `executionMode=write`
   - evidence-heavy QA
   - multi-persona customer-voice
   일 때만 개별 메시지
2. 나머지 `info/analyze` 결과는 `Captain 진행`에 흡수
3. `message-style.ts`
   - 흡수 요약 포맷 추가

검증:

- message-style / happy-path / runtime-intake

### Track 4. Specialist Contract Enforcement

상태:

- 구현 완료

목표:

- role playbook을 prompt 관습이 아니라 런타임 규칙으로 강화

구현:

1. `roles/contracts.ts`
   - role별 최소 필드
   - evidence requirement
2. `specialists.ts`
   - `changedFiles` 정합성 검사
   - QA blocking에 evidence 강제
3. `executor.ts`
   - planner/designer/customer-voice write-mode scope 제한
   - disallowed action 위반 시 reject

검증:

- contract / executor / customer-voice / QA 테스트 추가

### Track 5. Release Lifecycle

상태:

- 구현 완료

목표:

- `approved`, `released`, `archived`를 구분

구현:

1. 승인 후 배포 완료 전까지 `approved`
2. 실제 배포 후 `released`
3. archive 정책 추가
4. Governor 마감/프로젝트 마감 메시지 보강

검증:

- approval-gates / happy-path / message-style

## 제외

이번 하드닝 범위에서 아래는 제외한다.

- 역할별 별도 bot identity
- 자동 preemption
- QA auto-fix 기본 활성화
- 고객-facing 제품 쉘

## 구현 우선순위 제안

1. Workflow State Machine V2
2. Specialist Contract Enforcement
3. Specialist Visibility Gate
4. Governor Control Plane
5. Release Lifecycle

이 순서가 맞는 이유:

- 상태와 계약이 먼저 잠겨야 UI/메시지가 의미를 가진다
- Governor control plane은 상태모델 위에서 얹어야 깔끔하다

## 완료 기준

아래가 모두 만족되면 이 하드닝 라운드는 끝이다.

- Slack thread만 보고도 `계획 / 진행 / QA / 승인 / 마감`이 구분된다
- DB에서 `Goal / Run / Task` 상태가 모순 없이 읽힌다
- `#total`에서 포트폴리오 제어 명령이 실제로 먹힌다
- QA와 Customer Voice가 근거 없이 `blocking`을 남길 수 없다
- planner/designer/customer-voice write-mode가 문서/artifact 범위로 제한된다

## 이번 라운드로 닫힌 항목

이번 하드닝 라운드로 아래는 닫혔다.

- Goal/Run/Task 상태 전이 정교화
- `#total` Governor 제어 명령
- specialist visibility gate
- write-scope / artifact contract enforcement
- `approved -> released -> archived` 운영 상태
- stale state repair
- QA evidence artifact mirror + Slack upload
- Governor audit trail
- command-audited capability enforcement

## 남은 후속 과제

다음 라운드에서 다룰 만한 항목은 아래 정도다.

- role별 OS-level sandbox 또는 더 강한 capability isolation
- richer QA/browser evidence artifact
- Governor manual reroute / force take-over
