import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import type { AgentImprovement, HRAgent, HRDepartment, HRReport, HRReportSummary, RetroMetadata } from './types'
import { getHrDir } from './global-root'

// ---------------------------------------------------------------------------
// Trend calculation
// ---------------------------------------------------------------------------

const GRADE_ORDER: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 }

function calculateTrend(
  agentId: string,
  currentGrade: string,
  hrDir: string
): 'improving' | 'declining' | 'stable' {
  if (!existsSync(hrDir)) return 'stable'

  const files = readdirSync(hrDir)
    .filter(f => f.startsWith('retro-report-') && f.endsWith('.json'))
    .sort()
    .reverse()

  if (files.length === 0) return 'stable'

  try {
    const prevData = JSON.parse(readFileSync(join(hrDir, files[0]), 'utf-8')) as HRReport
    const prevAgent = prevData.agents?.find((a) => a.agent_id === agentId)
    if (!prevAgent) return 'stable'

    const curr = GRADE_ORDER[currentGrade] ?? 3
    const prev = GRADE_ORDER[prevAgent.grade] ?? 3

    if (curr > prev) return 'improving'
    if (curr < prev) return 'declining'
    return 'stable'
  } catch (err) {
    console.warn(`[retro-to-hr] Failed to read previous HR report for trend calculation (agent: ${agentId})`, err)
    return 'stable'
  }
}

// ---------------------------------------------------------------------------
// Agent → department mapping (matches bams-viz-emit.sh dept_map)
// ---------------------------------------------------------------------------

const DEPT_MAP: Record<string, string> = {
  'product-strategy': 'planning', 'business-analysis': 'planning', 'ux-research': 'planning', 'project-governance': 'planning',
  'frontend-engineering': 'engineering', 'backend-engineering': 'engineering', 'platform-devops': 'engineering', 'data-integration': 'engineering',
  'product-analytics': 'evaluation', 'experimentation': 'evaluation', 'performance-evaluation': 'evaluation', 'business-kpi': 'evaluation',
  'qa-strategy': 'qa', 'automation-qa': 'qa', 'defect-triage': 'qa', 'release-quality-gate': 'qa',
  'pipeline-orchestrator': 'management', 'cross-department-coordinator': 'management', 'executive-reporter': 'management', 'resource-optimizer': 'management', 'hr-agent': 'management',
}

function inferDepartment(agentId: string): string {
  return DEPT_MAP[agentId] ?? 'unknown'
}

// ---------------------------------------------------------------------------
// Phase 1 parser: agent metrics table
// ---------------------------------------------------------------------------

export function parseAgentMetrics(filePath: string): HRAgent[] {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const agents: HRAgent[] = []

  const parseNum = (s: string): number => parseInt(s.replace(/,/g, ''), 10) || 0
  const parseRate = (s: string): number | null => {
    const cleaned = s.trim()
    if (cleaned === '—' || cleaned === '-' || cleaned === '') return null
    const val = parseFloat(cleaned.replace(/,/g, '').replace(/%$/, ''))
    return isNaN(val) ? null : val
  }

  // Find the first agent metrics table (with "에이전트" header) and parse only that
  type ColMap = { agent: number; dept: number; invocations: number; successRate: number; retryRate: number; avgMs: number; grade: number }
  let colMap: ColMap | null = null
  let inAgentTable = false
  let passedSeparator = false

  for (const line of lines) {
    // Stop parsing if we hit a new section after the agent table
    if (inAgentTable && passedSeparator && !line.startsWith('|') && line.startsWith('#')) break

    if (!line.startsWith('|')) continue
    const sepCells = line.split('|').slice(1, -1)
    if (sepCells.length > 0 && sepCells.every(c => /^[\s\-:]+$/.test(c))) {
      if (inAgentTable) passedSeparator = true
      continue
    }

    const cols = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1)
    if (cols.length < 5) continue

    // Detect header row and build column map — only accept the first "에이전트" header
    const lower = cols.map(c => c.toLowerCase())
    if (!inAgentTable && (lower[0].includes('에이전트') || lower[0] === 'agent')) {
      inAgentTable = true
      passedSeparator = false
      colMap = { agent: 0, dept: -1, invocations: -1, successRate: -1, retryRate: -1, avgMs: -1, grade: -1 }
      for (let i = 0; i < lower.length; i++) {
        const h = lower[i]
        if (h.includes('부서') || h.includes('dept'))                         colMap.dept = i
        if ((h.includes('호출') && !h.includes('율')) || h.includes('호출 수')) colMap.invocations = i
        if (h.includes('성공률') || h === 'success_rate')                     colMap.successRate = i
        if (h.includes('재시도') && (h.includes('율') || h.includes('%')))     colMap.retryRate = i
        if (h.includes('평균') && (h.includes('ms') || h.includes('소요')))   colMap.avgMs = i
        if (h.includes('등급') || h === 'grade')                              colMap.grade = i
      }
      // Fallback for 11-col format: positional
      if (cols.length >= 11 && colMap.invocations === -1) {
        colMap = { agent: 0, dept: 1, invocations: 2, successRate: 3, retryRate: 5, avgMs: 6, grade: 10 }
      }
      continue
    }

    // Skip rows that aren't in the agent table or are another table's header
    if (!inAgentTable || !colMap) continue
    // Skip if this looks like a different table header
    if (lower[0].includes('부서') || lower[0].includes('항목') || lower[0].includes('순위')) break

    try {
      const agentId = cols[colMap.agent]
      if (!agentId || /^[-\s]+$/.test(agentId)) continue

      const rawDept = colMap.dept >= 0 ? (cols[colMap.dept] || '') : ''
      const department = rawDept && rawDept !== 'unknown' ? rawDept : inferDepartment(agentId)
      const invocationCount = colMap.invocations >= 0 ? parseNum(cols[colMap.invocations]) : 0
      const successRateRaw = colMap.successRate >= 0 ? parseRate(cols[colMap.successRate]) : null
      const successRate = successRateRaw !== null ? (successRateRaw > 1 ? successRateRaw / 100 : successRateRaw) : null
      const retryRateRaw = colMap.retryRate >= 0 ? parseRate(cols[colMap.retryRate]) : null
      const retryRate = retryRateRaw !== null ? retryRateRaw : 0
      const avgDurationMs = colMap.avgMs >= 0 ? parseNum(cols[colMap.avgMs]) : 0

      // Grade: from column or from separate grading section
      let grade = '?'
      if (colMap.grade >= 0 && cols[colMap.grade]) {
        const gradeRaw = cols[colMap.grade]
        const gradeMatch = gradeRaw.match(/\*\*([A-F])\*\*/) ?? gradeRaw.match(/([A-F])/)
        grade = gradeMatch ? gradeMatch[1] : gradeRaw.replace(/\*/g, '').trim()
      }

      const retryCount = Math.round(invocationCount * retryRate / 100)

      agents.push({
        agent_id: agentId,
        department,
        grade,
        invocation_count: invocationCount,
        success_rate: successRate,
        avg_duration_ms: avgDurationMs,
        retry_count: retryCount,
        escalation_count: 0,
        trend: 'stable',
      })
    } catch (err) {
      console.warn(`[retro-to-hr] Skipping malformed agent metrics row: "${cols?.[0] ?? "unknown"}"`, err)
    }
  }

  // If no grade column in table, try to extract grades from "## 등급" section
  if (agents.length > 0 && agents.every(a => a.grade === '?')) {
    for (const line of lines) {
      if (!line.startsWith('|')) continue
      // Match last column containing a grade like **A**, **B**, **C** etc.
      // e.g. "| pipeline-orchestrator | 32.7 | 5 | 24.5 | **62.2** | **C** |"
      const cols = line.split('|').map(c => c.trim()).filter(Boolean)
      if (cols.length < 2) continue
      const lastCol = cols[cols.length - 1]
      const gradeMatch = lastCol.match(/\*\*([A-F])\*\*/) ?? lastCol.match(/^([A-F])$/)
      if (gradeMatch) {
        const agentId = cols[0].replace(/\*/g, '').trim()
        const agent = agents.find(a => a.agent_id === agentId)
        if (agent) agent.grade = gradeMatch[1]
      }
    }
  }

  return agents
}

// ---------------------------------------------------------------------------
// Phase 2 parser: KPT consolidated
// ---------------------------------------------------------------------------

interface KPTResult {
  actionItems: string[]
  keepCount: number
  problemCount: number
  tryCount: number
}

export function parseKPT(filePath: string): KPTResult {
  const defaults: KPTResult = { actionItems: [], keepCount: 0, problemCount: 0, tryCount: 0 }

  if (!existsSync(filePath)) {
    console.warn(`[retro-to-hr] phase2-kpt-consolidated.md not found: ${filePath}`)
    return defaults
  }

  try {
    const content = readFileSync(filePath, 'utf-8')

    // KPT counts
    const keepMatch = content.match(/Keep 종합.*?(\d+)건/)
    const problemMatch = content.match(/Problem 종합.*?(\d+)건/)
    const tryMatch = content.match(/Try 종합.*?(\d+)건/)

    const keepCount = keepMatch ? parseInt(keepMatch[1], 10) : 0
    const problemCount = problemMatch ? parseInt(problemMatch[1], 10) : 0
    const tryCount = tryMatch ? parseInt(tryMatch[1], 10) : 0

    // Action items table — find "## 4. 액션 아이템" section
    const actionItems: string[] = []
    const lines = content.split('\n')
    let inActionTable = false

    for (const line of lines) {
      if (/##\s+\d+\.\s*(액션 아이템|Action Item)/i.test(line)) {
        inActionTable = true
        continue
      }
      if (inActionTable && line.startsWith('## ')) {
        break // next section
      }
      if (!inActionTable) continue
      if (!line.startsWith('|')) continue
      // Separator row: every cell contains only dashes, colons, and spaces
    const sepCells = line.split('|').slice(1, -1)
    if (sepCells.length > 0 && sepCells.every(c => /^[\s\-:]+$/.test(c))) continue

      const cols = line
        .split('|')
        .map(c => c.trim())
        .filter((_, i, arr) => i > 0 && i < arr.length - 1)

      if (cols.length < 2) continue

      // skip header row
      const firstCol = cols[0]
      if (['#', 'No', 'no', '번호'].includes(firstCol)) continue
      // skip separator row
      if (/^[-\s]+$/.test(firstCol)) continue

      const item = cols[1]?.trim()
      if (item && item !== '내용' && item !== 'content') {
        actionItems.push(item)
        if (actionItems.length >= 10) break
      }
    }

    return { actionItems, keepCount, problemCount, tryCount }
  } catch (err) {
    console.warn(`[retro-to-hr] Failed to parse KPT file: ${filePath}`, err)
    return defaults
  }
}

// ---------------------------------------------------------------------------
// Phase 5 parser: retro report
// ---------------------------------------------------------------------------

interface RetroReportResult {
  period: { start: string | null; end: string | null }
  analyzedPipelines: number
  retroDate: string | null
  gradeDistribution: Record<string, number>
}

export function parseRetroReport(filePath: string): RetroReportResult {
  const defaults: RetroReportResult = {
    period: { start: null, end: null },
    analyzedPipelines: 0,
    retroDate: null,
    gradeDistribution: {},
  }

  if (!existsSync(filePath)) {
    console.warn(`[retro-to-hr] phase5-retro-report.md not found: ${filePath}`)
    return defaults
  }

  try {
    const content = readFileSync(filePath, 'utf-8')

    // Flexible pipeline count: "(7개 파이프라인" or "파이프라인: 7개" or "| 7개 |"
    const pipelinesMatch = content.match(/\(?(\d+)개\s*파이프라인/)
      ?? content.match(/파이프라인[:\s]*(\d+)개/)
      ?? content.match(/파이프라인 수\s*\|\s*(\d+)/)
    const analyzedPipelines = pipelinesMatch ? parseInt(pipelinesMatch[1], 10) : 0

    const retroDateMatch = content.match(/작성일[:\s]*(\d{4}-\d{2}-\d{2})/)
    const retroDate = retroDateMatch ? retroDateMatch[1] : null

    // Flexible period: "2026-03-04 ~ 2026-04-03" with or without parentheses
    const periodStartMatch = content.match(/(\d{4}-\d{2}-\d{2})\s*~/)
    const periodEndMatch = content.match(/~\s*(\d{4}-\d{2}-\d{2})/)
    let periodStart = periodStartMatch ? periodStartMatch[1] : null
    let periodEnd = periodEndMatch ? periodEndMatch[1] : null

    // Fallback: extract dates from pipeline list table rows (YYYY-MM-DD HH:MM)
    if (!periodStart || !periodEnd) {
      const tableDates: string[] = []
      for (const l of content.split('\n')) {
        const dateMatch = l.match(/\|\s*(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/)
        if (dateMatch) tableDates.push(dateMatch[1])
      }
      if (tableDates.length > 0) {
        tableDates.sort()
        periodStart = periodStart ?? tableDates[0]
        periodEnd = periodEnd ?? tableDates[tableDates.length - 1]
      }
    }

    // Grade distribution (optional): lines like "| A | 5건 | ..."
    const gradeDistribution: Record<string, number> = {}
    const lines = content.split('\n')
    for (const line of lines) {
      const gradeDistMatch = line.match(/^\|\s*([A-F])\s*\|\s*(\d+)건/)
      if (gradeDistMatch) {
        gradeDistribution[gradeDistMatch[1]] = parseInt(gradeDistMatch[2], 10)
      }
    }

    return {
      period: { start: periodStart, end: periodEnd },
      analyzedPipelines,
      retroDate,
      gradeDistribution,
    }
  } catch (err) {
    console.warn(`[retro-to-hr] Failed to parse retro report: ${filePath}`, err)
    return defaults
  }
}

// ---------------------------------------------------------------------------
// Phase 4 parser: improvements summary
// ---------------------------------------------------------------------------

export function parseImprovements(retroDir: string): { improvements: AgentImprovement[], actionItems: string[] } {
  const summaryPath = join(retroDir, 'phase4-improvements-summary.md')
  const defaults = { improvements: [] as AgentImprovement[], actionItems: [] as string[] }

  if (!existsSync(summaryPath)) return defaults

  try {
    const content = readFileSync(summaryPath, 'utf-8')
    const lines = content.split('\n')

    // Parse agent improvement sections: "### {agent} — N개 변경 항목"
    const improvements: AgentImprovement[] = []
    let currentAgent: string | null = null
    let currentChanges: string[] = []
    let gradeInfo = ''

    for (const line of lines) {
      // Match "### pipeline-orchestrator — 4개 변경 항목"
      const agentMatch = line.match(/^### (\S+)\s*—\s*(\d+)개\s*변경/)
      if (agentMatch) {
        if (currentAgent) {
          improvements.push(parseAgentBlock(currentAgent, gradeInfo, currentChanges))
        }
        currentAgent = agentMatch[1]
        currentChanges = []
        gradeInfo = ''
        continue
      }

      // Match grade line: "**예상 등급 변화:** C(66.9점) → B+(85점 이상)"
      const gradeMatch = line.match(/\*\*예상 등급 변화:\*\*\s*(.+)/)
      if (gradeMatch && currentAgent) {
        gradeInfo = gradeMatch[1]
        continue
      }

      // Parse change table rows inside agent section
      if (currentAgent && line.startsWith('|') && !line.includes('순서') && !line.includes('---')) {
        const cols = line.split('|').map(c => c.trim()).filter(Boolean)
        if (cols.length >= 3 && /^\d/.test(cols[0])) {
          currentChanges.push(cols[1]) // "변경 항목" column
        }
      }
    }
    if (currentAgent) {
      improvements.push(parseAgentBlock(currentAgent, gradeInfo, currentChanges))
    }

    // Parse action items from "## 4. 전체 우선순위" table
    const actionItems: string[] = []
    let inPriorityTable = false
    for (const line of lines) {
      if (/##\s+\d+\.\s*(전체 우선순위|Priority)/i.test(line)) {
        inPriorityTable = true
        continue
      }
      if (inPriorityTable && line.startsWith('## ')) break
      if (!inPriorityTable || !line.startsWith('|')) continue

      const cols = line.split('|').map(c => c.trim()).filter(Boolean)
      if (cols.length >= 4 && /^\*?\*?\d/.test(cols[0])) {
        const agent = cols[1]
        const item = cols[2]
        actionItems.push(`${agent}: ${item}`)
      }
    }

    return { improvements, actionItems }
  } catch (err) {
    console.warn(`[retro-to-hr] Failed to parse improvements summary`, err)
    return defaults
  }
}

function parseAgentBlock(agentId: string, gradeInfo: string, changes: string[]): AgentImprovement {
  // Parse "C(66.9점) → B+(85점 이상)" or "C*(60.0점, 잠정) → 실제 등급 재산출"
  const gradeMatch = gradeInfo.match(/([A-F]\*?)\s*[\(（].*?[\)）]\s*→\s*(\S+)/)
  return {
    agent_id: agentId,
    grade_before: gradeMatch?.[1] ?? '?',
    grade_target: gradeMatch?.[2] ?? '?',
    changes,
  }
}

// ---------------------------------------------------------------------------
// Department aggregation
// ---------------------------------------------------------------------------

function aggregateDepartments(agents: HRAgent[]): HRDepartment[] {
  const map = new Map<string, { agents: HRAgent[] }>()

  for (const agent of agents) {
    const dept = agent.department || 'unknown'
    if (!map.has(dept)) map.set(dept, { agents: [] })
    map.get(dept)!.agents.push(agent)
  }

  const departments: HRDepartment[] = []
  for (const [deptId, { agents: deptAgents }] of map.entries()) {
    const validRates = deptAgents
      .map(a => a.success_rate)
      .filter((r): r is number => r !== null)

    const avg_success_rate =
      validRates.length > 0
        ? Math.round((validRates.reduce((a, b) => a + b, 0) / validRates.length) * 10000) / 10000
        : null

    const total_invocations = deptAgents.reduce((s, a) => s + a.invocation_count, 0)

    departments.push({
      department_id: deptId,
      agent_count: deptAgents.length,
      avg_success_rate,
      total_invocations,
    })
  }

  return departments
}

// ---------------------------------------------------------------------------
// Summary calculation
// ---------------------------------------------------------------------------

function buildSummary(agents: HRAgent[], analyzedPipelines: number): HRReportSummary {
  const totalInvocations = agents.reduce((s, a) => s + a.invocation_count, 0)

  // Weighted average success rate
  const validAgents = agents.filter(a => a.success_rate !== null)
  let overallSuccessRate: number | null = null
  if (validAgents.length > 0) {
    const weightedSum = validAgents.reduce(
      (s, a) => s + (a.success_rate as number) * a.invocation_count,
      0
    )
    const weightedTotal = validAgents.reduce((s, a) => s + a.invocation_count, 0)
    overallSuccessRate =
      weightedTotal > 0
        ? Math.round((weightedSum / weightedTotal) * 10000) / 10000
        : null
  }

  return {
    total_pipelines: analyzedPipelines,
    total_invocations: totalInvocations,
    overall_success_rate: overallSuccessRate,
  }
}

// ---------------------------------------------------------------------------
// Migration: .crew/artifacts/hr/ → ~/.bams/artifacts/hr/
// ---------------------------------------------------------------------------

/**
 * 기존에 .crew/artifacts/hr/에 저장된 HR JSON을 ~/.bams/artifacts/hr/로 마이그레이션합니다.
 * 이미 globalHrDir에 동일 파일이 존재하면 스킵합니다.
 */
function migrateCrewHrToGlobal(crewRoot: string, globalHrDir: string): void {
  const crewHrDir = join(crewRoot, 'artifacts', 'hr')
  if (!existsSync(crewHrDir)) return

  let migrated = 0
  try {
    const files = readdirSync(crewHrDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const src = join(crewHrDir, file)
      const dst = join(globalHrDir, file)
      if (!existsSync(dst)) {
        copyFileSync(src, dst)
        migrated++
        console.log(`[retro-to-hr] Migrated: ${file} → ${globalHrDir}`)
      }
    }
    if (migrated > 0) {
      console.log(`[retro-to-hr] Migration 완료: ${migrated}개 파일을 ${globalHrDir}로 이동`)
    }
  } catch (err) {
    console.warn(`[retro-to-hr] Migration 중 오류 발생 (무시하고 계속):`, err)
  }
}

// ---------------------------------------------------------------------------
// Main conversion function
// ---------------------------------------------------------------------------

export function convertRetroToHR(retroSlug: string, crewRoot: string): void {
  const retroDir = join(crewRoot, 'artifacts', 'retro', retroSlug)

  // HR JSON은 글로벌 경로(~/.bams/artifacts/hr/)에 저장 — viz API의 getHrDir()와 일치
  const hrDir = getHrDir()
  mkdirSync(hrDir, { recursive: true })

  // 기존 .crew/artifacts/hr/에 저장된 파일을 글로벌 경로로 마이그레이션
  migrateCrewHrToGlobal(crewRoot, hrDir)

  // Phase 1 — required
  const phase1Path = join(retroDir, 'phase1-agent-metrics.md')
  if (!existsSync(phase1Path)) {
    throw new Error(
`[retro-to-hr] Required file missing: ${phase1Path}\n  retro slug: ${retroSlug}\n  retro dir: ${retroDir}\n  Ensure the retro pipeline has completed Phase 1 (agent-metrics) before calling convertRetroToHR.`
    )
  }

  const agents = parseAgentMetrics(phase1Path)

  // Update trend for each agent
  for (const agent of agents) {
    agent.trend = calculateTrend(agent.agent_id, agent.grade, hrDir)
  }

  // Phase 2 — optional
  const phase2Path = join(retroDir, 'phase2-kpt-consolidated.md')
  const { actionItems: kptActionItems, keepCount, problemCount, tryCount } = parseKPT(phase2Path)

  // Phase 4 — optional (improvements)
  const { improvements, actionItems: phase4ActionItems } = parseImprovements(retroDir)
  // Merge: phase4 action items take priority, fallback to KPT
  const actionItems = phase4ActionItems.length > 0 ? phase4ActionItems : kptActionItems

  // Phase 5 — optional
  const phase5Path = join(retroDir, 'phase5-retro-report.md')
  const { period, analyzedPipelines, retroDate, gradeDistribution } = parseRetroReport(phase5Path)

  // Today's date for file naming and retro_date fallback
  const today = new Date().toISOString().slice(0, 10)
  const reportDate = retroDate ?? today

  const departments = aggregateDepartments(agents)
  const summary = buildSummary(agents, analyzedPipelines)

  // Alerts: D or F grade agents
  const alerts = agents
    .filter(a => a.grade === 'D' || a.grade === 'F')
    .map(a => `${a.agent_id}: 등급 ${a.grade} — 성능 개선 필요`)

  const recommendations = actionItems.slice(0, 5)

  const retro_metadata: RetroMetadata = {
    analyzed_pipelines: analyzedPipelines,
    retro_date: reportDate,
    action_items: actionItems,
    keep_count: keepCount,
    problem_count: problemCount,
    try_count: tryCount,
    // Use parsed grade distribution, or compute from agents
    grade_distribution: Object.keys(gradeDistribution).length > 0
      ? gradeDistribution
      : agents.reduce((acc, a) => {
          if (a.grade && a.grade !== '?') acc[a.grade] = (acc[a.grade] ?? 0) + 1
          return acc
        }, {} as Record<string, number>),
    ...(improvements.length > 0 ? { improvements } : {}),
  }

  const report: HRReport = {
    report_date: reportDate,
    source: 'retro',
    retro_slug: retroSlug,
    period,
    summary,
    departments,
    agents,
    alerts,
    recommendations,
    retro_metadata,
  }

  const outputFilename = `retro-report-${retroSlug}-${reportDate}.json`
  const outputPath = join(hrDir, outputFilename)

  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`[retro-to-hr] Written: ${outputPath}`)

  // ---------------------------------------------------------------------------
  // DB 저장 (bun:sqlite — 직접 SQL, TaskDB 의존성 없음)
  // DB 쓰기 실패 시 경고만 출력하고 JSON fallback으로 계속 진행
  // ---------------------------------------------------------------------------
  try {
    // DB 경로: 글로벌 단일 DB
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const globalDbDir = join(home, '.claude', 'plugins', 'marketplaces', 'my-claude')
    mkdirSync(globalDbDir, { recursive: true })
    const dbPath = join(globalDbDir, 'bams.db')

    const hrDb = new Database(dbPath, { create: true })
    hrDb.exec('PRAGMA journal_mode = WAL;')
    hrDb.exec(`
      CREATE TABLE IF NOT EXISTS hr_reports (
        id              TEXT PRIMARY KEY,
        retro_slug      TEXT NOT NULL UNIQUE,
        report_date     TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'retro',
        period_start    TEXT,
        period_end      TEXT,
        data            TEXT NOT NULL,
        created_at      DATETIME NOT NULL DEFAULT (datetime('now')),
        updated_at      DATETIME NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS hr_reports_date_idx ON hr_reports(report_date DESC);
    `)

    const newId = randomUUID()
    hrDb.prepare(
      `INSERT OR REPLACE INTO hr_reports
        (id, retro_slug, report_date, source, period_start, period_end, data, updated_at)
       VALUES (
         COALESCE((SELECT id FROM hr_reports WHERE retro_slug = ?), ?),
         ?, ?, ?, ?, ?, ?, datetime('now')
       )`
    ).run(
      retroSlug, newId,
      retroSlug,
      reportDate,
      'retro',
      period.start ?? null,
      period.end ?? null,
      JSON.stringify(report)
    )

    hrDb.close()
    console.log(`[retro-to-hr] DB 저장 완료: ${dbPath} (retro_slug=${retroSlug})`)
  } catch (dbErr) {
    const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
    console.warn(`[retro-to-hr] DB 저장 실패 (비치명적, JSON fallback 사용): ${msg}`)
  }
}
