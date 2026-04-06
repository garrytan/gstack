/**
 * global-root.ts — 글로벌 bams 데이터 루트 경로 (Single Source of Truth)
 *
 * 모든 프로젝트가 공유하는 중앙 데이터 디렉토리: ~/.bams/
 * emit.sh, EventStore, Control Plane이 모두 이 경로를 참조.
 *
 * 오버라이드: BAMS_ROOT 환경변수 (테스트 또는 커스텀 경로용)
 */

import { join } from 'path'
import { mkdirSync } from 'fs'

const DEFAULT_DIR_NAME = '.bams'

/**
 * 글로벌 bams 루트 경로를 반환합니다.
 *
 * 우선순위:
 *   1. BAMS_ROOT 환경변수 (명시적 오버라이드)
 *   2. $HOME/.bams/ (기본값)
 *
 * 디렉토리가 없으면 자동 생성합니다.
 */
export function getGlobalRoot(): string {
  const explicit = process.env.BAMS_ROOT
  if (explicit) {
    mkdirSync(explicit, { recursive: true })
    return explicit
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  if (!home) {
    throw new Error('HOME environment variable is not set')
  }

  const root = join(home, DEFAULT_DIR_NAME)
  mkdirSync(root, { recursive: true })
  return root
}

/** 파이프라인 이벤트 디렉토리 */
export function getPipelineEventsDir(): string {
  return join(getGlobalRoot(), 'artifacts', 'pipeline')
}

/** 에이전트 이벤트 디렉토리 */
export function getAgentsEventsDir(): string {
  return join(getGlobalRoot(), 'artifacts', 'agents')
}

/** HR 리포트 디렉토리 */
export function getHrDir(): string {
  return join(getGlobalRoot(), 'artifacts', 'hr')
}

/** 글로벌 DB 경로를 반환합니다.
 *
 * 경로: ~/.claude/plugins/marketplaces/my-claude/bams.db (항상 고정)
 * 오버라이드: BAMS_DB_PATH 환경변수
 *
 * 디렉토리가 없으면 자동 생성합니다.
 */
export function getDbPath(): string {
  if (process.env.BAMS_DB_PATH) return process.env.BAMS_DB_PATH

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  if (!home) {
    throw new Error('HOME environment variable is not set')
  }

  const dir = join(home, '.claude', 'plugins', 'marketplaces', 'my-claude')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'bams.db')
}
