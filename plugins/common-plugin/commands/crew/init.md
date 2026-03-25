---
description: Crew 워크스페이스 초기화 (멀티에이전트 개발 환경 설정)
argument-hint: [프로젝트 설명]
---

# Crew Init

Crew 오케스트레이터로서 이 프로젝트의 `.crew/` 워크스페이스를 초기화합니다.

## Step 0: 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## Step 1: 기존 상태 확인

Glob 도구로 `.crew/` 디렉토리가 이미 존재하는지 확인합니다.

**`.crew/`가 존재하지 않으면** → Step 2로 진행 (신규 초기화).

**`.crew/`가 이미 존재하면** → **AskUserQuestion**으로 선택을 요청:

Question: "이미 Crew 워크스페이스가 존재합니다. 어떻게 할까요?"
Header: "Init Mode"
Options:
- **유지** - "기존 상태를 그대로 유지하고 종료"
- **부분 재초기화** - "코드베이스 재스캔, config/컨벤션/LSP 업데이트 (board, history, sprints, artifacts 보존)"
- **전체 재초기화** - "모든 상태를 초기화 (board, history 포함 — 진행 중 태스크가 삭제됩니다!)"

**유지** 선택 시: 여기서 중단.

**부분 재초기화** 선택 시:
- Step 2 (언어 선택), Step 3 (컨텍스트 수집) 실행
- Step 4 (Git 확인) — 이미 git 저장소이면 스킵
- Step 5 (디렉토리 생성) — 이미 존재하는 디렉토리는 스킵
- Step 6 (LSP 서버) — 재설치/업데이트
- Step 7 (코드베이스 분석) — 재스캔
- Step 8 (config.md) — 아키텍처 요약, 감지된 컨벤션을 업데이트하되 `last_task_id`, `test_dir`은 기존 값 유지
- Step 9 (CLAUDE.md) — Crew 섹션 업데이트
- **Step 10, 11, 12 스킵** (README, board, history는 기존 것 보존)
- Step 13 (결과 보고)

**전체 재초기화** 선택 시:
- 모든 Step을 처음부터 실행 (기존 `.crew/` 내용 덮어쓰기)

## Step 2: 언어 선택

**AskUserQuestion** 도구를 사용하여 이 프로젝트에서 사용할 프로그래밍 언어를 물어봅니다. **multiSelect** 질문입니다.

Question: "이 프로젝트에서 사용할 프로그래밍 언어를 선택하세요."
Header: "Languages"
Options (multiSelect: true):
- **TypeScript** - "TypeScript / JavaScript (ts, tsx, js, jsx)"
- **Python** - "Python (py, pyi)"
- **Go** - "Go (go)"
- **Rust** - "Rust (rs)"
- **Java** - "Java (java)"
- **C/C++** - "C / C++ (c, cpp, h, hpp)"
- **Ruby** - "Ruby (rb)"
- **Kotlin** - "Kotlin (kt, kts)"
- **Swift** - "Swift (swift)"
- **PHP** - "PHP (php)"

사용자는 "Other"를 통해 커스텀 언어를 입력할 수 있습니다.

선택된 언어 목록을 이후 단계에서 사용하기 위해 저장합니다.

## Step 3: 프로젝트 컨텍스트 수집

사용자의 프로젝트 설명: $ARGUMENTS

기존 코드베이스를 분석하여 컨텍스트를 감지합니다:
1. `CLAUDE.md`가 있으면 읽어서 프로젝트 지침 확인
2. Glob으로 `package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json` 등 확인
3. 발견된 설정 파일을 읽어 프로젝트명과 프레임워크 추출
4. 기존 테스트 디렉토리 확인 (`**/*test*/**`, `**/*spec*/**`)

## Step 4: Git 저장소 확인

Bash로 `git rev-parse --git-dir 2>/dev/null`를 실행하여 현재 프로젝트가 git 저장소인지 확인합니다.

**git 저장소가 아닌 경우:**

1. Bash로 `git init` 실행
2. `.gitignore`가 존재하는지 Glob으로 확인. 없으면 Step 2에서 선택한 언어 기반으로 `.gitignore` 생성:

```
# OS
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# Crew
.crew/plugins/
```

언어별 추가 패턴:
- **TypeScript/JavaScript**: `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`
- **Python**: `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, `.env`, `*.egg-info/`, `.pytest_cache/`
- **Go**: `vendor/` (go mod 사용 시 불필요할 수 있음)
- **Rust**: `target/`
- **Java**: `*.class`, `target/`, `build/`, `.gradle/`
- **C/C++**: `*.o`, `*.so`, `*.dylib`, `build/`, `cmake-build-*/`
- **Ruby**: `.bundle/`, `vendor/bundle/`
- **Kotlin**: `*.class`, `build/`, `.gradle/`
- **Swift**: `.build/`, `Packages/`, `*.xcodeproj/xcuserdata/`
- **PHP**: `vendor/`, `.phpunit.result.cache`

`.gitignore`가 이미 존재하면 덮어쓰지 않습니다. 단, `.crew/plugins/` 패턴이 없으면 파일 끝에 추가합니다.

3. 출력: "Git 저장소를 초기화했습니다."

**git 저장소인 경우** → 아무것도 하지 않고 다음 Step으로 진행.

## Step 5: 디렉토리 구조 생성

Bash `mkdir -p`로 다음 디렉토리를 생성합니다:

```
.crew/
.crew/sprints/
.crew/artifacts/prd/
.crew/artifacts/design/
.crew/artifacts/review/
.crew/artifacts/test/
.crew/plugins/crew-lsp/.claude-plugin/
```

## Step 6: LSP 서버 설치

Step 2에서 선택된 언어에 따라 해당 LSP 서버 바이너리를 설치하고 플러그인 설정을 생성합니다.

### LSP 서버 참조 테이블

| 언어 | LSP 서버 | 설치 명령 |
|------|----------|-----------|
| TypeScript | typescript-language-server | `npm install -g typescript-language-server typescript` |
| Python | pyright-langserver | `pip install pyright` (venv 있으면 내부에서, 아니면 `npm install -g pyright`) |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| Java | jdtls | `brew install jdtls` (macOS) 또는 수동 |
| C/C++ | clangd | `brew install llvm` (macOS) 또는 `apt install clangd` |
| Ruby | solargraph | `gem install solargraph` |
| Kotlin | kotlin-language-server | `brew install kotlin-language-server` 또는 수동 |
| Swift | sourcekit-lsp | Xcode 포함 (설치 불필요) |
| PHP | intelephense | `npm install -g intelephense` |

`.lsp.json` 생성 시 각 언어의 파일 확장자를 해당 언어 ID로 매핑합니다 (예: `.ts`→`typescript`, `.py`→`python`, `.go`→`go`).

### 설치 프로세스

각 선택된 언어에 대해:

1. **LSP 서버 바이너리가 이미 있는지 확인** — Bash로 `which <binary>` 실행. 예: `which gopls`, `which pyright-langserver` 등.

2. **미설치 시** 위 테이블의 설치 명령을 Bash로 실행. 오류를 적절히 처리:
   - `npm`이 필요하지만 없는 경우 사용자에게 알림
   - `go`가 필요하지만 없는 경우 사용자에게 알림
   - 설치 실패 시 로그를 남기되 다른 언어는 계속 진행
   - 성공/실패한 설치를 추적

3. **Python의 경우 특별 처리**: 프로젝트에 `.venv/`가 있는지 확인. 있으면 venv 내에서 pyright 설치. 없으면 `npm install -g pyright` 사용.

### LSP 플러그인 생성

설치 시도 후 `.lsp.json` 설정 파일을 생성합니다.

`.crew/plugins/crew-lsp/.lsp.json`에 성공적으로 설치된 언어의 서버만 포함하여 JSON을 동적으로 구성합니다. 각 서버는 `command`, `extensionToLanguage` 키를 포함하며, typescript-language-server, pyright-langserver, intelephense, solargraph은 `"args": ["--stdio"]`도 추가합니다.

### 플러그인 매니페스트 생성

`.crew/plugins/crew-lsp/.claude-plugin/plugin.json` 작성:
```json
{
  "name": "crew-lsp",
  "version": "1.0.0",
  "description": "Crew 개발 환경용 LSP 서버"
}
```

### 플러그인 등록

Bash로 실행:
```bash
claude plugin install .crew/plugins/crew-lsp --scope local
```

`claude plugin install` 커맨드를 사용할 수 없거나 실패하면, 사용자에게 다음으로 시작하라고 안내:
```bash
claude --plugin-dir .crew/plugins/crew-lsp
```

## Step 7: 코드베이스 분석 및 리뷰

**코드가 존재하는 경우에만 실행.** Step 3에서 소스 파일이 하나도 감지되지 않았으면 이 Step을 스킵하고 "새 프로젝트 — 코드베이스 분석 스킵" 메시지를 출력한 뒤 Step 8로 진행.

**4개 서브에이전트를 병렬로 실행** (Task tool, subagent_type: **"Explore"**, model: **"haiku"** — 초기 스캔이므로 속도 우선):

### Agent 1 — 아키텍처 매퍼:

> **시니어 소프트웨어 아키텍트**로서 이 프로젝트의 전체 아키텍처를 분석합니다.
>
> 수행 작업:
> 1. Glob으로 전체 디렉토리 구조 매핑 (node_modules, .git, vendor, dist, build, __pycache__ 제외)
> 2. 엔트리포인트 식별 (main 파일, index 파일, app 파일)
> 3. 주요 파일(최대 20개) 읽어서 모듈, 패키지, 상호 관계 매핑
> 4. 데이터 흐름 추적: 데이터가 어디서 들어오고, 어떻게 처리되고, 어디로 나가는지
> 5. 외부 서비스 연동 식별 (데이터베이스, API, 메시지 큐)
>
> 반환 내용:
> - **디렉토리 트리** (간소화, 중요 디렉토리만)
> - **엔트리포인트**: 파일 경로 목록
> - **모듈 맵**: 각 주요 모듈/패키지의 역할과 핵심 파일
> - **데이터 흐름**: 시스템을 통한 데이터 이동 텍스트 설명
> - **외부 의존성**: 코드가 연결하는 서비스, 데이터베이스, API

### Agent 2 — 패턴 및 컨벤션 감지기:

> **코드 표준 전문가**로서 이 프로젝트의 코딩 컨벤션과 패턴을 분석합니다.
>
> 수행 작업:
> 1. 여러 모듈에 걸쳐 대표적인 소스 파일 10-15개 읽기
> 2. 네이밍 컨벤션 식별 (camelCase, snake_case, PascalCase 등 어디에 무엇을 쓰는지)
> 3. 에러 핸들링 패턴 식별 (try/catch 스타일, 에러 반환, Result 타입)
> 4. 설정 파일 읽기: .eslintrc, .prettierrc, pyproject.toml [tool.*], .editorconfig, rustfmt.toml, .golangci.yml 등
> 5. 테스트 패턴 식별: 프레임워크, 디렉토리 구조, 네이밍, 픽스처/목
> 6. CI/CD 확인: .github/workflows/, Jenkinsfile, .gitlab-ci.yml 등
>
> 반환 내용:
> - **네이밍 컨벤션**: 엔티티 유형별 (변수, 함수, 클래스, 파일, 디렉토리)
> - **에러 핸들링 패턴**: 에러 생성, 전파, 처리 방식
> - **코드 스타일**: 포매팅 규칙, import 정렬, 파일 구조 패턴
> - **테스트 패턴**: 프레임워크, 디렉토리 레이아웃, 네이밍 규칙, 목/픽스처 사용 방식
> - **CI/CD**: 파이프라인 단계, 실행되는 검사
> - **린팅/포매팅**: 설정된 도구와 주요 규칙

### Agent 3 — 헬스 체크 리뷰어:

> **코드 품질 및 보안 감사관**으로서 이 코드베이스의 건강 상태를 점검합니다.
>
> 수행 작업:
> 1. Grep으로 TODO, FIXME, HACK, XXX, DEPRECATED 주석 검색
> 2. Grep으로 하드코딩된 시크릿 패턴 검색 (API 키, 비밀번호, 토큰): `password\s*=`, `api_key`, `secret`, `token\s*=` 등
> 3. 미사용 코드 또는 미사용 export/함수 식별
> 4. 일반적인 안티패턴 확인 (갓 클래스, 순환 의존성, 깊은 중첩 코드)
> 5. 의존성 최신성 확인: 락 파일에서 오래되거나 취약한 패키지 확인
> 6. 코드 중복 식별 (유사한 함수명, 파일 간 반복 패턴)
>
> 발견된 각 이슈에 대해 출력:
> - **심각도**: Critical / Major / Minor
> - **카테고리**: Security / Quality / Tech Debt / Dead Code
> - **파일**: path:line
> - **설명**: 이슈 내용
> - **권장사항**: 해결 방법
>
> 신뢰도 >= 75%인 이슈만 보고합니다.

### Agent 4 — 성능 리뷰어:

> **성능 엔지니어링 전문가**로서 이 코드베이스의 성능 우려사항을 분석합니다.
>
> 수행 작업:
> 1. 데이터 처리, API 핸들러, 데이터베이스 쿼리 중심으로 소스 파일 읽기
> 2. N+1 쿼리 패턴 또는 과도한 데이터베이스/API 호출 식별
> 3. 메모리 이슈 확인: 대규모 할당, 무제한 캐시, 정리 누락, 고루틴/스레드 누수
> 4. 비동기/이벤트 루프 컨텍스트에서의 블로킹 작업 확인
> 5. 비효율적 알고리즘 식별 (대규모 데이터셋에 대한 이차 루프)
> 6. 페이지네이션 누락, 무제한 결과 세트, 대용량 페이로드 처리 확인
> 7. 리소스 관리 확인: 커넥션 풀, 파일 핸들, 스트림 정리
>
> 발견된 각 이슈에 대해 출력:
> - **심각도**: Critical / Major / Minor
> - **카테고리**: Memory / Runtime / I/O / Algorithm
> - **파일**: path:line
> - **영향**: 예상 영향 설명
> - **설명**: 이슈 내용
> - **권장사항**: 최적화 방안
>
> 신뢰도 >= 75%인 이슈만 보고합니다.

### 결과 종합

4개 에이전트가 모두 반환한 후:

1. 결과를 종합하여 `.crew/artifacts/review/init-review.md`에 저장합니다. 다음 섹션을 포함:
   - **아키텍처**: 디렉토리 구조, 엔트리포인트, 모듈 맵, 데이터 흐름 (Agent 1)
   - **컨벤션**: 네이밍, 에러 핸들링, 코드 스타일, 테스트 패턴, CI/CD (Agent 2)
   - **헬스 체크**: 심각도별 이슈 요약 테이블 + 상세 (Agent 3)
   - **성능**: 카테고리별 이슈 요약 테이블 + 상세 (Agent 4)
   - **권장사항**: 4개 에이전트 결과를 종합한 Top 5-10 실행 가능한 권장사항

## Step 8: config.md 생성

`.crew/config.md` 작성:

```markdown
---
project: [감지된 프로젝트명 또는 "untitled"]
created: [현재 ISO timestamp]
languages: [Step 2에서 선택한 언어를 YAML 리스트로]
frameworks: [감지된 프레임워크를 YAML 리스트로]
test_dir: null
last_task_id: 0
---

# Crew 설정

## 프로젝트 개요
[$ARGUMENTS가 있으면 사용, 없으면 코드베이스 분석에서 요약]

## 아키텍처 요약
[Agent 1 결과 축약: 엔트리포인트, 모듈 맵, 데이터 흐름 — 최대 10-15줄]
[코드베이스 없는 경우: "새 프로젝트. 첫 피처 구현 시 아키텍처가 문서화됩니다."]

## 팀 역할
- **PM**: 요구사항 분석, 태스크 분해, PRD 작성
- **Architect**: 기술 설계, 파일 구조, 인터페이스 정의
- **Developer**: 코드 구현 (병렬 처리 가능한 태스크)
- **Reviewer**: 다관점 코드 리뷰 (정확성, 보안, 성능, 품질, 테스트)
- **QA**: 테스트 생성, 커버리지 검증

## LSP 서버
[성공적으로 설치된 LSP 서버 목록, 예:]
- gopls (Go)
- pyright (Python)
- typescript-language-server (TypeScript/JavaScript)

## 감지된 컨벤션
[Agent 2 결과: 네이밍, 에러 핸들링, 코드 스타일, 테스트 패턴 — 간결한 불릿 목록]
[코드베이스 없는 경우: "기존 코드베이스 미감지. 첫 피처 구현 시 컨벤션이 설정됩니다."]
```

## Step 9: CLAUDE.md 생성

Glob으로 프로젝트 루트에 `CLAUDE.md`가 존재하는지 확인합니다. **이미 존재하면 덮어쓰지 않고 아래 Crew 섹션을 기존 파일 끝에 추가합니다.**

CLAUDE.md가 없으면 `CLAUDE.md` 작성:

```markdown
# 프로젝트 지침

## 언어

모든 응답, 분석, 리포트, 산출물(.md 파일)은 한글로 작성합니다.
코드 주석, 변수명, 커밋 메시지 등 코드 관련 내용은 영어를 유지합니다.

## CLAUDE.md 관리 원칙

- 이 파일은 최대한 간결하고 명확하게 유지합니다
- 중복된 지침을 작성하지 않습니다
- 불필요하거나 오래된 지침은 삭제합니다

## 코드 작성 방침

### 1. 코딩 전에 생각하기
- 가정을 명시적으로 밝히고, 불확실하면 질문
- 여러 해석이 가능하면 조용히 선택하지 말고 선택지를 제시
- 더 간단한 접근이 있으면 제안
- 혼란스러운 요소는 넘어가지 말고 명확히 짚기

### 2. 단순성 우선
- 요청된 것 이상의 기능을 추가하지 않음
- 한 번만 쓰이는 코드에 추상화를 만들지 않음
- 불필요한 "유연성"이나 "설정 가능성"을 넣지 않음
- 발생할 수 없는 시나리오에 대한 에러 핸들링을 하지 않음
- 50줄이면 될 것을 200줄로 만들지 않음

### 3. 외과적 변경
- 관련 없는 코드, 주석, 포맷을 개선하지 않음
- 동작하는 코드를 리팩토링하지 않음
- 기존 스타일을 따름
- 내 변경으로 생긴 미사용 코드만 정리 (기존 dead code는 건드리지 않음)
- 모든 변경된 줄은 사용자의 요청에 직접 연결되어야 함

### 4. 목표 기반 실행
- 모호한 태스크를 측정 가능한 목표와 검증 단계로 변환
- 다단계 작업에는 각 단계별 체크포인트가 있는 구조화된 계획 수립
- 강한 기준은 독립적 반복을 가능하게 하고, 약한 기준은 끊임없는 확인을 필요로 함

### 5. 문서 동기화
- 코드 변경이 프로젝트의 README.md 내용에 영향을 줄 때 (API 변경, 새 기능 추가, 설정 변경, 사용법 변경 등) 반드시 README.md도 함께 업데이트
- `/crew:dev`, `/crew:debug` 등으로 코드가 수정된 후 마무리 단계에서 README.md 동기화 여부를 확인하고 필요 시 업데이트

## Crew 플러그인

이 프로젝트는 Crew 멀티에이전트 개발 플러그인을 사용합니다.

### 커맨드
- `/crew:init` - 워크스페이스 초기화
- `/crew:plan <feature>` - PM+Architect 기반 피처 플래닝
- `/crew:dev <feature|task>` - 풀 개발 파이프라인 (기획 → 구현 → 리뷰 → 테스트)
- `/crew:debug <버그 설명>` - 버그 조사 → 원인 분석 → 영향 분석 → 수정 → 검증
- `/crew:q <질문>` - 코드베이스 질문 (자동 범위 감지 + 관련 코드 수집)
- `/crew:review [scope]` - 5관점 병렬 코드 리뷰
- `/crew:verify [--fix]` - CI/CD 전 최종 검증 (테스트, 린트, 빌드, 시크릿)
- `/crew:sprint <plan|status|close>` - 스프린트 관리
- `/crew:status` - 프로젝트 대시보드
- `/crew:README [질문]` - Crew 사용법 안내

### 상태 디렉토리
Crew 상태 파일은 `.crew/` 디렉토리에 저장됩니다:
- `config.md` - 프로젝트 설정 (아키텍처, 컨벤션)
- `board.md` - 칸반 태스크 보드
- `artifacts/` - 에이전트 산출물 (PRD, 설계, 리뷰, 테스트)

### 컨벤션
- Task ID: `TASK-NNN` (3자리 zero-padded)
- 아티팩트 파일명: slugified (예: `user-auth-prd.md`)
- 오케스트레이터만 `.crew/` 상태 파일 읽기/쓰기
- 서브에이전트는 프롬프트로 컨텍스트 전달받고 텍스트로 결과 반환
```

CLAUDE.md가 이미 존재하면, `## CLAUDE.md 관리 원칙` 섹션(아직 없는 경우만), `## 코드 작성 방침` 섹션(아직 없는 경우만), `## Crew 플러그인` 섹션 (`### 커맨드`, `### 상태 디렉토리`, `### 컨벤션` 포함), `## 언어` 섹션(아직 없는 경우만)을 기존 파일 끝에 추가합니다.

## Step 10: README.md 생성 (없는 경우)

Glob으로 프로젝트 루트에 `README.md`가 존재하는지 확인합니다. **이미 존재하면 이 단계를 스킵합니다.**

README.md가 없으면, 수집된 모든 컨텍스트(Step 3 프로젝트 컨텍스트, Step 6 코드베이스 분석)를 기반으로 생성합니다.

`README.md` 작성:

```markdown
# [프로젝트명]

[1-2문장 설명 — $ARGUMENTS 또는 코드베이스 분석 기반]

## 기술 스택

[감지된 언어, 프레임워크, 주요 의존성 목록]

## 프로젝트 구조

```
[Architecture Mapper 에이전트의 간소화된 디렉토리 트리, 중요 디렉토리만 표시]
```

## 시작하기

### 사전 요구사항

[감지된 언어 기반 필요 도구 목록: node, python, go, rust 등]

### 설치

[감지된 설정 파일에서 추론:]
[package.json이면: `npm install`]
[go.mod이면: `go mod download`]
[requirements.txt이면: `pip install -r requirements.txt`]
[pyproject.toml이면: `uv sync` 또는 `pip install -e .`]
[Cargo.toml이면: `cargo build`]
[감지 안 됨: "TBD"]

### 실행

[package.json scripts, Makefile 타겟, 또는 메인 엔트리포인트에서 추론]
[감지 안 됨: "TBD"]

## 테스트

[컨벤션 감지기 결과: 테스트 프레임워크, 테스트 실행 방법]
[감지 안 됨: "TBD"]

## 개발

이 프로젝트는 AI 기반 개발을 위해 [Crew](https://bitbucket.org/ezardev-admin/marketplace-for-claude)를 사용합니다:

- `/crew:plan <feature>` - 피처 플래닝
- `/crew:dev <feature>` - 풀 개발 파이프라인
- `/crew:review` - 코드 리뷰
- `/crew:sprint` - 스프린트 관리
```

실제로 감지된 내용에 맞게 섹션을 조정합니다. 유용한 정보가 없는 섹션은 "TBD"로 채우기보다 생략합니다.

## Step 11: board.md 생성

`.crew/board.md` 작성:

```markdown
# 태스크 보드

> Last updated: [현재 ISO timestamp]

## Backlog

## In Progress

## In Review

## Done
```

## Step 12: history.md 생성

`.crew/history.md` 작성:

```markdown
# 히스토리

## 완료된 태스크
```

## Step 13: 결과 보고

다음 정보를 포함한 요약을 표시합니다:

- **프로젝트**: 이름, 언어, 프레임워크
- **Git**: 초기화 여부 (✓ 초기화됨 / ○ 기존 저장소)
- **LSP 서버**: 각 언어별 설치 상태 (✓ 설치됨 / ✗ 실패 / ○ 이미 존재)
- **코드베이스 리뷰** (Step 7 실행 시): 분석 파일 수, 아키텍처 한 줄 요약, 헬스 이슈 수, 리포트 경로
- **README**: 생성 여부
- **디렉토리 구조**: `.crew/` 하위 주요 파일 설명
- **다음 단계**: `/crew:plan`, `/crew:dev`, `/crew:review`, `/crew:status` 안내
- **참고** (LSP 설치 실패 시): 수동 설치 명령 안내
