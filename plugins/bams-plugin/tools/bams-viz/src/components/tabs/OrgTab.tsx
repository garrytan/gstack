'use client'

import { usePolling } from '@/hooks/usePolling'
import { EmptyState } from '@/components/ui/EmptyState'

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface OrgSkill {
  skill_id: string
  skill_name: string
  purpose: string
}

interface OrgAgent {
  agent_id: string
  agent_name: string
  role: string
  model: string
  responsibility: string
  skills: OrgSkill[]
  collaborates_with: string[]
}

interface OrgDepartment {
  department_id: string
  department_name: string
  agent_count: number
  agents: OrgAgent[]
}

interface OrgResponse {
  mermaid: string
  departments?: OrgDepartment[]
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const DEPT_COLORS: Record<string, string> = {
  executive: '#ec4899',
  planning: '#3b82f6',
  engineering: '#22c55e',
  design: '#6b7280',
  evaluation: '#f97316',
  qa: '#a855f7',
}

const ROLE_BADGE: Record<string, { label: string; color: string }> = {
  commander:        { label: 'Commander',  color: '#ef4444' },
  department_lead:  { label: 'Dept Lead',  color: '#3b82f6' },
  lead:             { label: 'Lead',       color: '#22c55e' },
  specialist:       { label: 'Specialist', color: '#6b7280' },
}

function deptColor(deptId: string): string {
  return DEPT_COLORS[deptId] ?? '#6b7280'
}

function roleBadge(role: string): { label: string; color: string } {
  return ROLE_BADGE[role] ?? { label: role, color: '#6b7280' }
}

/* ------------------------------------------------------------------ */
/*  Skill badge                                                         */
/* ------------------------------------------------------------------ */

function SkillBadge({ skill }: { skill: OrgSkill }) {
  return (
    <span
      title={skill.purpose}
      style={{
        display: 'inline-block',
        padding: '2px 7px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 600,
        color: '#fff',
        background: '#0ea5e9',
        marginRight: '4px',
        marginBottom: '3px',
        cursor: 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {skill.skill_name}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Collaborator badge                                                  */
/* ------------------------------------------------------------------ */

interface CollaboratorBadgeProps {
  agentId: string
  agentName: string
  deptId: string
}

function CollaboratorBadge({ agentId, agentName, deptId }: CollaboratorBadgeProps) {
  const color = deptColor(deptId)
  const displayName = agentName || agentId
  return (
    <span
      title={agentId}
      style={{
        display: 'inline-block',
        padding: '2px 7px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 600,
        color: '#fff',
        background: color,
        marginRight: '4px',
        marginBottom: '3px',
        cursor: 'default',
        whiteSpace: 'nowrap',
        opacity: 0.85,
      }}
    >
      {displayName}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  DepartmentCard                                                      */
/* ------------------------------------------------------------------ */

interface DepartmentCardProps {
  dept: OrgDepartment
  agentDeptMap: Map<string, { deptId: string; agentName: string }>
}

function DepartmentCard({ dept, agentDeptMap }: DepartmentCardProps) {
  const color = deptColor(dept.department_id)

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '10px',
      overflow: 'hidden',
      marginBottom: '20px',
      borderLeft: `3px solid ${color}`,
    }}>
      {/* Department header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-secondary)',
      }}>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: color, flexShrink: 0,
        }} />
        <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>
          {dept.department_name}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '2px' }}>
          ({dept.department_id})
        </span>
        <div style={{ flex: 1 }} />
        <span style={{
          fontSize: '11px',
          color: '#fff',
          background: color,
          padding: '2px 9px',
          borderRadius: '10px',
          fontWeight: 600,
        }}>
          {dept.agent_count}명
        </span>
      </div>

      {/* Agent table header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 0.9fr 100px 1.6fr 1.6fr 2.5fr',
        gap: '8px',
        padding: '8px 16px',
        fontSize: '10px',
        fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-secondary)',
      }}>
        <div>Name</div>
        <div>Role</div>
        <div>Model</div>
        <div>Skills</div>
        <div>Collaborates With</div>
        <div>Responsibility</div>
      </div>

      {/* Agent rows */}
      {dept.agents.map((agent, i) => {
        const rb = roleBadge(agent.role)
        const isLast = i === dept.agents.length - 1
        return (
          <div
            key={agent.agent_id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 0.9fr 100px 1.6fr 1.6fr 2.5fr',
              gap: '8px',
              padding: '10px 16px',
              fontSize: '12px',
              borderBottom: isLast ? 'none' : '1px solid var(--border-light)',
              alignItems: 'start',
            }}
          >
            {/* Name */}
            <div style={{ color: 'var(--text-secondary)', fontSize: '12px', paddingTop: '2px' }}>
              {agent.agent_name}
            </div>

            {/* Role */}
            <div style={{ paddingTop: '2px' }}>
              <span style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '10px',
                fontWeight: 600,
                color: '#fff',
                background: rb.color,
                whiteSpace: 'nowrap',
              }}>
                {rb.label}
              </span>
            </div>

            {/* Model */}
            <div style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              fontFamily: 'monospace',
              paddingTop: '4px',
            }}>
              {agent.model}
            </div>

            {/* Skills */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start' }}>
              {agent.skills.length > 0
                ? agent.skills.map((skill) => (
                    <SkillBadge key={skill.skill_id} skill={skill} />
                  ))
                : <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>—</span>
              }
            </div>

            {/* Collaborates with */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start' }}>
              {agent.collaborates_with.length > 0
                ? agent.collaborates_with.map((collaboratorId) => {
                    const info = agentDeptMap.get(collaboratorId)
                    return (
                      <CollaboratorBadge
                        key={collaboratorId}
                        agentId={collaboratorId}
                        agentName={info?.agentName ?? collaboratorId}
                        deptId={info?.deptId ?? ''}
                      />
                    )
                  })
                : <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>—</span>
              }
            </div>

            {/* Responsibility */}
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.45', paddingTop: '2px' }}>
              {agent.responsibility}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  OrgTab                                                              */
/* ------------------------------------------------------------------ */

export function OrgTab() {
  const { data, error, isLoading } = usePolling<OrgResponse>('/api/org', 3000)

  if (isLoading && !data) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading org chart...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', color: 'var(--status-fail)' }}>Error loading org chart: {error.message}</div>
  }
  if (!data?.departments || data.departments.length === 0) {
    return <EmptyState icon="🏢" title="No org data" description="Organization chart data is not available yet" />
  }

  // Build agentId -> { deptId, agentName } lookup for collaborator badge coloring
  const agentDeptMap = new Map<string, { deptId: string; agentName: string }>()
  for (const dept of data.departments) {
    for (const agent of dept.agents) {
      agentDeptMap.set(agent.agent_id, {
        deptId: dept.department_id,
        agentName: agent.agent_name,
      })
    }
  }

  const totalAgents = data.departments.reduce((sum, d) => sum + d.agent_count, 0)

  return (
    <div style={{ padding: '20px', overflow: 'auto', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: '20px',
        paddingBottom: '12px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: '18px' }}>🏢</span>
        <span style={{ fontWeight: 700, fontSize: '15px' }}>Organization</span>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {data.departments.length}개 부서 · {totalAgents}명
        </span>
      </div>

      {/* Department cards */}
      {data.departments.map(dept => (
        <DepartmentCard key={dept.department_id} dept={dept} agentDeptMap={agentDeptMap} />
      ))}
    </div>
  )
}
