'use client'

import { usePolling } from '@/hooks/usePolling'
import { TaskRow } from './TaskRow'
import type { Task } from '@/lib/types'

interface TaskTableProps {
  pipelineSlug: string
}

interface TasksResponse {
  tasks: Task[]
  count: number
}

export function TaskTable({ pipelineSlug }: TaskTableProps) {
  const { data, error, isLoading } = usePolling<TasksResponse>(
    `/api/pipelines/${encodeURIComponent(pipelineSlug)}/tasks`,
    3000
  )

  if (isLoading && !data) {
    return (
      <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
        Loading tasks...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '16px', textAlign: 'center', color: 'var(--status-fail)', fontSize: '11px' }}>
        Failed to load tasks
      </div>
    )
  }

  const tasks = data?.tasks ?? []

  if (tasks.length === 0) {
    return (
      <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
        No tasks
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '11px',
      }}>
        <thead>
          <tr style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-muted)',
            textAlign: 'left',
          }}>
            <th style={{ padding: '6px 12px', fontWeight: 500 }}>Title</th>
            <th style={{ padding: '6px 12px', fontWeight: 500 }}>Agent</th>
            <th style={{ padding: '6px 12px', fontWeight: 500 }}>Model</th>
            <th style={{ padding: '6px 12px', fontWeight: 500 }}>Label</th>
            <th style={{ padding: '6px 12px', fontWeight: 500 }}>Duration</th>
            <th style={{ padding: '6px 12px', fontWeight: 500 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <TaskRow key={task.id} task={task} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
