import { sanitizeId } from './utils'

interface DeptColor {
  fill: string
  stroke: string
  label: string
}

const DEPT_COLORS: Record<string, DeptColor> = {
  executive: { fill: '#ec4899', stroke: '#db2777', label: '총괄팀' },
  planning_department: { fill: '#3b82f6', stroke: '#2563eb', label: '기획부서' },
  planning: { fill: '#3b82f6', stroke: '#2563eb', label: '기획부서' },
  engineering_department: { fill: '#22c55e', stroke: '#16a34a', label: '개발부서' },
  engineering: { fill: '#22c55e', stroke: '#16a34a', label: '개발부서' },
  evaluation_department: { fill: '#f97316', stroke: '#ea580c', label: '평가부서' },
  evaluation: { fill: '#f97316', stroke: '#ea580c', label: '평가부서' },
  qa_department: { fill: '#a855f7', stroke: '#9333ea', label: 'QA부서' },
  qa: { fill: '#a855f7', stroke: '#9333ea', label: 'QA부서' },
}

interface JojikdoAgent {
  agent_id?: string
  name?: string
  agent_name?: string
  model?: string
}

interface JojikdoDepartment {
  department_id?: string
  name?: string
  department_name?: string
  agents?: JojikdoAgent[]
}

interface AgentCallTarget {
  agent_id?: string
  purpose?: string
}

interface Jojikdo {
  departments?: JojikdoDepartment[]
  agent_calls?: Record<string, (string | AgentCallTarget)[]>
}

/** Default collaboration edges when jojikdo.json has no agent_calls */
const DEFAULT_AGENT_CALLS: Record<string, (string | AgentCallTarget)[]> = {
  pipeline_orchestrator_agent: [
    { agent_id: 'product_strategy_agent', purpose: '기획 지시' },
    { agent_id: 'frontend_engineering_agent', purpose: '구현 지시' },
    { agent_id: 'backend_engineering_agent', purpose: '구현 지시' },
    { agent_id: 'qa_strategy_agent', purpose: '검증 지시' },
    { agent_id: 'hr_agent', purpose: '에이전트 관리' },
  ],
  cross_department_coordinator_agent: [
    { agent_id: 'pipeline_orchestrator_agent', purpose: '조율' },
    { agent_id: 'project_governance_agent', purpose: '거버넌스' },
  ],
  product_strategy_agent: [
    { agent_id: 'business_analysis_agent', purpose: '기능 명세' },
    { agent_id: 'ux_research_agent', purpose: 'UX 조사' },
  ],
  business_analysis_agent: [
    { agent_id: 'frontend_engineering_agent', purpose: '구현 전달' },
    { agent_id: 'backend_engineering_agent', purpose: '구현 전달' },
  ],
  frontend_engineering_agent: [
    { agent_id: 'automation_qa_agent', purpose: '테스트 요청' },
  ],
  backend_engineering_agent: [
    { agent_id: 'automation_qa_agent', purpose: '테스트 요청' },
    { agent_id: 'data_integration_engineering_agent', purpose: '데이터 연동' },
  ],
  qa_strategy_agent: [
    { agent_id: 'automation_qa_agent', purpose: '자동화 실행' },
    { agent_id: 'defect_triage_agent', purpose: '결함 분류' },
  ],
  release_quality_gate_agent: [
    { agent_id: 'platform_devops_agent', purpose: '배포 승인' },
  ],
  executive_reporter_agent: [
    { agent_id: 'product_analytics_agent', purpose: '데이터 수집' },
    { agent_id: 'business_kpi_agent', purpose: 'KPI 수집' },
  ],
}

/**
 * Generate org chart Mermaid code from jojikdo JSON data
 */
export function generateOrgChart(jojikdo: Jojikdo, activeAgents: string[] = []): string {
  const lines: string[] = ['flowchart TB']
  // Version loaded dynamically in generateOrgChartFromFile; fallback here
  const version = (jojikdo as Record<string, unknown>).version || 'latest'
  lines.push(`  ROOT(("bams-plugin<br/>v${version}"))`)

  lines.push('')

  const departments = jojikdo.departments || []
  const styleLines: string[] = []

  for (const dept of departments) {
    const deptId = dept.department_id || dept.name || 'unknown'
    const sid = sanitizeId(deptId)
    const deptInfo: DeptColor = DEPT_COLORS[deptId] || {
      fill: '#6b7280',
      stroke: '#4b5563',
      label: dept.department_name || dept.name || deptId,
    }

    // Subgraph per department — groups agents visually
    lines.push(`  subgraph ${sid}_group["${deptInfo.label}"]`)
    lines.push(`    direction TB`)

    const agents = dept.agents || []
    for (const agent of agents) {
      const agentId = agent.agent_id || agent.name || 'unknown'
      const shortName = (agent.agent_name || agent.name || agentId).replace(/ Agent$/, '')
      const model = agent.model || 'sonnet'
      const isActive = activeAgents.includes(agentId)

      lines.push(`    ${sanitizeId(agentId)}["${shortName}<br/><small>${model}</small>"]`)

      if (isActive) {
        styleLines.push(`  style ${sanitizeId(agentId)} fill:#fbbf24,stroke:#f59e0b,color:#000`)
      }
    }

    lines.push(`  end`)
    lines.push(`  ROOT --> ${sid}_group`)
    lines.push('')

    // Subgraph style
    styleLines.push(`  style ${sid}_group fill:${deptInfo.fill}18,stroke:${deptInfo.stroke},stroke-width:2px,color:${deptInfo.fill}`)
  }

  // Agent call relationships — only between departments
  // 지시 (directive) = red solid, 협조 (cooperation) = blue dotted
  const agentCalls = jojikdo.agent_calls || DEFAULT_AGENT_CALLS
  lines.push('  %% Cross-department collaboration')
  // linkStyle uses global edge index; ROOT-->dept edges come first
  const rootEdgeCount = departments.length
  const directiveIndices: number[] = []
  const cooperationIndices: number[] = []
  let edgeIdx = 0
  for (const [caller, callees] of Object.entries(agentCalls)) {
    if (Array.isArray(callees)) {
      for (const callee of callees) {
        const calleeId = typeof callee === 'object' ? (callee.agent_id || '') : callee
        const purpose = typeof callee === 'object' ? callee.purpose : ''
        const safePurpose = purpose ? purpose.replace(/["|]/g, ' ') : ''
        const isDirective = /지시|위임|실행|요청/.test(purpose || '')
        const globalIdx = rootEdgeCount + edgeIdx
        edgeIdx++

        if (safePurpose) {
          if (isDirective) {
            lines.push(`  ${sanitizeId(caller)} -->|"${safePurpose}"| ${sanitizeId(calleeId)}`)
          } else {
            lines.push(`  ${sanitizeId(caller)} -.->|"${safePurpose}"| ${sanitizeId(calleeId)}`)
          }
        } else {
          if (isDirective) {
            lines.push(`  ${sanitizeId(caller)} --> ${sanitizeId(calleeId)}`)
          } else {
            lines.push(`  ${sanitizeId(caller)} -.-> ${sanitizeId(calleeId)}`)
          }
        }

        if (isDirective) {
          directiveIndices.push(globalIdx)
        } else {
          cooperationIndices.push(globalIdx)
        }
      }
    }
  }

  // Apply linkStyle: directive=red, cooperation=blue
  lines.push('')
  lines.push('  %% Edge colors: red=지시(directive), blue=협조(cooperation)')
  if (directiveIndices.length > 0) {
    lines.push(`  linkStyle ${directiveIndices.join(',')} stroke:#ef4444,stroke-width:2px`)
  }
  if (cooperationIndices.length > 0) {
    lines.push(`  linkStyle ${cooperationIndices.join(',')} stroke:#3b82f6,stroke-width:1.5px`)
  }

  lines.push('')
  lines.push('  style ROOT fill:#1e293b,stroke:#0f172a,color:#fff,font-weight:bold')
  lines.push(...styleLines)

  return lines.join('\n')
}

/**
 * Generate org chart from a JSON file path (server-side only)
 * This function reads from the filesystem and should only be used in API routes or server components.
 */
export async function generateOrgChartFromFile(
  jojikdoPath: string,
  activeAgents: string[] = []
): Promise<string> {
  try {
    const { readFileSync } = await import('node:fs')
    const jojikdo: Jojikdo = JSON.parse(readFileSync(jojikdoPath, 'utf-8'))
    return generateOrgChart(jojikdo, activeAgents)
  } catch {
    return '```\n조직도 파일을 찾을 수 없습니다\n```'
  }
}
