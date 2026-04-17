import { describe, test, expect } from 'bun:test'
import { generateFlowchart, generateGantt } from '../src/lib/mermaid-gen'
import type { Pipeline } from '../src/lib/types'

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    slug: 'test',
    type: 'dev',
    status: 'completed',
    command: 'dev',
    startedAt: '2026-04-03T10:00:00Z',
    endedAt: '2026-04-03T10:05:00Z',
    durationMs: 300000,
    steps: [],
    agents: [],
    errors: [],
    ...overrides,
  }
}

describe('generateFlowchart', () => {
  test('empty pipeline produces minimal flowchart', () => {
    const result = generateFlowchart(makePipeline())
    expect(result).toContain('flowchart LR')
  })

  test('single step without agents', () => {
    const result = generateFlowchart(makePipeline({
      steps: [{ number: 1, name: 'Build', phase: 'Phase 1', status: 'done', durationMs: 5000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:05Z', agentCallIds: [] }],
    }))
    expect(result).toContain('S1')
    expect(result).toContain('Build')
    expect(result).toContain('style S1 fill:#22c55e')
  })

  test('parallel agents create fork node', () => {
    const result = generateFlowchart(makePipeline({
      steps: [{ number: 1, name: 'Impl', phase: 'Phase 2', status: 'done', durationMs: 10000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:10Z', agentCallIds: ['a1', 'a2'] }],
      agents: [
        { callId: 'a1', agentType: 'frontend-engineering', model: 'claude-opus-4-7[1m]', stepNumber: 1, durationMs: 8000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:08Z', isError: false, description: '', promptSummary: '', parallelGroup: null, department: 'engineering' },
        { callId: 'a2', agentType: 'backend-engineering', model: 'claude-opus-4-7[1m]', stepNumber: 1, durationMs: 10000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:10Z', isError: false, description: '', promptSummary: '', parallelGroup: null, department: 'engineering' },
      ],
    }))
    expect(result).toContain('S1{"Impl"}')
    expect(result).toContain('A_a1')
    expect(result).toContain('A_a2')
    expect(result).toContain('frontend-engineering')
    expect(result).toContain('backend-engineering')
  })

  test('failed step gets red style', () => {
    const result = generateFlowchart(makePipeline({
      steps: [{ number: 1, name: 'Test', phase: 'Phase 3', status: 'fail', durationMs: 1000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:01Z', agentCallIds: [] }],
    }))
    expect(result).toContain('style S1 fill:#ef4444')
  })
})

describe('generateGantt', () => {
  test('empty pipeline produces minimal gantt', () => {
    const result = generateGantt(makePipeline())
    expect(result).toContain('gantt')
    expect(result).toContain('dateFormat')
  })

  test('step with agents shows agent bars', () => {
    const result = generateGantt(makePipeline({
      steps: [{ number: 1, name: 'Build', phase: 'Phase 1', status: 'done', durationMs: 5000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:05Z', agentCallIds: [] }],
      agents: [
        { callId: 'a1', agentType: 'frontend-engineering', model: 'claude-opus-4-7[1m]', stepNumber: 1, durationMs: 5000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:05Z', isError: false, description: '', promptSummary: '', parallelGroup: null, department: 'engineering' },
      ],
    }))
    expect(result).toContain('frontend-engineering (claude-opus-4-7[1m])')
    expect(result).toContain('section Phase 1')
  })

  test('error agent gets crit tag', () => {
    const result = generateGantt(makePipeline({
      steps: [{ number: 1, name: 'Test', phase: 'Phase 3', status: 'fail', durationMs: 1000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:01Z', agentCallIds: [] }],
      agents: [
        { callId: 'a1', agentType: 'qa-strategy', model: 'sonnet', stepNumber: 1, durationMs: 1000, startedAt: '2026-04-03T10:00:00Z', endedAt: '2026-04-03T10:00:01Z', isError: true, description: '', promptSummary: '', parallelGroup: null, department: 'qa' },
      ],
    }))
    expect(result).toContain('crit,')
  })
})
