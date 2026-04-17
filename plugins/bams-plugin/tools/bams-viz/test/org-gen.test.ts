import { describe, test, expect } from 'bun:test'
import { generateOrgChart } from '../src/lib/org-gen'

describe('generateOrgChart', () => {
  const minimalJojikdo = {
    departments: [
      {
        department_id: 'planning',
        department_name: '기획부서',
        agents: [
          { agent_id: 'product_strategy_agent', agent_name: 'Product Strategy', model: 'sonnet' },
        ],
      },
    ],
  }

  test('generates valid flowchart header', () => {
    const result = generateOrgChart(minimalJojikdo)
    expect(result).toContain('flowchart TB')
    expect(result).toContain('ROOT')
  })

  test('creates subgraph per department', () => {
    const result = generateOrgChart(minimalJojikdo)
    expect(result).toContain('subgraph planning_group')
    expect(result).toContain('end')
  })

  test('includes agent nodes inside subgraph', () => {
    const result = generateOrgChart(minimalJojikdo)
    expect(result).toContain('product_strategy_agent')
    expect(result).toContain('Product Strategy')
    expect(result).toContain('sonnet')
  })

  test('highlights active agents', () => {
    const result = generateOrgChart(minimalJojikdo, ['product_strategy_agent'])
    expect(result).toContain('style product_strategy_agent fill:#fbbf24')
  })

  test('handles empty departments', () => {
    const result = generateOrgChart({ departments: [] })
    expect(result).toContain('flowchart TB')
    expect(result).toContain('ROOT')
  })

  test('handles missing departments field', () => {
    const result = generateOrgChart({})
    expect(result).toContain('flowchart TB')
  })

  test('uses DEFAULT_AGENT_CALLS when no agent_calls provided', () => {
    const result = generateOrgChart(minimalJojikdo)
    // Should contain cross-department collaboration edges from defaults
    expect(result).toContain('%% Cross-department collaboration')
  })

  test('uses provided agent_calls over defaults', () => {
    const jojikdo = {
      ...minimalJojikdo,
      agent_calls: {
        product_strategy_agent: [
          { agent_id: 'some_agent', purpose: '커스텀 목적' },
        ],
      },
    }
    const result = generateOrgChart(jojikdo)
    expect(result).toContain('커스텀 목적')
  })

  test('multi-department layout', () => {
    const jojikdo = {
      departments: [
        {
          department_id: 'planning',
          department_name: '기획부서',
          agents: [{ agent_id: 'ps', agent_name: 'PS', model: 'sonnet' }],
        },
        {
          department_id: 'engineering',
          department_name: '개발부서',
          agents: [{ agent_id: 'fe', agent_name: 'FE', model: 'claude-opus-4-7[1m]' }],
        },
        {
          department_id: 'qa',
          department_name: 'QA부서',
          agents: [{ agent_id: 'qa', agent_name: 'QA', model: 'sonnet' }],
        },
      ],
    }
    const result = generateOrgChart(jojikdo)
    expect(result).toContain('subgraph planning_group')
    expect(result).toContain('subgraph engineering_group')
    expect(result).toContain('subgraph qa_group')
  })
})
