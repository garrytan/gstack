---
description: CI/CD 전 최종 검증 — 테스트, 린트, 빌드, 시크릿 점검
argument-hint: [--fix | --report-only]
---

# Crew Verify

Crew 오케스트레이터로서 CI/CD 파이프라인에 코드를 보내기 전 최종 검증을 실행합니다.
dev, debug, review 등으로 작성/수정된 모든 코드가 실제로 동작하는지 확인합니다.

옵션: $ARGUMENTS
- `--fix`: 자동 수정 가능한 이슈를 자동 수정 (린트, 포맷팅)
- `--report-only`: 검증만 하고 수정하지 않음 (기본값)
- 비어있으면 `--report-only`로 동작

## 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "Crew가 초기화되지 않았습니다. `/crew:init`을 실행하여 설정하세요."
- 여기서 중단.

`.crew/config.md`를 읽어 프로젝트 언어, 프레임워크, 컨벤션을 파악합니다.

## Phase 1: 환경 점검

### 1a. Git 상태 확인

Bash로 다음을 실행:

1. `git status --porcelain` — 미커밋 변경사항 확인
2. `git log --oneline -5` — 최근 커밋 확인
3. `git branch --show-current` — 현재 브랜치 확인

결과 기록:
- 미커밋 파일 수
- 스테이지된 파일 수
- 현재 브랜치명

### 1b. 변경 범위 파악

Bash로 `git diff --name-only HEAD~10` (또는 main 브랜치와의 diff)를 실행하여 최근 변경된 파일 목록을 확보합니다.

이 목록을 **검증 대상 파일**로 사용합니다. 전체 프로젝트가 아닌 변경된 영역에 집중합니다.

## Phase 2: 5개 검증을 병렬로 실행

다음 5개 검증을 **순차적으로** 실행합니다. 각 검증은 Bash 도구로 직접 실행합니다 (서브에이전트 아님). 단, Check 5 (시크릿 점검)은 서브에이전트로 실행하므로 다른 Check와 병렬 가능합니다.

### Check 1: 테스트 실행

`.crew/config.md`의 언어와 프레임워크를 기반으로 테스트 러너를 감지합니다:

| 감지 대상 | 테스트 명령 |
|-----------|------------|
| `package.json`의 `"test"` 스크립트 | `npm test` 또는 `yarn test` |
| `pytest.ini`, `pyproject.toml [tool.pytest]`, `conftest.py` | `pytest` (venv 있으면 venv 내에서) |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |
| `build.gradle` | `./gradlew test` |
| `pom.xml` | `mvn test` |
| `Gemfile` | `bundle exec rspec` 또는 `bundle exec rake test` |
| `Makefile`의 `test` 타겟 | `make test` |

**감지 우선순위**: Makefile의 test 타겟 > 언어별 기본 명령

**Bash로 테스트 실행**. 타임아웃 5분 (`timeout: 300000`).

결과 기록:
- **status**: pass / fail / skip (러너 없음) / timeout
- **total**: 총 테스트 수 (파싱 가능하면)
- **passed**: 통과 수
- **failed**: 실패 수
- **failed_tests**: 실패한 테스트 이름 목록 (최대 20개)
- **duration**: 실행 시간

### Check 2: 린트 실행

언어별 린터를 감지하고 실행합니다:

| 감지 대상 | 린트 명령 |
|-----------|----------|
| `.eslintrc*`, `eslint.config.*` | `npx eslint [변경된 JS/TS 파일]` |
| `pyproject.toml [tool.ruff]`, `ruff.toml` | `ruff check [변경된 PY 파일]` |
| `pyproject.toml [tool.flake8]`, `.flake8` | `flake8 [변경된 PY 파일]` |
| `.golangci.yml` | `golangci-lint run ./...` |
| `go.mod` (golangci 없으면) | `go vet ./...` |
| `clippy` (Rust) | `cargo clippy -- -D warnings` |
| `rubocop.yml` | `bundle exec rubocop [변경된 RB 파일]` |

린터가 여러 개 감지되면 모두 실행합니다.

`--fix` 옵션인 경우: 린터의 자동 수정 플래그를 추가합니다:
- eslint: `--fix`
- ruff: `ruff check --fix`
- golangci-lint: `--fix`
- rubocop: `--auto-correct`

결과 기록:
- **status**: pass / fail / skip (린터 없음)
- **errors**: 에러 수
- **warnings**: 경고 수
- **fixed**: 자동 수정된 수 (`--fix`인 경우)
- **issues**: 이슈 목록 (파일:라인:메시지, 최대 20개)

### Check 3: 포맷팅 검증

코드 포매터를 감지하고 포맷 검증합니다:

| 감지 대상 | 검증 명령 |
|-----------|----------|
| `.prettierrc*`, `prettier.config.*` | `npx prettier --check [변경된 파일]` |
| `pyproject.toml [tool.black]` | `black --check [변경된 PY 파일]` |
| `pyproject.toml [tool.ruff.format]` | `ruff format --check [변경된 PY 파일]` |
| `go.mod` | `gofmt -l [변경된 GO 파일]` (출력이 있으면 미포맷) |
| `rustfmt.toml` 또는 Rust 프로젝트 | `cargo fmt -- --check` |

`--fix` 옵션인 경우: 포매터를 실제 적용합니다:
- prettier: `--write`
- black: `--check` 제거
- ruff format: `--check` 제거
- gofmt: `-w`
- cargo fmt: `--check` 제거

결과 기록:
- **status**: pass / fail / skip (포매터 없음)
- **unformatted**: 미포맷 파일 수
- **files**: 미포맷 파일 목록
- **fixed**: 자동 수정된 수 (`--fix`인 경우)

### Check 4: 빌드 검증

프로젝트가 빌드되는지 확인합니다:

| 감지 대상 | 빌드 명령 |
|-----------|----------|
| `package.json`의 `"build"` 스크립트 | `npm run build` |
| `tsconfig.json` (build 스크립트 없으면) | `npx tsc --noEmit` |
| `go.mod` | `go build ./...` |
| `Cargo.toml` | `cargo build` |
| `build.gradle` | `./gradlew build -x test` |
| `pom.xml` | `mvn compile -q` |
| `Makefile`의 `build` 타겟 | `make build` |

**Bash로 빌드 실행**. 타임아웃 5분.

결과 기록:
- **status**: pass / fail / skip (빌드 명령 없음) / timeout
- **errors**: 빌드 에러 목록 (파일:라인:메시지, 최대 20개)

### Check 5: 시크릿 및 민감 정보 점검

서브에이전트 실행 (Task tool, subagent_type: **"Explore"**, model: **"haiku"** — 패턴 매칭 중심, 속도 우선):

> **보안 감사관**으로서 최근 변경된 파일에서 민감 정보 유출을 점검합니다.
>
> **변경된 파일**: [Phase 1b의 변경 파일 목록]
>
> 수행 작업:
> 1. 변경된 파일을 읽고 다음 패턴을 Grep으로 검색:
>    - 하드코딩된 API 키/토큰: `api[_-]?key\s*[:=]`, `token\s*[:=]`, `secret\s*[:=]`, `password\s*[:=]`
>    - AWS 키: `AKIA[0-9A-Z]{16}`, `aws[_-]?secret`
>    - 개인키/인증서: `-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----`, `-----BEGIN CERTIFICATE-----`
>    - 환경변수 직접 값: `.env` 파일이 커밋 대상인지 확인
>    - 내부 URL/IP: `192.168.`, `10.0.`, `localhost:[0-9]+` (프로덕션 코드에서)
> 2. `.gitignore`에 `.env`, 시크릿 파일이 포함되어 있는지 확인
> 3. 테스트 픽스처에 실제 시크릿이 사용되는지 확인
>
> 각 발견에 대해:
> - **심각도**: Critical (실제 시크릿 가능성) / Warning (패턴 매칭만)
> - **파일**: path:line
> - **패턴**: 매칭된 패턴 유형
> - **컨텍스트**: 해당 라인의 코드 (시크릿 값은 마스킹)

결과 기록:
- **status**: pass / fail
- **critical**: Critical 발견 수
- **warnings**: Warning 발견 수
- **issues**: 발견 목록

## Phase 3: 결과 종합

5개 검증이 모두 완료된 후 결과를 종합합니다.

### 전체 판정

다음 규칙으로 최종 판정:

- **PASS**: 모든 check가 pass 또는 skip
- **WARN**: fail이 있지만 모두 minor (포맷팅만 실패, 시크릿 warning만)
- **FAIL**: 테스트 실패, 빌드 실패, 린트 에러, 시크릿 critical 중 하나라도 있음

### 리포트 저장

타임스탬프 slug 생성 (예: `2026-02-24-143052`).

`.crew/artifacts/test/verify-[timestamp].md`에 저장합니다. 다음 섹션을 포함:
- **메타**: 일시, 브랜치, 판정, 옵션
- **요약 테이블**: 5개 검증별 상태(✓/✗/○)와 상세 수치
- **미커밋 변경사항**: 파일 목록
- **각 검증 상세**: 실패/이슈가 있는 항목만 상세 기록

## Phase 4: 결과 제시

사용자에게 결과를 표시합니다: 브랜치, 판정 (PASS/WARN/FAIL), 5개 검증별 상태와 수치, 리포트 경로.

### FAIL인 경우

실패 항목을 상세히 표시한 후:

**AskUserQuestion**:

Question: "검증에 실패한 항목이 있습니다. 어떻게 할까요?"
Header: "Action"
Options:
- **자동 수정** - "수정 가능한 항목 자동 수정 (린트, 포맷팅) 후 재검증"
- **상세 보기** - "실패 항목의 상세 내용 확인"
- **무시하고 진행** - "현재 상태로 CI/CD 진행 (권장하지 않음)"
- **중단** - "수동으로 처리"

**자동 수정** 선택 시:
1. 린트 에러 → 린터의 `--fix` 플래그로 재실행
2. 포맷팅 → 포매터를 적용 모드로 재실행
3. 수정 후 테스트를 다시 실행하여 수정이 테스트를 깨뜨리지 않았는지 확인
4. 결과를 다시 표시

**상세 보기** 선택 시:
- 각 실패 항목의 전체 출력을 표시
- 표시 후 다시 AskUserQuestion으로 다음 행동 선택

### WARN인 경우

경고 항목을 표시하고:

```
⚠ 경고 사항:
  - [항목별 경고 내용]

경고 항목은 CI/CD에서 실패하지 않을 수 있지만, 해결을 권장합니다.
```

### PASS인 경우

```
✓ 모든 검증 통과. CI/CD로 진행할 수 있습니다.
```

미커밋 변경사항이 있으면 추가:
```
참고: 미커밋 변경사항이 [N]개 파일에 있습니다.
  git add . && git commit 으로 커밋하세요.
```

## Phase 5: CLAUDE.md 상태 업데이트

`CLAUDE.md`의 `## Crew 현재 상태` 섹션을 업데이트합니다 (없으면 파일 끝에 추가, 있으면 Edit으로 교체). `.crew/board.md`를 읽어 다음을 포함:
- 마지막 업데이트 타임스탬프
- 진행 중인 작업 (In Progress/In Review 태스크)
- 활성 스프린트 정보
- 최근 검증 결과 (판정, 리포트 경로)
- 다음 단계 (PASS면 CI/CD 안내, FAIL/WARN이면 해결 필요 항목)
